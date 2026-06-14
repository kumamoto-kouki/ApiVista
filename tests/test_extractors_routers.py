"""Tests for router relation extraction (Pass1, Requirements 1.2, 1.3)."""

from __future__ import annotations

from pathlib import Path

import libcst

from apivista_backend_analysis.extractors.routers import extract_router_relations

FIXTURES = Path(__file__).parent / "fixtures" / "sample_app"


def _parse(path: Path) -> libcst.Module:
    return libcst.parse_module(path.read_text())


def test_main_app_has_fastapi_instance_and_include_router_calls() -> None:
    file_path = "main.py"
    module = _parse(FIXTURES / "main.py")

    result = extract_router_relations(module, file_path)

    assert len(result.fastapi_instances) == 1
    fastapi_instance = result.fastapi_instances[0]
    assert fastapi_instance.variable_name == "app"
    assert fastapi_instance.location.file == file_path
    assert fastapi_instance.location.line > 0

    assert len(result.include_router_calls) == 2

    by_router_expr = {call.router_expr: call for call in result.include_router_calls}

    items_call = by_router_expr["items.router"]
    assert items_call.target_name == "app"
    assert items_call.prefix == "/api"
    assert items_call.location.file == file_path
    assert items_call.location.line > 0

    users_call = by_router_expr["users.router"]
    assert users_call.target_name == "app"
    assert users_call.prefix == ""
    assert users_call.location.file == file_path
    assert users_call.location.line > 0

    assert result.routers == []


def test_items_router_definition() -> None:
    file_path = "routers/items.py"
    module = _parse(FIXTURES / "routers" / "items.py")

    result = extract_router_relations(module, file_path)

    assert len(result.routers) == 1
    router_def = result.routers[0]
    assert router_def.variable_name == "router"
    assert router_def.prefix == "/items"
    assert router_def.location.file == file_path
    assert router_def.location.line > 0

    assert result.fastapi_instances == []
    assert result.include_router_calls == []


def test_users_router_definition() -> None:
    file_path = "routers/users.py"
    module = _parse(FIXTURES / "routers" / "users.py")

    result = extract_router_relations(module, file_path)

    assert len(result.routers) == 1
    router_def = result.routers[0]
    assert router_def.variable_name == "router"
    assert router_def.prefix == "/users"
    assert router_def.location.file == file_path
    assert router_def.location.line > 0
