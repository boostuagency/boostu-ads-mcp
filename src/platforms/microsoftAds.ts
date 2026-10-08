import { z } from "zod";
import { dateRangeShape, resolveDateRange, type DateRange } from "../lib/dates.js";
import { request, TokenCache } from "../lib/http.js";
import { defineTool, fingerprint, KeyedCache, type ToolContext } from "../lib/tools.js";
import type { MicrosoftAdsCredentials } from "../types.js";
import { csvToObjects, unzipFirstFile } from "../lib/zipcsv.js";
import type { ChannelTotals } from "./totals.js";

const CAMPAIGN = "https://campaign.api.bingads.microsoft.com/CampaignManagement/v13";
const CUSTOMER = "https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13";
const REPORTING = "https://reporting.api.bingads.microsoft.com/Reporting/v13";

// Microsoft rotates refresh tokens: remember the newest one per original token and report it to the host.
const rotated = new Map<string, string>();
const tokenCaches = new Map<string, TokenCache>();
type RotationHook = (refreshToken: string) => void;

function accessToken(c: MicrosoftAdsCredentials, onRotate?: RotationHook): Promise<string> {
  const key = `${c.clientId}\u0000${c.refreshToken}`;
  let cache = tokenCaches.get(key);
  if (!cache) {
    cache = new TokenCache(async () => {
      const form: Record<string, string> = {
        client_id: c.clientId,
        grant_type: "refresh_token",
        refresh_token: rotated.get(key) ?? c.refreshToken,
        scope: "https://ads.microsoft.com/msads.manage offline_access",
      };
      if (c.clientSecret) form.client_secret = c.clientSecret;
      const res: any = await request("Microsoft OAuth", `https://login.microsoftonline.com/${c.tenant ?? "common"}/oauth2/v2.0/token`, { form });
      if (res.refresh_token && res.refresh_token !== form.refresh_token) {
        rotated.set(key, res.refresh_token);
        onRotate?.(res.refresh_token);
      }
      return res;
    });
    tokenCaches.set(key, cache);
  }
  return cache.get();
}

