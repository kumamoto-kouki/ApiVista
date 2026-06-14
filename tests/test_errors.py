"""Tests for the Error and Warning Collector (apivista_backend_analysis.errors)."""

from apivista_backend_analysis.errors import WarningCollector
from apivista_backend_analysis.models import AnalysisOutput, Warning


def test_empty_collector_returns_empty_list() -> None:
    collector = WarningCollector()

    assert collector.warnings == []
    assert len(collector) == 0


def test_record_single_warning() -> None:
    collector = WarningCollector()

    collector.record(target="backend/app/routes.py", reason="syntax error")

    assert collector.warnings == [Warning(target="backend/app/routes.py", reason="syntax error")]


def test_record_multiple_warnings_preserves_order() -> None:
    collector = WarningCollector()

    collector.record(target="backend/a.py", reason="reason a")
    collector.record(target="backend/b.py", reason="reason b")
    collector.record(target="POST /items", reason="dynamic path not resolvable")

    assert collector.warnings == [
        Warning(target="backend/a.py", reason="reason a"),
        Warning(target="backend/b.py", reason="reason b"),
        Warning(target="POST /items", reason="dynamic path not resolvable"),
    ]


def test_warnings_property_returns_independent_copy() -> None:
    collector = WarningCollector()
    collector.record(target="backend/a.py", reason="reason a")

    first = collector.warnings
    first.append(Warning(target="extra", reason="should not affect collector"))

    assert collector.warnings == [Warning(target="backend/a.py", reason="reason a")]


def test_record_parse_error_formats_reason_with_file_path() -> None:
    collector = WarningCollector()

    collector.record_parse_error("backend/app/broken.py", ValueError("bad syntax"))

    [warning] = collector.warnings
    assert warning.target == "backend/app/broken.py"
    assert "bad syntax" in warning.reason


def test_collected_warnings_usable_in_analysis_output() -> None:
    collector = WarningCollector()
    collector.record(target="backend/a.py", reason="syntax error")
    collector.record(target="GET /dynamic", reason="path not statically resolvable")

    output = AnalysisOutput(warnings=collector.warnings)

    assert len(output.warnings) == 2
    assert output.warnings[0].target == "backend/a.py"
    assert output.warnings[1].reason == "path not statically resolvable"
