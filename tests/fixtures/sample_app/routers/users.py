"""Users router fixture.

Declares its own ``APIRouter(prefix="/users")`` and is included into the app
in ``main.py`` without an additional prefix, so its full paths are exactly
"/users/...".

Imports ``UserRequest``/``UserResponse`` from the separate ``schemas`` module
to exercise cross-file schema reference resolution (Requirement 2.1).
"""

from fastapi import APIRouter

from ..schemas import UserRequest, UserResponse

router = APIRouter(prefix="/users")


@router.get("/{user_id}", response_model=UserResponse)
def get_user(user_id: int) -> UserResponse:
    """Full path resolves to /users/{user_id}."""

    return UserResponse(id=user_id, name="sample-user", email="user@example.com")


@router.post("", response_model=UserResponse)
def create_user(user: UserRequest) -> UserResponse:
    """Full path resolves to /users."""

    return UserResponse(id=1, name=user.name, email=user.email)
