import { z } from "zod";
import { dateRangeShape, resolveDateRange, type DateRange } from "../lib/dates.js";
import { request, TokenCache } from "../lib/http.js";
import { defineTool, fingerprint, KeyedCache, type ToolContext } from "../lib/tools.js";
import type { LinkedInCredentials } from "../types.js";
import type { ChannelTotals } from "./totals.js";

const BASE = "https://api.linkedin.com/rest";

const tokenCaches = new Map<string, TokenCache>();

function accessToken(l: LinkedInCredentials): Promise<string> {
  if (!l.refreshToken || !l.clientId || !l.clientSecret) {
    if (!l.accessToken) throw new Error("LinkedIn credentials need an access token or client id + secret + refresh token.");
    return Promise.resolve(l.accessToken);
  }
  const key = `${l.clientId}\u0000${l.refreshToken}`;
  let cache = tokenCaches.get(key);
  if (!cache) {
    cache = new TokenCache(() =>
      request("LinkedIn OAuth", "https://www.linkedin.com/oauth/v2/accessToken", {
        form: { grant_type: "refresh_token", refresh_token: l.refreshToken!, client_id: l.clientId!, client_secret: l.clientSecret! },
      }),
    );
    tokenCaches.set(key, cache);
  }
  return cache.get();
}

async function headers(l: LinkedInCredentials, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await accessToken(l)}`,
    "LinkedIn-Version": l.apiVersion ?? "202609",
    "X-Restli-Protocol-Version": "2.0.0",
    ...extra,
  };
}

const accountNum = (id: string) => String(id).replace(/^urn:li:sponsoredAccount:/, "").replace(/[^0-9]/g, "");
const accountUrn = (id: string) => `urn:li:sponsoredAccount:${accountNum(id)}`;
const campaignUrn = (id: string) => (String(id).startsWith("urn:") ? id : `urn:li:sponsoredCampaign:${id}`);

/**
 * LinkedIn uses Rest.li 2.0 syntax (List(...), (start:(year:..)) ) that must not be percent-encoded,
 * while URNs inside lists must be. So the query string is built by hand.
 */
function restliQuery(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}
const list = (values: string[]) => `List(${values.map(encodeURIComponent).join(",")})`;
const liDate = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return `(year:${y},month:${m},day:${day})`;
};
const liRange = (r: DateRange) => `(start:${liDate(r.start)},end:${liDate(r.end)})`;

async function get(l: LinkedInCredentials, pathAndQuery: string): Promise<any> {
  return request("LinkedIn", `${BASE}/${pathAndQuery}`, { headers: await headers(l) });
}

/** Cursor-paginated finder (pageSize/pageToken). */
async function getAll(l: LinkedInCredentials, path: string, query: string, limit = 1000): Promise<any[]> {
  const out: any[] = [];
  let pageToken: string | undefined;
  do {
    const res = await get(l, `${path}?${query}&pageSize=${Math.min(limit, 1000)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    out.push(...(res.elements ?? []));
    pageToken = res.metadata?.nextPageToken;
  } while (pageToken && out.length < limit);
  return out.slice(0, limit);
}

const ANALYTICS_FIELDS = [
  "dateRange",
  "pivotValues",
  "costInLocalCurrency",
  "impressions",
  "clicks",
  "landingPageClicks",
  "externalWebsiteConversions",
  "conversionValueInLocalCurrency",
  "oneClickLeads",
  "totalEngagements",
  "videoViews",
  "approximateMemberReach",
];

async function analytics(l: LinkedInCredentials, opts: {
  range: DateRange;
  pivot: string;
  accounts?: string[];
  campaigns?: string[];
  granularity: "ALL" | "DAILY" | "MONTHLY";
  fields?: string[];
}): Promise<any[]> {
  const q = restliQuery({
    q: "analytics",
    pivot: opts.pivot,
    timeGranularity: opts.granularity,
    dateRange: liRange(opts.range),
    accounts: opts.accounts?.length ? list(opts.accounts.map(accountUrn)) : undefined,
    campaigns: opts.campaigns?.length ? list(opts.campaigns.map(campaignUrn)) : undefined,
    fields: (opts.fields ?? ANALYTICS_FIELDS).join(","),
  });
  const res = await get(l, `adAnalytics?${q}`);
  return (res.elements ?? []).map((e: any) => {
    const out: any = { ...e };
    for (const k of ["costInLocalCurrency", "conversionValueInLocalCurrency"]) if (e[k] !== undefined) out[k] = Number(e[k]);
    if (e.dateRange) {
      const d = (x: any) => `${x.year}-${String(x.month).padStart(2, "0")}-${String(x.day).padStart(2, "0")}`;
      out.dateRange = e.dateRange.end ? `${d(e.dateRange.start)}..${d(e.dateRange.end)}` : d(e.dateRange.start);
    }
    if (Array.isArray(e.pivotValues)) out.pivotValue = e.pivotValues.join(",");
    delete out.pivotValues;
    return out;
  });
}

