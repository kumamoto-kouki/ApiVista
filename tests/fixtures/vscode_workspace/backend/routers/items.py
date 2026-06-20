"""Items router fixture.

Declares its own ``APIRouter(prefix="/items")``, which combines with the
"/api" prefix applied at ``include_router`` time in ``main.py`` to form the
full path "/api/items/...".

Also defines a locally-scoped request/response model (``ItemResponse``), a
route whose path argument is not a string literal (statically unresolvable,
Requirement 5.2), and a handler that calls a helper function from another
module (call-graph fixture for future tasks).
"""

from fastapi import APIRouter
from pydantic import BaseModel

from ..helpers import format_item_label

router = APIRouter(prefix="/items")

# A path segment built at import time -- NOT a string literal, so the
# decorated route below cannot have its path statically resolved.
DYNAMIC_SEGMENT = "/dynamic"


class ItemCreate(BaseModel):
    """Locally-defined request model for creating an item."""

    name: str
    price: float


class ItemResponse(BaseModel):
    """Locally-defined response model for an item."""

    id: int
    name: str
    label: str


@router.get("/{item_id}", response_model=ItemResponse)
def get_item(item_id: int) -> ItemResponse:
    """Full path resolves to /api/items/{item_id}."""

    label = format_item_label(item_id, "sample-item")
    return ItemResponse(id=item_id, name="sample-item", label=label)


@router.post("", response_model=ItemResponse)
def create_item(item: ItemCreate) -> ItemResponse:
    """Full path resolves to /api/items."""

    label = format_item_label(1, item.name)
    return ItemResponse(id=1, name=item.name, label=label)


@router.get(DYNAMIC_SEGMENT)
def get_dynamic_item() -> dict:
    """Path argument is a module-level variable, not a string literal.

    This route must be excluded from the extracted results because its path
    cannot be statically resolved (Requirement 5.2).
    """

    return {"detail": "dynamic route"}
