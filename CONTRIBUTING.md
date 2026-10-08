# Contributing to BoostU Ads MCP

Thanks for your interest in contributing!

## Development setup

```bash
git clone https://github.com/boostuagency/boostu-ads-mcp.git
cd boostu-ads-mcp
npm install
npm run dev        # stdio, TypeScript via tsx
npm run dev:http   # HTTP mode
```

## Before submitting a pull request

```bash
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

All tests must pass and there must be no type errors. No test may call a live ad API.

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/), with the platform as scope when useful:

```
feat(google-ads): add asset group performance tool
fix(meta): convert budgets for zero-decimal currencies
docs: explain LinkedIn refresh tokens
```

## Adding a tool

1. Add it to the platform file in `src/platforms/` with `defineTool(ctx, name, def, handler)`.
2. Read the credentials from `ctx.creds.<platform>`; never from `process.env` (the library must work per tenant).
3. Mark tools that change anything with `write: true` (and `destructive: true` for raw or deleting operations). The handler receives `meta.dryRun` and must only preview or validate when it is true.
4. Return plain JSON; money in account currency units, ids as strings.
5. Add a unit test for any parsing or conversion logic and update the tool table in `README.md`.
