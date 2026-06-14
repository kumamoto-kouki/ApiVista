"""Tests for schema reference candidate / class definition registry extraction
(Pass1, Requirement 2.1).

``extract_schema_info()`` walks route-handler ``FunctionDef`` nodes (matching
the same HTTP-method decorator shape as ``extract_route_candidates``) and, for
each parameter annotation (``role="request"``) and return annotation
(``role="response"``), resolves the annotated name via ``ScopeProvider``:

- If the name resolves to a local class definition (``Assignment`` whose
  ``node`` is a ``ClassDef``), a ``SchemaRefCandidate`` is produced with
  ``class_name`` and ``location`` pointing at the ``class`` line.
- If the name resolves to an import (``ImportAssignment``), a
  ``SchemaRefCandidate`` is produced with ``class_name`` and a
  ``qualified_name`` derived from the import's module path, with
  ``location=None``.
- Builtin types (``int``, ``str``, ``dict``, etc.) and unannotated
  parameters/returns do not produce candidates.

It also walks top-level ``ClassDef`` nodes to build a ``ClassDefinition``
registry (class name, base class names as written, definition location), used
later by Pass2c to resolve import-derived candidates.
"""

from pathlib import Path

import libcst

from apivista_backend_analysis.extractors.schemas import extract_schema_info

FIXTURE_ITEMS = Path(__file__).parent / "fixtures" / "sample_app" / "routers" / "items.py"
FIXTURE_USERS = Path(__file__).parent / "fixtures" / "sample_app" / "routers" / "users.py"
FIXTURE_SCHEMAS = Path(__file__).parent / "fixtures" / "sample_app" / "schemas.py"


def _parse(path: Path) -> libcst.Module:
    return libcst.parse_module(path.read_text())


def test_items_local_request_and_response_candidates() -> None:
    module = _parse(FIXTURE_ITEMS)
    result = extract_schema_info(module, str(FIXTURE_ITEMS))

    # get_item: response candidate for ItemResponse (local)
    get_item_candidates = [c for c in result.ref_candidates if c.handler_name == "get_item"]
    assert len(get_item_candidates) == 1
    response_candidate = get_item_candidates[0]
    assert response_candidate.role == "response"
    assert response_candidate.class_name == "ItemResponse"
    assert response_candidate.location is not None
    assert response_candidate.location.line == 32
    assert response_candidate.qualified_name is None

    # create_item: request candidate for ItemCreate (local) AND response
    # candidate for ItemResponse (local)
    create_item_candidates = [c for c in result.ref_candidates if c.handler_name == "create_item"]
    assert len(create_item_candidates) == 2

    request_candidates = [c for c in create_item_candidates if c.role == "request"]
    assert len(request_candidates) == 1
    assert request_candidates[0].class_name == "ItemCreate"
    assert request_candidates[0].location is not None
    assert request_candidates[0].location.line == 25
    assert request_candidates[0].qualified_name is None

    response_candidates = [c for c in create_item_candidates if c.role == "response"]
    assert len(response_candidates) == 1
    assert response_candidates[0].class_name == "ItemResponse"
    assert response_candidates[0].location is not None
    assert response_candidates[0].location.line == 32


def test_items_non_handler_function_has_no_candidates() -> None:
    module = _parse(FIXTURE_ITEMS)
    result = extract_schema_info(module, str(FIXTURE_ITEMS))

    assert all(c.handler_name != "format_item_label" for c in result.ref_candidates)


def test_items_class_definition_registry() -> None:
    module = _parse(FIXTURE_ITEMS)
    result = extract_schema_info(module, str(FIXTURE_ITEMS))

    by_name = {c.class_name: c for c in result.class_definitions}

    assert "ItemCreate" in by_name
    assert by_name["ItemCreate"].base_class_names == ["BaseModel"]
    assert by_name["ItemCreate"].location.line == 25

    assert "ItemResponse" in by_name
    assert by_name["ItemResponse"].base_class_names == ["BaseModel"]
    assert by_name["ItemResponse"].location.line == 32


def test_users_import_derived_candidates() -> None:
    module = _parse(FIXTURE_USERS)
    result = extract_schema_info(module, str(FIXTURE_USERS))

    # get_user: response candidate for UserResponse (import-derived)
    get_user_candidates = [c for c in result.ref_candidates if c.handler_name == "get_user"]
    assert len(get_user_candidates) == 1
    get_user_response = get_user_candidates[0]
    assert get_user_response.role == "response"
    assert get_user_response.class_name == "UserResponse"
    assert get_user_response.location is None
    assert get_user_response.qualified_name is not None
    assert get_user_response.qualified_name.endswith("UserResponse")
    assert "schemas" in get_user_response.qualified_name

    # create_user: request candidate for UserRequest (import-derived) AND
    # response candidate for UserResponse (import-derived)
    create_user_candidates = [c for c in result.ref_candidates if c.handler_name == "create_user"]
    assert len(create_user_candidates) == 2

    request_candidates = [c for c in create_user_candidates if c.role == "request"]
    assert len(request_candidates) == 1
    assert request_candidates[0].class_name == "UserRequest"
    assert request_candidates[0].location is None
    assert request_candidates[0].qualified_name is not None
    assert request_candidates[0].qualified_name.endswith("UserRequest")
    assert "schemas" in request_candidates[0].qualified_name

    response_candidates = [c for c in create_user_candidates if c.role == "response"]
    assert len(response_candidates) == 1
    assert response_candidates[0].class_name == "UserResponse"
    assert response_candidates[0].location is None
    assert response_candidates[0].qualified_name is not None


def test_users_has_no_class_definitions() -> None:
    module = _parse(FIXTURE_USERS)
    result = extract_schema_info(module, str(FIXTURE_USERS))

    assert result.class_definitions == []


def test_schemas_module_class_definition_registry() -> None:
    module = _parse(FIXTURE_SCHEMAS)
    result = extract_schema_info(module, str(FIXTURE_SCHEMAS))

    by_name = {c.class_name: c for c in result.class_definitions}

    assert "UserRequest" in by_name
    assert by_name["UserRequest"].base_class_names == ["BaseModel"]
    assert by_name["UserRequest"].location.line == 11

    assert "UserResponse" in by_name
    assert by_name["UserResponse"].base_class_names == ["BaseModel"]
    assert by_name["UserResponse"].location.line == 18


def test_schemas_module_has_no_ref_candidates() -> None:
    module = _parse(FIXTURE_SCHEMAS)
    result = extract_schema_info(module, str(FIXTURE_SCHEMAS))

    assert result.ref_candidates == []
