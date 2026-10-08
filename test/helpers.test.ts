import { test } from "vitest";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { resolveDateRange } from "../src/lib/dates.js";
import { flattenRow } from "../src/platforms/googleAds.js";
import { csvToObjects, parseCsv, unzipFirstFile } from "../src/lib/zipcsv.js";
import { findClient, fuzzyMatch, normalize, parseClients } from "../src/clients.js";

const day = (s: string) => new Date(`${s}T00:00:00Z`);

test("date presets", () => {
  const now = day("2026-10-07");
  assert.deepEqual(resolveDateRange({ date_range: "yesterday" }, now), { start: "2026-10-06", end: "2026-10-06" });
  assert.deepEqual(resolveDateRange({ date_range: "last_7_days" }, now), { start: "2026-09-30", end: "2026-10-06" });
  assert.deepEqual(resolveDateRange({ date_range: "last_month" }, now), { start: "2026-09-01", end: "2026-09-30" });
  assert.deepEqual(resolveDateRange({ date_range: "this_quarter" }, now), { start: "2026-10-01", end: "2026-10-07" });
  assert.deepEqual(resolveDateRange({ date_range: "last_quarter" }, day("2026-02-10")), { start: "2025-10-01", end: "2025-12-31" });
  assert.deepEqual(resolveDateRange({ date_range: "last_month" }, day("2026-01-15")), { start: "2025-12-01", end: "2025-12-31" });
  assert.deepEqual(resolveDateRange({}, now), { start: "2026-09-07", end: "2026-10-06" });
  assert.deepEqual(resolveDateRange({ start_date: "2026-01-01", end_date: "2026-01-31", date_range: "today" }, now), { start: "2026-01-01", end: "2026-01-31" });
  assert.throws(() => resolveDateRange({ start_date: "2026-02-01", end_date: "2026-01-01" }, now));
});

test("google ads rows are flattened and micros converted", () => {
  const row = flattenRow({
    campaign: { id: "1", name: "Brand" },
    campaignBudget: { amountMicros: "25000000" },
    metrics: { costMicros: "12345678", averageCpc: 456789, clicks: "10", conversionsValue: 99.5 },
  });
  assert.equal(row["campaign.name"], "Brand");
  assert.equal(row["campaignBudget.amount"], 25);
  assert.equal(row["metrics.cost"], 12.35);
  assert.equal(row["metrics.averageCpc"], 0.46);
  assert.equal(row["metrics.clicks"], "10");
});

test("csv parsing handles quotes and numbers", () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n'), [["a", "b"], ["x, y", 'he said "hi"']]);
  assert.deepEqual(csvToObjects("Name,Spend,Ctr\nCampagne 1,12.5,3.20%\n"), [{ Name: "Campagne 1", Spend: 12.5, Ctr: 3.2 }]);
});

test("unzip extracts a deflated single-file archive", () => {
  const content = Buffer.from("Spend,Clicks\n1.5,3\n");
  const data = deflateRawSync(content);
  const name = Buffer.from("report.csv");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt32LE(cdOffset, 16);
  const zip = Buffer.concat([local, name, data, central, name, eocd]);
  assert.equal(unzipFirstFile(zip).toString(), content.toString());
});

test("fuzzy client matching", () => {
  assert.equal(normalize("Bäkkerij  Janssens BV"), "bakkerij janssens bv");
  assert.ok(fuzzyMatch("janssens", "Bakkerij Janssens BV"));
  assert.ok(fuzzyMatch("janssens bakkerij", "Bakkerij Janssens BV"));
  assert.ok(!fuzzyMatch("peeters", "Bakkerij Janssens BV"));
});

test("client registry parsing and lookup", () => {
  const clients = parseClients(JSON.stringify({ clients: [{ name: "Bakkerij Janssens", aliases: ["janssens"], google_ads: ["123"] }] }));
  assert.equal(findClient(clients, "JANSSENS")?.google_ads?.[0], "123");
  assert.equal(findClient(clients, "bakkerij"), clients[0]);
  assert.equal(findClient(clients, "peeters"), undefined);
  assert.throws(() => parseClients('[{"nope":1}]'));
});
