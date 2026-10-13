import json
import os
import time
from collections import deque
from math import ceil
from pathlib import Path
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request as FastAPIRequest
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

APP_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(APP_ROOT / ".env")

app = FastAPI(title="Nudge AI API", docs_url=None, redoc_url=None)


class PlanRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=25000)


# Best-effort per-process limit for a public demo. Use a shared limiter/API gateway
# when running multiple workers or deploying a production service.
RATE_LIMIT_REQUESTS = 10
RATE_LIMIT_WINDOW_SECONDS = 60
_rate_buckets: dict[str, deque[float]] = {}
_rate_lock = Lock()


def _enforce_rate_limit(client_ip: str) -> None:
    now = time.monotonic()
    cutoff = now - RATE_LIMIT_WINDOW_SECONDS

    with _rate_lock:
        bucket = _rate_buckets.setdefault(client_ip, deque())
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()

        if len(bucket) >= RATE_LIMIT_REQUESTS:
            retry_after = max(1, ceil(RATE_LIMIT_WINDOW_SECONDS - (now - bucket[0])))
            raise HTTPException(
                status_code=429,
                detail="Too many AI planning requests. Please wait a minute and try again.",
                headers={"Retry-After": str(retry_after)},
            )

        bucket.append(now)

        # Bound memory use if many distinct client addresses hit a long-lived worker.
        if len(_rate_buckets) > 2000:
            expired = [ip for ip, events in _rate_buckets.items()
                       if not events or events[-1] <= cutoff]
            for ip in expired:
                _rate_buckets.pop(ip, None)


@app.middleware("http")
async def add_security_headers(request: FastAPIRequest, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/")
def health():
    return {"status": "ok"}


@app.post("/api/plan")
def generate_plan(payload: PlanRequest, request: FastAPIRequest):
    """Proxy a planning prompt to Gemini without exposing the API key to the browser."""
    client_ip = request.client.host if request.client else "unknown"
    _enforce_rate_limit(client_ip)

    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="Gemini is not configured. Set GEMINI_API_KEY in the backend environment.",
        )

    model = os.getenv("GEMINI_MODEL", "gemini-3.8-flash").strip()
    if not model or any(
        ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
        for ch in model
    ):
        raise HTTPException(status_code=500, detail="GEMINI_MODEL has an invalid value.")

    endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = {
        "contents": [{"parts": [{"text": payload.prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.2,
            "maxOutputTokens": 4096,
        },
    }
    req = Request(
        endpoint,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )

    try:
        with urlopen(req, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        try:
            error_body = json.loads(exc.read().decode("utf-8"))
            detail = error_body.get("error", {}).get("message", "Gemini API request failed.")
        except (ValueError, UnicodeDecodeError):
            detail = "Gemini API request failed."
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API returned HTTP {exc.code}: {str(detail)[:300]}",
        ) from None
    except (URLError, TimeoutError):
        raise HTTPException(
            status_code=504,
            detail="Gemini API timed out or could not be reached.",
        ) from None
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=502, detail="Gemini returned an unreadable response.") from None

    try:
        text = result["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        text = ""

    if not isinstance(text, str) or not text.strip():
        raise HTTPException(
            status_code=502,
            detail="Gemini returned no text. Check model availability and API quota.",
        )

    return {"text": text}


@app.get("/")
def home():
    return FileResponse(APP_ROOT / "index.html")


@app.get("/{asset_name}")
def frontend_asset(asset_name: str):
    # Serve only the explicit frontend assets, never arbitrary repository files.
    allowed_assets = {"script.js", "style.css", "calendar.js", "calendar.css"}
    if asset_name not in allowed_assets:
        raise HTTPException(status_code=404, detail="Not found")

    path = APP_ROOT / asset_name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path)
