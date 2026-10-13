# Nudge AI — Vibe2Ship Hackathon Project

Nudge AI is a task-execution coach designed to turn a vague task into a practical, step-by-step plan. The interface includes task tracking, focus timers, snoozing, progress/streak statistics, mood feedback, and domain-specific offline fallback plans.

## Features

- **AI task planning:** Generates structured steps, durations, difficulty levels, and coaching tips with Gemini.
- **Task workflow:** Create tasks, mark steps complete, skip or snooze steps, and resume work.
- **Focus support:** Focus/session timers, progress tracking, and daily streaks.
- **Offline fallback:** Domain-specific plans remain available when AI generation is unavailable.
- **Private API key:** Browser code calls the FastAPI /api/plan endpoint; the Gemini key stays in the backend environment.
- **Basic abuse protection:** The demo API applies a small per-process request limit.

## Tech stack

- HTML, CSS, vanilla JavaScript
- Python, FastAPI, Uvicorn
- Google Gemini API

## Run locally

Requirements: Python 3.10+.

1. Clone the repository and open a terminal in the repository root.
2. Install backend dependencies:

       python -m pip install -r backend/requirements.txt

3. Copy .env.example to .env in the repository root and add a **new** Gemini API key to GEMINI_API_KEY. Keep the .env file local; Git ignores it. Never paste a real key into browser code or commit it.
4. Start the full-stack application:

       python -m uvicorn backend.server:app --reload

5. Open http://127.0.0.1:8000.

The default model is gemini-3.8-flash. Set GEMINI_MODEL in the environment if you need to use another model available to your Google AI project.

## Tests

Install development dependencies and run the test suite:

    python -m pip install -r backend/requirements-dev.txt
    python -m pytest -q

## Deploy on Render

This repository includes a render.yaml Blueprint for the combined frontend + backend service.

1. Import the GitHub repository into Render as a Blueprint.
2. In the Render service's environment settings, add GEMINI_API_KEY using a newly created, restricted key. Do not commit the key.
3. Deploy, then open the generated service URL and verify that the health endpoint at /api/ returns {"status":"ok"}.
4. Test a real AI task from the UI. A successful health check alone does not prove the Gemini key/model/quotas are working.

## Security notes

- If a Gemini key has been committed to a public repository, revoke it and review its usage. Removing it from the latest source does **not** erase it from older commits.
- The in-process rate limiter is a best-effort demo guard. Use a shared/distributed limiter or hosting/API-gateway protections for multi-worker or production deployments.
- Keep API access restricted and monitor Gemini usage and quotas before sharing a public demo.

## Repository layout

- index.html, style.css, calendar.css, script.js, calendar.js: frontend
- backend/server.py: FastAPI application and Gemini proxy
- backend/requirements.txt: runtime dependencies
- backend/requirements-dev.txt: test/development dependencies
- tests/test_api.py: backend smoke and proxy tests
- render.yaml: combined-service deployment configuration
