import { z } from "zod";
import { dateRangeShape, resolveDateRange } from "../lib/dates.js";
import { request } from "../lib/http.js";
import { defineTool, type ToolContext } from "../lib/tools.js";
import type { GoogleCredentials } from "../types.js";
import { googleAccessToken } from "./googleAuth.js";

const WM = "https://www.googleapis.com/webmasters/v3";
const auth = async (g: GoogleCredentials) => ({ Authorization: `Bearer ${await googleAccessToken(g, "searchConsole")}` });

export async function listGscSites(g: GoogleCredentials): Promise<any[]> {
  const res: any = await request("Search Console", `${WM}/sites`, { headers: await auth(g) });
  return (res.siteEntry ?? []).map((s: any) => ({ siteUrl: s.siteUrl, permission: s.permissionLevel }));
}

export function registerSearchConsole(ctx: ToolContext): void {
  const g = ctx.creds.google!;
  const siteUrl = z.string().describe("Property as listed by gsc_list_sites, e.g. 'sc-domain:example.be' or 'https://www.example.be/'");

  defineTool(
    ctx,
    "gsc_list_sites",
    {
      title: "Search Console: list properties",
      description: "Lists all Search Console properties the connected Google user can access.",
      input: { search: z.string().optional() },
    },
    async (a) => {
      let rows = await listGscSites(g);
      if (a.search) rows = rows.filter((r) => r.siteUrl.toLowerCase().includes(a.search!.toLowerCase()));
      return { count: rows.length, sites: rows };
    },
  );

  defineTool(
    ctx,
    "gsc_search_analytics",
    {
      title: "Search Console: search performance",
      description:
        "Clicks, impressions, CTR and average position by query, page, country, device, date or searchAppearance. Data lags about 2-3 days. Filters use operators equals, contains, notContains, includingRegex, excludingRegex.",
      input: {
        site_url: siteUrl,
        ...dateRangeShape,
        dimensions: z.array(z.enum(["query", "page", "country", "device", "date", "searchAppearance"])).default(["query"]),
        filters: z
          .array(
            z.object({
              dimension: z.enum(["query", "page", "country", "device", "searchAppearance"]),
              operator: z.enum(["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"]).default("contains"),
              expression: z.string(),
            }),
          )
          .optional(),
        search_type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).default("web"),
        limit: z.number().int().min(1).max(25_000).default(250),
      },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const res: any = await request("Search Console", `${WM}/sites/${encodeURIComponent(a.site_url)}/searchAnalytics/query`, {
        headers: await auth(g),
        json: {
          startDate: range.start,
          endDate: range.end,
          dimensions: a.dimensions,
          type: a.search_type,
          rowLimit: a.limit,
          dimensionFilterGroups: a.filters?.length ? [{ groupType: "and", filters: a.filters }] : undefined,
        },
      });
      return {
        range,
        rows: (res.rows ?? []).map((r: any) => {
          const o: Record<string, unknown> = {};
          a.dimensions.forEach((d, i) => (o[d] = r.keys?.[i]));
          return { ...o, clicks: r.clicks, impressions: r.impressions, ctr: Math.round(r.ctr * 10000) / 100, position: Math.round(r.position * 10) / 10 };
        }),
      };
    },
  );

  defineTool(
    ctx,
    "gsc_inspect_url",
    {
      title: "Search Console: URL inspection",
      description: "Index status, canonical, crawl info, mobile usability and rich results of one URL.",
      input: { site_url: siteUrl, url: z.string().url(), language: z.string().default("nl-BE") },
    },
    async (a) =>
      request("Search Console", "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
        headers: await auth(g),
        json: { inspectionUrl: a.url, siteUrl: a.site_url, languageCode: a.language },
      }),
  );

  defineTool(
    ctx,
    "gsc_list_sitemaps",
    {
      title: "Search Console: sitemaps",
      description: "Submitted sitemaps with last download, errors, warnings and indexed counts.",
      input: { site_url: siteUrl },
    },
    async (a) => request("Search Console", `${WM}/sites/${encodeURIComponent(a.site_url)}/sitemaps`, { headers: await auth(g) }),
  );
}
