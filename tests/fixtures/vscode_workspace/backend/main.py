"""Sample FastAPI application entrypoint used as a static-analysis fixture.

Wires together the ``items`` and ``users`` routers via ``include_router``
with a prefix, exercising the multi-file prefix chain that the route path
resolver (Pass2a) must follow.
"""

from fastapi import FastAPI

from .routers import items, users

app = FastAPI(title="Sample App")

# items router already declares prefix="/items" on its own APIRouter, and is
# mounted here under an additional "/api" prefix -> full paths become
# "/api/items/...".
app.include_router(items.router, prefix="/api")

# users router is mounted without an additional prefix here, so its full
# paths are exactly the prefix declared on its own APIRouter ("/users/...").
app.include_router(users.router)
