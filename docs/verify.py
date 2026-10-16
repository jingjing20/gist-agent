#!/usr/bin/env python3
"""只读核对文档链接、导航、保守Mermaid子集和敏感模式；不连接服务。"""
from pathlib import Path
from urllib.parse import unquote
import re
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
errors = []
links = 0
code_paths = set()
diagrams = 0
json_examples = 0
kinds = {}
linked = set()
anchors_checked = 0
credential_pattern = r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}'

def markdown_anchors(body):
    """当前文档ATX标题的GFM锚点子集；跳过代码围栏，处理同名标题后缀。"""
    counts, anchors, fenced = {}, set(), False
    for line in body.splitlines():
        if line.startswith('```'):
            fenced = not fenced
            continue
        heading = re.match(r'^#{1,6}\s+(.+?)\s*#*$', line) if not fenced else None
        if not heading:
            continue
        title = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', heading.group(1))
        slug = re.sub(r'[^\w\s-]', '', title.lower())
        slug = re.sub(r'\s', '-', slug)
        count = counts.get(slug, 0)
        anchors.add(slug if count == 0 else f'{slug}-{count}')
        counts[slug] = count + 1
    return anchors

# 本项目图只使用基础flowchart、sequence、stateDiagram、erDiagram语法。
# 此检查器检查本套子集的结构，不替代Mermaid官方解析器或渲染器。
def check_diagram(body, path):
    lines = [line.strip() for line in body.strip().splitlines() if line.strip() and not line.strip().startswith('%%')]
    kind = lines[0].split()[0] if lines else ''
    kinds[kind] = kinds.get(kind, 0) + 1
    if kind == 'flowchart':
        if not re.fullmatch(r'flowchart (LR|TD|TB|RL|BT)', lines[0]):
            errors.append(f'{path}: flowchart方向无效')
        for line in lines[1:]:
            if '-->' not in line or line.count('[') != line.count(']') or line.count('(') != line.count(')'):
                errors.append(f'{path}: flowchart边/节点结构无效: {line}')
    elif kind == 'sequenceDiagram':
        participants, stack = set(), []
        for line in lines[1:]:
            match = re.fullmatch(r'participant (\w+)(?: as .+)?', line)
            if match:
                if match.group(1) in participants:
                    errors.append(f'{path}: participant重复')
                participants.add(match.group(1))
            elif re.match(r'^(loop|alt|opt|par|rect|critical)\b', line):
                stack.append(line.split()[0])
            elif line == 'end':
                if stack:
                    stack.pop()
                else:
                    errors.append(f'{path}: sequence多余end')
            elif line.startswith('Note over '):
                note = re.fullmatch(r'Note over ([\w,]+): .+', line)
                if not note or not set(note.group(1).split(',')).issubset(participants):
                    errors.append(f'{path}: Note引用无效')
            else:
                message = re.fullmatch(r'(\w+)(->>|-->>|->|-->)(\w+): .+', line)
                if not message or not {message.group(1), message.group(3)}.issubset(participants):
                    errors.append(f'{path}: sequence消息引用/语法无效: {line}')
        if stack:
            errors.append(f'{path}: sequence块未结束')
    elif kind == 'stateDiagram-v2':
        for line in lines[1:]:
            if not re.fullmatch(r'(\w+|\[\*\]) --> (\w+|\[\*\])(?:: .+)?', line):
                errors.append(f'{path}: state转换语法无效: {line}')
    elif kind == 'erDiagram':
        for line in lines[1:]:
            if not re.fullmatch(r'\w+ \|\|--(?:o\{|\|\||o\|) \w+ : \w+', line):
                errors.append(f'{path}: ER关系语法无效: {line}')
    else:
        errors.append(f'{path}: 检查器不支持图类型 {kind}')

files = sorted(DOCS.rglob('*.md'))
for path in files:
    body = path.read_text()
    rel = path.relative_to(ROOT)
    for number, line in enumerate(body.splitlines(), 1):
        if line.rstrip() != line:
            errors.append(f'{rel}:{number}: 尾随空白')
    if len(body.strip()) < 120:
        errors.append(f'{rel}: 文档过短或空模板')
    if len(re.findall(r'^```', body, re.M)) % 2:
        errors.append(f'{rel}: 代码围栏不闭合')
    for example in re.findall(r'```json\n(.*?)\n```', body, re.S):
        json_examples += 1
        try:
            json.loads(example)
        except json.JSONDecodeError as error:
            errors.append(f'{rel}: JSON示例无效: {error}')
    for diagram in re.findall(r'```mermaid\n(.*?)\n```', body, re.S):
        diagrams += 1
        check_diagram(diagram, rel)
    for label, target in re.findall(r'\[([^\]\n]+)\]\(([^)\n]+)\)', body):
        if target.startswith(('https://', 'http://', 'mailto:')):
            continue
        if ':' in target.split('/')[0] and not target.startswith('/'):
            errors.append(f'{rel}: 不支持的链接 {target}')
            continue
        target = target.strip('<>')
        base, _, anchor = target.partition('#')
        resolved = (path.parent / base).resolve() if base else path
        links += 1
        if not resolved.exists():
            errors.append(f'{rel}: 链接不存在 {target}')
        elif resolved.is_file():
            linked.add(resolved)
            if not resolved.is_relative_to(DOCS):
                code_paths.add(resolved)
        if anchor:
            if resolved.is_file() and resolved.suffix == '.md':
                if unquote(anchor) not in markdown_anchors(resolved.read_text()):
                    errors.append(f'{rel}: 标题锚点不存在 {target}')
                else:
                    anchors_checked += 1
            else:
                errors.append(f'{rel}: 不支持的非Markdown锚点 {target}')
    if re.search(credential_pattern, body):
        errors.append(f'{rel}: 疑似真实凭据')
for path in sorted((DOCS/'reference').glob('*-descriptions.json')):
    body = path.read_text()
    try:
        json.loads(body)
    except json.JSONDecodeError as error:
        errors.append(f'{path.relative_to(ROOT)}: 用途JSON无效: {error}')
    for number, line in enumerate(body.splitlines(), 1):
        if line.rstrip() != line:
            errors.append(f'{path.relative_to(ROOT)}:{number}: 尾随空白')
    if re.search(credential_pattern, body):
        errors.append(f'{path.relative_to(ROOT)}: 疑似真实凭据')
for directory in [DOCS, DOCS/'design', DOCS/'guides', DOCS/'decisions', DOCS/'reference']:
    if not (directory/'README.md').exists():
        errors.append(f'{directory.relative_to(ROOT)}: 缺少README')
for path in files:
    if path.name != 'README.md' and path not in linked:
        errors.append(f'{path.relative_to(ROOT)}: 未进入导航')
result = subprocess.run([sys.executable, str(DOCS/'reference/generate.py'), '--check'], capture_output=True, text=True)
if result.returncode:
    errors.append(result.stdout + result.stderr)
if errors:
    print('\n'.join(errors))
    raise SystemExit(1)
print(f'通过：{len(files)}篇Markdown，{links}个本地链接，{len(code_paths)}个不同源码/配置路径，{diagrams}幅图结构。')
print(f'JSON示例：{json_examples}个，均可解析；教学示例不代表运行验收。')
print(f'标题锚点：{anchors_checked}个，均对应Markdown标题；采用当前GFM标题子集检查。')
print('图类型：' + ', '.join(f'{k}={v}' for k,v in kinds.items()))
print('生成参考一致，目录导航完整，未发现常见私钥/Token模式。Mermaid未渲染、未使用官方解析器。')
