import { existsSync, readFileSync } from "node:fs";
import { parseClients } from "./clients.js";
import type { AdsCredentials, ClientEntry, ServerOptions, WriteMode } from "./types.js";

type Env = Record<string, string | undefined>;

const str = (env: Env, name: string) => {
  const v = env[name];
  return v !== undefined && v.trim() !== "" ? v.trim() : undefined;
};
const list = (env: Env, name: string) =>
  (str(env, name) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Reads platform credentials from environment variables (see .env.example). */
export function credentialsFromEnv(env: Env = process.env): AdsCredentials {
  const c: AdsCredentials = {};
  const gId = str(env, "GOOGLE_OAUTH_CLIENT_ID");
  const gSecret = str(env, "GOOGLE_OAUTH_CLIENT_SECRET");
  const gRefresh = str(env, "GOOGLE_REFRESH_TOKEN");
  if (gId && gSecret && (gRefresh || str(env, "GOOGLE_ADS_REFRESH_TOKEN") || str(env, "GOOGLE_ANALYTICS_REFRESH_TOKEN") || str(env, "GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN"))) {
    c.google = {
      clientId: gId,
      clientSecret: gSecret,
      refreshToken: gRefresh ?? "",
      adsRefreshToken: str(env, "GOOGLE_ADS_REFRESH_TOKEN"),
      analyticsRefreshToken: str(env, "GOOGLE_ANALYTICS_REFRESH_TOKEN"),
      searchConsoleRefreshToken: str(env, "GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN"),
      adsLoginCustomerId: str(env, "GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
      adsDeveloperToken: str(env, "GOOGLE_ADS_DEVELOPER_TOKEN"),
      adsApiVersion: str(env, "GOOGLE_ADS_API_VERSION"),
    };
  }
  const metaToken = str(env, "META_ACCESS_TOKEN");
  if (metaToken) {
    c.meta = {
      accessToken: metaToken,
      appSecret: str(env, "META_APP_SECRET"),
      businessId: str(env, "META_BUSINESS_ID"),
      apiVersion: str(env, "META_API_VERSION"),
      conversionActions: list(env, "META_CONVERSION_ACTIONS"),
    };
  }
  const li = {
    accessToken: str(env, "LINKEDIN_ACCESS_TOKEN"),
    clientId: str(env, "LINKEDIN_CLIENT_ID"),
    clientSecret: str(env, "LINKEDIN_CLIENT_SECRET"),
    refreshToken: str(env, "LINKEDIN_REFRESH_TOKEN"),
    apiVersion: str(env, "LINKEDIN_API_VERSION"),
  };
  if (li.accessToken || (li.clientId && li.clientSecret && li.refreshToken)) c.linkedin = li;
  const tt = str(env, "TIKTOK_ACCESS_TOKEN");
  if (tt) c.tiktok = { accessToken: tt, appId: str(env, "TIKTOK_APP_ID"), secret: str(env, "TIKTOK_APP_SECRET") };
  const msDev = str(env, "MICROSOFT_ADS_DEVELOPER_TOKEN");
  const msId = str(env, "MICROSOFT_ADS_CLIENT_ID");
  const msRefresh = str(env, "MICROSOFT_ADS_REFRESH_TOKEN");
  if (msDev && msId && msRefresh) {
    c.microsoftAds = {
      developerToken: msDev,
      clientId: msId,
      clientSecret: str(env, "MICROSOFT_ADS_CLIENT_SECRET"),
      refreshToken: msRefresh,
      customerId: str(env, "MICROSOFT_ADS_CUSTOMER_ID"),
      tenant: str(env, "MICROSOFT_ADS_TENANT"),
    };
  }
  return c;
}

/** Client registry from CLIENTS_JSON or the file at CLIENTS_FILE (default ./clients.json). */
export function clientsFromEnv(env: Env = process.env): ClientEntry[] {
  const json = str(env, "CLIENTS_JSON");
  if (json) return parseClients(json);
  const file = str(env, "CLIENTS_FILE") ?? "clients.json";
  return existsSync(file) ? parseClients(readFileSync(file, "utf8")) : [];
}

/** Full server options from the environment (credentials, write mode, registry). */
export function optionsFromEnv(env: Env = process.env): ServerOptions {
  const writeAllow = list(env, "WRITE_ALLOWED_USERS").map((s) => s.toLowerCase());
  return {
    credentials: credentialsFromEnv(env),
    writeMode: (str(env, "WRITE_MODE") === "off" ? "off" : "confirm") as WriteMode,
    canWrite: writeAllow.length ? (u) => writeAllow.includes(u.id.toLowerCase()) : undefined,
    clients: clientsFromEnv(env),
    maxResponseChars: Number(str(env, "MAX_RESPONSE_CHARS") ?? 120_000),
    name: str(env, "SERVER_NAME"),
  };
}
