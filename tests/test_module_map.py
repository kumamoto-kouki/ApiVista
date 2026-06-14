"""Tests for the Module Map Builder (Pass0).

``build_module_map()`` walks ``backend_root`` for ``*.py`` files and builds a
``ModuleMap`` containing the module-dotted-path <-> file-path correspondence
and the set of top-level public names exported by each module. Files that
fail to parse (syntax errors) are skipped and recorded as warnings via the
``WarningCollector`` (Requirement 5.1).

``is_internal_module()`` checks whether a given module dotted-path is part of
the analyzed ``backend_root`` tree (Requirement 3.3).
"""

from pathlib import Path

from apivista_backend_analysis.errors import WarningCollector
from apivista_backend_analysis.module_map import build_module_map, is_internal_module

FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "sample_app"


def test_module_to_path_contains_all_valid_modules() -> None:
    collector = WarningCollector()

    module_map = build_module_map(FIXTURE_ROOT, collector)

    assert module_map.module_to_path["sample_app.main"] == FIXTURE_ROOT / "main.py"
    assert module_map.module_to_path["sample_app.schemas"] == FIXTURE_ROOT / "schemas.py"
    assert module_map.module_to_path["sample_app.helpers"] == FIXTURE_ROOT / "helpers.py"
    assert (
        module_map.module_to_path["sample_app.routers.items"]
        == FIXTURE_ROOT / "routers" / "items.py"
    )
    assert (
        module_map.module_to_path["sample_app.routers.users"]
        == FIXTURE_ROOT / "routers" / "users.py"
    )


def test_init_modules_map_to_package_dunder_init_files() -> None:
    collector = WarningCollector()

    module_map = build_module_map(FIXTURE_ROOT, collector)

    assert module_map.module_to_path["sample_app"] == FIXTURE_ROOT / "__init__.py"
    assert (
        module_map.module_to_path["sample_app.routers"] == FIXTURE_ROOT / "routers" / "__init__.py"
    )


def test_broken_file_is_skipped_and_recorded_as_warning() -> None:
    collector = WarningCollector()

    module_map = build_module_map(FIXTURE_ROOT, collector)

    assert "sample_app.routers.broken" not in module_map.module_to_path
    assert len(collector.warnings) == 1
    assert "broken.py" in collector.warnings[0].target


def test_path_to_module_is_reverse_of_module_to_path() -> None:
    collector = WarningCollector()

    module_map = build_module_map(FIXTURE_ROOT, collector)

    for module_name, path in module_map.module_to_path.items():
        assert module_map.path_to_module[path] == module_name


def test_exported_names_contains_top_level_class_definitions() -> None:
    collector = WarningCollector()

    module_map = build_module_map(FIXTURE_ROOT, collector)

    schemas_exports = module_map.exported_names["sample_app.schemas"]
    assert "UserRequest" in schemas_exports
    assert "UserResponse" in schemas_exports


def test_exported_names_contains_imported_names() -> None:
    collector = WarningCollector()

    module_map = build_module_map(FIXTURE_ROOT, collector)

    users_exports = module_map.exported_names["sample_app.routers.users"]
    assert "UserRequest" in users_exports
    assert "UserResponse" in users_exports
    assert "APIRouter" in users_exports


def test_exported_names_contains_top_level_function_definitions() -> None:
    collector = WarningCollector()

    module_map = build_module_map(FIXTURE_ROOT, collector)

    helpers_exports = module_map.exported_names["sample_app.helpers"]
    assert "format_item_label" in helpers_exports


def test_is_internal_module_true_for_modules_in_map() -> None:
    collector = WarningCollector()

    module_map = build_module_map(FIXTURE_ROOT, collector)

    assert is_internal_module(module_map, "sample_app.routers.items") is True
    assert is_internal_module(module_map, "sample_app") is True


def test_is_internal_module_false_for_external_modules() -> None:
    collector = WarningCollector()

    module_map = build_module_map(FIXTURE_ROOT, collector)

    assert is_internal_module(module_map, "fastapi") is False
    assert is_internal_module(module_map, "os.path") is False
    assert is_internal_module(module_map, "json") is False