const accountCache = new KeyedCache<any[]>();
export async function listLinkedInAccounts(l: LinkedInCredentials, force = false): Promise<any[]> {
  const key = await fingerprint(l.clientId, l.refreshToken, l.accessToken);
  return accountCache.get(key, force, () => loadAccounts(l));
}

async function loadAccounts(l: LinkedInCredentials): Promise<any[]> {
  const rows = (await getAll(l, "adAccounts", "q=search", 5000)).map((a) => ({
    id: String(a.id),
    name: a.name,
    status: a.status,
    currency: a.currency,
    type: a.type,
    reference: a.reference,
  }));
  return rows;
}

export async function linkedInTotals(l: LinkedInCredentials, accountId: string, range: DateRange): Promise<ChannelTotals> {
  const rows = await analytics(l, { range, pivot: "ACCOUNT", accounts: [accountId], granularity: "ALL" });
  const r = rows[0] ?? {};
  return {
    platform: "linkedin",
    accountId: accountNum(accountId),
    spend: Number(r.costInLocalCurrency ?? 0),
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    conversions: Number(r.externalWebsiteConversions ?? 0) + Number(r.oneClickLeads ?? 0),
    conversionValue: Number(r.conversionValueInLocalCurrency ?? 0),
  };
}

export function registerLinkedIn(ctx: ToolContext): void {
  const l = ctx.creds.linkedin!;
  const accountId = z.string().describe("LinkedIn ad account id (numeric or urn:li:sponsoredAccount:...). Use linkedin_list_ad_accounts.");

  defineTool(
    ctx,
    "linkedin_list_ad_accounts",
    {
      title: "LinkedIn: list ad accounts",
      description: "Lists LinkedIn Campaign Manager ad accounts the connected user can access, with status and currency.",
      input: { search: z.string().optional(), only_active: z.boolean().default(true), refresh: z.boolean().default(false) },
    },
    async (a) => {
      let rows = await listLinkedInAccounts(l, a.refresh);
      if (a.only_active) rows = rows.filter((r) => r.status === "ACTIVE");
      if (a.search) rows = rows.filter((r) => `${r.name} ${r.id}`.toLowerCase().includes(a.search!.toLowerCase()));
      return { count: rows.length, accounts: rows };
    },
  );

  defineTool(
    ctx,
    "linkedin_list_campaigns",
    {
      title: "LinkedIn: campaigns",
      description: "Campaigns of an ad account with status, objective, type, cost type, daily/total budget and campaign group.",
      input: {
        account_id: accountId,
        statuses: z.array(z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "COMPLETED", "CANCELED", "DRAFT", "PENDING_DELETION", "REMOVED"])).default(["ACTIVE", "PAUSED"]),
        limit: z.number().int().min(1).max(5000).default(500),
      },
    },
    async (a) => {
      const rows = await getAll(l, `adAccounts/${accountNum(a.account_id)}/adCampaigns`, `q=search&search=(status:(values:List(${a.statuses.join(",")})))`, a.limit);
      return {
        campaigns: rows.map((c) => ({
          id: String(c.id),
          name: c.name,
          status: c.status,
          objective: c.objectiveType,
          type: c.type,
          costType: c.costType,
          dailyBudget: c.dailyBudget ? `${c.dailyBudget.amount} ${c.dailyBudget.currencyCode}` : undefined,
          totalBudget: c.totalBudget ? `${c.totalBudget.amount} ${c.totalBudget.currencyCode}` : undefined,
          unitCost: c.unitCost ? `${c.unitCost.amount} ${c.unitCost.currencyCode}` : undefined,
          campaignGroup: c.campaignGroup,
          runSchedule: c.runSchedule,
        })),
      };
    },
  );

  defineTool(
    ctx,
    "linkedin_analytics",
    {
      title: "LinkedIn: ad analytics",
      description:
        "LinkedIn ad performance grouped by one pivot: ACCOUNT, CAMPAIGN_GROUP, CAMPAIGN, CREATIVE, or a professional demographic (MEMBER_JOB_FUNCTION, MEMBER_SENIORITY, MEMBER_INDUSTRY, MEMBER_COMPANY_SIZE, MEMBER_COMPANY, MEMBER_JOB_TITLE, MEMBER_COUNTRY_V2, MEMBER_REGION_V2). pivotValue holds URNs; use linkedin_list_campaigns to map campaign ids to names. Demographic data is approximate and lags 12-24h.",
      input: {
        account_id: accountId,
        ...dateRangeShape,
        pivot: z.string().default("CAMPAIGN"),
        granularity: z.enum(["ALL", "DAILY", "MONTHLY"]).default("ALL"),
        campaign_ids: z.array(z.string()).optional(),
        fields: z.array(z.string()).max(20).optional().describe("Override metrics (max 20); dateRange and pivotValues are always useful"),
      },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const rows = await analytics(l, {
        range,
        pivot: a.pivot,
        accounts: a.campaign_ids?.length ? undefined : [a.account_id],
        campaigns: a.campaign_ids,
        granularity: a.granularity,
        fields: a.fields,
      });
      // Attach campaign names for the CAMPAIGN pivot.
      if (a.pivot === "CAMPAIGN" && rows.length) {
        const camps = await getAll(l, `adAccounts/${accountNum(a.account_id)}/adCampaigns`, "q=search", 5000).catch(() => []);
        const names = new Map(camps.map((c: any) => [`urn:li:sponsoredCampaign:${c.id}`, c.name]));
        for (const r of rows) r.campaignName = names.get(r.pivotValue);
      }
      return { range, rows: rows.sort((x: any, y: any) => (y.costInLocalCurrency ?? 0) - (x.costInLocalCurrency ?? 0)) };
    },
  );

  defineTool(
    ctx,
    "linkedin_get",
    {
      title: "LinkedIn: raw REST GET",
      description:
        "Raw GET on the LinkedIn Marketing REST API (versioned, Rest.li 2.0). path_and_query is appended to https://api.linkedin.com/rest/, e.g. 'adAccounts/123/adCampaignGroups?q=search' or 'adAccounts/123/creatives?q=criteria'.",
      input: { path_and_query: z.string() },
    },
    async (a) => get(l, a.path_and_query.replace(/^\//, "")),
  );

  defineTool(
    ctx,
    "linkedin_update_campaign",
    {
      title: "LinkedIn: update campaign status or budget",
      description: "Pause/activate a LinkedIn campaign and/or change its daily budget (account currency).",
      input: {
        account_id: accountId,
        campaign_id: z.string(),
        status: z.enum(["ACTIVE", "PAUSED"]).optional(),
        daily_budget: z.number().positive().optional(),
      },
      write: true,
    },
    async (a, meta) => {
      if (!a.status && !a.daily_budget) throw new Error("Provide status and/or daily_budget");
      const path = `adAccounts/${accountNum(a.account_id)}/adCampaigns/${String(a.campaign_id).replace(/[^0-9]/g, "")}`;
      const current = await get(l, path);
      const set: any = {};
      if (a.status) set.status = a.status;
      if (a.daily_budget) set.dailyBudget = { amount: String(a.daily_budget), currencyCode: current.dailyBudget?.currencyCode ?? current.totalBudget?.currencyCode };
      const preview = {
        campaign: current.name,
        old: { status: current.status, dailyBudget: current.dailyBudget },
        new: set,
      };
      if (meta.dryRun) return preview;
      await request("LinkedIn", `${BASE}/${path}`, {
        headers: await headers(l, { "X-RestLi-Method": "PARTIAL_UPDATE" }),
        json: { patch: { $set: set } },
        retries: 0,
      });
      return { ...preview, updated: true };
    },
  );
}
