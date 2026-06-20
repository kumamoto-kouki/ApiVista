"""Intentionally invalid Python source.

Used to exercise Requirement 5.1 (a file with a syntax error is skipped, and
the skip is recorded as a warning, while other files continue to be
analyzed). This file is never imported by other fixture files.
"""

from fastapi import APIRouter

router = APIRouter(prefix="/broken")


@router.get("/oops"
def broken_handler(:
    return {"this": "is not valid python"}
