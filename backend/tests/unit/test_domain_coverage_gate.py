"""the domain package is held to 95% line coverage.

coverage.py has one ``fail_under`` per report, and CI already passes ``--cov=app
--cov-fail-under=85`` for the whole application, so a second, tighter gate on ``app/domain`` cannot
live in configuration alone. This test runs the pure unit tests (no database) in a child pytest
with its own coverage, measured on ``app/domain`` only, and fails below the threshold. The domain
package is pure by design, so the unit tests alone are the right measure.
"""

from __future__ import annotations

import os
import pathlib
import subprocess
import sys

BACKEND = pathlib.Path(__file__).resolve().parents[2]
THRESHOLD = 95


def test_domain_package_has_95_percent_coverage() -> None:
    env = {
        k: v
        for k, v in os.environ.items()
        # The parent's coverage session must not leak into the child's measurement.
        if not k.startswith(("COV_CORE", "COVERAGE"))
    }
    env["DOMAIN_COVERAGE_GATE_CHILD"] = "1"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "tests/unit",
            "--ignore=tests/unit/test_domain_coverage_gate.py",
            "--cov=app/domain",
            f"--cov-fail-under={THRESHOLD}",
            "--cov-report=term-missing",
            "-q",
            "-p",
            "no:cacheprovider",
        ],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        f"app/domain coverage is below {THRESHOLD}%:\n{result.stdout}\n{result.stderr}"
    )
