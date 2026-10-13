import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

# The repository root contains index.html, script.js, and the CSS/JS assets.
APP_ROOT = Path(__file__).resolve().parent.parent

app = FastAPI(title="Nudge AI API")


class PlanRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=25000)


@app.get("/api/")
def root():
    return {"status": "ok"}


@app.post("/api/plan")
def generate_plan(payload: PlanRequest):
    """Proxy the prompt to Gemini without exposing the API key to the browser."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="Gemini is not configured. Set GEMINI_API_KEY in the backend environment.",
        )

    model = os.getenv("GEMINI_MODEL", "gemini-3.8-flash").strip()
    if not model or any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for ch in model):
        raise HTTPException(status_code=500, detail="GEMINI_MODEL has an invalid value.")

    endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = {
        "contents": [{"parts": [{"text": payload.prompt}]}],
        "generationConfig": {"responseMimeType": "application/json"},
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
        # Do not return request headers or secrets to the caller.
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API returned HTTP {exc.code}: {str(detail)[:400]}",
        ) from None
    except (URLError, TimeoutError) as exc:
        raise HTTPException(
            status_code=504,
            detail="Gemini API timed out or could not be reached.",
        ) from None
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=502, detail="Gemini returned an unreadable response.") from None

    text = ""
    try:
        text = result["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        pass

    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=502, detail="Gemini returned no text. Check model availability and API quota.")

    return {"text": text}


@app.get("/")
def home():
    return FileResponse(APP_ROOT / "index.html")


@app.get("/{asset_name}")
def frontend_asset(asset_name: str):
    # Serve only the public frontend assets, not arbitrary repository files.
    allowed_assets = {"script.js", "style.css", "calendar.js", "calendar.css"}
    if asset_name not in allowed_assets:
        raise HTTPException(status_code=404, detail="Not found")
    path = APP_ROOT / asset_name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path)
