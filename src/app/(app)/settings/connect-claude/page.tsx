import { headers } from "next/headers";
import { requireUser } from "@/lib/auth-helpers";
import { listTokens } from "@/lib/mcp/tokens";
import { ConnectClaudeClient } from "@/components/admin/connect-claude-client";

export const dynamic = "force-dynamic";

/**
 * Open to every signed-in account, not just admins.
 *
 * The MCP endpoint scopes itself to whoever the token belongs to, so a member
 * connecting Claude reaches their own projects and nothing else. Restricting
 * the page would only mean the people with the least support get the least
 * help, while adding no safety the tools do not already provide.
 *
 * The token list and the endpoint URL are both resolved HERE rather than
 * fetched by the client on mount. Two reasons: the page renders complete
 * instead of flashing empty, and the client needs no mount effect — which the
 * React Compiler refuses anyway, correctly, since setting state from an effect
 * on first paint is a render the component did not need to do.
 */
export default async function ConnectClaudePage() {
  const user = await requireUser();
  const h = await headers();

  // From the request, so it is right on localhost, on a preview deployment and
  // in production, with no constant to keep in step.
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const baseUrl = host ? `${proto}://${host}` : "";

  const tokens = await listTokens(user.id);

  return (
    <div className="px-6 py-8">
      <ConnectClaudeClient
        email={(user as { email?: string }).email ?? "your account"}
        baseUrl={baseUrl}
        initialTokens={tokens.map((t) => ({
          id: t.id,
          name: t.name,
          prefix: t.prefix,
          createdAt: t.createdAt.toISOString(),
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
          revokedAt: t.revokedAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
