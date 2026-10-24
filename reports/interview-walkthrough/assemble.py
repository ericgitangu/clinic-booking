"""Markdown -> pandoc HTML5 -> wrapped page with inlined CSS, SVG and data-URI images."""
import base64, pathlib, re, subprocess, html

here = pathlib.Path(__file__).resolve().parent
technical_design = here.parent / "technical-design"
src = (here / "WALKTHROUGH.md").read_text()

# Drop the H1 (the cover carries the title) and the plain "Contents" list (the generated one replaces it).
src = re.sub(r"\A# [^\n]*\n", "", src)
src = re.sub(r"^Contents\n\n(?:\d+\. [^\n]*\n)+\n", "", src, flags=re.M)

n = 0
def fig(_):
    global n
    n += 1
    return f'\n<div class="mermaid-slot" data-n="{n:02d}"></div>\n'
src = re.sub(r"^```mermaid\n.*?^```$", fig, src, flags=re.S | re.M)
(here / ".body.md").write_text(src)

tmpl = here / "template.html"
subprocess.run(["/opt/homebrew/bin/pandoc", str(here / ".body.md"), "-f", "gfm+raw_html", "-t", "html5", "-s",
                "--template", str(tmpl), "--toc", "--toc-depth=3", "--section-divs", "--syntax-highlighting=tango",
                "--wrap=none", "-o", str(here / ".body.html")], check=True)
(here / ".body.md").unlink()
doc = (here / ".body.html").read_text()

# Diagrams
def svg_for(m):
    k = m.group(1)
    raw = (here / "diagrams" / f"{k}.svg").read_bytes()
    uri = "data:image/svg+xml;base64," + base64.b64encode(raw).decode()
    wide = 'class="diagram wide-fig"' if k in WIDE else 'class="diagram"'
    return f'<figure {wide}><img src="{uri}" alt="Diagram {k}"></figure>'
WIDE = set()
wf = here / "diagrams" / "wide.txt"
if wf.exists():
    WIDE = set(wf.read_text().split())
doc = re.sub(r'<div class="mermaid-slot" data-n="(\d+)"></div>', svg_for, doc)

# A heading directly above a landscape diagram moves onto that page so it is not stranded.
doc = re.sub(r'(<h3[^>]*>(?:(?!</h3>).)*</h3>)\s*<figure (class="diagram wide-fig")>', r'<figure \2>\1', doc, flags=re.S)
doc = re.sub(r'(<h2[^>]*>(?:(?!</h2>).)*</h2>)(\s*(?:<section[^>]*>\s*)?)<figure (class="diagram wide-fig")>',
             r'\2<figure \3>\1', doc, flags=re.S)

# Question cards: "**N. Question?**\nAnswer" paragraphs inside the question bank section.
def cards(sec):
    def card(m):
        return f'<div class="qcard"><span class="q">{m.group(1)}</span><p class="a">{m.group(2)}</p></div>'
    return re.sub(r"<p><strong>(\d+\. [^<]*)</strong>\s*(.*?)</p>", card, sec, flags=re.S)
m = re.search(r'<section id="9-question-bank".*?(?=<section id="10-demo-script")', doc, re.S)
assert m, "question bank section not found"
doc = doc[:m.start()] + cards(m.group(0)) + doc[m.end():]

# Inline CSS: the shared base + this report's branch + the pygments rules pandoc wrote into
# its own <style>.
base = here.parent / "base.css"
css = base.read_text() + "\n" + (here / "walkthrough.css").read_text()
pandoc_css = "\n".join(re.findall(r"<style>(.*?)</style>", doc, re.S))
doc = re.sub(r"<style>.*?</style>", "", doc, flags=re.S)
doc = doc.replace("/*CSS*/", "")
doc = doc.replace("</head>", "<style>" + css + "\n" + pandoc_css + "\n/*walk-end*/</style></head>", 1)

# Images as data URIs
def datauri(m):
    p = technical_design / m.group(1)
    return 'src="data:image/png;base64,' + base64.b64encode(p.read_bytes()).decode() + '"'
doc = re.sub(r'src="(assets/[^"]+\.png)"', datauri, doc)
(here / ".walk.render.html").write_text(doc)
print("slots:", n)
