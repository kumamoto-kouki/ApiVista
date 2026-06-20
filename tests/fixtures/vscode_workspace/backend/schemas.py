"""Shared Pydantic models imported by multiple routers.

Used to exercise cross-file schema reference resolution (Requirement 2.1):
``UserRequest``/``UserResponse`` are defined here and imported into
``routers/users.py``.
"""

from pydantic import BaseModel


class UserRequest(BaseModel):
    """Request body for creating a user."""

    name: str
    email: str


class UserResponse(BaseModel):
    """Response model for a single user."""

    id: int
    name: str
    email: str
