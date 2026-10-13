# Vibe2Ship — Nudge AI

Nudge AI is a task-planning web app. The frontend sends planning prompts to a FastAPI backend, and the backend calls Gemini. The API key is kept in the backend environment and is not included in browser JavaScript.

## Run locally

1. Install Python 3.10 or newer.
2. From the repository root, install dependencies:

   ```bash
   pip install -r backend/requirements.txt
   ```

3. Copy `.env.example` to `.env` in the repository root and put your new Gemini key in the local `.env` file. The `.env` file is ignored by Git. Never paste a real key into frontend code or commit it. Alternatively, set the environment variable directly:

   macOS / Linux:
   ```bash
   export GEMINI_API_KEY="YOUR_NEW_KEY"
   ```

   Windows PowerShell:
   ```powershell
   $env:GEMINI_API_KEY="YOUR_NEW_KEY"
   ```

4. Start the app from the repository root:

   ```bash
   uvicorn backend.server:app --reload
   ```

5. Open http://127.0.0.1:8000.

The default model is `gemini-3.8-flash`. Set `GEMINI_MODEL` in the hosting environment to use another model available to your Google AI project.

## Deployment

Deploy the frontend and backend as one service so the same-origin `/api/plan` request reaches FastAPI.

- Build command: `pip install -r backend/requirements.txt`
- Start command: `uvicorn backend.server:app --host 0.0.0.0 --port $PORT`
- Add the key in the hosting provider's environment-variable or secret settings.
- Do not commit a real local environment file.

For a public production deployment, configure rate limiting and usage monitoring at your hosting provider or API gateway.

## Key security

If a key has ever been committed to a public repository, revoke it in Google AI Studio / Google Cloud and check its usage. Removing it from the latest source does not remove it from older Git commits.
