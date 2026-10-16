#!/usr/bin/env python3
"""从当前源码生成 API 与平台 DDL 索引，仅写入 docs/reference；--check 只比较。"""
from pathlib import Path
import argparse
import json
import re

ROOT = Path(__file__).resolve().parents[2]
DEST = Path(__file__).resolve().parent

def link(path):
    return f'[{path.name}](../../{path.relative_to(ROOT).as_posix()})'

def descriptions(name):
    """语义说明单独维护，不从处理器名称猜测业务用途。"""
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f'{name}: 重复键 {key}')
            result[key] = value
        return result
    return json.loads((DEST / name).read_text(), object_pairs_hook=unique)

def validate_descriptions(items, keys, name, fields):
    expected = set(keys)
    if len(keys) != len(expected):
        raise ValueError(f'{name}: 源码中发现重复入口')
    if not isinstance(items, dict) or set(items) != expected:
        actual = set(items) if isinstance(items, dict) else set()
        raise ValueError(f'{name}: 缺少说明 {sorted(expected - actual)}；多余说明 {sorted(actual - expected)}')
    for key, item in items.items():
        if not isinstance(item, dict) or set(item) != set(fields):
            raise ValueError(f'{name}: {key} 必须完整提供 {fields}')
        for field in set(fields) - {'evidence'}:
            if not isinstance(item[field], str) or not item[field].strip() or '\n' in item[field]:
                raise ValueError(f'{name}: {key}.{field} 必须为非空单行说明')
        if not isinstance(item['evidence'], list) or not item['evidence']:
            raise ValueError(f'{name}: {key} 缺少代码证据')
        for evidence in item['evidence']:
            if not isinstance(evidence, str):
                raise ValueError(f'{name}: {key} 代码证据必须是路径#符号')
            relative, separator, symbol = evidence.partition('#')
            source = (ROOT / relative).resolve()
            if not separator or not source.is_relative_to(ROOT) or not source.is_file():
                raise ValueError(f'{name}: {key} 证据路径无效 {evidence}')
            if not re.fullmatch(r'[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*', symbol):
                raise ValueError(f'{name}: {key} 证据符号无效 {evidence}')
            body = source.read_text()
            if any(not re.search(r'(?<![\w$])' + re.escape(part) + r'(?![\w$])', body) for part in symbol.split('.')):
                raise ValueError(f'{name}: {key} 证据符号未找到 {evidence}')
        for field in {'guide', 'design'} & set(fields):
            target = (DEST / item[field].partition('#')[0]).resolve()
            if not target.is_relative_to(ROOT / 'docs') or not target.is_file():
                raise ValueError(f'{name}: {key} 讲解入口无效 {item[field]}')

def cell(value):
    return value.replace('|', '\\|')

def evidence_links(items):
    return '；'.join(f'[`{symbol}`](../../{relative})' for relative, symbol in (item.split('#', 1) for item in items))

def skip_decorators(text):
    i = 0
    while True:
        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text) or text[i] != '@':
            return i
        decorator = re.match(r'@\w+', text[i:])
        if not decorator:
            raise ValueError('装饰器读取失败')
        i += decorator.end()
        if i < len(text) and text[i] == '(':
            depth, quote = 1, ''
            i += 1
            while i < len(text) and depth:
                c = text[i]
                i += 1
                if quote:
                    if c == '\\':
                        i += 1
                    elif c == quote:
                        quote = ''
                elif c in "'\"`":
                    quote = c
                elif c == '(':
                    depth += 1
                elif c == ')':
                    depth -= 1
            if depth:
                raise ValueError('装饰器括号未闭合')

