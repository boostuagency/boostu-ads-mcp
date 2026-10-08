# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [1.0.0] - 2026-10-08

### Added

- First public release, extracted from BoostU's internal agency MCP.
- 58 tools across Google Ads, Meta Ads, GA4, Search Console, LinkedIn Ads, TikTok Ads and Microsoft Advertising, plus cross-channel totals, an all-accounts overview and a client registry.
- `createServer(options)` library API with per-call credentials, write gating, audit hook and token-rotation hook, for embedding in multi-tenant hosts.
- `boostu-ads-mcp` binary with stdio and `--http` (API key protected) transports.
- Preview-first write tools with Google `validateOnly` and Meta `validate_only` checks.
