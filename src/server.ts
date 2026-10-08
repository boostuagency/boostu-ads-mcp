import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "./lib/tools.js";
import { registerCrossChannel } from "./platforms/crossChannel.js";
import { enabledPlatforms } from "./platforms/enabled.js";
import { registerGa4 } from "./platforms/ga4.js";
import { registerGoogleAds } from "./platforms/googleAds.js";
import { registerLinkedIn } from "./platforms/linkedin.js";
import { registerMeta } from "./platforms/meta.js";
import { registerMicrosoftAds } from "./platforms/microsoftAds.js";
import { registerSearchConsole } from "./platforms/searchConsole.js";
import { registerTikTok } from "./platforms/tiktok.js";
import type { ServerOptions } from "./types.js";
import { VERSION } from "./version.js";

const INSTRUCTIONS = `Ads MCP: Google Ads, Meta Ads, GA4, Search Console, LinkedIn Ads, TikTok Ads and Microsoft Ads in one server.

Workflow:
1. Unknown account ids? Call find_client_accounts with the client or brand name (or list_clients when a client registry is configured).
2. Read data with the platform tools (google_ads_*, meta_*, ga4_*, gsc_*, linkedin_*, tiktok_*, microsoft_ads_*) or cross_channel_performance for totals across channels.
3. Write tools (pause, budgets, keywords, raw mutate/post) ALWAYS run as a preview first. Show the preview to the user and only repeat the call with confirm=true after explicit approval. Never batch unrelated changes into one confirmation.

Conventions: date presets use REPORT_TIMEZONE (default Europe/Brussels); money is in the account currency; Google Ads micros are already converted.
Platform conversions are not deduplicated across channels; mention this when comparing channels and use GA4 as the neutral source.
Answer in the language of the user.`;

/**
 * Builds an MCP server for one set of credentials. Cheap to call per request:
 * OAuth access tokens and account lists are cached per credential across instances.
 */
export function createServer(options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: "boostu-ads-mcp", title: options.name ?? "Ads MCP", version: VERSION },
    { instructions: options.instructions ? `${INSTRUCTIONS}\n\n${options.instructions}` : INSTRUCTIONS },
  );
  const ctx: ToolContext = { server, user: options.user ?? { id: "local" }, options, creds: options.credentials };
  const enabled = enabledPlatforms(options.credentials);

  registerCrossChannel(ctx);
  if (enabled.googleAds) registerGoogleAds(ctx);
  if (enabled.meta) registerMeta(ctx);
  if (enabled.ga4) registerGa4(ctx);
  if (enabled.searchConsole) registerSearchConsole(ctx);
  if (enabled.linkedin) registerLinkedIn(ctx);
  if (enabled.tiktok) registerTikTok(ctx);
  if (enabled.microsoftAds) registerMicrosoftAds(ctx);

  registerPrompts(server);
  return server;
}

function registerPrompts(server: McpServer): void {
  const text = (t: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: t } }] });

  server.registerPrompt(
    "client_report",
    {
      title: "Client performance report",
      description: "Cross-channel report for one client, compared with the previous period.",
      argsSchema: { client: z.string(), period: z.string().optional() },
    },
    ({ client, period }) =>
      text(
        `Create a performance report for "${client}" over ${period ?? "the last 7 days"}.
1. Find the accounts with find_client_accounts.
2. Get totals with cross_channel_performance (with previous period comparison).
3. Drill into campaigns per channel (google_ads_campaign_performance, meta_insights level=campaign, ...).
4. Check GA4 (ga4_traffic_overview) for neutral conversion numbers.
Report: key figures per channel, notable risers and fallers, budget pacing and 3 to 5 concrete recommendations. Be concise.`,
      ),
  );

  server.registerPrompt(
    "google_ads_audit",
    { title: "Google Ads account audit", description: "Thorough audit of one Google Ads account.", argsSchema: { client: z.string() } },
    ({ client }) =>
      text(
        `Audit the Google Ads account of "${client}" (last 30 days compared with the 30 days before).
Check: conversion tracking (google_ads_conversion_actions), budget pacing and lost impression share, bidding strategies, search terms without conversions (google_ads_search_terms only_without_conversions=true), quality scores, ad strength and disapproved ads, recent changes (google_ads_change_history) and Google's recommendations (judge them critically).
Give a prioritised action list (impact x effort). Do NOT make changes without explicit approval.`,
      ),
  );

  server.registerPrompt(
    "wasted_spend",
    {
      title: "Find wasted spend",
      description: "Search terms, keywords, ads and ad sets that cost money without results.",
      argsSchema: { client: z.string(), min_cost: z.string().optional() },
    },
    ({ client, min_cost }) =>
      text(
        `Find wasted spend for "${client}" over the last 30 days: Google Ads search terms and keywords without conversions costing more than ${min_cost ?? "20"}, Meta ad sets and ads with a CPA far above the account average, and the same for other connected channels.
Propose negative keywords and items to pause as a preview. Only apply them after my approval.`,
      ),
  );

  server.registerPrompt(
    "daily_check",
    { title: "Daily all-accounts check", description: "Which accounts spent nothing yesterday and which over- or underspend.", argsSchema: {} },
    () =>
      text(
        `Run the daily check across all accounts: use agency_overview for yesterday (date_range=yesterday) on Google Ads and Meta. List accounts with zero spend (possible billing issue or disapproval), accounts with a sharp drop or rise against their 7 day average, and accounts with a CPA far above their target (list_clients for targets).`,
      ),
  );
}