def api_index():
    rows = []
    paths = sorted((ROOT / 'apps/api/src').rglob('*.ts')) + [ROOT / 'apps/worker/src/health.controller.ts']
    for path in paths:
        source = path.read_text()
        controllers = list(re.finditer(r"@Controller\('([^']*)'\)", source))
        for i, controller in enumerate(controllers):
            block = source[controller.end():controllers[i+1].start() if i+1 < len(controllers) else len(source)]
            cls = re.search(r'class\s+(\w+)', block).group(1)
            prefix = '/api/' if 'apps/api/' in path.as_posix() else '/'
            decorators = list(re.finditer(r'@(Get|Post|Patch|Put|Delete)\(([^)]*)\)', block))
            previous_end = 0
            for decorator in decorators:
                arg = decorator.group(2).strip().strip("'\"")
                tail = block[decorator.end():]
                offset = skip_decorators(tail)
                method = re.match(r'(?:async\s+)?(\w+)\s*\(', tail[offset:])
                if not method:
                    raise ValueError(f'无法读取处理器: {path}')
                route = prefix + '/'.join(x for x in [controller.group(1), arg] if x)
                if prefix == '/':
                    auth = 'Worker 进程端口，无 JWT'
                else:
                    auth = '公开' if '@Public()' in block[previous_end:decorator.start()] else 'Bearer JWT'
                rows.append((decorator.group(1).upper(), route, auth, cls + '.' + method.group(1), path))
                previous_end = decorator.end() + offset + method.end()
    notes = descriptions('api-descriptions.json')
    validate_descriptions(notes, [f'{verb} {route}' for verb, route, *_ in rows], 'api-descriptions.json', ['purpose', 'group', 'evidence', 'guide'])
    result = '''# API 接口索引（路由生成与用途说明）

用途：按业务目的选择接口，理解每个方法的主要结果，再定位真实处理器与实现指南。适用读者：前端、API开发。分析基线：2026-10-14当前工作区。

来源：方法、路径和处理器从Nest Controller/HTTP装饰器提取；中文用途由[api-descriptions.json](api-descriptions.json)依据处理器及服务人工核对后维护，生成器合并两者，不根据方法名推测功能。API全局前缀`/api`，默认全局JWT Guard；Worker health使用独立端口。

重新生成：`python3 docs/reference/generate.py`；只读校验：`python3 docs/reference/generate.py --check`。新增/删除路由必须同步用途说明；缺失或多余条目、无效证据路径/符号会阻止生成和检查。已有路由内部行为变化仍需人工复核用途，不能以生成一致代替语义校验。

这不是OpenAPI或线上接口探测，不推断默认HTTP响应码、完整body类型或统一错误包装。下方鉴权列说明入口是否要求JWT；数据所有权/源共享/版本等进一步限制见用途、关键边界及链接指南。
'''
    groups = {}
    for row in rows:
        note = notes[f'{row[0]} {row[1]}']
        groups.setdefault(note['group'], []).append((row, note))
    reading_order = ['认证与账号', '会话与历史消息', '分析任务与流式通信', '分析证据', '数据源与表管理', '数据源授权', 'Schema 与业务语义', '正式业务记忆', '记忆候选审核', 'Worker 运维']
    for group in sorted(groups, key=lambda value: reading_order.index(value) if value in reading_order else len(reading_order)):
        entries = groups[group]
        result += f'\n## {group}\n\n| 方法 | 路径 | 作用与主要结果 | 鉴权入口 | 处理器与代码依据 | 详解 |\n| --- | --- | --- | --- | --- | --- |\n'
        for (verb, route, auth, handler, path), note in entries:
            source = f'[`{handler}`](../../{path.relative_to(ROOT).as_posix()})'
            evidence = evidence_links(note['evidence'])
            result += f'| {verb} | `{route}` | {cell(note["purpose"])} | {auth} | {source}；{evidence} | [实现指南]({note["guide"]}) |\n'
    result += f'\n共 {len(rows)} 个接口（含独立Worker health），每个接口均有经源码核对的用途说明。\n'
    result += '''

## 关键请求和响应边界

- `POST /api/chat`：body为message、conversationId、可选datasourceId/reasoningEnabled；header Idempotency-Key；202返回generationId/conversationId/userMessageId/responseMessageId。取消/重试的id是generation ID。
- `GET /api/chat/sync`：query `known_generation_ids`逗号分隔最多100项；返回eventCursor、activeGenerations、reconciledGenerations。
- `GET /api/chat/events`：query `after`为RedisStream ID，返回SSE；history query `after_sequence`为generation逻辑序号，返回mode=events或snapshot。
- Artifact元数据和rows都要求query conversationId；rows可带cursor/limit（默认50，1–100），nextCursor是存储行偏移量。
- 上传tables：multipart `file`与`tableConfigs`，后者是`[{sheetName?,displayName}]`的JSON字符串。数据源create/update仅name/description，没有远程数据库host/password字段。
- 列注释建议body为columns字符串数组；保存body为changes（column/originalComment/comment）。
- Memory list：query datasourceId、q、cursor、limit；get可带version；create body datasourceId/name/description；patch body expectedVersion和name/description；delete query expectedVersion。
- Memory related：body datasourceId/content、可选excludeId；候选list query datasourceId、可选conversationId；confirm body expectedVersion，可选content/memoryId/expectedMemoryVersion；reject只有expectedVersion。
- 用户改密码body包含currentPassword/password；找回密码body email、可选origin；重置body token/password；认证me为POST。

Controller inline TypeScript类型不等于完整运行时校验；实际约束必须继续阅读对应Service。核心链路见 [Generation指南](../guides/generation-lifecycle.md) 和 [Memory指南](../guides/memory.md)。
'''
    return result

