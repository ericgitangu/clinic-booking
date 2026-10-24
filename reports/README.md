# Reports

Every generated PDF in this repository is built from the same print system. The brand, cover,
running header, document footer, typography, tables, callouts and page furniture live once in
[`base.css`](base.css). A report adds only a small branch stylesheet for its own pacing.

| Report | Source | Branch | Output |
| --- | --- | --- | --- |
| Technical Design | [`technical-design/tdd.html`](technical-design/tdd.html) | [`technical-design/tdd.css`](technical-design/tdd.css) | [`technical-design/technical-design.pdf`](technical-design/technical-design.pdf) |
| Interview Walkthrough | [`interview-walkthrough/WALKTHROUGH.md`](interview-walkthrough/WALKTHROUGH.md) | [`interview-walkthrough/walkthrough.css`](interview-walkthrough/walkthrough.css) | [`interview-walkthrough/interview-walkthrough.pdf`](interview-walkthrough/interview-walkthrough.pdf) |

## Build

```bash
make reports                 # every report
python3 reports/build_all.py --only technical-design
```

The builder needs `weasyprint`, `pandoc`, `pdftoppm` and `pdfinfo`. It renders page images into
each report's `check/` directory so a reviewer can spot a bad page break; those images are
generated and are not tracked.

## The brand footer

Every page after the cover carries:

> Powered by Idyllic Clinic Technologies - Made with ❤ with Deveric
> <https://developer.ericgitangu.com> · Page N of M

The cover carries the Idyllic Clinic logo, the report title and subtitle, a document control
table (author, date, version, status, repository, live system) and the same attribution as a
brand stamp. The footer is part of `base.css`, not a per-report copy, so a new report inherits it
by linking the base stylesheet.