async function headers(c: MicrosoftAdsCredentials, accountId?: string, onRotate?: RotationHook): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${await accessToken(c, onRotate)}`,
    DeveloperToken: c.developerToken,
  };
  if (c.customerId) h.CustomerId = c.customerId;
  if (accountId) h.CustomerAccountId = accountId;
  return h;
}

async function call(c: MicrosoftAdsCredentials, url: string, body: unknown, accountId?: string, method = "POST"): Promise<any> {
  return request("Microsoft Ads", url, { method, headers: await headers(c, accountId), json: body, retries: method === "POST" ? 2 : 0 });
}

const accountCache = new KeyedCache<any[]>();
export async function listMicrosoftAccounts(c: MicrosoftAdsCredentials, force = false): Promise<any[]> {
  const key = await fingerprint(c.clientId, c.refreshToken, c.customerId);
  return accountCache.get(key, force, () => loadAccounts(c));
}

async function loadAccounts(c: MicrosoftAdsCredentials): Promise<any[]> {
  const res = await call(c, `${CUSTOMER}/AccountsInfo/Query`, { CustomerId: c.customerId ?? null, OnlyParentAccounts: false });
  const rows = (res.AccountsInfo ?? []).map((a: any) => ({ id: String(a.Id), name: a.Name, number: a.Number, status: a.AccountLifeCycleStatus, pauseReason: a.PauseReason }));
  return rows;
}

const msDate = (d: string) => {
  const [Year, Month, Day] = d.split("-").map(Number);
  return { Year, Month, Day };
};

/** Submits a report, polls until ready and returns the parsed CSV rows. */
async function runReport(c: MicrosoftAdsCredentials, accountId: string, type: string, columns: string[], range: DateRange, aggregation: string): Promise<Record<string, string | number>[]> {
  const submit = await call(c, 
    `${REPORTING}/GenerateReport/Submit`,
    {
      ReportRequest: {
        Type: type,
        Format: "Csv",
        FormatVersion: "2.0",
        ExcludeReportHeader: true,
        ExcludeReportFooter: true,
        ExcludeColumnHeaders: false,
        ReturnOnlyCompleteData: false,
        ReportName: `mcp-${Date.now()}`,
        Aggregation: aggregation,
        Columns: columns,
        Scope: { AccountIds: [Number(accountId)] },
        Time: { CustomDateRangeStart: msDate(range.start), CustomDateRangeEnd: msDate(range.end), ReportTimeZone: "BrusselsCopenhagenMadridParis" },
      },
    },
    accountId,
  );
  const id = submit.ReportRequestId;
  const deadline = Date.now() + 90_000;
  for (let delay = 1000; Date.now() < deadline; delay = Math.min(delay * 1.5, 5000)) {
    await new Promise((r) => setTimeout(r, delay));
    const poll = await call(c, `${REPORTING}/GenerateReport/Poll`, { ReportRequestId: id }, accountId);
    const status = poll.ReportRequestStatus?.Status;
    if (status === "Success") {
      const url = poll.ReportRequestStatus.ReportDownloadUrl;
      if (!url) return []; // no data in range
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      const buf = Buffer.from(await res.arrayBuffer());
      const csv = buf[0] === 0x50 && buf[1] === 0x4b ? unzipFirstFile(buf).toString("utf8") : buf.toString("utf8");
      return csvToObjects(csv);
    }
    if (status === "Error") throw new Error(`Microsoft Ads report failed: ${JSON.stringify(poll)}`);
  }
  throw new Error(`Microsoft Ads report ${id} not ready after 90s; try a shorter period.`);
}

const BASE_COLUMNS = ["Spend", "Impressions", "Clicks", "Ctr", "AverageCpc", "Conversions", "Revenue", "CostPerConversion", "ReturnOnAdSpend"];

export async function microsoftTotals(c: MicrosoftAdsCredentials, accountId: string, range: DateRange): Promise<ChannelTotals> {
  const rows = await runReport(c, accountId, "AccountPerformanceReportRequest", ["AccountName", "CurrencyCode", "Spend", "Impressions", "Clicks", "Conversions", "Revenue"], range, "Summary");
  const sum = (k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  return {
    platform: "microsoft_ads",
    accountId,
    accountName: rows[0]?.AccountName as string | undefined,
    currency: rows[0]?.CurrencyCode as string | undefined,
    spend: sum("Spend"),
    impressions: sum("Impressions"),
    clicks: sum("Clicks"),
    conversions: sum("Conversions"),
    conversionValue: sum("Revenue"),
  };
}

export function registerMicrosoftAds(ctx: ToolContext): void {
  const c = ctx.creds.microsoftAds!;
  // Warm the token cache with the host's rotation hook so rotated tokens get persisted.
  const onRotate = ctx.options.onTokenRotated;
  if (onRotate) void accessToken(c, (rt) => onRotate("microsoftAds", rt)).catch(() => {});
  const accountId = z.string().describe("Microsoft Advertising account id (numeric Id, not the account number). Use microsoft_ads_list_accounts.");

  defineTool(
    ctx,
    "microsoft_ads_list_accounts",
    {
      title: "Microsoft Ads: list accounts",
      description: "Lists Microsoft Advertising (Bing) accounts under the connected manager account.",
      input: { search: z.string().optional(), refresh: z.boolean().default(false) },
    },
    async (a) => {
      let rows = await listMicrosoftAccounts(c, a.refresh);
      if (a.search) rows = rows.filter((r) => `${r.name} ${r.id} ${r.number}`.toLowerCase().includes(a.search!.toLowerCase()));
      return { count: rows.length, accounts: rows };
    },
  );

  defineTool(
    ctx,
    "microsoft_ads_report",
    {
      title: "Microsoft Ads: performance report",
      description:
        "Runs a Microsoft Ads report (async, can take up to a minute). Levels: account, campaign, ad_group, keyword, search_query. Optional extra columns per Microsoft's report column names.",
      input: {
        account_id: accountId,
        ...dateRangeShape,
        level: z.enum(["account", "campaign", "ad_group", "keyword", "search_query"]).default("campaign"),
        aggregation: z.enum(["Summary", "Daily", "Weekly", "Monthly"]).default("Summary"),
        extra_columns: z.array(z.string()).optional(),
      },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const spec = {
        account: { type: "AccountPerformanceReportRequest", cols: ["AccountName", "CurrencyCode"] },
        campaign: { type: "CampaignPerformanceReportRequest", cols: ["CampaignId", "CampaignName", "CampaignStatus", "CurrencyCode"] },
        ad_group: { type: "AdGroupPerformanceReportRequest", cols: ["CampaignName", "AdGroupId", "AdGroupName", "AdGroupStatus"] },
        keyword: { type: "KeywordPerformanceReportRequest", cols: ["CampaignName", "AdGroupName", "KeywordId", "Keyword", "BidMatchType", "KeywordStatus", "QualityScore"] },
        search_query: { type: "SearchQueryPerformanceReportRequest", cols: ["CampaignName", "AdGroupName", "SearchQuery", "Keyword", "DeliveredMatchType"] },
      }[a.level];
      const timeCol = a.aggregation === "Summary" ? [] : ["TimePeriod"];
      // ReturnOnAdSpend is not available on every report type
      const metrics = a.level === "search_query" ? BASE_COLUMNS.filter((c) => c !== "ReturnOnAdSpend") : BASE_COLUMNS;
      const rows = await runReport(c, a.account_id, spec.type, [...timeCol, ...spec.cols, ...metrics, ...(a.extra_columns ?? [])], range, a.aggregation);
      return { range, rowCount: rows.length, rows: rows.sort((x, y) => Number(y.Spend ?? 0) - Number(x.Spend ?? 0)).slice(0, 2000) };
    },
  );

  defineTool(
    ctx,
    "microsoft_ads_list_campaigns",
    {
      title: "Microsoft Ads: campaigns",
      description: "Campaigns of an account with status, type, budget and bidding scheme.",
      input: { account_id: accountId },
    },
    async (a) => {
      const res = await call(c, `${CAMPAIGN}/Campaigns/QueryByAccountId`, { AccountId: a.account_id, CampaignType: "Search Shopping DynamicSearchAds Audience PerformanceMax" }, a.account_id);
      return {
        campaigns: (res.Campaigns ?? []).map((c: any) => ({
          id: String(c.Id),
          name: c.Name,
          status: c.Status,
          type: c.CampaignType,
          dailyBudget: c.DailyBudget,
          budgetType: c.BudgetType,
          bidding: c.BiddingScheme?.Type,
          timeZone: c.TimeZone,
        })),
      };
    },
  );

  defineTool(
    ctx,
    "microsoft_ads_update_campaigns",
    {
      title: "Microsoft Ads: pause / enable / budget",
      description: "Pause or activate campaigns and/or set their daily budget.",
      input: {
        account_id: accountId,
        campaign_ids: z.array(z.string()).min(1).max(100),
        status: z.enum(["Active", "Paused"]).optional(),
        daily_budget: z.number().positive().optional(),
      },
      write: true,
    },
    async (a, meta) => {
      if (!a.status && !a.daily_budget) throw new Error("Provide status and/or daily_budget");
      const res = await call(c, `${CAMPAIGN}/Campaigns/QueryByAccountId`, { AccountId: a.account_id, CampaignType: "Search Shopping DynamicSearchAds Audience PerformanceMax" }, a.account_id);
      const current = (res.Campaigns ?? []).filter((c: any) => a.campaign_ids.includes(String(c.Id)));
      const preview = current.map((c: any) => ({
        id: String(c.Id),
        name: c.Name,
        from: { status: c.Status, dailyBudget: c.DailyBudget },
        to: { status: a.status ?? c.Status, dailyBudget: a.daily_budget ?? c.DailyBudget },
      }));
      if (meta.dryRun) return { changes: preview, notFound: a.campaign_ids.filter((id) => !current.some((c: any) => String(c.Id) === id)) };
      const campaigns = current.map((c: any) => ({
        Id: c.Id,
        ...(a.status ? { Status: a.status } : {}),
        ...(a.daily_budget ? { DailyBudget: a.daily_budget } : {}),
      }));
      const upd = await call(c, `${CAMPAIGN}/Campaigns`, { AccountId: a.account_id, Campaigns: campaigns }, a.account_id, "PUT");
      return { changes: preview, partialErrors: upd.PartialErrors ?? [] };
    },
  );
}
