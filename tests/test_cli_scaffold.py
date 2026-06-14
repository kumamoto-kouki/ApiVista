"""Scaffold tests for the apivista-backend-analysis CLI entrypoint."""

import subprocess
import sys

import pytest


def test_cli_help_runs_successfully():
    """`python -m apivista_backend_analysis.cli --help` should exit 0 and print usage."""
    result = subprocess.run(
        [sys.executable, "-m", "apivista_backend_analysis.cli", "--help"],
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    assert "usage" in result.stdout.lower()
    assert "backend_dir" in result.stdout or "backend-dir" in result.stdout


def test_main_help_raises_systemexit_zero():
    """Calling main() with --help should raise SystemExit(0)."""
    from apivista_backend_analysis.cli import main

    with pytest.raises(SystemExit) as exc_info:
        main(["--help"])

    assert exc_info.value.code == 0
