"""Schema reference candidate and class definition registry extraction.

(Pass1, Requirement 2.1)

This module produces two kinds of intermediate data, consumed by Pass2c
(a later task):

1. :class:`SchemaRefCandidate` -- for each route-handler ``FunctionDef``
   (recognized via the same HTTP-method decorator shape as
   :mod:`apivista_backend_analysis.extractors.routes`), each parameter
   annotation (``role="request"``) and the return annotation
   (``role="response"``) is resolved via ``ScopeProvider``:

   - If the annotated name resolves to a class defined in *this* file (an
     ``Assignment`` whose ``node`` is a ``ClassDef``), the candidate records
     ``class_name`` and ``location`` (the ``class`` line), with
     ``qualified_name=None``.
   - If the annotated name resolves to an ``ImportAssignment`` (imported from
     another module), the candidate records ``class_name`` and a
     ``qualified_name`` built from the import's module path (e.g.
     ``"..schemas.UserResponse"`` for ``from ..schemas import UserResponse``),
     with ``location=None``. Final resolution of the import to a definition
     location is deferred to Pass2c, which aggregates ``ClassDefinition``
     registries across all files.
   - Builtin types (``int``, ``str``, ``float``, ``bool``, ``dict``, ``list``,
     ``None``, etc. -- anything resolving to a ``BuiltinAssignment``) and
     unannotated parameters/returns do NOT produce a candidate.

   Multiple request-model parameters each produce a separate
   ``role="request"`` candidate.

   CONCERN (heuristic): this task does not perform ``BaseModel`` inheritance
   checking (deferred to Pass2c, since it may require cross-file/transitive
   checks). Any annotation that resolves to a local class definition or an
   import (and is not a recognized builtin) produces a candidate. This may
   over-produce candidates for non-Pydantic classes/imports used as type
   annotations; Pass2c is expected to filter these by checking ``BaseModel``
   inheritance via the aggregated ``ClassDefinition`` registry.

2. :class:`ClassDefinition` -- for each top-level ``ClassDef`` in the file,
   records the class name, the base class names as written (e.g.
   ``"BaseModel"``), and the definition location (the ``class`` line).
   Pass2c aggregates these across all files into an index used to resolve
   import-derived schema reference candidates to their definitions.

CONCERN (route-handler filtering): per design.md, schema reference candidates
are specifically about route handlers ("ハンドラの引数アノテーション"). This
module reuses the same ``_ROUTE_DECORATOR_MATCHER`` shape as
:mod:`apivista_backend_analysis.extractors.routes` to identify route handlers,
so non-handler functions (e.g. helper functions) do not produce candidates.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import libcst
import libcst.matchers as m
from libcst.metadata import CodeRange, PositionProvider, ScopeProvider
from libcst.metadata.scope_provider import Assignment, BuiltinAssignment, ImportAssignment

from apivista_backend_analysis.extractors.routes import _ROUTE_DECORATOR_MATCHER
from apivista_backend_analysis.models import SourceLocation


@dataclass(frozen=True)
class SchemaRefCandidate:
    """A candidate request/response schema reference found on a route handler.

    Exactly one of ``(location, qualified_name)`` is populated:

    - For a LOCAL definition (the annotated class is defined in the same
      file, resolved via ``ScopeProvider`` to a ``ClassDef``), ``location``
      is the source position of the ``class`` line and ``qualified_name`` is
      ``None``.
    - For an IMPORT-derived type (resolved via ``ScopeProvider`` to an
      ``ImportAssignment``), ``qualified_name`` is a string built from the
      import's module path and the class name (e.g.
      ``"..schemas.UserResponse"``), and ``location`` is ``None``. Pass2c is
      responsible for resolving this qualified name to a definition location
      using the aggregated ``ClassDefinition`` registry.
    """

    role: Literal["request", "response"]
    class_name: str
    handler_name: str
    handler_location: SourceLocation
    location: SourceLocation | None = None
    qualified_name: str | None = None


@dataclass(frozen=True)
class ClassDefinition:
    """A top-level class definition collected for the Pass2c schema registry."""

    class_name: str
    base_class_names: list[str]
    location: SourceLocation


@dataclass(frozen=True)
class SchemaExtractionResult:
    """The result of :func:`extract_schema_info` for a single file."""

    ref_candidates: list[SchemaRefCandidate] = field(default_factory=list)
    class_definitions: list[ClassDefinition] = field(default_factory=list)


def extract_schema_info(
    module: libcst.Module | libcst.MetadataWrapper,
    file_path: str,
) -> SchemaExtractionResult:
    """Extract schema reference candidates and the class definition registry.

    Walks route-handler ``FunctionDef`` nodes (matching the HTTP-method
    decorator shape from :mod:`apivista_backend_analysis.extractors.routes`)
    to produce :class:`SchemaRefCandidate` entries for parameter/return type
    annotations, and walks top-level ``ClassDef`` nodes to produce
    :class:`ClassDefinition` registry entries.

    ``file_path`` is used to build ``SourceLocation.file`` for all locations.
    """

    if isinstance(module, libcst.MetadataWrapper):
        wrapper = module
    else:
        wrapper = libcst.MetadataWrapper(module)

    positions = wrapper.resolve(PositionProvider)
    scopes = wrapper.resolve(ScopeProvider)

    ref_candidates: list[SchemaRefCandidate] = []
    class_definitions: list[ClassDefinition] = []

    visitor = _SchemaVisitor(
        file_path=file_path,
        positions=positions,
        scopes=scopes,
        ref_candidates=ref_candidates,
        class_definitions=class_definitions,
    )
    wrapper.module.visit(visitor)

    return SchemaExtractionResult(
        ref_candidates=ref_candidates,
        class_definitions=class_definitions,
    )


class _SchemaVisitor(libcst.CSTVisitor):
    def __init__(
        self,
        file_path: str,
        positions: dict[libcst.CSTNode, CodeRange],
        scopes: dict[libcst.CSTNode, object],
        ref_candidates: list[SchemaRefCandidate],
        class_definitions: list[ClassDefinition],
    ) -> None:
        self._file_path = file_path
        self._positions = positions
        self._scopes = scopes
        self._ref_candidates = ref_candidates
        self._class_definitions = class_definitions

    def visit_ClassDef(self, node: libcst.ClassDef) -> None:
        line = self._positions[node].start.line
        location = SourceLocation(file=self._file_path, line=line)
        base_names = [
            name for base in node.bases if (name := _expression_to_name(base.value)) is not None
        ]
        self._class_definitions.append(
            ClassDefinition(
                class_name=node.name.value,
                base_class_names=base_names,
                location=location,
            )
        )

    def visit_FunctionDef(self, node: libcst.FunctionDef) -> None:
        if not _is_route_handler(node):
            return

        handler_name = node.name.value
        handler_line = self._positions[node].start.line
        handler_location = SourceLocation(file=self._file_path, line=handler_line)

        for param in node.params.params:
            candidate = self._resolve_annotation(
                annotation=param.annotation,
                role="request",
                handler_name=handler_name,
                handler_location=handler_location,
            )
            if candidate is not None:
                self._ref_candidates.append(candidate)

        candidate = self._resolve_annotation(
            annotation=node.returns,
            role="response",
            handler_name=handler_name,
            handler_location=handler_location,
        )
        if candidate is not None:
            self._ref_candidates.append(candidate)

    def _resolve_annotation(
        self,
        annotation: libcst.Annotation | None,
        role: Literal["request", "response"],
        handler_name: str,
        handler_location: SourceLocation,
    ) -> SchemaRefCandidate | None:
        if annotation is None:
            return None

        ann_node = annotation.annotation
        if not isinstance(ann_node, libcst.Name):
            # Attribute access (e.g. `module.Type`), subscripted generics
            # (e.g. `list[Foo]`, `Optional[Foo]`), and other compound
            # annotation shapes are not resolved by this heuristic.
            return None

        class_name = ann_node.value
        scope = self._scopes.get(ann_node)
        if scope is None:
            return None

        assignments = scope[class_name]
        for assignment in assignments:
            if isinstance(assignment, BuiltinAssignment):
                # Builtins (int, str, dict, None, ...) are never schema refs.
                return None

            if isinstance(assignment, ImportAssignment):
                module_name = assignment.get_module_name_for_import()
                qualified_name = f"{module_name}.{class_name}"
                return SchemaRefCandidate(
                    role=role,
                    class_name=class_name,
                    handler_name=handler_name,
                    handler_location=handler_location,
                    qualified_name=qualified_name,
                )

            if isinstance(assignment, Assignment):
                target = assignment.node
                if isinstance(target, libcst.ClassDef):
                    location = SourceLocation(
                        file=self._file_path,
                        line=self._positions[target].start.line,
                    )
                    return SchemaRefCandidate(
                        role=role,
                        class_name=class_name,
                        handler_name=handler_name,
                        handler_location=handler_location,
                        location=location,
                    )
                # Resolved to a non-class local assignment (e.g. a variable
                # or function) -- not a schema reference candidate.
                return None

        return None


def _is_route_handler(node: libcst.FunctionDef) -> bool:
    """Return True if ``node`` has a decorator matching the route-decorator shape."""

    return any(m.matches(decorator, _ROUTE_DECORATOR_MATCHER) for decorator in node.decorators)


def _expression_to_name(expr: libcst.BaseExpression) -> str | None:
    """Return a simple string representation of a base-class expression.

    Handles ``Name`` (e.g. ``BaseModel``) and ``Attribute`` (e.g.
    ``module.BaseModel``, rendered as ``"module.BaseModel"``). Other
    expression shapes (e.g. subscripted generics) return ``None``.
    """

    if isinstance(expr, libcst.Name):
        return expr.value
    if isinstance(expr, libcst.Attribute):
        prefix = _expression_to_name(expr.value)
        if prefix is None:
            return None
        return f"{prefix}.{expr.attr.value}"
    return None
