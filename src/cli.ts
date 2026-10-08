#!/usr/bin/env node
/**
 * boostu-ads-mcp CLI.
 *   boostu-ads-mcp            stdio transport (Claude Desktop, Claude Code, Cursor, ...)
 *   boostu-ads-mcp --http     Streamable HTTP on $PORT (default 3000) at /mcp, protected by MCP_API_KEYS
 */
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { optionsFromEnv } from "./env.js";
import { enabledPlatforms } from "./platforms/enabled.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

const log = (msg: string) => console.error(`[boostu-ads-mcp] ${msg}`);

function describePlatforms(): string {
  const on = Object.entries(enabledPlatforms(optionsFromEnv().credentials))
    .filter(([, v]) => v)
    .map(([k]) => k);
  return on.length ? on.join(", ") : "none (set credentials, see .env.example)";
}

async function runStdio(): Promise<void> {
  const server = createServer(optionsFromEnv());
  await server.connect(new StdioServerTransport());
  log(`v${VERSION} on stdio; platforms: ${describePlatforms()}`);
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** "name:key,name2:key2" or a bare key. */
function parseKeys(raw: string | undefined): { name: string; key: string }[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(":");
      return i > 0 ? { name: pair.slice(0, i), key: pair.slice(i + 1) } : { name: "api-key", key: pair };
    });
}

function authenticate(req: IncomingMessage, keys: { name: string; key: string }[]): string | undefined {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  for (const k of keys) {
    if (k.key.length === token.length && timingSafeEqual(Buffer.from(k.key), Buffer.from(token))) return k.name;
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 10 * 1024 * 1024) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

async function runHttp(): Promise<void> {
  const keys = parseKeys(process.env.MCP_API_KEYS);
  if (!keys.length) {
    log("MCP_API_KEYS is required in --http mode (e.g. MCP_API_KEYS=me:a-long-random-secret).");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 3000);
  const baseOptions = optionsFromEnv();
  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
      return;
    }
    const user = authenticate(req, keys);
    if (!user) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end(JSON.stringify({ error: "invalid_token" }));
      return;
    }
    try {
      const body = await readJson(req);
      const server = createServer({ ...baseOptions, user: { id: user } });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log(`request failed: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Bad request" }, id: null }));
    }
  });
  http.listen(port, () => log(`v${VERSION} on http://0.0.0.0:${port}/mcp; platforms: ${describePlatforms()}`));
}

const main = process.argv.includes("--http") ? runHttp : runStdio;
main().catch((err) => {
  log(`fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
