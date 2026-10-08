import { z } from "zod";
import { dateRangeShape, resolveDateRange, type DateRange } from "../lib/dates.js";
import { request } from "../lib/http.js";
import { defineTool, fingerprint, KeyedCache, type ToolContext } from "../lib/tools.js";
import { googleAccessToken } from "./googleAuth.js";
import type { GoogleCredentials } from "../types.js";
import type { ChannelTotals } from "./totals.js";

const base = (g: GoogleCredentials) => `https://googleads.googleapis.com/${g.adsApiVersion ?? "v25"}`;

export const cleanCid = (id: string | number) => String(id).replace(/[^0-9]/g, "");

async function headers(g: GoogleCredentials, loginCustomerId?: string): Promise<Record<string, string>> {
  const token = await googleAccessToken(g, "ads");
  const h: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (g.adsDeveloperToken) h["developer-token"] = g.adsDeveloperToken;
  const login = loginCustomerId ? cleanCid(loginCustomerId) : g.adsLoginCustomerId ? cleanCid(g.adsLoginCustomerId) : undefined;
  if (login) h["login-customer-id"] = login;
  return h;
}

// Metrics that the API returns in micros although their name does not end in "Micros".
const IMPLICIT_MICROS = new Set(["averageCpc", "averageCpm", "averageCost", "averageCpv", "averageCpe", "costPerConversion", "costPerAllConversions", "costPerCurrentModelAttributedConversion"]);

/** Flattens nested API rows into dotted keys and converts micros fields to currency units. */
export function flattenRow(obj: any, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      flattenRow(v, key, out);
    } else if (/Micros$/.test(k) && v !== null && v !== undefined && !Array.isArray(v)) {
      out[key.replace(/Micros$/, "")] = Math.round((Number(v) / 1e6) * 100) / 100;
    } else if (prefix.endsWith("metrics") && IMPLICIT_MICROS.has(k) && typeof v === "number") {
      out[key] = Math.round((v / 1e6) * 100) / 100;
    } else {
      out[key] = v;
    }
  }
  return out;
}

export async function gaqlSearch(g: GoogleCredentials, customerId: string, query: string, opts: { limit?: number; loginCustomerId?: string } = {}): Promise<any[]> {
  const limit = opts.limit ?? 1000;
  const rows: any[] = [];
  let pageToken: string | undefined;
  do {
    const res: any = await request("Google Ads", `${base(g)}/customers/${cleanCid(customerId)}/googleAds:search`, {
      headers: await headers(g, opts.loginCustomerId),
      json: { query, ...(pageToken ? { pageToken } : {}) },
    });
    rows.push(...(res.results ?? []));
    pageToken = res.nextPageToken;
  } while (pageToken && rows.length < limit);
  return rows.slice(0, limit);
}

async function mutate(g: GoogleCredentials, customerId: string, mutateOperations: unknown[], validateOnly: boolean, loginCustomerId?: string) {
  return request("Google Ads", `${base(g)}/customers/${cleanCid(customerId)}/googleAds:mutate`, {
    headers: await headers(g, loginCustomerId),
    json: { mutateOperations, validateOnly, partialFailure: false },
    retries: 0,
  });
}

const during = (r: DateRange) => `segments.date BETWEEN '${r.start}' AND '${r.end}'`;

const METRICS =
  "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions, metrics.conversions_value, metrics.cost_per_conversion, metrics.all_conversions";

function withRoas(row: Record<string, unknown>): Record<string, unknown> {
  const cost = Number(row["metrics.cost"] ?? 0);
  const value = Number(row["metrics.conversionsValue"] ?? 0);
  if (cost > 0) row["metrics.roas"] = Math.round((value / cost) * 100) / 100;
  return row;
}

// ---------- account list (cached per credential) ----------
const accountCache = new KeyedCache<any[]>();

export async function listGoogleAdsAccounts(g: GoogleCredentials, force = false): Promise<any[]> {
  const key = await fingerprint(g.clientId, g.adsRefreshToken || g.refreshToken, g.adsLoginCustomerId);
  return accountCache.get(key, force, () => loadAccounts(g));
}

