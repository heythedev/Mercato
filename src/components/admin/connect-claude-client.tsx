"use client";

import { useCallback, useState } from "react";
import { Check, Copy, Globe, Plus, Terminal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Card, EmptyState, Notice, PageHeader, Pill } from "@/components/ui/primitives";

/**
 * The guide, inside the tool.
 *
 * Rebuilt around the one decision a person actually makes — browser or
 * terminal — after it had grown into four numbered steps where the first
 * ("create a token") applied to only one of the two routes, and a
 * troubleshooting table sat between setting it up and using it. Numbered
 * steps are the wrong shape for a fork in the road: half of them are noise
 * whichever way you go.
 *
 * So: pick a route, see only that route's instructions, and the things you
 * need when something is wrong are at the bottom where you will look for
 * them rather than in the middle where they interrupt.
 */

type Token = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

function CopyBox({ value, label, big }: { value: string; label?: string; big?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch gap-2">
      <code
        className={cn(
          "min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-lg border border-border bg-background px-3 py-2 leading-relaxed",
          big ? "text-sm font-medium" : "text-[12px]",
        )}
      >
        {value}
      </code>
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } catch {
            toast.error("Could not copy — select the text and copy manually");
          }
        }}
        aria-label={label ? `Copy ${label}` : "Copy"}
        className="shrink-0 rounded-lg border border-border px-3 text-xs hover:bg-muted"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground text-[11px] font-semibold text-background">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-snug">{title}</p>
        {children ? <div className="mt-2">{children}</div> : null}
      </div>
    </li>
  );
}

