"""Build-time copy of tdd.html for WeasyPrint.

Inline <code> (not inside <pre>) gets <wbr> after '/', '_' and '::' and ',' so long identifiers can break
only at those points, never mid-token, and short code with spaces (for example a command) is
kept on one line with no-break spaces. The source stays readable.
"""
import re
import sys

src, dst = sys.argv[1], sys.argv[2]
html = open(src, encoding="utf-8").read()

def fix(match: re.Match) -> str:
    inner = match.group(1)
    if "<" in inner:  # leave anything with markup alone
        return match.group(0)
    if " " in inner and len(inner) <= 24:
        inner = inner.replace(" ", "&nbsp;")
    inner = re.sub(r"(::|/|_|,)(?=[^\s])", r"\1<wbr>", inner)
    return "<code>" + inner + "</code>"

parts = re.split(r"(<pre>.*?</pre>)", html, flags=re.S)
out = [p if p.startswith("<pre>") else re.sub(r"<code>(.*?)</code>", fix, p, flags=re.S) for p in parts]
open(dst, "w", encoding="utf-8").write("".join(out))
