import { headers } from "next/headers";
import { encode } from "next-auth/jwt";
import { prisma } from "@/lib/db";

/**
 * Call one of Mercato's own API routes, as the person, from the server.
 *
 * The alternative was extracting the categorise and export logic out of their
 * route handlers into callable services. Those handlers are the two most
 * complex things in the app — a thousand lines each, with time budgets,
 * resume tokens and job stores — and refactoring them to add a second caller
 * is how you break the first one. "Use Mercato's workflow" is most literally
 * true when the workflow is invoked exactly as the browser invokes it.
 *
 * So this mints a short-lived session for the user and makes the request the
 * browser would have made. The route cannot tell the difference, which is the
 * point: the same authorization, the same spend guard, the same job store,
 * the same resume logic, with no second implementation to drift.
 *
 * The session never leaves this process — it is minted, attached to a request
 * to our own origin, and discarded. It lasts a minute, because it exists for
 * the duration of one call.
 */

const SESSION_TTL_S = 60;

function cookieName(): string {
  // Must match auth.config.ts exactly, including the __Secure- prefix that
  // production adds — a mismatch here reads as "not signed in".
  return process.env.NODE_ENV === "production"
    ? "__Secure-mercato.session-token"
    : "mercato.session-token";
}

async function originFromRequest(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export type InvokeResult = { ok: boolean; status: number; body: unknown };

export async function invokeAsUser(
  userId: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<InvokeResult> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return { ok: false, status: 500, body: { error: "AUTH_SECRET is not configured" } };
  }

  // Role and team come from the database rather than from the caller, so a
  // stale actor cannot be replayed into a session with more reach than the
  // person currently has.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, teamId: true },
  });
  if (!user) return { ok: false, status: 404, body: { error: "No such user" } };

  const token = await encode({
    token: { id: user.id, sub: user.id, email: user.email, role: user.role, teamId: user.teamId },
    secret,
    salt: cookieName(),
    maxAge: SESSION_TTL_S,
  });

  const res = await fetch(`${await originFromRequest()}${path}`, {
    method: init?.method ?? "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${cookieName()}=${token}`,
    },
    body: init?.body === undefined ? "{}" : JSON.stringify(init.body),
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // A route that answered with HTML means something redirected — almost
    // always the proxy sending an unauthenticated request to /login. Say so,
    // rather than returning an unparseable blob.
    body = { error: "Mercato did not answer with JSON", snippet: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * A daily ceiling on the tools that SPEND.
 *
 * Reads and writes to the database are cheap. Starting a categorisation or an
 * export is not: it runs on Mercato's own AI balance, not the caller's, and a
 * model that decides to re-run a catalogue "to be sure" spends real money
 * without anyone deciding to. The spend guard already refuses when the
 * balance is too low; this is the other half — a limit on how often, per
 * person, regardless of what the balance says.
 */
export const RUNS_PER_DAY = 20;

export async function runQuotaRemaining(userId: string, tools: string[]): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const used = await prisma.mcpCall.count({
    where: { userId, tool: { in: tools }, ok: true, createdAt: { gte: since } },
  });
  return Math.max(0, RUNS_PER_DAY - used);
}
