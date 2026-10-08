import { z } from "zod";

export const DATE_PRESETS = [
  "today",
  "yesterday",
  "last_7_days",
  "last_14_days",
  "last_30_days",
  "last_90_days",
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export interface DateRange {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

const TZ = process.env.REPORT_TIMEZONE ?? "Europe/Brussels";

/** Reusable zod fields for tools that accept a date range. */
export const dateRangeShape = {
  date_range: z
    .enum(DATE_PRESETS)
    .optional()
    .describe("Preset period (Europe/Brussels). 'last_N_days' excludes today. Ignored when start_date and end_date are given. Default last_30_days."),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Custom start date YYYY-MM-DD (inclusive)"),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Custom end date YYYY-MM-DD (inclusive)"),
};

function todayInTz(): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return new Date(`${parts}T00:00:00Z`);
}

export function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}

export function resolveDateRange(args: { date_range?: DatePreset; start_date?: string; end_date?: string }, now: Date = todayInTz()): DateRange {
  if (args.start_date && args.end_date) {
    if (args.start_date > args.end_date) throw new Error("start_date must be on or before end_date");
    return { start: args.start_date, end: args.end_date };
  }
  const today = now;
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const q = Math.floor(m / 3);
  switch (args.date_range ?? "last_30_days") {
    case "today":
      return { start: fmt(today), end: fmt(today) };
    case "yesterday":
      return { start: fmt(addDays(today, -1)), end: fmt(addDays(today, -1)) };
    case "last_7_days":
      return { start: fmt(addDays(today, -7)), end: fmt(addDays(today, -1)) };
    case "last_14_days":
      return { start: fmt(addDays(today, -14)), end: fmt(addDays(today, -1)) };
    case "last_30_days":
      return { start: fmt(addDays(today, -30)), end: fmt(addDays(today, -1)) };
    case "last_90_days":
      return { start: fmt(addDays(today, -90)), end: fmt(addDays(today, -1)) };
    case "this_month":
      return { start: fmt(new Date(Date.UTC(y, m, 1))), end: fmt(today) };
    case "last_month":
      return { start: fmt(new Date(Date.UTC(y, m - 1, 1))), end: fmt(new Date(Date.UTC(y, m, 0))) };
    case "this_quarter":
      return { start: fmt(new Date(Date.UTC(y, q * 3, 1))), end: fmt(today) };
    case "last_quarter":
      return { start: fmt(new Date(Date.UTC(y, q * 3 - 3, 1))), end: fmt(new Date(Date.UTC(y, q * 3, 0))) };
    case "this_year":
      return { start: `${y}-01-01`, end: fmt(today) };
    case "last_year":
      return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
  }
}
