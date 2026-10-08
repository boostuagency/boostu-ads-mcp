import { request, TokenCache } from "../lib/http.js";
import type { GoogleCredentials } from "../types.js";

// Shared across server instances so a per-request server does not refresh every time.
const caches = new Map<string, TokenCache>();

export type GoogleProduct = "ads" | "analytics" | "searchConsole";

export function googleRefreshToken(g: GoogleCredentials, product: GoogleProduct): string {
  const specific = product === "ads" ? g.adsRefreshToken : product === "analytics" ? g.analyticsRefreshToken : g.searchConsoleRefreshToken;
  return specific || g.refreshToken;
}

/** Access token for a Google user, refreshed and cached per (client, refresh token). */
export function googleAccessToken(g: GoogleCredentials, product: GoogleProduct): Promise<string> {
  const rt = googleRefreshToken(g, product);
  if (!rt || !g.clientId || !g.clientSecret) throw new Error("Google OAuth credentials are incomplete (client id, client secret, refresh token).");
  const key = `${g.clientId}\u0000${rt}`;
  let cache = caches.get(key);
  if (!cache) {
    cache = new TokenCache(() =>
      request("Google OAuth", "https://oauth2.googleapis.com/token", {
        form: { client_id: g.clientId, client_secret: g.clientSecret, refresh_token: rt, grant_type: "refresh_token" },
      }),
    );
    caches.set(key, cache);
  }
  return cache.get();
}
