"""The migration chain has exactly one head, and the check that says so fails on two."""

from __future__ import annotations

import pathlib
import subprocess
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts" / "alembic_single_head.py"
VERSIONS = ROOT / "backend" / "migrations" / "versions"


def run(directory: pathlib.Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(directory)], capture_output=True, text=True, check=False
    )


def write(directory: pathlib.Path, name: str, revision: str, down: str | None) -> None:
    value = "None" if down is None else repr(down)
    (directory / f"{name}.py").write_text(f'revision = "{revision}"\ndown_revision = {value}\n')


def test_the_real_chain_has_one_head() -> None:
    result = run(VERSIONS)
    assert result.returncode == 0, result.stdout
    assert "one head" in result.stdout


def test_a_linear_chain_passes(tmp_path: pathlib.Path) -> None:
    write(tmp_path, "0001_a", "0001", None)
    write(tmp_path, "0002_b", "0002", "0001")
    assert run(tmp_path).returncode == 0


def test_two_branches_off_the_same_parent_fail(tmp_path: pathlib.Path) -> None:
    """The collision this guards against: two branches each add the next migration."""
    write(tmp_path, "0001_a", "0001", None)
    write(tmp_path, "0002_b", "0002", "0001")
    write(tmp_path, "0002_c", "0003", "0001")
    result = run(tmp_path)
    assert result.returncode == 1
    assert "found 2" in result.stdout and "0002" in result.stdout and "0003" in result.stdout


def test_the_same_revision_id_twice_fails(tmp_path: pathlib.Path) -> None:
    write(tmp_path, "0001_a", "0001", None)
    write(tmp_path, "0002_b", "0002", "0001")
    write(tmp_path, "0002_other", "0002", "0001")
    assert run(tmp_path).returncode == 1


def test_a_merge_revision_joins_two_parents_into_one_head(tmp_path: pathlib.Path) -> None:
    write(tmp_path, "0001_a", "0001", None)
    write(tmp_path, "0002_b", "0002", "0001")
    write(tmp_path, "0003_c", "0003", "0001")
    (tmp_path / "0004_merge.py").write_text('revision = "0004"\ndown_revision = ("0002", "0003")\n')
    assert run(tmp_path).returncode == 0


def test_an_empty_directory_fails(tmp_path: pathlib.Path) -> None:
    assert run(tmp_path).returncode == 1


@pytest.mark.parametrize("junk", ["", "x = 1\n"])
def test_a_file_without_revisions_is_reported(tmp_path: pathlib.Path, junk: str) -> None:
    write(tmp_path, "0001_a", "0001", None)
    (tmp_path / "bad.py").write_text(junk)
    assert run(tmp_path).returncode == 1
