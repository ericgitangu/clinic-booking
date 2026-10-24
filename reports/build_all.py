#!/usr/bin/env python3
"""Build every generated report from the shared print system.

The reports are deliberately separate branches: the technical design is a hand-written HTML
document with its own diagrams, while the walkthrough is Markdown assembled through pandoc.
Both load reports/base.css, so the brand, tables and footer stay identical.

Usage:
    python3 reports/build_all.py
    python3 reports/build_all.py --only technical-design
    python3 reports/build_all.py --list
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent

REPORTS: dict[str, dict[str, object]] = {
    "technical-design": {
        "script": HERE / "technical-design" / "build.sh",
        "pdf": HERE / "technical-design" / "technical-design.pdf",
        "label": "Technical Design",
    },
    "interview-walkthrough": {
        "script": HERE / "interview-walkthrough" / "build.sh",
        "pdf": HERE / "interview-walkthrough" / "interview-walkthrough.pdf",
        "label": "Interview Walkthrough",
    },
}


def page_count(pdf: pathlib.Path) -> str:
    try:
        out = subprocess.run(
            ["pdfinfo", str(pdf)], check=True, capture_output=True, text=True
        ).stdout
    except (FileNotFoundError, subprocess.CalledProcessError):
        return "pages unknown"
    for line in out.splitlines():
        if line.startswith("Pages:"):
            return f"{line.split(':', 1)[1].strip()} pages"
    return "pages unknown"


def build(name: str) -> None:
    report = REPORTS[name]
    script = pathlib.Path(report["script"])
    pdf = pathlib.Path(report["pdf"])
    print(f"\n== {report['label']} ==", flush=True)
    if not script.exists():
        raise SystemExit(f"missing build script: {script}")
    subprocess.run(["bash", str(script)], check=True, cwd=script.parent)
    if not pdf.exists():
        raise SystemExit(f"build finished without an output: {pdf}")
    print(f"{pdf.relative_to(ROOT)}: {page_count(pdf)}", flush=True)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", choices=sorted(REPORTS), help="build one report")
    parser.add_argument("--list", action="store_true", help="list the reports and exit")
    args = parser.parse_args(argv)

    if args.list:
        for key, report in REPORTS.items():
            print(f"{key:22} {report['label']:24} -> {report['pdf']}")
        return 0

    names = [args.only] if args.only else list(REPORTS)
    for name in names:
        build(name)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
