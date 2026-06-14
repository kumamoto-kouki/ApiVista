"""Tests for output models defined in apivista_backend_analysis.models."""

import pytest
from pydantic import ValidationError

from apivista_backend_analysis.models import (
    AnalysisOutput,
    FileNode,
    FunctionNode,
    RouteDefinition,
    SchemaReference,
    SourceLocation,
    Warning,
)


def test_analysis_output_json_schema_is_valid() -> None:
    schema = AnalysisOutput.model_json_schema()

    assert isinstance(schema, dict)
    assert "properties" in schema
    properties = schema["properties"]
    for field in ("schemaVersion", "routes", "functions", "files", "warnings"):
        assert field in properties


def test_analysis_output_defaults() -> None:
    output = AnalysisOutput()

    assert output.schemaVersion == 1
    assert output.routes == []
    assert output.functions == []
    assert output.files == []
    assert output.warnings == []


def test_analysis_output_forbids_extra_fields() -> None:
    with pytest.raises(ValidationError):
        AnalysisOutput(unexpectedField="boom")


def test_source_location_forbids_extra_fields() -> None:
    with pytest.raises(ValidationError):
        SourceLocation(file="app/main.py", line=1, extra="boom")


def test_schema_reference_role_accepts_request_and_response() -> None:
    request_ref = SchemaReference(
        className="UserRequest",
        location=SourceLocation(file="app/schemas.py", line=10),
        role="request",
    )
    response_ref = SchemaReference(
        className="UserResponse",
        location=SourceLocation(file="app/schemas.py", line=20),
        role="response",
    )

    assert request_ref.role == "request"
    assert response_ref.role == "response"


def test_schema_reference_role_rejects_invalid_value() -> None:
    with pytest.raises(ValidationError):
        SchemaReference(
            className="UserRequest",
            location=SourceLocation(file="app/schemas.py", line=10),
            role="invalid",
        )


def test_route_definition_defaults_schema_refs_to_empty_list() -> None:
    route = RouteDefinition(
        method="GET",
        path="/users/{id}",
        handler=SourceLocation(file="app/api/users.py", line=42),
        entryFunctionId="app.api.users:get_user",
    )

    assert route.schemaRefs == []


def test_function_node_defaults_calls_to_empty_list() -> None:
    function = FunctionNode(
        id="app.api.users:get_user",
        name="get_user",
        file="app/api/users.py",
        location=SourceLocation(file="app/api/users.py", line=42),
    )

    assert function.calls == []


def test_file_node_defaults_depends_on_to_empty_list() -> None:
    file_node = FileNode(id="app/api/users.py", path="app/api/users.py")

    assert file_node.dependsOn == []


def test_warning_requires_target_and_reason() -> None:
    warning = Warning(target="app/api/users.py", reason="syntax error")

    assert warning.target == "app/api/users.py"
    assert warning.reason == "syntax error"


def test_analysis_output_with_full_data_round_trips_through_json() -> None:
    output = AnalysisOutput(
        routes=[
            RouteDefinition(
                method="GET",
                path="/users/{id}",
                handler=SourceLocation(file="app/api/users.py", line=42),
                entryFunctionId="app.api.users:get_user",
                schemaRefs=[
                    SchemaReference(
                        className="UserResponse",
                        location=SourceLocation(file="app/schemas.py", line=5),
                        role="response",
                    )
                ],
            )
        ],
        functions=[
            FunctionNode(
                id="app.api.users:get_user",
                name="get_user",
                file="app/api/users.py",
                location=SourceLocation(file="app/api/users.py", line=42),
                calls=["app.services.users:fetch_user"],
            )
        ],
        files=[
            FileNode(
                id="app/api/users.py", path="app/api/users.py", dependsOn=["app/services/users.py"]
            )
        ],
        warnings=[Warning(target="app/api/legacy.py", reason="syntax error")],
    )

    dumped = output.model_dump_json()
    restored = AnalysisOutput.model_validate_json(dumped)

    assert restored == output
