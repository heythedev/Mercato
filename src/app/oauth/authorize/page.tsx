import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { flags } from "@/lib/flags";
import { SCOPE_LABEL, parseScopes, redirectUriAllowed, resourceMatches, scopeString } from "@/lib/oauth/core";
import { canonicalResource, getClient } from "@/lib/oauth/store";
import { baseUrl } from "@/lib/oauth/metadata";
import { Notice } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * The consent screen — the only thing standing between open client
 * registration and somebody else's catalogue.
 *
 * Two rules shape it. Errors that concern the CLIENT (a bad redirect URI, an
 * unknown client id) are shown here and never redirected anywhere: sending
 * an error to an unverified callback is itself the attack. Errors that
 * concern the REQUEST are returned to the registered callback, which is what
 * the spec asks for and what lets a client recover.
 *
 * And the client's name is presented as its own claim, because it is: anyone
 * may register "Mercato Official" and the only honest thing to do is say
 * where that string came from.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Params> }) {
  if (!flags.mcp()) redirect("/");

  const sp = await searchParams;
  const clientId = one(sp.client_id);
  const redirectUri = one(sp.redirect_uri);
  const state = one(sp.state);
  const challenge = one(sp.code_challenge);
  const method = one(sp.code_challenge_method) || "S256";
  const resource = one(sp.resource);
  const scopes = parseScopes(one(sp.scope));

  const client = await getClient(clientId);
  if (!client) return <Problem title="Unknown application">No application is registered with that id.</Problem>;
  if (!redirectUriAllowed(redirectUri, client.redirectUris)) {
    // Never bounce to an unregistered URI, not even to report the error.
    return (
      <Problem title="That callback address is not registered">
        {client.name} asked to be sent to an address it did not register. Nothing has been shared.
      </Problem>
    );
  }

  // The host the browser will actually be returned to. Safe to state as a
  // fact: redirectUriAllowed above matched it EXACTLY against the URIs this
  // client registered, so it cannot be anywhere else.
  const returnHost = (() => {
    try { return new URL(redirectUri).host; } catch { return redirectUri; }
  })();

  const base = await baseUrl();
  const back = (error: string, description: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    redirect(u.toString());
  };

  if (method !== "S256") back("invalid_request", "code_challenge_method must be S256");
  if (!challenge) back("invalid_request", "code_challenge is required");
  if (!resourceMatches(resource, canonicalResource(base))) {
    back("invalid_target", "resource does not match this server");
  }

  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    // Sign in first, then come straight back to this same request.
    const self = new URL(`${base}/oauth/authorize`);
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string") self.searchParams.set(k, v);
    redirect(`/login?callbackUrl=${encodeURIComponent(self.pathname + self.search)}`);
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="rounded-xl border border-border bg-card p-6">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Mercato</p>
        <h1 className="mt-2 text-xl font-semibold leading-tight">
          Connect <span className="break-words">{client.name}</span> to your account?
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Signed in as <strong className="text-foreground">{user?.email ?? "your account"}</strong>.
        </p>

        <p className="mt-5 text-sm font-medium">It will be able to:</p>
        <ul className="mt-2 space-y-2">
          {scopes.map((s) => (
            <li key={s} className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-[13px]">
              {SCOPE_LABEL[s]}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
          Only what you can see yourself — never another person&apos;s projects.
        </p>

        {/* The name is whatever the application called itself when it
            registered, and anyone can register anything — so it is a claim.
            The DESTINATION is not: the browser is sent there, and only to a
            URI registered for this client and matched exactly. Showing the
            fact beside the claim is what lets somebody tell a routine connect
            from a page they were sent. Naming only the unverified part made
            every ordinary connection look like an attack. */}
        <Notice tone="warning" className="mt-5" title="Check you started this">
          This will send you back to <strong className="text-foreground">{returnHost}</strong>, which
          Mercato checked. The name <strong className="text-foreground">{client.name}</strong> is
          what the application calls itself and is not verified. If you did not just try to connect
          something, close this page.
        </Notice>

        <form action="/api/oauth/approve" method="POST" className="mt-6 flex gap-2">
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="redirect_uri" value={redirectUri} />
          <input type="hidden" name="scope" value={scopeString(scopes)} />
          <input type="hidden" name="state" value={state} />
          <input type="hidden" name="code_challenge" value={challenge} />
          <input type="hidden" name="resource" value={resource} />
          <button
            name="decision"
            value="deny"
            className="h-10 flex-1 rounded-lg border border-border text-sm font-medium hover:bg-muted"
          >
            Cancel
          </button>
          <button
            name="decision"
            value="allow"
            className="h-10 flex-1 rounded-lg bg-foreground text-sm font-medium text-background hover:opacity-90"
          >
            Allow
          </button>
        </form>
      </div>
    </main>
  );
}

function Problem({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <Notice tone="critical" title={title}>
        {children}
      </Notice>
    </main>
  );
}
