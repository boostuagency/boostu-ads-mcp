import { z } from "zod";
import { dateRangeShape, resolveDateRange } from "../lib/dates.js";
import { request } from "../lib/http.js";
import { defineTool, fingerprint, KeyedCache, type ToolContext } from "../lib/tools.js";
import type { GoogleCredentials } from "../types.js";
import { googleAccessToken } from "./googleAuth.js";

const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const DATA = "https://analyticsdata.googleapis.com/v1beta";

const auth = async (g: GoogleCredentials) => ({ Authorization: `Bearer ${await googleAccessToken(g, "analytics")}` });
export const propId = (id: string) => String(id).replace(/^properties\//, "").replace(/[^0-9]/g, "");

const propertyCache = new KeyedCache<any[]>();

export async function listGa4Properties(g: GoogleCredentials, force = false): Promise<any[]> {
  const key = await fingerprint(g.clientId, g.analyticsRefreshToken || g.refreshToken);
  return propertyCache.get(key, force, () => loadProperties(g));
}

async function loadProperties(g: GoogleCredentials): Promise<any[]> {
  const rows: any[] = [];
  let pageToken: string | undefined;
  do {
    const res: any = await request("GA4", `${ADMIN}/accountSummaries`, { headers: await auth(g), query: { pageSize: 200, pageToken } });
    for (const acc of res.accountSummaries ?? []) {
      for (const p of acc.propertySummaries ?? []) {
        rows.push({ propertyId: propId(p.property), name: p.displayName, account: acc.displayName, accountId: String(acc.account).split("/")[1], type: p.propertyType });
      }
    }
    pageToken = res.nextPageToken;
  } while (pageToken);
  return rows;
}

/** Converts GA4's header + row arrays into plain objects. */
function tidyReport(res: any) {
  const dims = (res.dimensionHeaders ?? []).map((h: any) => h.name);
  const mets = (res.metricHeaders ?? []).map((h: any) => h.name);
  const toObj = (r: any) => {
    const o: Record<string, unknown> = {};
    dims.forEach((d: string, i: number) => (o[d] = r.dimensionValues?.[i]?.value));
    mets.forEach((m: string, i: number) => (o[m] = Number(r.metricValues?.[i]?.value)));
    return o;
  };
  return {
    rowCount: res.rowCount ?? 0,
    rows: (res.rows ?? []).map(toObj),
    totals: res.totals?.length ? toObj(res.totals[0]) : undefined,
    metadata: res.metadata?.samplingMetadatas ? { sampling: res.metadata.samplingMetadatas } : undefined,
  };
}

export async function runGa4Report(g: GoogleCredentials, propertyId: string, body: Record<string, unknown>) {
  return tidyReport(await request("GA4", `${DATA}/properties/${propId(propertyId)}:runReport`, { headers: await auth(g), json: body }));
}

export function registerGa4(ctx: ToolContext): void {
  const g = ctx.creds.google!;
  const propertyId = z.string().describe("GA4 property id (numeric). Use ga4_list_properties to find it.");

  defineTool(
    ctx,
    "ga4_list_properties",
    {
      title: "GA4: list properties",
      description: "Lists all Google Analytics 4 accounts and properties the connected Google user can access. Filter with `search`.",
      input: { search: z.string().optional(), refresh: z.boolean().default(false) },
    },
    async (a) => {
      let rows = await listGa4Properties(g, a.refresh);
      if (a.search) {
        const s = a.search.toLowerCase();
        rows = rows.filter((r) => `${r.name} ${r.account} ${r.propertyId}`.toLowerCase().includes(s));
      }
      return { count: rows.length, properties: rows };
    },
  );

  defineTool(
    ctx,
    "ga4_run_report",
    {
      title: "GA4: run report",
      description:
        "Runs a GA4 Data API report. Common dimensions: date, sessionDefaultChannelGroup, sessionSourceMedium, sessionCampaignName, landingPage, pagePath, deviceCategory, country, eventName. Common metrics: sessions, totalUsers, newUsers, engagedSessions, engagementRate, averageSessionDuration, screenPageViews, keyEvents, eventCount, purchaseRevenue, transactions, ecommercePurchases, advertiserAdCost, returnOnAdSpend. Use ga4_get_metadata for custom dimensions/metrics.",
      input: {
        property_id: propertyId,
        ...dateRangeShape,
        dimensions: z.array(z.string()).default([]),
        metrics: z.array(z.string()).min(1),
        dimension_filter: z.record(z.string(), z.any()).optional().describe("Raw GA4 FilterExpression, e.g. {filter:{fieldName:'sessionDefaultChannelGroup',stringFilter:{value:'Paid Search'}}}"),
        metric_filter: z.record(z.string(), z.any()).optional(),
        order_by_metric: z.string().optional().describe("Metric to sort descending by"),
        compare_previous_period: z.boolean().default(false).describe("Adds the preceding period of equal length as a second date range"),
        limit: z.number().int().min(1).max(100_000).default(250),
      },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const dateRanges: any[] = [{ startDate: range.start, endDate: range.end, name: "current" }];
      if (a.compare_previous_period) {
        const s = new Date(`${range.start}T00:00:00Z`);
        const e = new Date(`${range.end}T00:00:00Z`);
        const days = Math.round((e.getTime() - s.getTime()) / 86400_000) + 1;
        const ps = new Date(s.getTime() - days * 86400_000);
        const pe = new Date(s.getTime() - 86400_000);
        dateRanges.push({ startDate: ps.toISOString().slice(0, 10), endDate: pe.toISOString().slice(0, 10), name: "previous" });
      }
      const res = await runGa4Report(g, a.property_id, {
        dateRanges,
        dimensions: a.dimensions.map((name) => ({ name })),
        metrics: a.metrics.map((name) => ({ name })),
        dimensionFilter: a.dimension_filter,
        metricFilter: a.metric_filter,
        orderBys: a.order_by_metric ? [{ metric: { metricName: a.order_by_metric }, desc: true }] : undefined,
        limit: a.limit,
        metricAggregations: ["TOTAL"],
      });
      return { range, ...res };
    },
  );

  defineTool(
    ctx,
    "ga4_traffic_overview",
    {
      title: "GA4: traffic and conversions by channel",
      description: "Quick overview per default channel group (or source/medium or campaign): sessions, users, engagement rate, key events, transactions and revenue.",
      input: {
        property_id: propertyId,
        ...dateRangeShape,
        group_by: z.enum(["sessionDefaultChannelGroup", "sessionSourceMedium", "sessionCampaignName", "landingPage"]).default("sessionDefaultChannelGroup"),
        limit: z.number().int().min(1).max(1000).default(50),
      },
    },
    async (a) => {
      const range = resolveDateRange(a);
      return {
        range,
        ...(await runGa4Report(g, a.property_id, {
          dateRanges: [{ startDate: range.start, endDate: range.end }],
          dimensions: [{ name: a.group_by }],
          metrics: ["sessions", "totalUsers", "engagementRate", "keyEvents", "transactions", "purchaseRevenue"].map((name) => ({ name })),
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: a.limit,
          metricAggregations: ["TOTAL"],
        })),
      };
    },
  );

  defineTool(
    ctx,
    "ga4_realtime_report",
    {
      title: "GA4: realtime",
      description: "Active users in the last 30 minutes, optionally split by a realtime dimension (country, deviceCategory, unifiedScreenName, eventName, minutesAgo).",
      input: {
        property_id: propertyId,
        dimensions: z.array(z.string()).default([]),
        metrics: z.array(z.string()).default(["activeUsers"]),
        limit: z.number().int().min(1).max(10_000).default(50),
      },
    },
    async (a) =>
      tidyReport(
        await request("GA4", `${DATA}/properties/${propId(a.property_id)}:runRealtimeReport`, {
          headers: await auth(g),
          json: { dimensions: a.dimensions.map((name) => ({ name })), metrics: a.metrics.map((name) => ({ name })), limit: a.limit },
        }),
      ),
  );

  defineTool(
    ctx,
    "ga4_get_metadata",
    {
      title: "GA4: available dimensions and metrics",
      description: "Lists dimensions and metrics available for a property, including custom definitions. Use custom_only to see only the property's custom ones.",
      input: { property_id: propertyId, custom_only: z.boolean().default(true), search: z.string().optional() },
    },
    async (a) => {
      const res: any = await request("GA4", `${DATA}/properties/${propId(a.property_id)}/metadata`, { headers: await auth(g) });
      const keep = (x: any) =>
        (!a.custom_only || x.customDefinition) && (!a.search || `${x.apiName} ${x.uiName}`.toLowerCase().includes(a.search.toLowerCase()));
      return {
        dimensions: (res.dimensions ?? []).filter(keep).map((d: any) => ({ apiName: d.apiName, uiName: d.uiName, category: d.category })),
        metrics: (res.metrics ?? []).filter(keep).map((m: any) => ({ apiName: m.apiName, uiName: m.uiName, type: m.type, category: m.category })),
      };
    },
  );

  defineTool(
    ctx,
    "ga4_property_config",
    {
      title: "GA4: property configuration",
      description: "Property settings plus key events (conversions), data streams and Google Ads links. Useful for tracking audits.",
      input: { property_id: propertyId },
    },
    async (a) => {
      const id = propId(a.property_id);
      const h = await auth(g);
      const get = (path: string) => request("GA4", `${ADMIN}/properties/${id}${path}`, { headers: h }).catch((e) => ({ error: String(e.message ?? e) }));
      const [property, keyEvents, dataStreams, googleAdsLinks, retention] = await Promise.all([
        get(""),
        get("/keyEvents"),
        get("/dataStreams"),
        get("/googleAdsLinks"),
        get("/dataRetentionSettings"),
      ]);
      return { property, keyEvents, dataStreams, googleAdsLinks, retention };
    },
  );
}
