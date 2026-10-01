import { NextRequest, NextResponse, after } from "next/server";
import { projectIdFromArgs, recordCall, rowsFromResult } from "@/lib/mcp/usage";
import { flags, mcpWriteTools, writeToolEnabled } from "@/lib/flags";
import { actorForToken } from "@/lib/mcp/tokens";
import { TOOLS } from "@/lib/mcp/tools";
import { WRITE_TOOLS } from "@/lib/mcp/write-tools";

/**
 * The tools this request may use.
 *
 * Read tools always; write tools only when MCP_WRITE_ENABLED says so. They are
 * withheld from tools/list as well as refused on call, so a model cannot
 * discover a tool it is not allowed to use and keep trying — an error it can
 * see is an error it will work around.
 */
function availableTools() {
  // Per tool, not all-or-nothing: enabling category assignment should not also
  // enable clearing fields or setting a default that governs every future
  // export. MCP_WRITE_ENABLED takes a list — see mcpWriteTools().
  return [...TOOLS, ...WRITE_TOOLS.filter((t) => writeToolEnabled(t.name))];
}

/**
 * Mercato's MCP endpoint.
 *
 * One hosted server rather than a thing each person installs. That choice is
 * about identity, not convenience: a local server needs a token in a config
 * file on every laptop, and whoever holds it acts as its owner — which would
 * hand a member their colleagues' private templates and a team admin another
 * team's projects, quietly undoing authz.ts through the one door left open.
 *
 * Here the bearer token names a PERSON, every tool builds its actor from that
 * person, and the tools call the same scope helpers the web app calls. What
 * Claude can reach is exactly what its owner can reach signed in.
 *
 * Speaks JSON-RPC over POST — the Streamable HTTP transport — implemented
 * directly rather than through the SDK's server class, because that expects
 * a long-lived Node process and this is a serverless function that exists for
 * the length of one request. The protocol surface a client needs is small:
 * initialize, tools/list, tools/call.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const PROTOCOL_VERSION = "2025-06-18";

type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const result = (id: RpcRequest["id"], value: unknown) =>
  NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result: value });

const failure = (id: RpcRequest["id"], code: number, message: string, status = 200) =>
  NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });

/** Zod shapes are convenient to declare and useless to a client; JSON Schema
 *  is what the protocol asks for. Only the shapes these tools actually use. */
function toJsonSchema(shape: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, def] of Object.entries(shape)) {
    const d = def as { _def?: { typeName?: string; description?: string; values?: string[] }; isOptional?: () => boolean; description?: string };
    const inner = (d as { _def?: { innerType?: unknown } })._def?.innerType as typeof d | undefined;
    const target = inner ?? d;
    const name = (target as { _def?: { typeName?: string } })._def?.typeName;

    let type = "string";
    let extra: Record<string, unknown> = {};
    if (name === "ZodNumber") type = "number";
    else if (name === "ZodBoolean") type = "boolean";
    else if (name === "ZodEnum") {
      extra = { enum: (target as { _def: { values: string[] } })._def.values };
    }

    properties[key] = { type, ...extra, ...(d.description ? { description: d.description } : {}) };
    if (typeof d.isOptional === "function" && !d.isOptional()) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

export async function POST(req: NextRequest) {
  // Off entirely: 404, not 503. A disabled endpoint should look absent rather
  // than broken, so nobody spends an afternoon debugging a connection to
  // something that was switched off on purpose.
  if (!flags.mcp()) {
    return NextResponse.json({ error: "MCP is disabled on this deployment" }, { status: 404 });
  }

  let body: RpcRequest;
  try {
    body = (await req.json()) as RpcRequest;
  } catch {
    return failure(null, -32700, "Parse error");
  }

  const { method, id, params } = body;

  // `initialize` and `notifications/*` are answered before authentication so a
  // client can complete its handshake and then report a clean 401 on the first
  // real call, rather than failing to connect with nothing to show the user.
  if (method === "initialize") {
    return result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "mercato", version: "1.0.0" },
      instructions:
        "Mercato — multi-marketplace product listing. Tools are scoped to the account whose token you are using: " +
        "you see exactly what that person sees signed in, and nothing else. Read-only. " +
        "Start with whoami to confirm which account, then list_projects.",
    });
  }
  if (method?.startsWith("notifications/")) return new NextResponse(null, { status: 202 });

  const auth = await actorForToken(req.headers.get("authorization"));
  if (!auth) {
    // 401 with WWW-Authenticate so a client can say something better than
    // "it didn't work" — the token is missing, revoked, or not ours.
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: id ?? null,
        error: {
          code: -32001,
          message:
            "No valid Mercato token. Create one under Settings → Connect to Claude and send it as: Authorization: Bearer mrc_…",
        },
      },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="mercato"' } },
    );
  }

  if (method === "tools/list") {
    return result(id, {
      tools: availableTools().map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: toJsonSchema(t.schema as Record<string, unknown>),
      })),
    });
  }

  if (method === "tools/call") {
    const name = String((params as { name?: string })?.name ?? "");
    const args = ((params as { arguments?: Record<string, unknown> })?.arguments ?? {}) as Record<string, unknown>;
    const tool = availableTools().find((t) => t.name === name);
    if (!tool) return failure(id, -32602, `No such tool: ${name}`);

    // Recorded for every call, success or failure, and written AFTER the
    // response so the audit trail never costs the caller a millisecond.
    // after() rather than a bare promise: on a serverless instance a
    // fire-and-forget write is frozen with the response and simply lost.
    const startedAt = Date.now();
    const session = req.headers.get("mcp-session-id");
    const log = (ok: boolean, rows: number | null, error?: string) =>
      after(() =>
        recordCall({
          userId: auth.actor.id,
          tokenId: auth.tokenId,
          sessionId: session,
          tool: name,
          projectId: projectIdFromArgs(args),
          ok,
          error,
          durationMs: Date.now() - startedAt,
          rows,
        }),
      );

    try {
      const out = await tool.run(auth.actor, args);
      log(true, rowsFromResult(out.content?.[0]?.text));
      return result(id, out);
    } catch (e) {
      // Reported as a tool result rather than a protocol error: the call was
      // well-formed and the model should see what went wrong and adapt, not
      // be told the transport broke.
      console.error(`[mcp] ${name} failed for ${auth.email}:`, e);
      log(false, null, (e as Error).message);
      return result(id, {
        content: [{ type: "text", text: `Tool failed: ${(e as Error).message}` }],
        isError: true,
      });
    }
  }

  return failure(id, -32601, `Method not found: ${method}`);
}

/** A plain GET is someone pasting the URL into a browser. Tell them what it
 *  is rather than returning a bare 405 they have to decode. */
export async function GET() {
  if (!flags.mcp()) {
    return NextResponse.json({ error: "MCP is disabled on this deployment" }, { status: 404 });
  }
  return NextResponse.json({
    name: "mercato-mcp",
    transport: "streamable-http (POST, JSON-RPC 2.0)",
    tools: availableTools().map((t) => t.name),
    writeToolsEnabled: mcpWriteTools(),
    auth: "Authorization: Bearer mrc_… — create one under Settings → Connect to Claude",
  });
}
