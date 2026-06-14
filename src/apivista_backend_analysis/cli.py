"""CLI entrypoint for apivista-backend-analysis.

Parses arguments, runs the analysis pipeline, and writes the resulting
``AnalysisOutput`` JSON to stdout or to ``--output-file``. Logs and
progress information are written to stderr only.
"""

import argparse
from collections.abc import Sequence


def build_parser() -> argparse.ArgumentParser:
    """Build the argument parser for the CLI."""
    parser = argparse.ArgumentParser(
        prog="apivista-backend-analysis",
        description=(
            "Statically analyze a FastAPI backend directory and emit "
            "structured route/schema/call-graph data as JSON."
        ),
    )
    parser.add_argument(
        "backend_dir",
        help="Path to the backend directory to analyze.",
    )
    parser.add_argument(
        "--output-file",
        default=None,
        help="Path to write the JSON output to. Defaults to stdout.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point for the ``apivista-backend-analysis`` command."""
    parser = build_parser()
    parser.parse_args(argv)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
