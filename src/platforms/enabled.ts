import type { AdsCredentials } from "../types.js";

export interface EnabledPlatforms {
  googleAds: boolean;
  ga4: boolean;
  searchConsole: boolean;
  meta: boolean;
  linkedin: boolean;
  tiktok: boolean;
  microsoftAds: boolean;
}

/** Which platforms have enough credentials to register their tools. */
export function enabledPlatforms(c: AdsCredentials): EnabledPlatforms {
  const g = c.google;
  const gOk = Boolean(g?.clientId && g.clientSecret && (g.refreshToken || g.adsRefreshToken || g.analyticsRefreshToken || g.searchConsoleRefreshToken));
  const products = g?.products ?? ["ads", "analytics", "searchConsole"];
  return {
    googleAds: gOk && products.includes("ads") && Boolean(g!.adsRefreshToken || g!.refreshToken),
    ga4: gOk && products.includes("analytics") && Boolean(g!.analyticsRefreshToken || g!.refreshToken),
    searchConsole: gOk && products.includes("searchConsole") && Boolean(g!.searchConsoleRefreshToken || g!.refreshToken),
    meta: Boolean(c.meta?.accessToken),
    linkedin: Boolean(c.linkedin?.accessToken || (c.linkedin?.clientId && c.linkedin.clientSecret && c.linkedin.refreshToken)),
    tiktok: Boolean(c.tiktok?.accessToken),
    microsoftAds: Boolean(c.microsoftAds?.developerToken && c.microsoftAds.clientId && c.microsoftAds.refreshToken),
  };
}
