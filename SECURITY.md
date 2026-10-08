# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in `boostu-ads-mcp`, please report it privately.
**Do not open a public GitHub issue.**

Email **nick@boostu.be** with:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if possible),
- the affected version or commit.

We aim to acknowledge reports within a few business days and will keep you updated on
remediation. Please give us reasonable time to release a fix before any public disclosure.

## Handling credentials

This server calls advertising APIs with credentials that can spend money and change campaigns.

- Never commit `.env` or `clients.json` to version control. Both are listed in `.gitignore`.
- Treat OAuth client secrets, refresh tokens, Meta and TikTok access tokens and Microsoft
  developer tokens as secrets. Anyone holding them can read and change your ad accounts.
- Prefer a Meta **system user** token scoped to the ad accounts you need over a personal token.
- In `--http` mode, use long random `MCP_API_KEYS` and serve the endpoint over HTTPS only.
- Keep `WRITE_MODE=confirm` (the default) or `off` unless you have a reason to change it.
- If a credential is exposed, revoke it immediately in the platform's developer console.

## Supported versions

Only the latest published version receives security updates.
