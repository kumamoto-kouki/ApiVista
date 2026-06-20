"""Helper utilities shared by route handlers.

Provides a plain function (``format_item_label``) that a handler in
``routers/items.py`` calls, to give the call-graph builder (Requirement 3.1)
something to extract. It also calls a stdlib function (``json.dumps``), which
is outside of ``backend/`` and should be treated as a terminal call
(Requirement 3.3) by later tasks.
"""

import json


def format_item_label(item_id: int, name: str) -> str:
    """Return a human-readable label for an item, built via stdlib json."""

    return json.dumps({"id": item_id, "name": name})
