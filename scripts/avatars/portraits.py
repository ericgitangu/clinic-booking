"""Regenerates the AI portraits of the five fictional seeded doctors.

    uv run --with gradio_client python scripts/avatars/portraits.py [doctor key ...]
    make avatars

Not part of CI and not run by the apps: the committed WebP files in packages/ui/assets/doctors/ came
from one run of this script on 2026-10-18. Running it again calls a third-party service and needs a
Hugging Face login already cached on this machine (`huggingface-cli login`); the token is read with
huggingface_hub.get_token() and is never written to a file, a log or an error message.

Model:    Z-Image-Turbo (Tongyi-MAI/Z-Image-Turbo), via the Space mcp-tools/Z-Image-Turbo (gradio /generate)
Settings: 1024x1024, steps 8, shift 3.0, fixed seed 2026 (so the run can be repeated)
Output:   <id>-256.webp and <id>-512.webp in packages/ui/assets/doctors/ (ImageMagick `magick`, quality 82,
          metadata stripped). The 1024 px originals go to a temporary directory and are deleted; they
          are never committed.
Licence:  Apache License 2.0. The model card header reads `license: apache-2.0`
          (https://huggingface.co/Tongyi-MAI/Z-Image-Turbo); the project's licence text is at
          https://github.com/Tongyi-MAI/Z-Image/blob/main/LICENSE. The card is not gated and adds no terms
          about generated images.

The people are fictional. Run `node scripts/avatars/sync.mjs` afterwards to copy the files into the apps.
"""

from __future__ import annotations

import inspect
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SPACE = "mcp-tools/Z-Image-Turbo"
SEED, STEPS, SHIFT = 2026, 8, 3.0
RESOLUTION = "1024x1024 ( 1:1 )"
OUT = Path(__file__).resolve().parents[2] / "packages" / "ui" / "assets" / "doctors"

BASE = (
    "Professional corporate headshot photograph, {who}, wearing a crisp white doctor's coat over {wear}, "
    "stethoscope around neck, warm genuine smile, looking at camera, soft even studio lighting, "
    "plain light grey background, head and shoulders, centered, sharp focus, photorealistic, 85mm lens"
)

# Ids are the seed's deterministic uuid5 values (backend/app/scripts/seed.py).
IDS = {
    "otieno": "e52e9da0-f7f3-5a6a-93d3-d7f658947afa",
    "kamau": "412e6793-68f2-5c62-832d-cb7839acae9d",
    "rotich": "d761df1a-d923-5bb3-bf78-057823782bc2",
    "mwangi": "b465c5a0-40d4-5871-9606-c7a460b7e8b0",
    "njeri": "ceae880b-86c2-562d-978c-ac7794404e04",
}
DOCS = {
    "otieno": "a Kenyan Black woman in her late 30s, general practitioner, short natural hair, small gold stud earrings",
    "kamau": "a Kenyan Black man in his mid 30s, paediatrician, short cropped hair, friendly expression",
    "rotich": "a Kenyan Black woman in her early 30s, dermatologist, neat braids tied back, clear radiant skin",
    "mwangi": "a Kenyan Black man in his late 40s, obstetrician gynaecologist, short greying hair, trimmed beard, reassuring expression",
    "njeri": "a Kenyan Black woman in her early 40s, dentist, shoulder-length relaxed hair, bright smile",
}
WEAR = {
    "otieno": "navy blouse",
    "kamau": "light blue shirt",
    "rotich": "teal scrubs",
    "mwangi": "white shirt and dark tie",
    "njeri": "lilac scrubs",
}


def redact(text: str, token: str) -> str:
    """Error text with the token removed, in case a library echoes a header back."""
    return text.replace(token, "[redacted]") if token else text


def main(keys: list[str]) -> int:
    import httpx
    from gradio_client import Client
    from gradio_client.exceptions import AppError
    from huggingface_hub import get_token

    # What a failed call can raise; anything else is a bug and should show its traceback.
    expected = (
        httpx.HTTPError,
        AppError,
        OSError,
        ValueError,
        RuntimeError,
        subprocess.CalledProcessError,
    )
    token = get_token()
    if not token:
        print(
            "No Hugging Face token cached; log in first (huggingface-cli login).",
            file=sys.stderr,
        )
        return 2
    unknown = [k for k in keys if k not in IDS]
    if unknown:
        print(f"unknown doctor key(s): {', '.join(unknown)}", file=sys.stderr)
        return 2
    # The client's keyword for the token changed between versions.
    kw = "hf_token" if "hf_token" in inspect.signature(Client).parameters else "token"
    try:
        client = Client(SPACE, verbose=False, **{kw: token})
    except expected as e:
        print(
            f"could not reach {SPACE}: {type(e).__name__}: {redact(str(e), token)}",
            file=sys.stderr,
        )
        return 1

    failed = 0
    with tempfile.TemporaryDirectory(prefix="portraits-") as tmp:
        for key in keys or list(IDS):
            try:
                result = client.predict(
                    prompt=BASE.format(who=DOCS[key], wear=WEAR[key]),
                    resolution=RESOLUTION,
                    seed=SEED,
                    steps=STEPS,
                    shift=SHIFT,
                    random_seed=False,
                    api_name="/generate",
                )
                source = Path(tmp) / f"{key}.png"
                shutil.copy(result[0], source)
                for size in (256, 512):
                    subprocess.run(
                        [
                            "magick",
                            str(source),
                            "-resize",
                            f"{size}x{size}",
                            "-strip",
                            "-quality",
                            "82",
                            str(OUT / f"{IDS[key]}-{size}.webp"),
                        ],
                        check=True,
                    )
                print(f"{key} ok")
            except expected as e:
                failed += 1
                print(
                    f"{key} FAILED {type(e).__name__}: {redact(str(e), token)}",
                    file=sys.stderr,
                )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
