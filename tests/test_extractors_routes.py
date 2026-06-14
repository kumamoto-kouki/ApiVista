"""Tests for route decorator extraction (Pass1, Requirement 1.1, 1.4, 5.2, 5.3).

``extract_route_candidates()`` walks ``FunctionDef`` nodes and recognizes only
attribute-call decorators whose attribute name matches an HTTP method
(``get``/``post``/``put``/``delete``/``patch``). Programmatic registration
(e.g. ``add_api_route``) and unrelated decorators are ignored entirely
(Requirement 1.4).

For recognized route-candidate decorators, the first positional argument is
inspected: if it is a string literal, the path is resolved (quotes stripped)
into a ``RouteCandidate``. Otherwise (variable reference, f-string, call,
missing argument, etc.) no ``RouteCandidate`` is produced and a warning is
recorded via the ``WarningCollector`` (Requirement 5.2, 5.3).
"""

from pathlib import Path

import libcst

from apivista_backend_analysis.errors import WarningCollector
from apivista_backend_analysis.extractors.routes import extract_route_candidates

FIXTURE_ITEMS = Path(__file__).parent / "fixtures" / "sample_app" / "routers" / "items.py"


def _parse(source: str) -> libcst.Module:
    return libcst.parse_module(source)


def test_literal_path_routes_extracted_from_sample_app() -> None:
    source = FIXTURE_ITEMS.read_text()
    module = _parse(source)
    collector = WarningCollector()

    candidates = extract_route_candidates(module, str(FIXTURE_ITEMS), collector)

    get_candidates = [c for c in candidates if c.method == "get" and c.path == "/{item_id}"]
    assert len(get_candidates) == 1
    assert get_candidates[0].handler_name == "get_item"

    post_candidates = [c for c in candidates if c.method == "post" and c.path == ""]
    assert len(post_candidates) == 1
    assert post_candidates[0].handler_name == "create_item"


def test_dynamic_path_route_is_unresolved_and_warned() -> None:
    source = FIXTURE_ITEMS.read_text()
    module = _parse(source)
    collector = WarningCollector()

    candidates = extract_route_candidates(module, str(FIXTURE_ITEMS), collector)

    # The DYNAMIC_SEGMENT-decorated handler must not produce a RouteCandidate.
    assert all(c.handler_name != "get_dynamic_item" for c in candidates)

    # Exactly one warning should be recorded for this file (the dynamic route).
    assert len(collector.warnings) == 1
    warning = collector.warnings[0]
    assert "get_dynamic_item" in warning.reason or "get_dynamic_item" in warning.target
    assert "static" in warning.reason.lower() or "resolved" in warning.reason.lower()


def test_non_route_decorators_are_silently_ignored() -> None:
    source = """
def some_other_decorator(func):
    return func


@some_other_decorator
def plain_function() -> None:
    pass


@router.add_api_route("/x", endpoint=plain_function)
def registration_only() -> None:
    pass
"""
    module = _parse(source)
    collector = WarningCollector()

    candidates = extract_route_candidates(module, "dummy.py", collector)

    assert candidates == []
    assert collector.warnings == []


def test_method_coverage_get_post_put_delete_patch() -> None:
    source = """
@router.get("/a")
def handle_get() -> None:
    pass


@router.post("/b")
def handle_post() -> None:
    pass


@router.put("/c")
def handle_put() -> None:
    pass


@router.delete("/d")
def handle_delete() -> None:
    pass


@router.patch("/e")
def handle_patch() -> None:
    pass
"""
    module = _parse(source)
    collector = WarningCollector()

    candidates = extract_route_candidates(module, "dummy.py", collector)

    methods = {(c.method, c.path, c.handler_name) for c in candidates}
    assert methods == {
        ("get", "/a", "handle_get"),
        ("post", "/b", "handle_post"),
        ("put", "/c", "handle_put"),
        ("delete", "/d", "handle_delete"),
        ("patch", "/e", "handle_patch"),
    }
    assert collector.warnings == []
