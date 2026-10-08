import { test } from "vitest";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, credentialsFromEnv, enabledPlatforms, type ServerOptions } from "../src/index.js";

async function connect(options: ServerOptions) {
  const server = createServer(options);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("only platforms with credentials register tools", async () => {
  const client = await connect({ credentials: { meta: { accessToken: "x" } } });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("meta_insights"));
  assert.ok(names.includes("cross_channel_performance"));
  assert.ok(!names.some((n) => n.startsWith("google_ads_")));
  assert.ok(!names.some((n) => n.startsWith("ga4_")));
});

test("writeMode off hides write tools", async () => {
  const client = await connect({ credentials: { meta: { accessToken: "x" } }, writeMode: "off" });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("meta_list_campaigns"));
  assert.ok(!names.includes("meta_set_status"));
  assert.ok(!names.includes("meta_graph_post"));
});

test("write tools expose confirm and the read-only hint is set correctly", async () => {
  const client = await connect({ credentials: { meta: { accessToken: "x" } } });
  const tools = (await client.listTools()).tools;
  const write = tools.find((t) => t.name === "meta_set_status")!;
  const read = tools.find((t) => t.name === "meta_insights")!;
  assert.ok("confirm" in (write.inputSchema.properties ?? {}));
  assert.equal(write.annotations?.readOnlyHint, false);
  assert.equal(read.annotations?.readOnlyHint, true);
});

test("canWrite blocks confirmed writes and audit is not emitted for previews", async () => {
  const events: unknown[] = [];
  const client = await connect({
    credentials: { meta: { accessToken: "x" } },
    user: { id: "intern@example.com" },
    canWrite: () => false,
    onAudit: (e) => events.push(e),
  });
  const res: any = await client.callTool({ name: "meta_set_status", arguments: { ids: ["1"], status: "PAUSED", confirm: true } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /not allowed/);
  assert.equal(events.length, 0);
});

test("boostu_status reports enabled platforms and registry size", async () => {
  const client = await connect({ credentials: { tiktok: { accessToken: "t" } }, clients: [{ name: "A" }], user: { id: "u1" } });
  const res: any = await client.callTool({ name: "boostu_status", arguments: {} });
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.platforms.tiktok, true);
  assert.equal(body.platforms.googleAds, false);
  assert.equal(body.clientRegistryEntries, 1);
});

test("credentialsFromEnv only creates complete platform blocks", () => {
  const creds = credentialsFromEnv({
    GOOGLE_OAUTH_CLIENT_ID: "id",
    GOOGLE_OAUTH_CLIENT_SECRET: "secret",
    GOOGLE_REFRESH_TOKEN: "rt",
    GOOGLE_ADS_LOGIN_CUSTOMER_ID: "123-456-7890",
    META_ACCESS_TOKEN: "",
    MICROSOFT_ADS_DEVELOPER_TOKEN: "dev",
  });
  assert.equal(creds.google?.adsLoginCustomerId, "123-456-7890");
  assert.equal(creds.meta, undefined);
  assert.equal(creds.microsoftAds, undefined);
  const e = enabledPlatforms(creds);
  assert.ok(e.googleAds && e.ga4 && e.searchConsole);
  assert.ok(!enabledPlatforms({ google: { ...creds.google!, products: ["ads"] } }).ga4);
});
