"""Error and Warning Collector.

A small cross-cutting component used by all analysis passes (Module Map
Builder, Route and Schema Extractor, Route Path Resolver, Schema Reference
Resolver) to record reasons why a file, route, or schema reference was
skipped or excluded from the analysis result.

The collector itself has no knowledge of specific error types (such as
``ParserSyntaxError`` or ``UnicodeDecodeError``); each pass is responsible
for catching its own exceptions and translating them into a human-readable
``reason`` before recording it here. This keeps the collector generic and
reusable across passes.
"""

from __future__ import annotations

from apivista_backend_analysis.models import Warning


class WarningCollector:
    """Accumulates ``Warning``-shaped records for the analysis output.

    Each recorded warning has a ``target`` (the file path or route/schema
    identifier the warning is about) and a ``reason`` (a human-readable
    description of why it was skipped or excluded). Recorded warnings
    preserve insertion order and can be retrieved as ``list[Warning]``,
    suitable for direct use as ``AnalysisOutput.warnings``.
    """

    def __init__(self) -> None:
        self._warnings: list[Warning] = []

    def record(self, target: str, reason: str) -> None:
        """Record a warning for ``target`` with the given ``reason``."""
        self._warnings.append(Warning(target=target, reason=reason))

    def record_parse_error(self, file_path: str, error: BaseException) -> None:
        """Record a file-parse-skip warning.

        Convenience helper for the common case where a file could not be
        parsed (e.g. due to ``ParserSyntaxError`` or ``UnicodeDecodeError``)
        and is being skipped. ``file_path`` becomes the warning's
        ``target`` and the ``reason`` is formatted from ``error``.
        """
        self.record(file_path, f"Failed to parse file: {error}")

    @property
    def warnings(self) -> list[Warning]:
        """Return the accumulated warnings as a list, in recorded order."""
        return list(self._warnings)

    def __len__(self) -> int:
        return len(self._warnings)
