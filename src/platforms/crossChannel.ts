import { z } from "zod";
import { findClient, fuzzyMatch } from "../clients.js";
import type { AdsCredentials } from "../types.js";
import { dateRangeShape, fmt, resolveDateRange, type DateRange } from "../lib/dates.js";
import { defineTool, type ToolContext } from "../lib/tools.js";
import { googleAdsTotals, listGoogleAdsAccounts } from "./googleAds.js";
import { linkedInTotals, listLinkedInAccounts } from "./linkedin.js";
import { listMetaAdAccounts, metaTotals } from "./meta.js";
import { listMicrosoftAccounts, microsoftTotals } from "./microsoftAds.js";
import { listGa4Properties } from "./ga4.js";
import { listGscSites } from "./searchConsole.js";
import { listTikTokAdvertisers, tikTokTotals } from "./tiktok.js";
import type { ChannelTotals } from "./totals.js";
import { enabledPlatforms } from "./enabled.js";

type AdPlatform = "google_ads" | "meta" | "linkedin" | "tiktok" | "microsoft_ads";

const AD_PLATFORMS: AdPlatform[] = ["google_ads", "meta", "linkedin", "tiktok", "microsoft_ads"];

function totalsFor(creds: AdsCredentials, p: AdPlatform, id: string, r: DateRange): Promise<ChannelTotals> {
  switch (p) {
    case "google_ads":
      return googleAdsTotals(creds.google!, id, r);
    case "meta":
      return metaTotals(creds.meta!, id, r);
    case "linkedin":
      return linkedInTotals(creds.linkedin!, id, r);
    case "tiktok":
      return tikTokTotals(creds.tiktok!, id, r);
    case "microsoft_ads":
      return microsoftTotals(creds.microsoftAds!, id, r);
  }
}

function isEnabledFor(creds: AdsCredentials, p: AdPlatform): boolean {
  const e = enabledPlatforms(creds);
  return { google_ads: e.googleAds, meta: e.meta, linkedin: e.linkedin, tiktok: e.tiktok, microsoft_ads: e.microsoftAds }[p];
}

/** Runs async jobs with a concurrency cap. */
async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = { status: "fulfilled", value: await fn(items[idx]) };
        } catch (e) {
          out[idx] = { status: "rejected", reason: e };
        }
      }
    }),
  );
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function withKpis(t: Omit<ChannelTotals, "platform" | "accountId"> & Partial<ChannelTotals>) {
  return {
    ...t,
    spend: r2(t.spend),
    conversions: r2(t.conversions),
    conversionValue: r2(t.conversionValue),
    ctr: t.impressions ? r2((t.clicks / t.impressions) * 100) : null,
    cpc: t.clicks ? r2(t.spend / t.clicks) : null,
    cpa: t.conversions ? r2(t.spend / t.conversions) : null,
    roas: t.spend && t.conversionValue ? r2(t.conversionValue / t.spend) : null,
  };
}

function sumTotals(rows: ChannelTotals[]) {
  const byCurrency = new Map<string, ChannelTotals>();
  for (const r of rows) {
    const cur = r.currency ?? "unknown";
    const acc = byCurrency.get(cur) ?? { platform: "all", accountId: "all", currency: cur, spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };
    acc.spend += r.spend;
    acc.impressions += r.impressions;
    acc.clicks += r.clicks;
    acc.conversions += r.conversions;
    acc.conversionValue += r.conversionValue;
    byCurrency.set(cur, acc);
  }
  return [...byCurrency.values()].map(withKpis);
}

function previousPeriod(r: DateRange): DateRange {
  const s = new Date(`${r.start}T00:00:00Z`);
  const e = new Date(`${r.end}T00:00:00Z`);
  const days = Math.round((e.getTime() - s.getTime()) / 86400_000) + 1;
  return { start: fmt(new Date(s.getTime() - days * 86400_000)), end: fmt(new Date(s.getTime() - 86400_000)) };
}

async function collect(creds: AdsCredentials, accounts: { platform: AdPlatform; id: string }[], range: DateRange) {
  const results = await pool(accounts, 6, (a) => totalsFor(creds, a.platform, a.id, range));
  const ok: ChannelTotals[] = [];
  const errors: { platform: string; accountId: string; error: string }[] = [];
  results.forEach((res, i) => {
    if (res.status === "fulfilled") ok.push(res.value);
    else errors.push({ platform: accounts[i].platform, accountId: accounts[i].id, error: String((res.reason as Error)?.message ?? res.reason).slice(0, 500) });
  });
  return { ok, errors };
}

