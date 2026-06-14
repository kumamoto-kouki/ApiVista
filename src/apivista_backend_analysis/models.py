"""Output models for the Backend Route Extractor.

This module defines the Pydantic v2 models that make up the
``AnalysisOutput`` schema, including ``schemaVersion``. All models use
``extra="forbid"`` so that unexpected fields fail validation rather than
being silently dropped.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict

SCHEMA_VERSION = 1


class SourceLocation(BaseModel):
    """A position in source code, expressed as a relative file path and line number."""

    model_config = ConfigDict(extra="forbid")

    file: str
    line: int


class SchemaReference(BaseModel):
    """A reference to a Pydantic model used as a request or response schema."""

    model_config = ConfigDict(extra="forbid")

    className: str
    location: SourceLocation
    role: Literal["request", "response"]


class RouteDefinition(BaseModel):
    """A single FastAPI route definition with its resolved full path and handler."""

    model_config = ConfigDict(extra="forbid")

    method: str
    path: str
    handler: SourceLocation
    entryFunctionId: str
    schemaRefs: list[SchemaReference] = []


class FunctionNode(BaseModel):
    """A function-level node in the call graph."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    file: str
    location: SourceLocation
    calls: list[str] = []


class FileNode(BaseModel):
    """A file-level node in the dependency graph."""

    model_config = ConfigDict(extra="forbid")

    id: str
    path: str
    dependsOn: list[str] = []


class Warning(BaseModel):
    """A warning describing a file or route excluded from the analysis result."""

    model_config = ConfigDict(extra="forbid")

    target: str
    reason: str


class AnalysisOutput(BaseModel):
    """The top-level output of the Backend Route Extractor."""

    model_config = ConfigDict(extra="forbid")

    schemaVersion: int = SCHEMA_VERSION
    routes: list[RouteDefinition] = []
    functions: list[FunctionNode] = []
    files: list[FileNode] = []
    warnings: list[Warning] = []
