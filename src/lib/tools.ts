import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AdsCredentials, AuditEvent, McpUser, ServerOptions } from "../types.js";
import { ApiError } from "./http.js";

/** Everything a platform needs to register its tools for one server instance. */
export interface ToolContext {
  server: McpServer;
  user: McpUser;
  options: ServerOptions;
  creds: AdsCredentials;
}

type Shape = Record<string, z.ZodType>;

export interface ToolDef<S extends Shape> {
  title: string;
  description: string;
  input: S;
  /** Write tools get a `confirm` flag, are hidden when writeMode is "off" and emit audit events. */
  write?: boolean;
  destructive?: boolean;
}

export interface CallMeta {
  user: McpUser;
  /** For write tools: true when confirm was not set; the handler must only preview/validate. */
  dryRun: boolean;
}

const confirmField = z
  .boolean()
  .default(false)
  .describe("Set to true ONLY after the user explicitly approved the previewed change. Without it the tool returns a preview (dry run) and changes nothing.");

function defaultAudit(event: AuditEvent): void {
  console.log(JSON.stringify(event));
}

export function asText(data: unknown, maxChars: number, note?: string): CallToolResult {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + `\n\n[TRUNCATED: response was ${text.length} chars. Narrow the date range, add filters or use a lower limit.]`;
  }
  return { content: [{ type: "text", text: note ? `${note}\n\n${text}` : text }] };
}

function errorResult(err: unknown): CallToolResult {
  let message: string;
  if (err instanceof ApiError) {
    message = `${err.platform} API error (HTTP ${err.status}):\n${typeof err.body === "string" ? err.body : JSON.stringify(err.body, null, 1)}`;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return { isError: true, content: [{ type: "text", text: message.slice(0, 20_000) }] };
}

export function defineTool<S extends Shape>(
  ctx: ToolContext,
  name: string,
  def: ToolDef<S>,
  handler: (args: z.infer<z.ZodObject<S>>, meta: CallMeta) => Promise<unknown>,
): void {
  const writeMode = ctx.options.writeMode ?? "confirm";
  if (def.write && writeMode === "off") return;
  const maxChars = ctx.options.maxResponseChars ?? 120_000;
  const audit = ctx.options.onAudit ?? defaultAudit;

  const input = (def.write ? { ...def.input, confirm: confirmField } : def.input) as S;
  const description = def.write
    ? `${def.description}\n\nWRITE TOOL: first call without confirm to get a preview, show it to the user, and only call again with confirm=true after explicit approval.`
    : def.description;

  ctx.server.registerTool(
    name,
    {
      title: def.title,
      description,
      inputSchema: input,
      annotations: { title: def.title, readOnlyHint: !def.write, destructiveHint: Boolean(def.destructive), openWorldHint: true },
    },
    (async (args: any): Promise<CallToolResult> => {
      const dryRun = def.write ? !args.confirm : false;
      const logArgs = { ...args, confirm: undefined };
      try {
        if (def.write && !dryRun && ctx.options.canWrite && !ctx.options.canWrite(ctx.user)) {
          return errorResult(new Error(`${ctx.user.id} is not allowed to execute write operations.`));
        }
        const started = Date.now();
        const result = await handler(args, { user: ctx.user, dryRun });
        if (def.write && !dryRun) {
          audit({ type: "audit", at: new Date().toISOString(), user: ctx.user.id, tool: name, args: logArgs, ms: Date.now() - started, ok: true });
        }
        if (def.write && dryRun) {
          return asText(result, maxChars, "PREVIEW ONLY, nothing was changed. Show this to the user and call again with confirm=true after approval.");
        }
        return asText(result, maxChars);
      } catch (err) {
        if (def.write && !dryRun) {
          audit({ type: "audit", at: new Date().toISOString(), user: ctx.user.id, tool: name, args: logArgs, ok: false, error: String((err as Error)?.message ?? err).slice(0, 500) });
        }
        return errorResult(err);
      }
    }) as any,
  );
}

/** Small per-key TTL cache for account lists, shared across server instances. */
export class KeyedCache<T> {
  private map = new Map<string, { at: number; value: T }>();
  constructor(private readonly ttlMs = 10 * 60_000) {}
  async get(key: string, force: boolean, load: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key);
    if (!force && hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = await load();
    this.map.set(key, { at: Date.now(), value });
    if (this.map.size > 5000) this.map.delete(this.map.keys().next().value!);
    return value;
  }
}

/** Stable, non-reversible key for a credential (used for caches, never logged). */
export async function fingerprint(...parts: Array<string | undefined>): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(parts.map((p) => p ?? "").join("\u0000")).digest("hex").slice(0, 32);
}