export function registerCrossChannel(ctx: ToolContext): void {
  const creds = ctx.creds;
  const clients = ctx.options.clients ?? [];
  const enabled = enabledPlatforms(creds);
  const isEnabled = (p: AdPlatform) => isEnabledFor(creds, p);
  const accountsShape = {
    google_ads: z.array(z.string()).optional(),
    meta: z.array(z.string()).optional(),
    linkedin: z.array(z.string()).optional(),
    tiktok: z.array(z.string()).optional(),
    microsoft_ads: z.array(z.string()).optional(),
  };

  defineTool(
    ctx,
    "boostu_status",
    {
      title: "Status: which channels are connected",
      description: "Shows which platforms this MCP server is connected to and how many clients are in the client registry. Call this first when unsure what is available.",
      input: {},
    },
    async () => ({
      user: ctx.user.id,
      platforms: enabled,
      clientRegistryEntries: clients.length,
      tips: [
        "Use find_client_accounts to locate a client's accounts on every channel by name.",
        "Use cross_channel_performance for a client's total spend/results across channels.",
        "Write tools always preview first; pass confirm=true only after the user approved.",
      ],
    }),
  );

  defineTool(
    ctx,
    "list_clients",
    {
      title: "Client registry",
      description: "Lists clients from the client registry with their account ids per channel, owner and targets (CPA/ROAS/budget).",
      input: { search: z.string().optional(), owner: z.string().optional() },
    },
    async (a) => {
      let rows = clients;
      if (a.search) rows = rows.filter((c) => fuzzyMatch(a.search!, [c.name, ...(c.aliases ?? [])].join(" ")));
      if (a.owner) rows = rows.filter((c) => (c.owner ?? "").toLowerCase().includes(a.owner!.toLowerCase()));
      return { count: rows.length, clients: rows };
    },
  );

  defineTool(
    ctx,
    "find_client_accounts",
    {
      title: "Find a client's accounts on all channels",
      description:
        "Searches the client registry AND the live account lists of every connected platform (Google Ads MCC, Meta, LinkedIn, TikTok, Microsoft Ads, GA4, Search Console) for a client name. Use this before any client question when you do not know the account ids.",
      input: { name: z.string().describe("Client or brand name, e.g. 'Janssens' or 'bakkerij janssens'") },
    },
    async (a) => {
      const registry = findClient(clients, a.name);
      const match = (s: string) => fuzzyMatch(a.name, s);
      const jobs: Record<string, () => Promise<any[]>> = {};
      if (enabled.googleAds) jobs.google_ads = async () => (await listGoogleAdsAccounts(creds.google!)).filter((r) => !r.manager && match(`${r.name} ${r.id}`));
      if (enabled.meta) jobs.meta = async () => (await listMetaAdAccounts(creds.meta!)).filter((r) => match(`${r.name} ${r.business ?? ""}`));
      if (enabled.linkedin) jobs.linkedin = async () => (await listLinkedInAccounts(creds.linkedin!)).filter((r) => match(r.name));
      if (enabled.tiktok) jobs.tiktok = async () => (await listTikTokAdvertisers(creds.tiktok!)).filter((r) => match(r.name));
      if (enabled.microsoftAds) jobs.microsoft_ads = async () => (await listMicrosoftAccounts(creds.microsoftAds!)).filter((r) => match(r.name));
      if (enabled.ga4) jobs.ga4 = async () => (await listGa4Properties(creds.google!)).filter((r) => match(`${r.name} ${r.account}`));
      if (enabled.searchConsole) jobs.search_console = async () => (await listGscSites(creds.google!)).filter((r) => match(r.siteUrl.replace(/[./:-]/g, " ")));
      const entries = Object.entries(jobs);
      const settled = await Promise.allSettled(entries.map(([, fn]) => fn()));
      const live: Record<string, unknown> = {};
      settled.forEach((s, i) => (live[entries[i][0]] = s.status === "fulfilled" ? s.value : { error: String((s.reason as Error)?.message ?? s.reason).slice(0, 300) }));
      return { registry: registry ?? null, liveMatches: live };
    },
  );

  defineTool(
    ctx,
    "cross_channel_performance",
    {
      title: "Cross-channel performance",
      description:
        "Spend, impressions, clicks, conversions, conversion value, CTR, CPC, CPA and ROAS per ad account and summed (per currency) across Google Ads, Meta, LinkedIn, TikTok and Microsoft Ads. Pass `client` (registry name) or explicit account ids per platform. Note: conversion definitions differ per platform (Meta = purchase+lead by default, LinkedIn = website conversions + lead form leads) and platforms double-count shared conversions; use GA4 for deduplicated truth.",
      input: {
        client: z.string().optional().describe("Client name from the registry"),
        ...accountsShape,
        ...dateRangeShape,
        compare_previous_period: z.boolean().default(true),
      },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const client = a.client ? findClient(clients, a.client) : undefined;
      if (a.client && !client) throw new Error(`Client '${a.client}' is not in the registry. Use find_client_accounts and pass account ids explicitly.`);
      const accounts: { platform: AdPlatform; id: string }[] = [];
      for (const p of AD_PLATFORMS) {
        const ids = [...(a[p] ?? []), ...((client?.[p] as string[] | undefined) ?? [])];
        for (const id of new Set(ids)) {
          if (isEnabled(p)) accounts.push({ platform: p, id });
        }
      }
      if (!accounts.length) throw new Error("No ad accounts given (or their platforms are not connected).");
      const current = await collect(creds, accounts, range);
      const result: any = {
        client: client?.name,
        targets: client?.targets,
        range,
        perAccount: current.ok.map(withKpis),
        total: sumTotals(current.ok),
        errors: current.errors.length ? current.errors : undefined,
      };
      if (a.compare_previous_period) {
        const prevRange = previousPeriod(range);
        const prev = await collect(creds, accounts, prevRange);
        result.previous = { range: prevRange, total: sumTotals(prev.ok), perAccount: prev.ok.map(withKpis) };
      }
      return result;
    },
  );

  defineTool(
    ctx,
    "agency_overview",
    {
      title: "All-accounts spend overview",
      description:
        "Totals per active ad account across ALL clients on the selected platforms, for agency-wide checks such as 'which accounts spent nothing yesterday', 'top spenders this month' or 'accounts with CPA above X'. Heavy: one API call per account, so prefer short periods and filter platforms.",
      input: {
        platforms: z.array(z.enum(["google_ads", "meta", "linkedin", "tiktok", "microsoft_ads"])).default(["google_ads", "meta"]),
        ...dateRangeShape,
        min_spend: z.number().default(0).describe("Hide accounts below this spend (0 shows accounts with zero spend too)"),
        max_accounts: z.number().int().min(1).max(500).default(200),
      },
    },
    async (a) => {
      const range = resolveDateRange(a);
      const accounts: { platform: AdPlatform; id: string; name?: string }[] = [];
      for (const p of a.platforms) {
        if (!isEnabled(p)) continue;
        const list =
          p === "google_ads"
            ? (await listGoogleAdsAccounts(creds.google!)).filter((r) => !r.manager && (!r.status || r.status === "ENABLED"))
            : p === "meta"
              ? (await listMetaAdAccounts(creds.meta!)).filter((r) => r.status === "ACTIVE")
              : p === "linkedin"
                ? (await listLinkedInAccounts(creds.linkedin!)).filter((r) => r.status === "ACTIVE")
                : p === "tiktok"
                  ? await listTikTokAdvertisers(creds.tiktok!)
                  : (await listMicrosoftAccounts(creds.microsoftAds!)).filter((r) => r.status === "Active");
        for (const r of list) accounts.push({ platform: p, id: r.id, name: r.name });
      }
      const limited = accounts.slice(0, a.max_accounts);
      const { ok, errors } = await collect(creds, limited, range);
      const names = new Map(limited.map((x) => [`${x.platform}:${x.id}`, x.name]));
      const rows = ok
        .map((t) => withKpis({ ...t, accountName: t.accountName ?? names.get(`${t.platform}:${t.accountId}`) ?? names.get(`${t.platform}:act_${t.accountId}`) }))
        .filter((t) => t.spend >= a.min_spend)
        .sort((x, y) => y.spend - x.spend);
      return {
        range,
        accountsChecked: limited.length,
        skippedBecauseOfLimit: Math.max(0, accounts.length - limited.length),
        rows,
        total: sumTotals(ok),
        errors: errors.length ? errors : undefined,
      };
    },
  );
}
