"""粗略估算 Token，用于上下文预算控制。

并非精确 BPE 分词，通过中文/ASCII 字符权重实现。
"""

import json
import re

CJK_CHARS_PER_TOKEN = 1.2
ASCII_CHARS_PER_TOKEN = 4
MESSAGE_OVERHEAD = 4

# 覆盖常用中日韩 Unicode 字符范围
_CJK_RE = re.compile(
    r"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\U00020000-\U0002a6df\U0002a700-\U0002b73f]"
)


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    cjk = len(_CJK_RE.findall(text))
    ascii_count = len(text) - cjk
    import math

    return math.ceil(cjk / CJK_CHARS_PER_TOKEN + ascii_count / ASCII_CHARS_PER_TOKEN)


def estimate_message_tokens(msg: dict) -> int:
    content = msg.get("content")
    if isinstance(content, str):
        return MESSAGE_OVERHEAD + estimate_tokens(content)
    return MESSAGE_OVERHEAD + estimate_tokens(
        json.dumps(msg, ensure_ascii=False, default=str)
    )


def estimate_messages_tokens(msgs: list[dict]) -> int:
    return sum(estimate_message_tokens(m) for m in msgs)