def split_declarations(source, start):
    parts, buf, depth, quote = [], '', 1, ''
    i = start
    while i < len(source) and depth:
        c = source[i]
        i += 1
        if quote:
            buf += c
            if c == quote:
                if i < len(source) and source[i] == quote:
                    buf += source[i]
                    i += 1
                else:
                    quote = ''
        elif c in "'\"":
            quote = c
            buf += c
        elif c == '(':
            depth += 1
            buf += c
        elif c == ')':
            depth -= 1
            if depth:
                buf += c
        elif c == ',' and depth == 1:
            parts.append(buf.strip())
            buf = ''
        else:
            buf += c
    parts.append(buf.strip())
    if depth:
        raise ValueError('DDL括号未闭合')
    return parts

def schema_index():
    notes = descriptions('schema-descriptions.json')
    result = '''# 平台数据库 Schema 参考（代码生成）

用途：查当前平台表列、类型和约束声明。适用读者：数据库/API/Worker开发。来源是源码DDL，**不是线上数据库导出**；动态上传分析表不包含在内。

重新生成或校验见 [generate.py](generate.py)。默认值中的`${ANALYSIS_RUNTIME_VERSIONS...}`表示由共享契约插入，不是数据库真实存储表达式。每条约束按DDL原文压缩空白，不替代迁移验证。

每张表下方给出业务用途和关键字段讲解入口；用途由[schema-descriptions.json](schema-descriptions.json)人工核对读写实现后维护，与DDL生成定义合并。详细关键字段/关系/生命周期只在[数据库设计](../design/data-model.md)维护，不复制整份解释到本参考。列声明是查询精确定义用的字典，不能仅凭字段名判断业务意义。
'''
    names = []
    for relative in ['packages/database/src/schema.ts', 'packages/database/src/memory-schema.ts', 'packages/database/src/analysis-state-schema.ts']:
        path = ROOT / relative
        source = re.sub(r'--[^\n]*', '', path.read_text())
        for table in re.finditer(r'CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(', source):
            name = table.group(1)
            names.append(name)
            if name not in notes:
                raise ValueError(f'schema-descriptions.json: 缺少表用途 {name}')
            note = notes[name]
            result += f'\n## {name}\n\n用途：{note["purpose"]}\n\n关键字段与读写语义：[对应数据模型讲解]({note["design"]})。读写依据：{evidence_links(note["evidence"])}。\n\nDDL：{link(path)}\n\n| 列 | 类型 | 声明约束与默认值 |\n| --- | --- | --- |\n'
            constraints = []
            for item in split_declarations(source, table.end()):
                item = re.sub(r'\s+', ' ', item)
                if re.match(r'^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b', item, re.I):
                    constraints.append(item)
                    continue
                column = re.match(r'(\w+)\s+([A-Z]+(?:\(\d+(?:,\d+)?\))?)(.*)', item)
                if not column:
                    raise ValueError('无法解析列: ' + item)
                name, typ, extra = column.groups()
                result += f'| `{name}` | `{typ}` | `{extra.strip() or "未声明"}` |\n'
            if constraints:
                result += '\n表级约束：\n\n' + '\n'.join('- `' + x + '`' for x in constraints) + '\n'
    validate_descriptions(notes, names, 'schema-descriptions.json', ['purpose', 'design', 'evidence'])
    result += f'\n共 {len(names)} 张固定平台表。索引、记忆来源升级ALTER/DO及运行时Schema校验请直接读对应源码；本索引不声称列校验可覆盖全部约束。\n'
    return result

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    for name, content in {'api-index.md': api_index(), 'database-schema.md': schema_index()}.items():
        target = DEST / name
        if args.check:
            if not target.exists() or target.read_text() != content:
                raise SystemExit(f'参考与源码不一致: {target.relative_to(ROOT)}')
        else:
            target.write_text(content)
        print(('已验证 ' if args.check else '已生成 ') + name)
if __name__ == '__main__':
    main()