export function ConnectClaudeClient({
  email,
  baseUrl,
  initialTokens,
  enabled,
  writeEnabled,
}: {
  email: string;
  baseUrl: string;
  initialTokens: Token[];
  /** MCP_ENABLED. Off: say so plainly rather than issue tokens that cannot work. */
  enabled: boolean;
  /** MCP_WRITE_ENABLED. Off by default — writes are a deliberate decision. */
  writeEnabled: boolean;
}) {
  const [tokens, setTokens] = useState<Token[]>(initialTokens);
  const [route, setRoute] = useState<"browser" | "terminal">("browser");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/mcp/tokens", { cache: "no-store" });
    if (r.ok) setTokens((await r.json()).tokens ?? []);
  }, []);

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const r = await fetch("/api/mcp/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const d = await r.json();
      if (!r.ok) { toast.error(d.error ?? "Could not create the token"); return; }
      setFresh(d.token);
      setName("");
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string, label: string) {
    if (!confirm(`Revoke "${label}"? Any Claude using it stops working immediately.`)) return;
    const r = await fetch(`/api/mcp/tokens?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (r.ok) { toast.success("Revoked"); await load(); }
    else toast.error("Could not revoke");
  }

  const url = baseUrl ? `${baseUrl}/api/mcp` : "/api/mcp";
  const active = tokens.filter((t) => !t.revokedAt);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Connect to Claude"
        subtitle={`Ask Claude about Mercato in plain English. It connects as ${email} and sees exactly what you see — nothing more.`}
      />

      {!enabled && (
        <Notice tone="critical" title="MCP is switched off on this deployment" className="mb-6">
          Tokens below are not revoked and start working again the moment it is switched back on.
          Set <code className="text-xs">MCP_ENABLED=true</code> to re-enable.
        </Notice>
      )}

      {fresh && (
        <Notice tone="warning" title="Copy this now — it cannot be shown again" className="mb-6">
          <div className="mt-2">
            <CopyBox value={fresh} label="token" />
          </div>
          {/*
            Said next to the token rather than in a policy page nobody opens.
            The mistake is specific and easy: the setup command CONTAINS the
            token, so pasting "the command" into a chat to ask why it is not
            working hands over the credential with it.
          */}
          <p className="mt-2">
            <strong className="text-foreground">Treat it like a password.</strong> The command
            below contains it — type it into your own terminal only, never into a chat or a
            ticket. If it does get out, revoke it here and make another.
          </p>
        </Notice>
      )}

      {/* ── pick a route ───────────────────────────────────────────── */}
      <div className="mb-4 flex w-fit gap-1 rounded-lg bg-muted p-1">
        {([
          ["browser", "In the browser", Globe],
          ["terminal", "In a terminal", Terminal],
        ] as const).map(([k, label, Icon]) => (
          <button
            key={k}
            onClick={() => setRoute(k)}
            className={cn(
              "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition",
              route === k ? "bg-background shadow" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {route === "browser" ? (
        <Card className="mb-6">
          <ol className="space-y-5">
            <Step n={1} title="In Claude, open Settings → Connectors → Add custom connector" />
            <Step n={2} title="Name it “Mercato”, and paste this as the MCP server URL">
              <CopyBox value={url} label="server URL" big />
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                That is the whole field. There is no token to enter here.
              </p>
            </Step>
            <Step n={3} title="Press Continue, then Allow on the Mercato page it opens">
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                Claude sends you here to sign in and approve. You can withdraw it later from this
                page.
              </p>
            </Step>
          </ol>
        </Card>
      ) : (
        <Card className="mb-6">
          <ol className="space-y-5">
            <Step n={1} title="Create a token for this device">
              <div className="flex flex-wrap gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
                  placeholder="My laptop"
                  maxLength={60}
                  className="min-w-48 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
                />
                <button
                  onClick={() => void create()}
                  disabled={!name.trim() || creating}
                  className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-40"
                >
                  <Plus className="h-4 w-4" />
                  {creating ? "Creating…" : "Create token"}
                </button>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                One per device, so you can revoke a laptop without disturbing anything else.
              </p>
            </Step>
            <Step n={2} title="Run this, replacing YOUR_TOKEN with the one just created">
              <CopyBox
                label="command"
                value={`claude mcp add --transport http mercato ${url} --header "Authorization: Bearer YOUR_TOKEN"`}
              />
            </Step>
            <Step n={3} title="Restart Claude, then run /mcp — it should list mercato" />
          </ol>
        </Card>
      )}

      {/* ── what to ask ────────────────────────────────────────────── */}
      <Card className="mb-6">
        <h2 className="text-base font-semibold">Then ask it something</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Plain English. Claude picks the right tool itself.
        </p>
        <ul className="mt-4 space-y-2 text-sm">
          {[
            "Which of my projects still have uncategorised products?",
            "For the Vickerman project, which required columns would ship empty and why?",
            "Find every product with no barcode in MS-WM 2.",
            "What has Kimi cost over the last 14 days, by feature?",
          ].map((q) => (
            <li key={q} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
              &ldquo;{q}&rdquo;
            </li>
          ))}
        </ul>
        {writeEnabled ? (
          <Notice tone="warning" className="mt-4" title="Write tools are on">
            Claude can also change things. Bulk changes show you what they would touch and write
            nothing until you confirm, and nothing can be done that you could not do yourself.
          </Notice>
        ) : (
          <Notice tone="info" className="mt-4" title="Read-only">
            Claude can look at anything you can look at, and change nothing.
          </Notice>
        )}
      </Card>

      {/* ── tokens ─────────────────────────────────────────────────── */}
      {active.length > 0 && (
        <>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Your tokens
          </h2>
          <div className="mb-6 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {active.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <code>{t.prefix}…</code> · created {new Date(t.createdAt).toLocaleDateString()}
                  </p>
                </div>
                {t.lastUsedAt ? (
                  <Pill tone="good">used {new Date(t.lastUsedAt).toLocaleDateString()}</Pill>
                ) : (
                  <Pill tone="neutral">never used</Pill>
                )}
                <button
                  onClick={() => void revoke(t.id, t.name)}
                  aria-label={`Revoke ${t.name}`}
                  className={cn(
                    "shrink-0 rounded-lg border border-border p-2 text-muted-foreground",
                    "hover:border-red-300 hover:text-red-600",
                  )}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {active.length === 0 && route === "terminal" && (
        <EmptyState title="No tokens yet" className="mb-6">
          Create one above to connect Claude Code to Mercato.
        </EmptyState>
      )}

      {/* ── troubleshooting, at the bottom where it is looked for ──── */}
      <details className="rounded-xl border border-border px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium">If it didn&apos;t work</summary>
        <dl className="mt-3 space-y-3 text-sm">
          {[
            ["Claude says it can't reach the server", <>Check the URL ends in <code className="text-xs">/api/mcp</code> with nothing after it — a trailing slash is enough to break it.</>],
            ["mercato isn't listed after setup", <>Claude reads its configuration at startup. Restart it — in the desktop app, close the window rather than just the chat.</>],
            ["401 Unauthorized", <>The token is wrong or revoked. Check the header reads <code className="text-xs">Bearer </code> then the token, or create a fresh one above.</>],
            ["It connects but sees nothing", <>Expected if your account holds no projects. Claude sees exactly what you see signed in — no more, no less.</>],
          ].map(([symptom, fix]) => (
            <div key={String(symptom)} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
              <dt className="font-medium">{symptom}</dt>
              <dd className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{fix}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
