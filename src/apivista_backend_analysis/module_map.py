"""Module Map Builder (Pass0).

Walks ``backend_root`` for ``*.py`` files and builds a ``ModuleMap``
containing the module-dotted-path <-> file-path correspondence and the set
of top-level public names exported by each module.

Files that fail to parse (``libcst.ParserSyntaxError`` or
``UnicodeDecodeError``) are skipped and recorded as warnings via the
``WarningCollector`` (Requirement 5.1). The resulting ``ModuleMap`` is the
basis for the module-dotted-path inputs to ``ids.make_function_id()`` used
by later passes, and ``is_internal_module()`` is used by the Call Graph
Builder (Requirement 3.3) to decide whether a call target is inside
``backend/`` (Requirement 6.1).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import libcst

from apivista_backend_analysis.errors import WarningCollector


@dataclass
class ModuleMap:
    """Internal Pass0 result: module <-> file mapping and exported names.

    Attributes:
        module_to_path: Module dotted-path -> file path (relative to
            ``backend_root``, e.g. ``"sample_app.routers.items"`` ->
            ``Path("sample_app/routers/items.py")`` when constructed with a
            relative ``backend_root``, or an absolute path when constructed
            with an absolute ``backend_root``).
        path_to_module: Reverse of ``module_to_path``.
        exported_names: Module dotted-path -> set of top-level public names
            (function defs, class defs, and names bound by top-level
            ``import``/``from ... import`` statements) defined or imported
            by that module.
    """

    module_to_path: dict[str, Path] = field(default_factory=dict)
    path_to_module: dict[Path, str] = field(default_factory=dict)
    exported_names: dict[str, set[str]] = field(default_factory=dict)

    def is_internal_module(self, module_name: str) -> bool:
        """Return whether ``module_name`` is part of the analyzed tree."""
        return is_internal_module(self, module_name)


def _module_name_for_path(relative_path: Path) -> str:
    """Compute the dotted module name for ``relative_path``.

    ``relative_path`` is relative to ``backend_root``. ``__init__.py`` files
    map to their containing package's dotted name (not ``<pkg>.__init__``).
    """
    parts = list(relative_path.with_suffix("").parts)
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _collect_exported_names(module: libcst.Module) -> set[str]:
    """Collect top-level function/class definitions and imported names."""
    names: set[str] = set()

    for statement in module.body:
        if isinstance(statement, libcst.ClassDef):
            names.add(statement.name.value)
        elif isinstance(statement, libcst.FunctionDef):
            names.add(statement.name.value)
        elif isinstance(statement, libcst.SimpleStatementLine):
            for small_stmt in statement.body:
                if isinstance(small_stmt, libcst.Import):
                    for import_alias in small_stmt.names:
                        names.add(_imported_binding_name(import_alias))
                elif isinstance(small_stmt, libcst.ImportFrom):
                    if isinstance(small_stmt.names, libcst.ImportStar):
                        continue
                    for import_alias in small_stmt.names:
                        names.add(_imported_binding_name(import_alias))

    return names


def _imported_binding_name(import_alias: libcst.ImportAlias) -> str:
    """Return the local binding name introduced by an import alias."""
    if import_alias.asname is not None:
        target = import_alias.asname.name
        if isinstance(target, libcst.Name):
            return target.value
    # No alias: for "import a.b.c" the bound name is "a"; for
    # "from x import name" the bound name is "name".
    name_node = import_alias.name
    if isinstance(name_node, libcst.Attribute):
        node: libcst.BaseExpression = name_node
        while isinstance(node, libcst.Attribute):
            node = node.value
        if isinstance(node, libcst.Name):
            return node.value
        return ""
    if isinstance(name_node, libcst.Name):
        return name_node.value
    return ""


def build_module_map(backend_root: Path, collector: WarningCollector) -> ModuleMap:
    """Walk ``backend_root`` and build the ``ModuleMap`` for Pass0.

    Args:
        backend_root: Root directory of the analyzed ``backend/`` tree.
        collector: Error and Warning Collector used to record files that
            fail to parse (skipped, Requirement 5.1).

    Returns:
        A ``ModuleMap`` with ``module_to_path``, ``path_to_module``, and
        ``exported_names`` populated for all successfully-parsed ``*.py``
        files under ``backend_root``. The dotted module names use
        ``backend_root``'s own top-level directory name as the package root
        (e.g. ``"sample_app.routers.items"``), consistent with the inputs
        expected by ``ids.make_function_id()``.
    """
    module_map = ModuleMap()
    package_root_name = backend_root.name

    for file_path in sorted(backend_root.rglob("*.py")):
        relative_to_root = file_path.relative_to(backend_root)
        relative_with_package = Path(package_root_name) / relative_to_root
        module_name = _module_name_for_path(relative_with_package)

        try:
            source = file_path.read_bytes()
            module = libcst.parse_module(source)
        except (libcst.ParserSyntaxError, UnicodeDecodeError) as error:
            collector.record_parse_error(str(file_path), error)
            continue

        module_map.module_to_path[module_name] = file_path
        module_map.path_to_module[file_path] = module_name
        module_map.exported_names[module_name] = _collect_exported_names(module)

    return module_map


def is_internal_module(module_map: ModuleMap, module_name: str) -> bool:
    """Return whether ``module_name`` is part of the analyzed tree.

    A module is considered internal if it (or one of its ancestor packages)
    is present in ``module_map.module_to_path``. External modules (e.g.
    ``"fastapi"``, ``"os.path"``, ``"json"``) return ``False``.
    """
    if module_name in module_map.module_to_path:
        return True

    parts = module_name.split(".")
    for i in range(len(parts) - 1, 0, -1):
        ancestor = ".".join(parts[:i])
        if ancestor in module_map.module_to_path:
            return True

    return False
