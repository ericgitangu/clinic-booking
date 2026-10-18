# Third-party material

| Material | Where | Licence | Source |
| --- | --- | --- | --- |
| Doctor portraits (AI-generated, fictional doctors; Z-Image-Turbo, run through the Hugging Face Space `mcp-tools/Z-Image-Turbo`) | `packages/ui/assets/doctors/*.webp` | Apache 2.0 (model card header: `license: apache-2.0`); permits commercial use, no restriction on outputs | <https://huggingface.co/Tongyi-MAI/Z-Image-Turbo> |
| Doctor avatars, fallback (Lorelei by Lisa Wischofsky, via DiceBear) | `packages/ui/assets/doctors/` | CC0 1.0 | <https://www.figma.com/community/file/1198749693280469639> |

The portraits are AI-generated images of fictional people, disclosed on the doctor list and in each image's
description. The model card's licence line is `license: apache-2.0` (model `Tongyi-MAI/Z-Image-Turbo`, revision `f332072aa78be7aecdf3ee76d5c247082da564a6`, confirmed with the Hugging Face CLI on 2026-10-19); the Space `mcp-tools/Z-Image-Turbo` is listed as running that model. The card is not gated and adds no
terms about generated images, and the Apache 2.0 text is at
<https://github.com/Tongyi-MAI/Z-Image/blob/main/LICENSE>. Apache 2.0 allows commercial use and does not
restrict outputs, so portfolio and commercial use of the portraits is permitted (a reading of the published
licence, not legal advice). Model, settings, prompt and derivatives are recorded in the assets README.

Details and regeneration steps: `packages/ui/assets/doctors/README.md`.
