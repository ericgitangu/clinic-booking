#!/usr/bin/env python3
"""The only part of a Vercel error that is ever printed: a validated error code.

    error_code(text) -> "forbidden" | None

A code is accepted only if it is a whole lowercase word, ^[a-z][a-z0-9_]{0,39}$, found as
  - the `error.code` string of a JSON error body, or
  - a whole line `Error: <code>`, or
  - a whole line `"code": "<code>"`.
Anything else returns None and nothing of the input is shown: Vercel's free-text messages can carry
scopes, ids and tokens in forms no redaction list can keep up with, so none is printed.
"""
import json
import re

CODE = r"[a-z][a-z0-9_]{0,39}"
_CODE = re.compile(CODE)
_ERROR_LINE = re.compile(r"[ \t]*Error:[ \t]*(" + CODE + r")[ \t]*")
_CODE_LINE = re.compile(r'[ \t]*"code"[ \t]*:[ \t]*"(' + CODE + r')"[ \t]*,?[ \t]*')


def error_code(text):
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            body = json.loads(text[start:end + 1])
        except ValueError:
            body = None
        if isinstance(body, dict):
            err = body.get("error")
            code = err.get("code") if isinstance(err, dict) else None
            if isinstance(code, str) and _CODE.fullmatch(code):
                return code
    for line in text.splitlines():
        m = _ERROR_LINE.fullmatch(line) or _CODE_LINE.fullmatch(line)
        if m:
            return m.group(1)
    return None
