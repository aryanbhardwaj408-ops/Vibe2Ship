# Nudge AI

**Turn a vague goal into a practical plan, then follow through.**

**Live demo:** [Try Nudge AI](https://vibe2-ship-wheat.vercel.app) · **Source code:** [GitHub repository](https://github.com/aryanbhardwaj408-ops/Vibe2Ship)

Nudge AI is an AI-powered task-execution coach built as a Vibe2Ship hackathon project. It helps turn a goal into structured steps and combines planning with the tools needed to actually do the work: task tracking, focus sessions, scheduling, snoozing, and progress statistics.

## Features

- **Conversational AI Coach** — clarify a goal and generate a structured plan with Gemini.
- **Multi-goal planning** — organize multiple tasks into a prioritized queue.
- **Review before starting** — inspect, edit, or remove proposed steps before committing to a plan.
- **Task management** — track pending, active, snoozed, and completed tasks; resume work and mark individual steps complete.
- **Focus and scheduling tools** — set time windows, use focus/session timers, and snooze tasks.
- **Progress feedback** — view activity, streaks, completion statistics, and mood-related feedback.
- **Voice input** — use the browser's Speech Recognition API where it is supported and permitted.
- **Fallback plans** — continue with domain-specific starter plans if the AI endpoint is unavailable.

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | HTML, CSS, vanilla JavaScript |
| Backend | Python, FastAPI, Uvicorn |
| AI | Google Gemini API |
| Local persistence | Browser `localStorage` |
| Quality checks | pytest, Node.js syntax checks, GitHub Actions |

## How it works

1. The user describes a task in the browser.
2. The frontend sends a planning prompt to `POST /api/plan`.
3. FastAPI reads `GEMINI_API_KEY` from its server-side environment and calls Gemini.
4. The backend returns the model response to the frontend, which validates the structured plan and prepares the steps.
5. If the request fails or the response cannot be used, the app can fall back to a built-in domain-specific plan.

**Security boundary:** the current frontend does not call Gemini directly and should never contain a real API key. The secret belongs in the backend environment.

## Run locally

Requirements: Python 3.10+ and Node.js for the JavaScript syntax checks.

1. Clone the repository and enter its root directory:

   ```bash
   git clone https://github.com/aryanbhardwaj408-ops/Vibe2Ship.git
   cd Vibe2Ship
   ```

2. Create and activate a virtual environment (Windows PowerShell example):

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```

   On macOS/Linux, use `python3 -m venv .venv` and `source .venv/bin/activate`.

3. Install backend dependencies:

   ```bash
   python -m pip install -r backend/requirements.txt
   ```

4. Create a local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

   Open `.env` and set `GEMINI_API_KEY` to a valid key from your Google AI project. Keep this file local; it is ignored by Git. Do not paste a real key into `script.js`, HTML, CSS, screenshots, or commits.

5. Start the app from the repository root:

   ```bash
   python -m uvicorn backend.server:app --reload
   ```

6. Open [http://127.0.0.1:8000](http://127.0.0.1:8000).

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | Yes, for live AI planning | Server-side Gemini API credential. Keep it secret. |
| `GEMINI_MODEL` | No | Model identifier. Defaults to `gemini-3.8-flash` in the current backend. |

The health endpoint is `GET /api/` and should return `{"status":"ok"}`. A successful health check confirms the API process is reachable; it does not by itself confirm Gemini credentials, model access, or quota.

## Tests and checks

Install the development dependencies:

```bash
python -m pip install -r backend/requirements-dev.txt
```

Run the backend tests:

```bash
python -m pytest -q
```

Run the additional syntax checks:

```bash
python -m compileall -q backend tests
node --check script.js
node --check calendar.js
```

GitHub Actions runs the compile checks, frontend JavaScript syntax checks, and pytest suite on pushes and pull requests.

## Deployment

### Render

The repository includes a `render.yaml` Blueprint for running the frontend and FastAPI backend together.

1. Create a Blueprint deployment from this GitHub repository.
2. Set `GEMINI_API_KEY` in the service's environment settings. Add the value directly in the hosting dashboard; do not commit it.
3. Optionally set `GEMINI_MODEL` if your Google AI project uses a different supported model.
4. Deploy and check `/api/` for the health response.
5. Test an actual planning request from the UI and confirm `POST /api/plan` returns a successful response.

### Vercel or another host

The frontend currently calls the relative path `/api/plan`, so the deployed site must route that request to a server-side FastAPI endpoint (or a compatible backend adapter). The repository currently contains the Render Blueprint but does not include a `vercel.json` file or a Vercel-specific serverless adapter. If your Vercel project uses separate routing or a separate backend, document that configuration alongside the deployment and keep the API key only in the backend's server-side environment—not in browser-visible variables.

## Important limitations

- Tasks and progress are stored in the browser's `localStorage`; there is no account system or cross-device cloud sync in this version.
- Voice input depends on browser support, permissions, and the browser's speech-recognition service.
- Built-in fallback plans allow the UI to continue when live AI planning is unavailable. For a deployment check, verify the `/api/plan` network response rather than relying only on seeing steps appear.
- The in-memory rate limiter is a best-effort demo safeguard. Production use would need shared rate limiting or gateway-level protections, plus monitoring of API usage and quotas.

## Repository layout

- `index.html`, `style.css`: main interface
- `script.js`, `calendar.js`, `calendar.css`: app behavior and calendar UI
- `backend/server.py`: FastAPI app and Gemini proxy
- `backend/requirements.txt`: runtime dependencies
- `backend/requirements-dev.txt`: test dependencies
- `tests/test_api.py`: backend and API-boundary tests
- `render.yaml`: Render deployment definition
- `SECURITY.md`: security policy
- `memory/PRD.md`: product brief and current requirements

## Security

If a credential is exposed, revoke it with the provider immediately, create a replacement, review usage, and update the backend secret. Removing a secret from the latest source does not remove it from old Git commits; history cleanup is a separate operation. See [SECURITY.md](SECURITY.md) before contributing or reporting a concern.
