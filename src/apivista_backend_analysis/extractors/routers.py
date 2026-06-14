"""Router relation extraction (Pass1, Requirements 1.2, 1.3).

This module extracts the "router relation" intermediate representation that
the Route Path Resolver (Pass2a) consumes to compute each route's full URL
path. Three kinds of top-level constructs are recognized:

1. ``<name> = APIRouter(prefix=...)`` -- a router definition, recorded as a
   :class:`RouterDefinition` with its variable name and (best-effort) prefix
   string.
2. ``<name> = FastAPI(...)`` / ``<name> = FastAPI()`` -- a FastAPI app
   instance, recorded as a :class:`FastAPIInstance`. This is the BFS-origin
   *candidate* marker for Pass2a: each file may contain at most one such
   instance, but multiple instances across files are expected (Pass2a is
   responsible for picking the unique app-wide origin and warning otherwise).
3. ``<obj>.include_router(<router_expr>, prefix=...)`` -- an include-router
   call, recorded as an :class:`IncludeRouterCall` capturing the target
   object's variable name, a string representation of the included router
   expression (which may be a dotted attribute access for cross-file
   references, e.g. ``items.router``), and the (best-effort) prefix string.

Prefix resolution is best-effort and literal-only: if a ``prefix=`` keyword
argument is present and is a string literal (``m.SimpleString``), its
unquoted value is used. If the keyword argument is absent, or present but not
a string literal (e.g. a variable reference or f-string), the prefix is
recorded as ``""`` (empty string), matching the "no additional prefix"
semantics for the purposes of Pass2a's path concatenation. Per design.md,
this sub-extraction does not require a ``WarningCollector`` -- non-literal
prefixes are simply treated as empty rather than raising a warning.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import libcst
import libcst.matchers as m
from libcst.metadata import CodeRange, PositionProvider

from apivista_backend_analysis.models import SourceLocation


@dataclass(frozen=True)
class RouterDefinition:
    """An ``APIRouter(prefix=...)`` assignment.

    ``variable_name`` is the name the router is bound to (e.g. ``"router"``).
    ``prefix`` is the literal prefix string if statically resolvable, or
    ``""`` if no ``prefix=`` kwarg is present or it is not a string literal.
    """

    variable_name: str
    prefix: str
    location: SourceLocation


@dataclass(frozen=True)
class FastAPIInstance:
    """A ``FastAPI()`` / ``FastAPI(...)`` instance assignment.

    ``variable_name`` is the name the app instance is bound to (e.g.
    ``"app"``). This marks a BFS-origin *candidate* for Pass2a: Pass2a is
    responsible for selecting the unique instance across all files and
    warning if zero or multiple candidates are found.
    """

    variable_name: str
    location: SourceLocation


@dataclass(frozen=True)
class IncludeRouterCall:
    """An ``<obj>.include_router(<router_expr>, prefix=...)`` call.

    ``target_name`` is the variable name the call is made on (e.g.
    ``"app"``). ``router_expr`` is a string representation of the included
    router expression -- this may be a simple name (``"router"``) or a dotted
    attribute access for cross-file references (``"items.router"``).
    ``prefix`` is the literal prefix string if statically resolvable, or
    ``""`` if no ``prefix=`` kwarg is present or it is not a string literal.
    """

    target_name: str
    router_expr: str
    prefix: str
    location: SourceLocation


@dataclass(frozen=True)
class RouterExtractionResult:
    """The router relation data extracted from a single file (Pass1 output).

    This bundles all three kinds of router-relation facts found in one file.
    Pass2a aggregates these across all files to build the full relation graph
    and BFS from the unique ``FastAPIInstance`` origin.
    """

    routers: list[RouterDefinition] = field(default_factory=list)
    fastapi_instances: list[FastAPIInstance] = field(default_factory=list)
    include_router_calls: list[IncludeRouterCall] = field(default_factory=list)


#: Matcher for a top-level ``<name> = APIRouter(...)`` assignment.
_ROUTER_ASSIGN_MATCHER = m.Assign(
    targets=[m.AssignTarget(target=m.Name())],
    value=m.Call(func=m.Name(value="APIRouter")),
)

#: Matcher for a top-level ``<name> = FastAPI(...)`` assignment.
_FASTAPI_ASSIGN_MATCHER = m.Assign(
    targets=[m.AssignTarget(target=m.Name())],
    value=m.Call(func=m.Name(value="FastAPI")),
)

#: Matcher for an ``<obj>.include_router(...)`` call.
_INCLUDE_ROUTER_CALL_MATCHER = m.Call(
    func=m.Attribute(value=m.Name(), attr=m.Name(value="include_router"))
)


def extract_router_relations(
    module: libcst.Module | libcst.MetadataWrapper,
    file_path: str,
) -> RouterExtractionResult:
    """Extract router relation facts from ``module``.

    Walks top-level statements for ``APIRouter(prefix=...)`` and
    ``FastAPI(...)`` assignments, and walks all ``Call`` expressions for
    ``<obj>.include_router(<router_expr>, prefix=...)`` calls.

    ``file_path`` is used to build the ``SourceLocation.file`` of each
    extracted item.
    """

    if isinstance(module, libcst.MetadataWrapper):
        wrapper = module
    else:
        wrapper = libcst.MetadataWrapper(module)

    positions = wrapper.resolve(PositionProvider)

    result = RouterExtractionResult()
    visitor = _RouterRelationVisitor(file_path, result, positions)
    wrapper.module.visit(visitor)
    return result


class _RouterRelationVisitor(libcst.CSTVisitor):
    def __init__(
        self,
        file_path: str,
        result: RouterExtractionResult,
        positions: dict[libcst.CSTNode, CodeRange],
    ) -> None:
        self._file_path = file_path
        self._result = result
        self._positions = positions

    def _location(self, node: libcst.CSTNode) -> SourceLocation:
        line = self._positions[node].start.line
        return SourceLocation(file=self._file_path, line=line)

    def visit_Assign(self, node: libcst.Assign) -> None:
        if m.matches(node, _ROUTER_ASSIGN_MATCHER):
            target = node.targets[0].target
            assert isinstance(target, libcst.Name)
            call = node.value
            assert isinstance(call, libcst.Call)
            prefix = _resolve_prefix_kwarg(call)
            self._result.routers.append(
                RouterDefinition(
                    variable_name=target.value,
                    prefix=prefix,
                    location=self._location(node),
                )
            )
        elif m.matches(node, _FASTAPI_ASSIGN_MATCHER):
            target = node.targets[0].target
            assert isinstance(target, libcst.Name)
            self._result.fastapi_instances.append(
                FastAPIInstance(
                    variable_name=target.value,
                    location=self._location(node),
                )
            )

    def visit_Call(self, node: libcst.Call) -> None:
        if not m.matches(node, _INCLUDE_ROUTER_CALL_MATCHER):
            return

        attribute = node.func
        assert isinstance(attribute, libcst.Attribute)
        target = attribute.value
        assert isinstance(target, libcst.Name)

        if not node.args:
            return

        first_arg = node.args[0]
        if first_arg.keyword is not None:
            # First *positional* argument is missing (e.g. only kwargs given).
            return

        router_expr = libcst.Module(body=[]).code_for_node(first_arg.value)
        prefix = _resolve_prefix_kwarg(node)

        self._result.include_router_calls.append(
            IncludeRouterCall(
                target_name=target.value,
                router_expr=router_expr,
                prefix=prefix,
                location=self._location(node),
            )
        )


def _resolve_prefix_kwarg(call: libcst.Call) -> str:
    """Resolve the ``prefix=`` keyword argument of ``call`` as a literal string.

    Returns the unquoted string value if ``prefix=`` is present and is a
    string literal (``m.SimpleString``). Returns ``""`` if ``prefix=`` is
    absent, or present but not a string literal (e.g. a variable reference or
    f-string) -- non-literal prefixes are not warning-worthy per design.md's
    scope for this sub-extraction.
    """

    for arg in call.args:
        if arg.keyword is not None and arg.keyword.value == "prefix":
            if m.matches(arg, m.Arg(value=m.SimpleString())):
                string_node = arg.value
                assert isinstance(string_node, libcst.SimpleString)
                value = string_node.evaluated_value
                assert isinstance(value, str)
                return value
            return ""
    return ""
