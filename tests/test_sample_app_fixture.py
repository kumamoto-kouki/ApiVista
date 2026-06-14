"""Tests asserting the structural integrity of the `sample_app` fixture.

`tests/fixtures/sample_app/` is a small multi-file FastAPI sample app used as
the test subject for later module-map/route/schema/call-graph extraction
tasks and the CLI end-to-end test. This test only validates the fixture's
own observable completion criteria:

- Every `.py` file under the fixture, except the intentionally-broken
  `routers/broken.py`, parses successfully with `libcst.parse_module()`.
- `routers/broken.py` exists and raises `libcst.ParserSyntaxError` when
  parsed, exercising Requirement 5.1 (syntax-error files are skipped with a
  warning by later tasks).
- The fixture contains the expected building blocks referenced by
  requirements 1.2, 1.3, 2.1, and 5.2: an `include_router(..., prefix=...)`
  chain, an `APIRouter(prefix=...)`, a `FastAPI()` instance, Pydantic
  `BaseModel` subclasses (local and cross-file), and a route with a
  statically-unresolvable path.
"""

from pathlib import Path

import libcst
import pytest

FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "sample_app"
BROKEN_FILE = FIXTURE_ROOT / "routers" / "broken.py"


def _all_python_files() -> list[Path]:
    return sorted(FIXTURE_ROOT.rglob("*.py"))


def test_fixture_contains_expected_files() -> None:
    expected = {
        FIXTURE_ROOT / "main.py",
        FIXTURE_ROOT / "schemas.py",
        FIXTURE_ROOT / "helpers.py",
        FIXTURE_ROOT / "routers" / "items.py",
        FIXTURE_ROOT / "routers" / "users.py",
        BROKEN_FILE,
    }
    actual = set(_all_python_files())

    assert expected.issubset(actual)


def test_broken_file_exists_and_is_outside_the_parseable_set() -> None:
    assert BROKEN_FILE.exists()

    parseable_files = [p for p in _all_python_files() if p != BROKEN_FILE]

    assert BROKEN_FILE not in parseable_files
    assert len(parseable_files) >= 5


@pytest.mark.parametrize(
    "path",
    [p for p in _all_python_files() if p != BROKEN_FILE],
    ids=lambda p: str(p.relative_to(FIXTURE_ROOT)),
)
def test_non_broken_files_parse_with_libcst(path: Path) -> None:
    source = path.read_bytes()

    module = libcst.parse_module(source)

    assert isinstance(module, libcst.Module)


def test_broken_file_raises_parser_syntax_error() -> None:
    source = BROKEN_FILE.read_bytes()

    with pytest.raises(libcst.ParserSyntaxError):
        libcst.parse_module(source)


def test_fixture_contains_prefix_chain_via_include_router() -> None:
    main_source = (FIXTURE_ROOT / "main.py").read_text()

    assert "include_router" in main_source
    assert "prefix=" in main_source
    assert "FastAPI(" in main_source


def test_fixture_contains_router_with_prefix() -> None:
    items_source = (FIXTURE_ROOT / "routers" / "items.py").read_text()
    users_source = (FIXTURE_ROOT / "routers" / "users.py").read_text()

    assert "APIRouter(prefix=" in items_source
    assert "APIRouter(prefix=" in users_source


def test_fixture_contains_local_and_cross_file_pydantic_models() -> None:
    items_source = (FIXTURE_ROOT / "routers" / "items.py").read_text()
    users_source = (FIXTURE_ROOT / "routers" / "users.py").read_text()
    schemas_source = (FIXTURE_ROOT / "schemas.py").read_text()

    # Locally-defined model used as request/response in the same file.
    assert "class ItemResponse(BaseModel)" in items_source
    assert "response_model=ItemResponse" in items_source

    # Cross-file models defined in schemas.py and imported into users.py.
    assert "class UserRequest(BaseModel)" in schemas_source
    assert "class UserResponse(BaseModel)" in schemas_source
    assert "from ..schemas import UserRequest, UserResponse" in users_source
    assert "response_model=UserResponse" in users_source


def test_fixture_contains_statically_unresolvable_route_path() -> None:
    items_source = (FIXTURE_ROOT / "routers" / "items.py").read_text()

    assert "DYNAMIC_SEGMENT" in items_source
    assert "@router.get(DYNAMIC_SEGMENT)" in items_source
