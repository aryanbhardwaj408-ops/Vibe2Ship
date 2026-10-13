# Security Policy

## Reporting a vulnerability

Please avoid filing public issues containing secrets, tokens, personal data, or exploitable details. Contact the repository owner privately with a concise description and reproduction steps.

## API key handling

- Never commit a real API key, access token, or .env file.
- Keep Gemini credentials in the backend's secret/environment settings.
- Restrict the key to the Gemini API where the provider supports it.
- If a key is exposed, revoke it, create a replacement, audit usage, and update the backend secret.
- Removing a key from the current version does not remove it from Git history. History cleanup is a separate operation, and revocation is still required.
