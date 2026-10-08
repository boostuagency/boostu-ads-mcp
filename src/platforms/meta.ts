import { createHmac } from "node:crypto";
import { z } from "zod";
import { dateRangeShape, resolveDateRange, type DateRange } from "../lib/dates.js";
import { request } from "../lib/http.js";
import { defineTool, fingerprint, KeyedCache, type ToolContext } from "../lib/tools.js";
import type { MetaCredentials } from "../types.js";
import type { ChannelTotals } from "./totals.js";

const base = (m: MetaCredentials) => `https://graph.facebook.com/${m.apiVersion ?? "v26.0"}`;

// Currencies without minor units: Meta budgets are expressed in the smallest unit of the currency.
const ZERO_DECIMAL = new Set(["JPY", "KRW", "CLP", "COP", "CRC", "HUF", "ISK", "IDR", "PYG", "TWD", "VND"]);
const minorFactor = (currency?: string) => (currency && ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100);

/** Action types counted as "conversions" in cross-channel totals. */
const conversionActions = (m: MetaCredentials) => m.conversionActions?.length ? m.conversionActions : ["purchase", "lead"];

export const actId = (id: string) => (String(id).startsWith("act_") ? String(id) : `act_${String(id).replace(/[^0-9]/g, "")}`);

function authParams(m: MetaCredentials): Record<string, string> {
  const p: Record<string, string> = { access_token: m.accessToken };
  if (m.appSecret) {
    p.appsecret_proof = createHmac("sha256", m.appSecret).update(m.accessToken).digest("hex");
  }
  return p;
}

function encodeParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

export async function graphGet(m: MetaCredentials, path: string, params: Record<string, unknown> = {}): Promise<any> {
  return request("Meta", `${base(m)}/${path.replace(/^\//, "")}`, { query: { ...encodeParams(params), ...authParams(m) } });
}

export async function graphPost(m: MetaCredentials, path: string, params: Record<string, unknown> = {}): Promise<any> {
  return request("Meta", `${base(m)}/${path.replace(/^\//, "")}`, { form: { ...encodeParams(params), ...authParams(m) }, retries: 0 });
}

/** Follows paging.next until `limit` items are collected. */
export async function graphGetAll(m: MetaCredentials, path: string, params: Record<string, unknown>, limit = 1000): Promise<any[]> {
  const out: any[] = [];
  let res = await graphGet(m, path, { limit: Math.min(limit, 500), ...params });
  out.push(...(res.data ?? []));
  while (res.paging?.next && out.length < limit) {
    res = await request("Meta", res.paging.next);
    out.push(...(res.data ?? []));
  }
  return out.slice(0, limit);
}

const timeRange = (r: DateRange) => ({ since: r.start, until: r.end });

/** Turns Meta's [{action_type, value}] arrays into {type: number}. */
function actionMap(list: any[] | undefined): Record<string, number> | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: Record<string, number> = {};
  for (const a of list) out[a.action_type] = Number(a.value);
  return out;
}

function tidyInsight(row: any): any {
  const out: any = { ...row };
  for (const k of ["actions", "action_values", "cost_per_action_type", "purchase_roas", "website_purchase_roas", "conversions", "conversion_values"]) {
    if (row[k]) out[k] = actionMap(row[k]);
  }
  for (const k of ["spend", "impressions", "clicks", "reach", "frequency", "ctr", "cpc", "cpm", "inline_link_clicks", "inline_link_click_ctr"]) {
    if (row[k] !== undefined) out[k] = Number(row[k]);
  }
  return out;
}

// ---------- accounts (cached) ----------
const accountCache = new KeyedCache<any[]>();
const ACCOUNT_FIELDS = "name,account_id,account_status,currency,timezone_name,business{id,name},amount_spent,disable_reason";

export async function listMetaAdAccounts(m: MetaCredentials, force = false): Promise<any[]> {
  const key = await fingerprint(m.accessToken, m.businessId);
  return accountCache.get(key, force, () => loadAccounts(m));
}

async function loadAccounts(m: MetaCredentials): Promise<any[]> {
  const seen = new Map<string, any>();
  const add = (rows: any[]) => rows.forEach((r) => seen.set(r.id, r));
  add(await graphGetAll(m, "me/adaccounts", { fields: ACCOUNT_FIELDS }, 5000));
  if (m.businessId) {
    add(await graphGetAll(m, `${m.businessId}/owned_ad_accounts`, { fields: ACCOUNT_FIELDS }, 5000).catch(() => []));
    add(await graphGetAll(m, `${m.businessId}/client_ad_accounts`, { fields: ACCOUNT_FIELDS }, 5000).catch(() => []));
  }
  const STATUS: Record<number, string> = { 1: "ACTIVE", 2: "DISABLED", 3: "UNSETTLED", 7: "PENDING_RISK_REVIEW", 8: "PENDING_SETTLEMENT", 9: "IN_GRACE_PERIOD", 100: "PENDING_CLOSURE", 101: "CLOSED", 201: "ANY_ACTIVE", 202: "ANY_CLOSED" };
  const rows = [...seen.values()].map((r) => ({
    id: r.id,
    name: r.name,
    status: STATUS[r.account_status] ?? r.account_status,
    currency: r.currency,
    timezone: r.timezone_name,
    business: r.business?.name,
    lifetimeSpend: r.amount_spent ? Number(r.amount_spent) / minorFactor(r.currency) : undefined,
  }));
  return rows;
}