async function loadAccounts(g: GoogleCredentials): Promise<any[]> {
  const mcc = g.adsLoginCustomerId ? cleanCid(g.adsLoginCustomerId) : undefined;
  let rows: any[];
  if (mcc) {
    const res = await gaqlSearch(g,
      mcc,
      "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status, customer_client.level, customer_client.currency_code, customer_client.time_zone FROM customer_client WHERE customer_client.level <= 5",
      { limit: 10_000 },
    );
    rows = res.map((r) => flattenRow(r.customerClient)).map((r) => ({
      id: String(r.id),
      name: r.descriptiveName,
      manager: r.manager,
      status: r.status,
      level: r.level,
      currency: r.currencyCode,
      timeZone: r.timeZone,
    }));
  } else {
    const res: any = await request("Google Ads", `${base(g)}/customers:listAccessibleCustomers`, { headers: await headers(g) });
    rows = (res.resourceNames ?? []).map((rn: string) => ({ id: rn.split("/")[1] }));
  }
  return rows;
}

export async function googleAdsTotals(g: GoogleCredentials, customerId: string, range: DateRange): Promise<ChannelTotals> {
  const rows = await gaqlSearch(g, customerId, `SELECT customer.currency_code, ${METRICS} FROM customer WHERE ${during(range)}`);
  const t = { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };
  let currency: string | undefined;
  for (const r of rows) {
    const f = flattenRow(r);
    currency = f["customer.currencyCode"] as string;
    t.spend += Number(f["metrics.cost"] ?? 0);
    t.impressions += Number(f["metrics.impressions"] ?? 0);
    t.clicks += Number(f["metrics.clicks"] ?? 0);
    t.conversions += Number(f["metrics.conversions"] ?? 0);
    t.conversionValue += Number(f["metrics.conversionsValue"] ?? 0);
  }
  return { platform: "google_ads", accountId: cleanCid(customerId), currency, ...t };
}

