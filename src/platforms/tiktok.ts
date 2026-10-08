import { z } from "zod";
import { dateRangeShape, resolveDateRange, type DateRange } from "../lib/dates.js";
import { ApiError, request } from "../lib/http.js";
import { defineTool, fingerprint, KeyedCache, type ToolContext } from "../lib/tools.js";
import type { TikTokCredentials } from "../types.js";
import type { ChannelTotals } from "./totals.js";

const BASE = "https://business-api.tiktok.com/open_api/v1.3";

function encode(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

/** TikTok wraps everything in {code, message, data}; code != 0 is an error even with HTTP 200. */
function unwrap(res: any): any {
  if (res?.code !== 0) throw new ApiError("TikTok", 200, res, `TikTok API error ${res?.code}: ${res?.message}`);
  return res.data;
}

export async function ttGet(t: TikTokCredentials, path: string, params: Record<string, unknown> = {}): Promise<any> {
  return unwrap(await request("TikTok", `${BASE}/${path.replace(/^\//, "")}`, { headers: { "Access-Token": t.accessToken }, query: encode(params) }));
}

export async function ttPost(t: TikTokCredentials, path: string, body: Record<string, unknown>): Promise<any> {
  return unwrap(
    await request("TikTok", `${BASE}/${path.replace(/^\//, "")}`, { headers: { "Access-Token": t.accessToken }, json: body, retries: 0 }),
  );
}

async function ttGetAll(t: TikTokCredentials, path: string, params: Record<string, unknown>, limit = 1000): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const data = await ttGet(t, path, { ...params, page, page_size: Math.min(1000, limit) });
    out.push(...(data.list ?? []));
    const total = data.page_info?.total_page ?? 1;
    if (page >= total || out.length >= limit) break;
  }
  return out.slice(0, limit);
}

const advertiserCache = new KeyedCache<any[]>();
export async function listTikTokAdvertisers(t: TikTokCredentials, force = false): Promise<any[]> {
  const key = await fingerprint(t.accessToken, t.appId);
  return advertiserCache.get(key, force, () => loadAdvertisers(t));
}

async function loadAdvertisers(t: TikTokCredentials): Promise<any[]> {
  if (!t.appId || !t.secret) throw new Error("A TikTok app id and app secret are needed to list advertisers.");
  const data = await ttGet(t, "oauth2/advertiser/get/", { app_id: t.appId, secret: t.secret });
  const rows = (data.list ?? []).map((a: any) => ({ id: String(a.advertiser_id), name: a.advertiser_name }));
  return rows;
}

const DEFAULT_METRICS = ["spend", "impressions", "clicks", "ctr", "cpc", "cpm", "reach", "conversion", "cost_per_conversion", "conversion_rate", "complete_payment", "total_complete_payment_rate", "complete_payment_roas"];

async function report(t: TikTokCredentials, advertiserId: string, range: DateRange, level: string, dimensions: string[], metrics: string[], limit: number) {
  const rows: any[] = [];
  for (let page = 1; ; page++) {
    const data = await ttGet(t, "report/integrated/get/", {
      advertiser_id: advertiserId,
      report_type: "BASIC",
      data_level: level,
      dimensions,
      metrics,
      start_date: range.start,
      end_date: range.end,
      page,
      page_size: 1000,
    });
    for (const r of data.list ?? []) {
      const m: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r.metrics ?? {})) m[k] = typeof v === "string" && v !== "" && !isNaN(Number(v)) ? Number(v) : v;
      rows.push({ ...r.dimensions, ...m });
    }
    if (page >= (data.page_info?.total_page ?? 1) || rows.length >= limit) break;
  }
  return rows.slice(0, limit);
}

export async function tikTokTotals(t: TikTokCredentials, advertiserId: string, range: DateRange): Promise<ChannelTotals> {
  const [r] = await report(t, advertiserId, range, "AUCTION_ADVERTISER", ["advertiser_id"], ["spend", "impressions", "clicks", "conversion", "total_complete_payment_rate", "currency", "advertiser_name"], 1);
  return {
    platform: "tiktok",
    accountId: advertiserId,
    accountName: r?.advertiser_name,
    currency: r?.currency,
    spend: Number(r?.spend ?? 0),
    impressions: Number(r?.impressions ?? 0),
    clicks: Number(r?.clicks ?? 0),
    conversions: Number(r?.conversion ?? 0),
    conversionValue: Number(r?.total_complete_payment_rate ?? 0),
  };
}

