/**
 * Credentials per platform. Every platform is optional: a platform without credentials
 * is simply not registered. The same shape is used by the stdio binary (read from env),
 * by self-hosted HTTP deployments and by multi-tenant hosts that store one set per tenant.
 */
export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  /** Refresh token of the Google user with access to Google Ads, GA4 and/or Search Console. */
  refreshToken: string;
  /** Optional dedicated refresh tokens per product (fall back to refreshToken). */
  adsRefreshToken?: string;
  analyticsRefreshToken?: string;
  searchConsoleRefreshToken?: string;
  /** Manager (MCC) id used as login-customer-id. */
  adsLoginCustomerId?: string;
  /** Optional since Google's developer token sunset (9 Sep 2026). Sent only when set. */
  adsDeveloperToken?: string;
  /** Default v25. */
  adsApiVersion?: string;
  /** Which Google products to enable (default: all three). */
  products?: Array<"ads" | "analytics" | "searchConsole">;
}

export interface MetaCredentials {
  /** System user token (recommended) or long-lived user token with ads_read / ads_management. */
  accessToken: string;
  appSecret?: string;
  businessId?: string;
  /** Default v26.0. */
  apiVersion?: string;
  /** Action types counted as conversions in cross-channel totals. Default purchase, lead. */
  conversionActions?: string[];
}

export interface LinkedInCredentials {
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  /** LinkedIn-Version header, YYYYMM. Default 202609. */
  apiVersion?: string;
}

export interface TikTokCredentials {
  accessToken: string;
  appId?: string;
  secret?: string;
}

export interface MicrosoftAdsCredentials {
  developerToken: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  /** Manager account (customer) id. */
  customerId?: string;
  tenant?: string;
}

export interface AdsCredentials {
  google?: GoogleCredentials;
  meta?: MetaCredentials;
  linkedin?: LinkedInCredentials;
  tiktok?: TikTokCredentials;
  microsoftAds?: MicrosoftAdsCredentials;
}

/** Optional client registry entry: maps a client to its account ids on every channel. */
export interface ClientEntry {
  name: string;
  aliases?: string[];
  google_ads?: string[];
  meta?: string[];
  ga4?: string[];
  search_console?: string[];
  linkedin?: string[];
  tiktok?: string[];
  microsoft_ads?: string[];
  owner?: string;
  notes?: string;
  targets?: Record<string, unknown>;
}

export interface McpUser {
  /** Used in audit events. */
  id: string;
  name?: string;
}

export interface AuditEvent {
  type: "audit";
  at: string;
  user: string;
  tool: string;
  args: unknown;
  ok: boolean;
  ms?: number;
  error?: string;
}

export type WriteMode = "off" | "confirm";

export interface ServerOptions {
  credentials: AdsCredentials;
  /** Who is calling; only used for audit events and canWrite. */
  user?: McpUser;
  /** "confirm" (default): write tools preview first and need confirm=true. "off": write tools are hidden. */
  writeMode?: WriteMode;
  /** Extra gate for executing writes (e.g. an allowlist). Default: everyone. */
  canWrite?: (user: McpUser) => boolean;
  /** Receives one event per executed write. Default: JSON line on stdout. */
  onAudit?: (event: AuditEvent) => void;
  /** Optional client registry. */
  clients?: ClientEntry[];
  /** Called when a provider rotates a refresh token, so hosts can persist it. */
  onTokenRotated?: (platform: "microsoftAds" | "linkedin", refreshToken: string) => void;
  /** Truncate tool responses above this size. Default 120000. */
  maxResponseChars?: number;
  /** Server name shown to clients. */
  name?: string;
  /** Extra text appended to the server instructions. */
  instructions?: string;
}
