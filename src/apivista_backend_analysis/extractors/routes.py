"""Route decorator extraction (Pass1, Requirements 1.1, 1.4, 5.2, 5.3).

Extraction happens in two stages:

1. **Decorator shape check** -- a decorator is recognized as a "route
   candidate" only if it is an attribute-call whose attribute name matches an
   HTTP method (``get``/``post``/``put``/``delete``/``patch``), e.g.
   ``@router.get(...)`` or ``@app.post(...)``. Programmatic registration
   (``add_api_route`` etc.) and any other decorator shape are not matched by
   this check at all, and are silently ignored -- this satisfies
   Requirement 1.4.

2. **Path argument resolution** -- for a recognized route-candidate
   decorator, the first positional argument of the call is inspected. If it
   is a string literal (``m.SimpleString``), the quotes/prefix are stripped
   and the resulting string becomes the ``RouteCandidate.path``. Otherwise
   (no argument, a variable reference, an f-string, a call expression, etc.)
   no ``RouteCandidate`` is produced; instead a warning is recorded via the
   ``WarningCollector`` noting that the path could not be statically resolved
   (Requirements 5.2, 5.3).
"""

from __future__ import annotations

from dataclasses import dataclass

import libcst
import libcst.matchers as m
from libcst.metadata import CodeRange, PositionProvider

from apivista_backend_analysis.errors import WarningCollector
from apivista_backend_analysis.models import SourceLocation

#: HTTP method names recognized as route-decorator attributes.
_HTTP_METHODS = frozenset({"get", "post", "put", "delete", "patch"})

#: Matcher for a recognized route-candidate decorator shape:
#: ``@<obj>.<method>(...)`` where ``<method>`` is an HTTP method name.
_ROUTE_DECORATOR_MATCHER = m.Decorator(
    decorator=m.Call(
        func=m.Attribute(attr=m.Name(value=m.MatchIfTrue(lambda value: value in _HTTP_METHODS)))
    )
)


@dataclass(frozen=True)
class RouteCandidate:
    """A route decorator whose path argument was statically resolved.

    ``location`` is the source position of the decorated function definition
    (the ``def`` line of the handler), expressed file-relative as a
    ``SourceLocation``.
    """

    method: str
    path: str
    handler_name: str
    location: SourceLocation


@dataclass(frozen=True)
class UnresolvedRouteCandidate:
    """A recognized route decorator whose path argument could not be resolved.

    Documents the shape that was recognized as a route candidate (matching
    the HTTP-method-attribute-call decorator shape) but whose first argument
    was not a string literal, so no full ``RouteCandidate`` could be built.
    A corresponding warning is recorded via the ``WarningCollector``.
    """

    method: str
    handler_name: str
    location: SourceLocation


def extract_route_candidates(
    module: libcst.Module | libcst.MetadataWrapper,
    file_path: str,
    collector: WarningCollector,
) -> list[RouteCandidate]:
    """Extract ``RouteCandidate``s from ``module``'s function definitions.

    Walks all ``FunctionDef`` nodes (top-level or nested) and, for each
    decorator matching the HTTP-method attribute-call shape, attempts to
    resolve the decorator's first positional argument as a string literal
    path. Resolved candidates are returned; unresolved ones are recorded as
    warnings via ``collector`` and excluded from the returned list.

    ``file_path`` is used to build the ``SourceLocation.file`` of each
    candidate and the ``target`` of any recorded warnings.
    """

    if isinstance(module, libcst.MetadataWrapper):
        wrapper = module
    else:
        wrapper = libcst.MetadataWrapper(module)

    positions = wrapper.resolve(PositionProvider)

    candidates: list[RouteCandidate] = []
    visitor = _RouteDecoratorVisitor(file_path, collector, candidates, positions)
    wrapper.module.visit(visitor)
    return candidates


class _RouteDecoratorVisitor(libcst.CSTVisitor):
    def __init__(
        self,
        file_path: str,
        collector: WarningCollector,
        candidates: list[RouteCandidate],
        positions: dict[libcst.CSTNode, CodeRange],
    ) -> None:
        self._file_path = file_path
        self._collector = collector
        self._candidates = candidates
        self._positions = positions

    def visit_FunctionDef(self, node: libcst.FunctionDef) -> None:
        handler_name = node.name.value
        line = self._positions[node].start.line
        location = SourceLocation(file=self._file_path, line=line)

        for decorator in node.decorators:
            if not m.matches(decorator, _ROUTE_DECORATOR_MATCHER):
                continue

            call = decorator.decorator
            assert isinstance(call, libcst.Call)
            attribute = call.func
            assert isinstance(attribute, libcst.Attribute)
            method = attribute.attr.value

            path = _resolve_path_argument(call)
            if path is not None:
                self._candidates.append(
                    RouteCandidate(
                        method=method,
                        path=path,
                        handler_name=handler_name,
                        location=location,
                    )
                )
            else:
                self._collector.record(
                    target=f"{self._file_path}:{handler_name}",
                    reason=(
                        f"Route path for handler '{handler_name}' "
                        f"(@{method}) could not be statically resolved"
                    ),
                )


def _resolve_path_argument(call: libcst.Call) -> str | None:
    """Resolve the first positional argument of ``call`` as a literal path.

    Returns the path string (quotes/prefix stripped) if the first argument is
    a ``m.SimpleString``, or ``None`` if there is no argument or the argument
    is not a string literal (variable reference, f-string, call expression,
    etc.).
    """

    if not call.args:
        return None

    first_arg = call.args[0]
    if first_arg.keyword is not None:
        # First *positional* argument is missing (e.g. only kwargs given).
        return None

    if not m.matches(first_arg, m.Arg(value=m.SimpleString())):
        return None

    string_node = first_arg.value
    assert isinstance(string_node, libcst.SimpleString)
    value = string_node.evaluated_value
    assert isinstance(value, str)
    return value
