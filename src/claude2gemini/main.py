from fastapi import FastAPI
from contextlib import asynccontextmanager

from claude2gemini.routes.messages import router as messages_router


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield


app = FastAPI(lifespan=lifespan)
app.include_router(messages_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
