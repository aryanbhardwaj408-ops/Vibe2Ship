# Security Policy

## Scope

This repository contains the Nudge AI frontend, a FastAPI backend, and deployment/test configuration. Please report vulnerabilities affecting the application, API endpoint, or handling of credentials.

## Reporting a vulnerability

Please do **not** open a public issue containing secrets, personal data, or detailed exploit instructions.

Report concerns privately to the repository owner through GitHub. If GitHub's private vulnerability reporting is enabled for this repository, use that feature. Include a concise description, affected file/endpoint, impact, and reproduction steps that do not disclose real credentials.

Please allow time for the issue to be reviewed before publicly disclosing details.

## API key and secret handling

- Keep `GEMINI_API_KEY` in the backend hosting provider's secret/environment settings.
- Never put a real key in `script.js`, HTML, CSS, frontend build variables, screenshots, documentation, or commits.
- Keep a local `.env` file out of Git. The repository's `.env.example` is a blank template and is safe to commit.
- Restrict credentials to the required provider/API where supported, and monitor usage and quotas.
- If a key is exposed, revoke it immediately, create a replacement, review provider usage, and update the backend environment.
- Removing a secret from the latest version does not remove it from earlier Git commits. History cleanup is separate; also consider forks, clones, caches, and references to old commits. Revocation is still the first and most important response.

## Deployment notes

- The browser should call the application's backend endpoint; Gemini credentials must never be sent to the browser.
- The API's in-process rate limiter is a best-effort demo safeguard, not a replacement for a shared limiter, API gateway, or hosting-level protections in a scaled production service.
- Test the real AI planning endpoint and monitor failures; a successful health check alone does not prove that the provider key, model access, or quota is configured correctly.
