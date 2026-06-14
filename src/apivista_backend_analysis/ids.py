"""ID numbering helpers shared across all analysis passes.

All function IDs and file IDs in the output of the Backend Route Extractor
must be derived through the helpers in this module so that IDs produced by
different passes (Pass1, Pass2a, Pass2b, Pass2c) refer to the same entity
consistently.
"""

from pathlib import Path


def make_function_id(module_dotted_path: str, qualname: str) -> str:
    """Return the canonical ID for a function or method.

    Args:
        module_dotted_path: The dotted module path of the file the function
            is defined in (e.g. ``"app.api.users"``), as determined by the
            Module Map Builder (Pass0).
        qualname: The qualified name of the function within its module,
            including any enclosing class/function scopes
            (e.g. ``"UsersRouter.get_user"``), used to disambiguate
            same-named functions defined in different scopes.

    Returns:
        A string of the form ``"<module-dotted-path>:<qualname>"``,
        e.g. ``"app.api.users:get_user"``.
    """
    return f"{module_dotted_path}:{qualname}"


def make_file_id(backend_root: Path, file_path: Path) -> str:
    """Return the canonical ID for a file, as a POSIX-style relative path.

    The returned value is used both as ``FileNode.id`` and as the
    ``file`` field of ``FunctionNode``/``SourceLocation``, so that all
    references to the same file use an identical string regardless of the
    operating system path separator.

    Args:
        backend_root: The root directory of the analyzed ``backend/``
            directory, as determined by the Module Map Builder (Pass0).
        file_path: An absolute (or otherwise resolvable) path to a file
            within ``backend_root``.

    Returns:
        The path of ``file_path`` relative to ``backend_root``, expressed
        using ``/`` as the path separator regardless of platform
        (e.g. ``"app/api/users.py"``).

    Raises:
        ValueError: If ``file_path`` is not located within ``backend_root``.
    """
    relative_path = file_path.relative_to(backend_root)
    return relative_path.as_posix()