// ---------- tool registration ----------
export function registerGoogleAds(ctx: ToolContext): void {
  const g = ctx.creds.google!;
  const customerId = z.string().describe("Google Ads customer id of the client account (with or without dashes). Use google_ads_list_accounts to find it.");
  const loginCustomerId = z.string().optional().describe("Override the manager (MCC) id used as login-customer-id. Normally leave empty.");
  const campaignIds = z.array(z.string()).optional().describe("Restrict to these campaign ids");
  const limit = (d: number) => z.number().int().min(1).max(10_000).default(d).describe("Max rows");

  defineTool(
    ctx,
    "google_ads_list_accounts",
    {
      title: "Google Ads: list client accounts (MCC)",
      description:
        "Lists every Google Ads account under the configured manager account (MCC) (customer_client hierarchy) with id, name, status, currency and whether it is a manager. Use `search` to filter by client name.",
      input: {
        search: z.string().optional().describe("Case-insensitive filter on account name or id"),
        include_managers: z.boolean().default(false),
        include_inactive: z.boolean().default(false).describe("Include CANCELED/SUSPENDED/CLOSED accounts"),
        refresh: z.boolean().default(false).describe("Bypass the 10 minute cache"),
      },
    },
    async (a) => {
      let rows = await listGoogleAdsAccounts(g, a.refresh);
      if (!a.include_managers) rows = rows.filter((r) => !r.manager);
      if (!a.include_inactive) rows = rows.filter((r) => !r.status || r.status === "ENABLED");
      if (a.search) {
        const s = a.search.toLowerCase().replace(/-/g, "");
        rows = rows.filter((r) => String(r.name ?? "").toLowerCase().includes(s) || String(r.id).includes(s));
      }
      return { count: rows.length, accounts: rows };
    },
  );

  defineTool(
    ctx,
    "google_ads_query",
    {
      title: "Google Ads: run GAQL query",
      description:
        "Runs any Google Ads Query Language (GAQL) SELECT against a client account. Most flexible read tool: any resource, segment or metric. Money fields ending in _micros are returned converted to currency units (key without 'Micros'). Example: SELECT campaign.name, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC LIMIT 20",
      input: { customer_id: customerId, query: z.string().describe("GAQL query"), limit: limit(1000), login_customer_id: loginCustomerId },
    },
    async (a) => {
      const rows = await gaqlSearch(g, a.customer_id, a.query, { limit: a.limit, loginCustomerId: a.login_customer_id });
      return { rowCount: rows.length, rows: rows.map((r) => flattenRow(r)) };
    },
  );

  defineTool(
    ctx,
    "google_ads_account_performance",
    {
      title: "Google Ads: account performance",
      description: "Account-level KPIs (cost, impressions, clicks, CTR, CPC, conversions, value, CPA, ROAS) for a period, optionally split per day/week/month.",
      input: {
        customer_id: customerId,
        ...dateRangeShape,
        granularity: z.enum(["total", "day", "week", "month"]).default("total"),
        login_customer_id: loginCustomerId,
      },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const seg = a.granularity === "total" ? "" : `segments.${a.granularity === "day" ? "date" : a.granularity}, `;
      const rows = await gaqlSearch(g,
        a.customer_id,
        `SELECT customer.descriptive_name, customer.currency_code, ${seg}${METRICS}, metrics.search_impression_share FROM customer WHERE ${during(range)}${seg ? ` ORDER BY ${seg.slice(0, -2)}` : ""}`,
        { loginCustomerId: a.login_customer_id },
      );
      return { range, rows: rows.map((r) => withRoas(flattenRow(r))) };
    },
  );

  defineTool(
    ctx,
    "google_ads_campaign_performance",
    {
      title: "Google Ads: campaign performance",
      description:
        "Per-campaign KPIs with status, channel type, bidding strategy and daily budget. Sorted by cost. Filter on status or campaign ids.",
      input: {
        customer_id: customerId,
        ...dateRangeShape,
        status: z.enum(["ENABLED", "PAUSED", "ALL"]).default("ALL").describe("ALL excludes REMOVED"),
        campaign_ids: campaignIds,
        limit: limit(200),
        login_customer_id: loginCustomerId,
      },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const where = [during(range), a.status === "ALL" ? "campaign.status != 'REMOVED'" : `campaign.status = '${a.status}'`];
      if (a.campaign_ids?.length) where.push(`campaign.id IN (${a.campaign_ids.map(cleanCid).join(",")})`);
      const rows = await gaqlSearch(g,
        a.customer_id,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign_budget.amount_micros, ${METRICS}, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share FROM campaign WHERE ${where.join(" AND ")} ORDER BY metrics.cost_micros DESC LIMIT ${a.limit}`,
        { loginCustomerId: a.login_customer_id, limit: a.limit },
      );
      return { range, rows: rows.map((r) => withRoas(flattenRow(r))) };
    },
  );

  defineTool(
    ctx,
    "google_ads_ad_group_performance",
    {
      title: "Google Ads: ad group performance",
      description: "Per-ad-group KPIs, optionally limited to campaigns. Sorted by cost.",
      input: { customer_id: customerId, ...dateRangeShape, campaign_ids: campaignIds, limit: limit(300), login_customer_id: loginCustomerId },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const where = [during(range), "ad_group.status != 'REMOVED'"];
      if (a.campaign_ids?.length) where.push(`campaign.id IN (${a.campaign_ids.map(cleanCid).join(",")})`);
      const rows = await gaqlSearch(g,
        a.customer_id,
        `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.cpc_bid_micros, ${METRICS} FROM ad_group WHERE ${where.join(" AND ")} ORDER BY metrics.cost_micros DESC LIMIT ${a.limit}`,
        { loginCustomerId: a.login_customer_id, limit: a.limit },
      );
      return { range, rows: rows.map((r) => withRoas(flattenRow(r))) };
    },
  );

  defineTool(
    ctx,
    "google_ads_keyword_performance",
    {
      title: "Google Ads: keyword performance",
      description: "Keyword KPIs incl. match type, status, quality score and its components. Sorted by cost.",
      input: { customer_id: customerId, ...dateRangeShape, campaign_ids: campaignIds, limit: limit(300), login_customer_id: loginCustomerId },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const where = [during(range), "ad_group_criterion.status != 'REMOVED'", "ad_group_criterion.negative = FALSE"];
      if (a.campaign_ids?.length) where.push(`campaign.id IN (${a.campaign_ids.map(cleanCid).join(",")})`);
      const rows = await gaqlSearch(g,
        a.customer_id,
        `SELECT campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.quality_info.quality_score, ad_group_criterion.quality_info.creative_quality_score, ad_group_criterion.quality_info.post_click_quality_score, ad_group_criterion.quality_info.search_predicted_ctr, ${METRICS} FROM keyword_view WHERE ${where.join(" AND ")} ORDER BY metrics.cost_micros DESC LIMIT ${a.limit}`,
        { loginCustomerId: a.login_customer_id, limit: a.limit },
      );
      return { range, rows: rows.map((r) => withRoas(flattenRow(r))) };
    },
  );

  defineTool(
    ctx,
    "google_ads_search_terms",
    {
      title: "Google Ads: search terms report",
      description:
        "Actual search queries that triggered ads, with KPIs. Use to find negative keyword candidates (high cost, zero conversions) or new keywords. Set only_without_conversions to list wasted spend.",
      input: {
        customer_id: customerId,
        ...dateRangeShape,
        campaign_ids: campaignIds,
        min_cost: z.number().optional().describe("Only terms with at least this cost (account currency)"),
        only_without_conversions: z.boolean().default(false),
        limit: limit(300),
        login_customer_id: loginCustomerId,
      },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const where = [during(range)];
      if (a.campaign_ids?.length) where.push(`campaign.id IN (${a.campaign_ids.map(cleanCid).join(",")})`);
      if (a.min_cost) where.push(`metrics.cost_micros >= ${Math.round(a.min_cost * 1e6)}`);
      if (a.only_without_conversions) where.push("metrics.conversions = 0");
      const rows = await gaqlSearch(g,
        a.customer_id,
        `SELECT search_term_view.search_term, search_term_view.status, campaign.name, ad_group.name, ${METRICS} FROM search_term_view WHERE ${where.join(" AND ")} ORDER BY metrics.cost_micros DESC LIMIT ${a.limit}`,
        { loginCustomerId: a.login_customer_id, limit: a.limit },
      );
      return { range, rows: rows.map((r) => withRoas(flattenRow(r))) };
    },
  );

  defineTool(
    ctx,
    "google_ads_ad_performance",
    {
      title: "Google Ads: ads and creatives",
      description: "Ads with type, status, ad strength, approval status, final URLs, RSA headlines/descriptions and KPIs.",
      input: { customer_id: customerId, ...dateRangeShape, campaign_ids: campaignIds, limit: limit(200), login_customer_id: loginCustomerId },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const where = [during(range), "ad_group_ad.status != 'REMOVED'"];
      if (a.campaign_ids?.length) where.push(`campaign.id IN (${a.campaign_ids.map(cleanCid).join(",")})`);
      const rows = await gaqlSearch(g,
        a.customer_id,
        `SELECT campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status, ad_group_ad.ad_strength, ad_group_ad.policy_summary.approval_status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ${METRICS} FROM ad_group_ad WHERE ${where.join(" AND ")} ORDER BY metrics.cost_micros DESC LIMIT ${a.limit}`,
        { loginCustomerId: a.login_customer_id, limit: a.limit },
      );
      return {
        range,
        rows: rows.map((r) => {
          const f = withRoas(flattenRow(r));
          for (const k of ["adGroupAd.ad.responsiveSearchAd.headlines", "adGroupAd.ad.responsiveSearchAd.descriptions"]) {
            if (Array.isArray(f[k])) f[k] = (f[k] as any[]).map((x) => (x.pinnedField ? `${x.text} [${x.pinnedField}]` : x.text));
          }
          return f;
        }),
      };
    },
  );

  defineTool(
    ctx,
    "google_ads_breakdown",
    {
      title: "Google Ads: performance breakdown",
      description: "Campaign KPIs split by a segment: device, day of week, hour of day, network, conversion action or date.",
      input: {
        customer_id: customerId,
        ...dateRangeShape,
        dimension: z.enum(["device", "day_of_week", "hour", "ad_network_type", "conversion_action_name", "date"]),
        campaign_ids: campaignIds,
        login_customer_id: loginCustomerId,
      },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const where = [during(range)];
      if (a.campaign_ids?.length) where.push(`campaign.id IN (${a.campaign_ids.map(cleanCid).join(",")})`);
      // conversion_action_name cannot be combined with cost metrics
      const metrics = a.dimension === "conversion_action_name" ? "metrics.conversions, metrics.conversions_value, metrics.all_conversions" : METRICS;
      const rows = await gaqlSearch(g, a.customer_id, `SELECT segments.${a.dimension}, ${metrics} FROM customer WHERE ${where.join(" AND ")}`, {
        loginCustomerId: a.login_customer_id,
        limit: 5000,
      });
      return { range, rows: rows.map((r) => withRoas(flattenRow(r))) };
    },
  );

  defineTool(
    ctx,
    "google_ads_budget_pacing",
    {
      title: "Google Ads: month-to-date budget pacing",
      description:
        "For each enabled campaign: daily budget, month-to-date spend, expected spend so far, projected month spend and pacing %. Spots campaigns that under- or overspend.",
      input: { customer_id: customerId, login_customer_id: loginCustomerId },
    },
    async (a) => {
      const range = resolveDateRange({ date_range: "this_month" });
      const day = Number(range.end.slice(8, 10));
      const [y, m] = range.end.split("-").map(Number);
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const rows = await gaqlSearch(g,
        a.customer_id,
        `SELECT campaign.id, campaign.name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, metrics.cost_micros FROM campaign WHERE campaign.status = 'ENABLED' AND ${during(range)}`,
        { loginCustomerId: a.login_customer_id },
      );
      const out = rows.map((r) => {
        const f = flattenRow(r);
        const budget = Number(f["campaignBudget.amount"] ?? 0);
        const spend = Number(f["metrics.cost"] ?? 0);
        const expected = budget * day;
        return {
          campaignId: f["campaign.id"],
          campaign: f["campaign.name"],
          dailyBudget: budget,
          sharedBudget: f["campaignBudget.explicitlyShared"],
          spendMtd: spend,
          expectedMtd: Math.round(expected * 100) / 100,
          projectedMonth: Math.round((spend / Math.max(day, 1)) * daysInMonth * 100) / 100,
          pacingPct: expected > 0 ? Math.round((spend / expected) * 100) : null,
        };
      });
      return { period: range, dayOfMonth: day, daysInMonth, campaigns: out.sort((x, y2) => y2.spendMtd - x.spendMtd) };
    },
  );

  defineTool(
    ctx,
    "google_ads_change_history",
    {
      title: "Google Ads: change history",
      description: "Recent changes in the account (who changed what, when). Max 30 days back.",
      input: { customer_id: customerId, days: z.number().int().min(1).max(30).default(7), limit: limit(200), login_customer_id: loginCustomerId },
    },
    async (a) => {
      const end = new Date();
      const start = new Date(end.getTime() - a.days * 86400_000);
      const ts = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
      const rows = await gaqlSearch(g,
        a.customer_id,
        `SELECT change_event.change_date_time, change_event.user_email, change_event.client_type, change_event.change_resource_type, change_event.resource_change_operation, change_event.changed_fields, change_event.campaign, change_event.ad_group FROM change_event WHERE change_event.change_date_time >= '${ts(start)}' AND change_event.change_date_time <= '${ts(end)}' ORDER BY change_event.change_date_time DESC LIMIT ${a.limit}`,
        { loginCustomerId: a.login_customer_id, limit: a.limit },
      );
      return { rows: rows.map((r) => flattenRow(r)) };
    },
  );

  defineTool(
    ctx,
    "google_ads_recommendations",
    {
      title: "Google Ads: Google's recommendations",
      description: "Open optimization recommendations from Google (type, campaign, impact estimate). Review critically; many favour more spend.",
      input: { customer_id: customerId, limit: limit(100), login_customer_id: loginCustomerId },
    },
    async (a) => {
      const rows = await gaqlSearch(g,
        a.customer_id,
        `SELECT recommendation.type, recommendation.campaign, recommendation.impact.base_metrics.cost_micros, recommendation.impact.potential_metrics.cost_micros, recommendation.impact.base_metrics.conversions, recommendation.impact.potential_metrics.conversions, recommendation.dismissed FROM recommendation WHERE recommendation.dismissed = FALSE LIMIT ${a.limit}`,
        { loginCustomerId: a.login_customer_id, limit: a.limit },
      );
      return { rows: rows.map((r) => flattenRow(r)) };
    },
  );

  defineTool(
    ctx,
    "google_ads_conversion_actions",
    {
      title: "Google Ads: conversion actions",
      description: "Conversion actions with status, category, type, primary/secondary, counting and attribution model, plus conversions in the period.",
      input: { customer_id: customerId, ...dateRangeShape, login_customer_id: loginCustomerId },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const defs = await gaqlSearch(g,
        a.customer_id,
        "SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.primary_for_goal, conversion_action.counting_type, conversion_action.attribution_model_settings.attribution_model, conversion_action.include_in_conversions_metric FROM conversion_action WHERE conversion_action.status != 'REMOVED'",
        { loginCustomerId: a.login_customer_id },
      );
      const stats = await gaqlSearch(g,
        a.customer_id,
        `SELECT segments.conversion_action, metrics.all_conversions, metrics.all_conversions_value, metrics.conversions FROM customer WHERE ${during(range)}`,
        { loginCustomerId: a.login_customer_id },
      );
      const byAction = new Map<string, any>();
      for (const s of stats) byAction.set(String(s.segments?.conversionAction ?? "").split("/").pop()!, flattenRow(s.metrics));
      return {
        range,
        actions: defs.map((d) => {
          const f = flattenRow(d.conversionAction);
          return { ...f, ...(byAction.get(String(f.id)) ?? {}) };
        }),
      };
    },
  );

  defineTool(
    ctx,
    "google_ads_keyword_ideas",
    {
      title: "Google Ads: Keyword Planner ideas",
      description:
        "Keyword ideas with average monthly searches, competition and top-of-page bid range from Keyword Planner. Defaults to Belgium and Dutch. Language ids: 1010 Dutch, 1002 French, 1000 English, 1001 German. Geo ids: 2056 Belgium, 2528 Netherlands, 2250 France, 2276 Germany, 2442 Luxembourg.",
      input: {
        customer_id: customerId,
        keywords: z.array(z.string()).optional().describe("Seed keywords"),
        url: z.string().optional().describe("Seed URL (page or domain)"),
        language_id: z.string().default("1010"),
        geo_ids: z.array(z.string()).default(["2056"]),
        limit: z.number().int().min(1).max(1000).default(100),
        login_customer_id: loginCustomerId,
      },
    },
    async (a) => {
      if (!a.keywords?.length && !a.url) throw new Error("Provide keywords and/or url");
      const body: any = {
        language: `languageConstants/${a.language_id}`,
        geoTargetConstants: a.geo_ids.map((g) => `geoTargetConstants/${g}`),
        keywordPlanNetwork: "GOOGLE_SEARCH",
        pageSize: a.limit,
      };
      if (a.keywords?.length && a.url) body.keywordAndUrlSeed = { keywords: a.keywords, url: a.url };
      else if (a.keywords?.length) body.keywordSeed = { keywords: a.keywords };
      else body.urlSeed = { url: a.url };
      const res: any = await request("Google Ads", `${base(g)}/customers/${cleanCid(a.customer_id)}:generateKeywordIdeas`, {
        headers: await headers(g, a.login_customer_id),
        json: body,
      });
      return {
        ideas: (res.results ?? []).slice(0, a.limit).map((r: any) => ({
          keyword: r.text,
          avgMonthlySearches: Number(r.keywordIdeaMetrics?.avgMonthlySearches ?? 0),
          competition: r.keywordIdeaMetrics?.competition,
          competitionIndex: r.keywordIdeaMetrics?.competitionIndex,
          lowTopOfPageBid: r.keywordIdeaMetrics?.lowTopOfPageBidMicros ? Number(r.keywordIdeaMetrics.lowTopOfPageBidMicros) / 1e6 : null,
          highTopOfPageBid: r.keywordIdeaMetrics?.highTopOfPageBidMicros ? Number(r.keywordIdeaMetrics.highTopOfPageBidMicros) / 1e6 : null,
        })),
      };
    },
  );

  // ---------- writes ----------
  const resourcePath: Record<string, (cid: string, id: string) => { op: string; rn: string }> = {
    campaign: (cid, id) => ({ op: "campaignOperation", rn: `customers/${cid}/campaigns/${cleanCid(id)}` }),
    ad_group: (cid, id) => ({ op: "adGroupOperation", rn: `customers/${cid}/adGroups/${cleanCid(id)}` }),
    ad: (cid, id) => ({ op: "adGroupAdOperation", rn: `customers/${cid}/adGroupAds/${id}` }),
    keyword: (cid, id) => ({ op: "adGroupCriterionOperation", rn: `customers/${cid}/adGroupCriteria/${id}` }),
  };

  defineTool(
    ctx,
    "google_ads_set_status",
    {
      title: "Google Ads: pause / enable",
      description:
        "Pause or enable campaigns, ad groups, ads or keywords. Ids: campaign and ad_group use their numeric id; ad uses 'adGroupId~adId'; keyword uses 'adGroupId~criterionId'. The preview runs Google's validateOnly check.",
      input: {
        customer_id: customerId,
        entity: z.enum(["campaign", "ad_group", "ad", "keyword"]),
        ids: z.array(z.string()).min(1).max(1000),
        status: z.enum(["ENABLED", "PAUSED"]),
        login_customer_id: loginCustomerId,
      },
      write: true,
    },
    async (a, meta) => {
      const cid = cleanCid(a.customer_id);
      const ops = a.ids.map((id) => {
        const { op, rn } = resourcePath[a.entity](cid, id);
        return { [op]: { update: { resourceName: rn, status: a.status }, updateMask: "status" } };
      });
      const res = await mutate(g, cid, ops, meta.dryRun, a.login_customer_id);
      return { action: `${a.entity} -> ${a.status}`, count: ops.length, resources: ops.map((o: any) => Object.values(o)[0]), validated: meta.dryRun, result: res };
    },
  );

  defineTool(
    ctx,
    "google_ads_update_campaign_budget",
    {
      title: "Google Ads: change campaign daily budget",
      description: "Sets the daily budget (account currency) of the budget attached to a campaign. Warns when the budget is shared with other campaigns.",
      input: {
        customer_id: customerId,
        campaign_id: z.string(),
        daily_budget: z.number().positive().describe("New daily budget in account currency, e.g. 75.5"),
        login_customer_id: loginCustomerId,
      },
      write: true,
    },
    async (a, meta) => {
      const cid = cleanCid(a.customer_id);
      const [row] = await gaqlSearch(g,
        cid,
        `SELECT campaign.name, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count, customer.currency_code FROM campaign WHERE campaign.id = ${cleanCid(a.campaign_id)}`,
        { loginCustomerId: a.login_customer_id },
      );
      if (!row) throw new Error(`Campaign ${a.campaign_id} not found in ${cid}`);
      const ops = [
        {
          campaignBudgetOperation: {
            update: { resourceName: row.campaignBudget.resourceName, amountMicros: String(Math.round(a.daily_budget * 1e6)) },
            updateMask: "amount_micros",
          },
        },
      ];
      const res = await mutate(g, cid, ops, meta.dryRun, a.login_customer_id);
      return {
        campaign: row.campaign.name,
        currency: row.customer?.currencyCode,
        oldDailyBudget: Number(row.campaignBudget.amountMicros) / 1e6,
        newDailyBudget: a.daily_budget,
        sharedBudgetWarning: row.campaignBudget.explicitlyShared
          ? `This budget is shared by ${row.campaignBudget.referenceCount} campaigns; all of them are affected.`
          : undefined,
        result: res,
      };
    },
  );

  const keywordItem = z.object({
    text: z.string(),
    match_type: z.enum(["EXACT", "PHRASE", "BROAD"]).default("PHRASE"),
  });

  defineTool(
    ctx,
    "google_ads_add_negative_keywords",
    {
      title: "Google Ads: add negative keywords",
      description: "Adds negative keywords to a campaign (campaign_id) or an ad group (ad_group_id).",
      input: {
        customer_id: customerId,
        campaign_id: z.string().optional(),
        ad_group_id: z.string().optional(),
        keywords: z.array(keywordItem).min(1).max(500),
        login_customer_id: loginCustomerId,
      },
      write: true,
    },
    async (a, meta) => {
      const cid = cleanCid(a.customer_id);
      if (!a.campaign_id === !a.ad_group_id) throw new Error("Provide exactly one of campaign_id or ad_group_id");
      const ops = a.keywords.map((k) =>
        a.campaign_id
          ? { campaignCriterionOperation: { create: { campaign: `customers/${cid}/campaigns/${cleanCid(a.campaign_id)}`, negative: true, keyword: { text: k.text, matchType: k.match_type } } } }
          : { adGroupCriterionOperation: { create: { adGroup: `customers/${cid}/adGroups/${cleanCid(a.ad_group_id!)}`, negative: true, keyword: { text: k.text, matchType: k.match_type } } } },
      );
      return { level: a.campaign_id ? "campaign" : "ad_group", keywords: a.keywords, result: await mutate(g, cid, ops, meta.dryRun, a.login_customer_id) };
    },
  );

  defineTool(
    ctx,
    "google_ads_add_keywords",
    {
      title: "Google Ads: add keywords",
      description: "Adds (positive) keywords to an ad group, optionally with a max CPC bid.",
      input: {
        customer_id: customerId,
        ad_group_id: z.string(),
        keywords: z.array(keywordItem.extend({ max_cpc: z.number().positive().optional() })).min(1).max(500),
        status: z.enum(["ENABLED", "PAUSED"]).default("ENABLED"),
        login_customer_id: loginCustomerId,
      },
      write: true,
    },
    async (a, meta) => {
      const cid = cleanCid(a.customer_id);
      const ops = a.keywords.map((k) => ({
        adGroupCriterionOperation: {
          create: {
            adGroup: `customers/${cid}/adGroups/${cleanCid(a.ad_group_id)}`,
            status: a.status,
            keyword: { text: k.text, matchType: k.match_type },
            ...(k.max_cpc ? { cpcBidMicros: String(Math.round(k.max_cpc * 1e6)) } : {}),
          },
        },
      }));
      return { keywords: a.keywords, result: await mutate(g, cid, ops, meta.dryRun, a.login_customer_id) };
    },
  );

  defineTool(
    ctx,
    "google_ads_mutate",
    {
      title: "Google Ads: advanced mutate",
      description:
        "Escape hatch for any change the dedicated tools do not cover (bids, ad copy, assets, targeting, new campaigns...). Takes raw GoogleAdsService.Mutate `mutateOperations` (REST JSON, camelCase), e.g. [{\"adGroupOperation\":{\"update\":{\"resourceName\":\"customers/123/adGroups/456\",\"cpcBidMicros\":\"1500000\"},\"updateMask\":\"cpc_bid_micros\"}}]. Preview = Google validateOnly.",
      input: {
        customer_id: customerId,
        mutate_operations: z.array(z.record(z.string(), z.any())).min(1).max(2000),
        login_customer_id: loginCustomerId,
      },
      write: true,
      destructive: true,
    },
    async (a, meta) => ({
      operations: a.mutate_operations.length,
      result: await mutate(g, a.customer_id, a.mutate_operations, meta.dryRun, a.login_customer_id),
    }),
  );
}
