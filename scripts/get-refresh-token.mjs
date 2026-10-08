#!/usr/bin/env node
// One-time helper to obtain the long-lived credentials the server needs.
// Run it LOCALLY with the agency user that has access to all clients:
//
//   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node scripts/get-refresh-token.mjs google
//   MICROSOFT_ADS_CLIENT_ID=... [MICROSOFT_ADS_CLIENT_SECRET=...] node scripts/get-refresh-token.mjs microsoft
//   LINKEDIN_CLIENT_ID=... LINKEDIN_CLIENT_SECRET=... node scripts/get-refresh-token.mjs linkedin
//   TIKTOK_APP_ID=... TIKTOK_APP_SECRET=... node scripts/get-refresh-token.mjs tiktok
//
// Add http://localhost:8765/callback as an allowed redirect URI in the provider's app settings first.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;
const provider = process.argv[2];
const env = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing env var ${k}`);
    process.exit(1);
  }
  return v;
};

const providers = {
  google: () => ({
    authUrl: () =>
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      new URLSearchParams({
        client_id: env("GOOGLE_OAUTH_CLIENT_ID"),
        redirect_uri: REDIRECT,
        response_type: "code",
        access_type: "offline",
        prompt: "consent",
        scope: [
          "https://www.googleapis.com/auth/adwords",
          "https://www.googleapis.com/auth/analytics.readonly",
          "https://www.googleapis.com/auth/webmasters.readonly",
        ].join(" "),
      }),
    exchange: (code) =>
      post("https://oauth2.googleapis.com/token", {
        code,
        client_id: env("GOOGLE_OAUTH_CLIENT_ID"),
        client_secret: env("GOOGLE_OAUTH_CLIENT_SECRET"),
        redirect_uri: REDIRECT,
        grant_type: "authorization_code",
      }),
    out: (t) => ({ GOOGLE_REFRESH_TOKEN: t.refresh_token }),
  }),
  microsoft: () => ({
    authUrl: () =>
      `https://login.microsoftonline.com/${process.env.MICROSOFT_ADS_TENANT ?? "common"}/oauth2/v2.0/authorize?` +
      new URLSearchParams({
        client_id: env("MICROSOFT_ADS_CLIENT_ID"),
        redirect_uri: REDIRECT,
        response_type: "code",
        response_mode: "query",
        prompt: "select_account",
        scope: "https://ads.microsoft.com/msads.manage offline_access",
      }),
    exchange: (code) =>
      post(`https://login.microsoftonline.com/${process.env.MICROSOFT_ADS_TENANT ?? "common"}/oauth2/v2.0/token`, {
        code,
        client_id: env("MICROSOFT_ADS_CLIENT_ID"),
        ...(process.env.MICROSOFT_ADS_CLIENT_SECRET ? { client_secret: process.env.MICROSOFT_ADS_CLIENT_SECRET } : {}),
        redirect_uri: REDIRECT,
        grant_type: "authorization_code",
        scope: "https://ads.microsoft.com/msads.manage offline_access",
      }),
    out: (t) => ({ MICROSOFT_ADS_REFRESH_TOKEN: t.refresh_token }),
  }),
  linkedin: () => ({
    authUrl: (state) =>
      "https://www.linkedin.com/oauth/v2/authorization?" +
      new URLSearchParams({
        response_type: "code",
        client_id: env("LINKEDIN_CLIENT_ID"),
        redirect_uri: REDIRECT,
        state,
        scope: "r_ads r_ads_reporting rw_ads",
      }),
    exchange: (code) =>
      post("https://www.linkedin.com/oauth/v2/accessToken", {
        grant_type: "authorization_code",
        code,
        client_id: env("LINKEDIN_CLIENT_ID"),
        client_secret: env("LINKEDIN_CLIENT_SECRET"),
        redirect_uri: REDIRECT,
      }),
    out: (t) => (t.refresh_token ? { LINKEDIN_REFRESH_TOKEN: t.refresh_token } : { LINKEDIN_ACCESS_TOKEN: t.access_token, NOTE: "No refresh token: your LinkedIn app has no programmatic refresh; the access token expires after 60 days." }),
  }),
  tiktok: () => ({
    authUrl: (state) =>
      "https://business-api.tiktok.com/portal/auth?" + new URLSearchParams({ app_id: env("TIKTOK_APP_ID"), redirect_uri: REDIRECT, state }),
    codeParam: "auth_code",
    exchange: async (code) => {
      const res = await fetch("https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: env("TIKTOK_APP_ID"), secret: env("TIKTOK_APP_SECRET"), auth_code: code }),
      });
      const json = await res.json();
      if (json.code !== 0) throw new Error(JSON.stringify(json));
      return json.data;
    },
    out: (t) => ({ TIKTOK_ACCESS_TOKEN: t.access_token, advertiser_ids: t.advertiser_ids }),
  }),
};

async function post(url, form) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}

if (!providers[provider]) {
  console.error(`Usage: node scripts/get-refresh-token.mjs <${Object.keys(providers).join("|")}>`);
  process.exit(1);
}

const p = providers[provider]();
const state = randomBytes(8).toString("hex");
const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  if (url.pathname !== "/callback") return res.writeHead(404).end();
  const code = url.searchParams.get(p.codeParam ?? "code");
  try {
    if (!code) throw new Error(url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "no code");
    if (url.searchParams.get("state") && url.searchParams.get("state") !== state) throw new Error("state mismatch");
    const tokens = await p.exchange(code);
    console.log("\nAdd these to your .env (or your host's environment variables):\n");
    for (const [k, v] of Object.entries(p.out(tokens))) console.log(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    res.end("Done. You can close this window and return to the terminal.");
  } catch (e) {
    console.error("Failed:", e.message);
    res.writeHead(400).end(`Failed: ${e.message}`);
  } finally {
    setTimeout(() => process.exit(0), 200);
  }
});
server.listen(PORT, () => {
  console.log(`Open this URL in your browser and log in with the account that has access to your ad accounts:\n\n${p.authUrl(state)}\n`);
});