export async function metaTotals(m: MetaCredentials, accountId: string, range: DateRange): Promise<ChannelTotals> {
  const [row] = await graphGetAll(m, `${actId(accountId)}/insights`, {
    level: "account",
    time_range: timeRange(range),
    fields: "account_name,account_currency,spend,impressions,clicks,actions,action_values",
  });
  const actions = actionMap(row?.actions) ?? {};
  const values = actionMap(row?.action_values) ?? {};
  return {
    platform: "meta",
    accountId: actId(accountId),
    accountName: row?.account_name,
    currency: row?.account_currency,
    spend: Number(row?.spend ?? 0),
    impressions: Number(row?.impressions ?? 0),
    clicks: Number(row?.clicks ?? 0),
    conversions: conversionActions(m).reduce((s, t) => s + (actions[t] ?? 0), 0),
    conversionValue: conversionActions(m).reduce((s, t) => s + (values[t] ?? 0), 0),
  };
}

// ---------- tools ----------
export function registerMeta(ctx: ToolContext): void {
  const m = ctx.creds.meta!;
  const accountId = z.string().describe("Meta ad account id (act_123... or just the number). Use meta_list_ad_accounts to find it.");
  const limit = (d: number) => z.number().int().min(1).max(5000).default(d).describe("Max rows");

  defineTool(
    ctx,
    "meta_list_ad_accounts",
    {
      title: "Meta: list ad accounts",
      description: "Lists all Meta (Facebook/Instagram) ad accounts the connected token / Business Manager can access, with status, currency and business. Filter with `search`.",
      input: {
        search: z.string().optional(),
        only_active: z.boolean().default(true),
        refresh: z.boolean().default(false),
      },
    },
    async (a) => {
      let rows = await listMetaAdAccounts(m, a.refresh);
      if (a.only_active) rows = rows.filter((r) => r.status === "ACTIVE");
      if (a.search) {
        const s = a.search.toLowerCase();
        rows = rows.filter((r) => `${r.name} ${r.id} ${r.business ?? ""}`.toLowerCase().includes(s));
      }
      return { count: rows.length, accounts: rows };
    },
  );

  defineTool(
    ctx,
    "meta_insights",
    {
      title: "Meta: performance insights",
      description:
        "Performance from the Meta Insights API at account, campaign, adset or ad level with optional breakdowns (age, gender, country, region, publisher_platform, platform_position, device_platform, impression_device) and daily/monthly split. actions/action_values/cost_per_action_type are returned as {action_type: value} maps (e.g. purchase, lead, link_click, add_to_cart).",
      input: {
        account_id: accountId,
        ...dateRangeShape,
        level: z.enum(["account", "campaign", "adset", "ad"]).default("campaign"),
        breakdowns: z.array(z.string()).optional().describe("e.g. ['age','gender'] or ['publisher_platform','platform_position']"),
        time_increment: z.enum(["all_days", "1", "7", "monthly"]).default("all_days").describe("'1' = per day"),
        campaign_ids: z.array(z.string()).optional(),
        adset_ids: z.array(z.string()).optional(),
        fields: z.array(z.string()).optional().describe("Override the default field list"),
        attribution_windows: z.array(z.string()).optional().describe("e.g. ['7d_click','1d_view']; default = account setting"),
        limit: limit(500),
      },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const levelFields: Record<string, string[]> = {
        account: ["account_id", "account_name"],
        campaign: ["campaign_id", "campaign_name", "objective"],
        adset: ["campaign_name", "adset_id", "adset_name"],
        ad: ["campaign_name", "adset_name", "ad_id", "ad_name"],
      };
      const fields = a.fields ?? [
        ...levelFields[a.level],
        "account_currency",
        "spend",
        "impressions",
        "reach",
        "frequency",
        "clicks",
        "inline_link_clicks",
        "ctr",
        "cpc",
        "cpm",
        "actions",
        "action_values",
        "cost_per_action_type",
        "purchase_roas",
      ];
      const filtering: any[] = [];
      if (a.campaign_ids?.length) filtering.push({ field: "campaign.id", operator: "IN", value: a.campaign_ids });
      if (a.adset_ids?.length) filtering.push({ field: "adset.id", operator: "IN", value: a.adset_ids });
      const rows = await graphGetAll(m, 
        `${actId(a.account_id)}/insights`,
        {
          level: a.level,
          time_range: timeRange(range),
          time_increment: a.time_increment,
          fields: fields.join(","),
          breakdowns: a.breakdowns?.join(","),
          filtering: filtering.length ? filtering : undefined,
          action_attribution_windows: a.attribution_windows,
        },
        a.limit,
      );
      return { range, rowCount: rows.length, rows: rows.map(tidyInsight) };
    },
  );

  defineTool(
    ctx,
    "meta_list_campaigns",
    {
      title: "Meta: campaigns",
      description: "Campaigns of an ad account with status, objective, buying type, bid strategy and budgets (converted to currency units).",
      input: {
        account_id: accountId,
        effective_status: z.array(z.string()).optional().describe("e.g. ['ACTIVE','PAUSED']. Default: all except deleted/archived"),
        limit: limit(200),
      },
    },
    async (a) => {
      const acc = await graphGet(m, actId(a.account_id), { fields: "currency" });
      const f = minorFactor(acc.currency);
      const rows = await graphGetAll(m, 
        `${actId(a.account_id)}/campaigns`,
        {
          fields: "id,name,status,effective_status,objective,buying_type,bid_strategy,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,special_ad_categories",
          effective_status: a.effective_status ?? ["ACTIVE", "PAUSED", "IN_PROCESS", "WITH_ISSUES", "CAMPAIGN_PAUSED"],
        },
        a.limit,
      );
      return {
        currency: acc.currency,
        campaigns: rows.map((r) => ({
          ...r,
          daily_budget: r.daily_budget ? Number(r.daily_budget) / f : undefined,
          lifetime_budget: r.lifetime_budget ? Number(r.lifetime_budget) / f : undefined,
          budget_remaining: r.budget_remaining ? Number(r.budget_remaining) / f : undefined,
        })),
      };
    },
  );

  defineTool(
    ctx,
    "meta_list_adsets",
    {
      title: "Meta: ad sets",
      description: "Ad sets with status, optimization goal, billing event, bid strategy, budgets, schedule and targeting.",
      input: {
        account_id: accountId,
        campaign_id: z.string().optional().describe("Only ad sets of this campaign"),
        effective_status: z.array(z.string()).optional(),
        include_targeting: z.boolean().default(true),
        limit: limit(200),
      },
    },
    async (a) => {
      const acc = await graphGet(m, actId(a.account_id), { fields: "currency" });
      const f = minorFactor(acc.currency);
      const fields = `id,name,campaign_id,status,effective_status,optimization_goal,billing_event,bid_strategy,bid_amount,daily_budget,lifetime_budget,start_time,end_time${a.include_targeting ? ",targeting" : ""}`;
      const rows = await graphGetAll(m, 
        a.campaign_id ? `${a.campaign_id}/adsets` : `${actId(a.account_id)}/adsets`,
        { fields, effective_status: a.effective_status ?? ["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES"] },
        a.limit,
      );
      return {
        currency: acc.currency,
        adsets: rows.map((r) => ({
          ...r,
          daily_budget: r.daily_budget ? Number(r.daily_budget) / f : undefined,
          lifetime_budget: r.lifetime_budget ? Number(r.lifetime_budget) / f : undefined,
          bid_amount: r.bid_amount ? Number(r.bid_amount) / f : undefined,
        })),
      };
    },
  );

  defineTool(
    ctx,
    "meta_list_ads",
    {
      title: "Meta: ads and creatives",
      description: "Ads with status, review feedback and creative details (headline, primary text, link, CTA, image/thumbnail URL).",
      input: {
        account_id: accountId,
        campaign_id: z.string().optional(),
        adset_id: z.string().optional(),
        effective_status: z.array(z.string()).optional(),
        limit: limit(200),
      },
    },
    async (a) => {
      const parent = a.adset_id ?? a.campaign_id ?? actId(a.account_id);
      const rows = await graphGetAll(m, 
        `${parent}/ads`,
        {
          fields:
            "id,name,adset_id,campaign_id,status,effective_status,ad_review_feedback,created_time,creative{id,name,title,body,object_type,call_to_action_type,image_url,thumbnail_url,link_url,object_story_spec,asset_feed_spec,instagram_permalink_url,effective_object_story_id}",
          effective_status: a.effective_status ?? ["ACTIVE", "PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED", "PENDING_REVIEW", "DISAPPROVED", "WITH_ISSUES"],
        },
        a.limit,
      );
      return { ads: rows };
    },
  );

  defineTool(
    ctx,
    "meta_graph_get",
    {
      title: "Meta: raw Graph API GET",
      description:
        "Read anything from the Meta Graph / Marketing API: e.g. path 'act_123/customaudiences' with fields 'id,name,approximate_count_lower_bound', '<page_id>/leadgen_forms', 'act_123/adspixels', '<business_id>/owned_pages'. Read-only.",
      input: {
        path: z.string().describe("Node or edge path without version, e.g. 'act_123/customaudiences'"),
        params: z.record(z.string(), z.any()).optional().describe("Query params, e.g. {fields: 'id,name'}"),
        limit: limit(200),
      },
    },
    async (a) => {
      const res = await graphGet(m, a.path, { limit: Math.min(a.limit, 500), ...a.params });
      if (Array.isArray(res.data) && res.paging?.next && res.data.length < a.limit) {
        return { data: await graphGetAll(m, a.path, a.params ?? {}, a.limit) };
      }
      return res;
    },
  );

  // ---------- writes ----------
  defineTool(
    ctx,
    "meta_set_status",
    {
      title: "Meta: pause / activate",
      description: "Sets status ACTIVE or PAUSED on campaigns, ad sets or ads (any mix of ids). Preview shows current status and runs Meta's validate_only check.",
      input: { ids: z.array(z.string()).min(1).max(200), status: z.enum(["ACTIVE", "PAUSED"]) },
      write: true,
    },
    async (a, meta) => {
      const results = [];
      for (const id of a.ids) {
        const current = await graphGet(m, id, { fields: "name,status,effective_status" });
        const res = await graphPost(m, id, { status: a.status, ...(meta.dryRun ? { execution_options: ["validate_only"] } : {}) });
        results.push({ id, name: current.name, from: current.status, to: a.status, result: res });
      }
      return { results };
    },
  );

  defineTool(
    ctx,
    "meta_update_budget",
    {
      title: "Meta: change budget",
      description: "Changes the daily or lifetime budget (in account currency units, e.g. 50 = EUR 50) of a campaign (CBO/Advantage+ budget) or an ad set.",
      input: {
        id: z.string().describe("Campaign id or ad set id"),
        daily_budget: z.number().positive().optional(),
        lifetime_budget: z.number().positive().optional(),
      },
      write: true,
    },
    async (a, meta) => {
      if (!a.daily_budget === !a.lifetime_budget) throw new Error("Provide exactly one of daily_budget or lifetime_budget");
      const current = await graphGet(m, a.id, { fields: "name,daily_budget,lifetime_budget,account_id" });
      const acc = await graphGet(m, actId(current.account_id), { fields: "currency" });
      const f = minorFactor(acc.currency);
      const params: Record<string, unknown> = a.daily_budget
        ? { daily_budget: Math.round(a.daily_budget * f) }
        : { lifetime_budget: Math.round(a.lifetime_budget! * f) };
      const res = await graphPost(m, a.id, { ...params, ...(meta.dryRun ? { execution_options: ["validate_only"] } : {}) });
      return {
        id: a.id,
        name: current.name,
        currency: acc.currency,
        old: { daily_budget: current.daily_budget ? Number(current.daily_budget) / f : null, lifetime_budget: current.lifetime_budget ? Number(current.lifetime_budget) / f : null },
        new: { daily_budget: a.daily_budget ?? null, lifetime_budget: a.lifetime_budget ?? null },
        result: res,
      };
    },
  );

  defineTool(
    ctx,
    "meta_graph_post",
    {
      title: "Meta: raw Graph API POST",
      description:
        "Escape hatch for any Marketing API write (create campaign/ad set/ad, update bids, targeting, creatives, audiences...). Budgets/bids are in minor units (cents). Preview adds execution_options=['validate_only'] where Meta supports it; endpoints that do not support it will error in preview.",
      input: {
        path: z.string().describe("e.g. 'act_123/campaigns' to create, or '<adset_id>' to update"),
        params: z.record(z.string(), z.any()).describe("Body params; objects/arrays are JSON-encoded automatically"),
        method: z.enum(["POST", "DELETE"]).default("POST"),
      },
      write: true,
      destructive: true,
    },
    async (a, meta) => {
      if (meta.dryRun) {
        if (a.method === "DELETE") return { wouldDelete: a.path, current: await graphGet(m, a.path).catch((e) => String(e)) };
        return { path: a.path, params: a.params, validation: await graphPost(m, a.path, { ...a.params, execution_options: ["validate_only"] }) };
      }
      if (a.method === "DELETE") {
        return request("Meta", `${base(m)}/${a.path}`, { method: "DELETE", query: authParams(m), retries: 0 });
      }
      return graphPost(m, a.path, a.params);
    },
  );
}