export function registerTikTok(ctx: ToolContext): void {
  const t = ctx.creds.tiktok!;
  const advertiserId = z.string().describe("TikTok advertiser id. Use tiktok_list_advertisers.");

  defineTool(
    ctx,
    "tiktok_list_advertisers",
    {
      title: "TikTok: list advertisers",
      description: "Lists TikTok Ads advertiser accounts authorised for the connected app.",
      input: { search: z.string().optional(), refresh: z.boolean().default(false) },
    },
    async (a) => {
      let rows = await listTikTokAdvertisers(t, a.refresh);
      if (a.search) rows = rows.filter((r) => `${r.name} ${r.id}`.toLowerCase().includes(a.search!.toLowerCase()));
      return { count: rows.length, advertisers: rows };
    },
  );

  defineTool(
    ctx,
    "tiktok_report",
    {
      title: "TikTok: performance report",
      description:
        "TikTok Ads report at advertiser, campaign, ad group or ad level. Set daily=true for a split per day (max 30 days per request then). Metrics default to spend, impressions, clicks, CTR, CPC, CPM, reach, conversions, CPA, purchases and purchase value/ROAS. Names are included automatically.",
      input: {
        advertiser_id: advertiserId,
        ...dateRangeShape,
        level: z.enum(["advertiser", "campaign", "adgroup", "ad"]).default("campaign"),
        daily: z.boolean().default(false),
        metrics: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(10_000).default(500),
      },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const map = {
        advertiser: { level: "AUCTION_ADVERTISER", dim: "advertiser_id", names: ["advertiser_name"] },
        campaign: { level: "AUCTION_CAMPAIGN", dim: "campaign_id", names: ["campaign_name"] },
        adgroup: { level: "AUCTION_ADGROUP", dim: "adgroup_id", names: ["campaign_name", "adgroup_name"] },
        ad: { level: "AUCTION_AD", dim: "ad_id", names: ["campaign_name", "adgroup_name", "ad_name"] },
      }[a.level];
      const dims = a.daily ? [map.dim, "stat_time_day"] : [map.dim];
      const rows = await report(t, a.advertiser_id, range, map.level, dims, [...map.names, ...(a.metrics ?? DEFAULT_METRICS)], a.limit);
      return { range, rows: rows.sort((x, y) => Number(y.spend ?? 0) - Number(x.spend ?? 0)) };
    },
  );

  defineTool(
    ctx,
    "tiktok_list_campaigns",
    {
      title: "TikTok: campaigns / ad groups / ads",
      description: "Lists campaigns, ad groups or ads of an advertiser with status, objective, budget and settings.",
      input: {
        advertiser_id: advertiserId,
        entity: z.enum(["campaign", "adgroup", "ad"]).default("campaign"),
        campaign_ids: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(5000).default(500),
      },
    },
    async (a) => {
      const filtering = a.campaign_ids?.length ? { campaign_ids: a.campaign_ids } : undefined;
      return { items: await ttGetAll(t, `${a.entity}/get/`, { advertiser_id: a.advertiser_id, filtering }, a.limit) };
    },
  );

  defineTool(
    ctx,
    "tiktok_get",
    {
      title: "TikTok: raw API GET",
      description: "Raw GET on the TikTok Business API v1.3, e.g. path 'pixel/list/' or 'audience/list/'. Params are JSON-encoded where needed.",
      input: { path: z.string(), params: z.record(z.string(), z.any()).default({}) },
    },
    async (a) => ttGet(t, a.path, a.params),
  );

  defineTool(
    ctx,
    "tiktok_set_status",
    {
      title: "TikTok: pause / enable",
      description: "Enable or disable TikTok campaigns, ad groups or ads.",
      input: {
        advertiser_id: advertiserId,
        entity: z.enum(["campaign", "adgroup", "ad"]),
        ids: z.array(z.string()).min(1).max(100),
        status: z.enum(["ENABLE", "DISABLE"]),
      },
      write: true,
    },
    async (a, meta) => {
      const idKey = `${a.entity}_ids`;
      const current = await ttGetAll(t, `${a.entity}/get/`, { advertiser_id: a.advertiser_id, filtering: { [idKey]: a.ids } }, a.ids.length);
      const preview = current.map((c) => ({ id: c[`${a.entity}_id`], name: c[`${a.entity}_name`], from: c.operation_status, to: a.status }));
      if (meta.dryRun) return { changes: preview };
      const res = await ttPost(t, `${a.entity}/status/update/`, { advertiser_id: a.advertiser_id, [idKey]: a.ids, operation_status: a.status });
      return { changes: preview, result: res };
    },
  );

  defineTool(
    ctx,
    "tiktok_update_budget",
    {
      title: "TikTok: change budget",
      description: "Changes the budget of a TikTok campaign or ad group (account currency).",
      input: { advertiser_id: advertiserId, entity: z.enum(["campaign", "adgroup"]), id: z.string(), budget: z.number().positive() },
      write: true,
    },
    async (a, meta) => {
      const [current] = await ttGetAll(t, `${a.entity}/get/`, { advertiser_id: a.advertiser_id, filtering: { [`${a.entity}_ids`]: [a.id] } }, 1);
      if (!current) throw new Error(`${a.entity} ${a.id} not found`);
      const preview = { id: a.id, name: current[`${a.entity}_name`], budgetMode: current.budget_mode, from: current.budget, to: a.budget };
      if (meta.dryRun) return preview;
      const res =
        a.entity === "campaign"
          ? await ttPost(t, "campaign/update/", { advertiser_id: a.advertiser_id, campaign_id: a.id, budget: a.budget })
          : await ttPost(t, "adgroup/budget/update/", { advertiser_id: a.advertiser_id, budget: [{ adgroup_id: a.id, budget: a.budget }] });
      return { ...preview, result: res };
    },
  );
}
