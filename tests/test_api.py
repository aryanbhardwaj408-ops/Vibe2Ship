import io
import json
from urllib.error import HTTPError

import pytest
from fastapi.testclient import TestClient

from backend import server


@pytest.fixture(autouse=True)
def reset_rate_limits():
    with server._rate_lock:
        server._rate_buckets.clear()
    yield
    with server._rate_lock:
        server._rate_buckets.clear()


@pytest.fixture
def client():
    return TestClient(server.app)


class FakeResponse:
    def __init__(self, data):
        self.data = json.dumps(data).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self):
        return self.data


def gemini_response(text='{"steps":[{"title":"Define the outcome"}]}'):
    return {
        "candidates": [
            {"content": {"parts": [{"text": text}]}}
        ]
    }


def test_health_endpoint(client):
    response = client.get("/api/")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["cache-control"] == "no-store"


def test_home_serves_frontend(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "Nudge AI" in response.text


def test_missing_api_key_returns_clear_error(client, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    response = client.post("/api/plan", json={"prompt": "Create a plan"})
    assert response.status_code == 503
    assert "GEMINI_API_KEY" in response.json()["detail"]


def test_invalid_prompt_is_rejected(client):
    response = client.post("/api/plan", json={"prompt": ""})
    assert response.status_code == 422


def test_proxy_sends_key_in_header_not_url(client, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-secret")
    monkeypatch.setenv("GEMINI_MODEL", "gemini-3.8-flash")
    captured = {}

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["headers"] = {name.lower(): value for name, value in request.header_items()}
        captured["timeout"] = timeout
        return FakeResponse(gemini_response())

    monkeypatch.setattr(server, "urlopen", fake_urlopen)
    response = client.post("/api/plan", json={"prompt": "Create a plan"})

    assert response.status_code == 200
    assert response.json()["text"].startswith('{"steps"')
    assert captured["url"] == (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        "gemini-3.8-flash:generateContent"
    )
    assert "key=" not in captured["url"]
    assert captured["headers"]["x-goog-api-key"] == "test-secret"
    assert captured["timeout"] == 30
    assert response.headers["cache-control"] == "no-store"


def test_upstream_error_is_sanitized(client, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-secret")
    error_body = io.BytesIO(json.dumps({
        "error": {"message": "Invalid API key"}
    }).encode("utf-8"))

    def fail_urlopen(request, timeout):
        raise HTTPError(request.full_url, 403, "Forbidden", {}, error_body)

    monkeypatch.setattr(server, "urlopen", fail_urlopen)
    response = client.post("/api/plan", json={"prompt": "Create a plan"})
    assert response.status_code == 502
    assert "Invalid API key" in response.json()["detail"]
    assert "test-secret" not in response.text


def test_rate_limit_returns_429_after_ten_requests(client, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-secret")
    monkeypatch.setattr(
        server, "urlopen",
        lambda request, timeout: FakeResponse(gemini_response())
    )

    responses = [
        client.post("/api/plan", json={"prompt": "Create a plan"})
        for _ in range(server.RATE_LIMIT_REQUESTS + 1)
    ]
    assert all(response.status_code == 200 for response in responses[:-1])
    assert responses[-1].status_code == 429
    assert int(responses[-1].headers["retry-after"]) > 0
