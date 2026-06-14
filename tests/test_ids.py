"""Tests for the ID numbering helpers in apivista_backend_analysis.ids."""

from pathlib import Path

from apivista_backend_analysis.ids import make_file_id, make_function_id


def test_make_function_id_format() -> None:
    assert make_function_id("app.api.users", "get_user") == "app.api.users:get_user"


def test_make_function_id_includes_qualname_for_nested_functions() -> None:
    function_id = make_function_id("app.api.users", "UsersRouter.get_user")

    assert function_id == "app.api.users:UsersRouter.get_user"


def test_make_function_id_is_deterministic() -> None:
    first = make_function_id("app.api.users", "get_user")
    second = make_function_id("app.api.users", "get_user")

    assert first == second


def test_make_file_id_returns_posix_relative_path(tmp_path: Path) -> None:
    backend_root = tmp_path / "backend"
    nested_file = backend_root / "app" / "api" / "users.py"
    nested_file.parent.mkdir(parents=True)
    nested_file.touch()

    file_id = make_file_id(backend_root, nested_file)

    assert file_id == "app/api/users.py"
    assert "\\" not in file_id


def test_make_file_id_is_deterministic(tmp_path: Path) -> None:
    backend_root = tmp_path / "backend"
    nested_file = backend_root / "app" / "main.py"
    nested_file.parent.mkdir(parents=True)
    nested_file.touch()

    first = make_file_id(backend_root, nested_file)
    second = make_file_id(backend_root, nested_file)

    assert first == second
    assert first == "app/main.py"


def test_make_file_id_top_level_file(tmp_path: Path) -> None:
    backend_root = tmp_path / "backend"
    backend_root.mkdir()
    top_level_file = backend_root / "main.py"
    top_level_file.touch()

    assert make_file_id(backend_root, top_level_file) == "main.py"
