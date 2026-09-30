"use client";

import { useCallback, useState } from "react";
import { Check, Copy, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Card, EmptyState, Notice, PageHeader, Pill } from "@/components/ui/primitives";

/**
 * The guide, inside the tool.
 *
 * A separate setup document goes stale the week after it is written, and
 * whoever needs it is not the person who knows where it lives. So the
 * instructions sit next to the button that issues the token, and the URL is
 * read from the browser rather than typed into a doc that will one day be
 * wrong.
 */

type Token = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

function CopyBox({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-lg border border-border bg-muted/50 px-3 py-2 text-[12px] leading-relaxed">
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
  // Seeded from the server, so the page renders complete rather than empty
  // and then filled. Refetched only after a change, never on mount.
  const [tokens, setTokens] = useState<Token[]>(initialTokens);
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
          <p className="mt-2">
            Mercato stores only a hash of it. If you lose it, revoke it and make another.
          </p>
          {/*
            Said here, next to the token, rather than in a policy page nobody
            opens. The mistake this prevents is a specific and easy one: the
            setup command below CONTAINS the token, so pasting "the command"
            into a chat, a ticket or an email to ask why it is not working
            hands over the credential with it.
          */}
          <p className="mt-2">
            <strong className="text-foreground">Treat it like a password.</strong> The command in
            step 2 contains it, so pasting that command into a chat, a ticket or an email shares
            your access along with it. Type it into your own terminal only. If it does get out,
            revoke it below and create another — revoking takes effect immediately.
          </p>
        </Notice>
      )}

      {/* ── 1. token ───────────────────────────────────────────────── */}
      <Card className="mb-4">
        <h2 className="text-base font-semibold">1. Create a token</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          One per device, so you can revoke a laptop without disturbing anything else.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
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
      </Card>

      {/* ── 2. connect ─────────────────────────────────────────────── */}
      <Card className="mb-4">
        <h2 className="text-base font-semibold">2. Add Mercato to Claude</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          In a terminal, from anywhere. Replace <code className="text-xs">YOUR_TOKEN</code> with the
          one above.
        </p>
        <div className="mt-4">
          <CopyBox
            label="command"
            value={`claude mcp add --transport http mercato ${url} --header "Authorization: Bearer YOUR_TOKEN"`}
          />
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Run it in your own terminal — don&apos;t paste it anywhere else, it carries your token.
          On claude.ai instead of the CLI, add it under Settings → Connectors using the same URL
          and the same <code className="text-xs">Authorization</code> header.
        </p>
      </Card>

      {/* ── 3. check ───────────────────────────────────────────────── */}
      <Card className="mb-4">
        <h2 className="text-base font-semibold">3. Check it worked</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Restart Claude, then run <code className="text-xs">/mcp</code>. It should list{" "}
          <strong>mercato</strong>. If it doesn&apos;t, the message tells you which step to redo:
        </p>
        {/*
          Every row is a failure somebody can actually hit, paired with the ONE
          thing that fixes it. A troubleshooting list that says "check your
          configuration" sends people back to the start of the page.
        */}
        <dl className="mt-4 space-y-3 text-sm">
          {[
            ["mercato isn't listed at all", <>The command didn&apos;t run, or Claude wasn&apos;t restarted afterwards. Run step 2 again and restart.</>],
            ["401 Unauthorized", <>The token is wrong or has been revoked. Check the header reads <code className="text-xs">Bearer </code> followed by the token, then create a fresh one above.</>],
            ["404 Not Found", <>Either the URL is missing <code className="text-xs">/api/mcp</code>, or MCP is switched off on this deployment — your tokens are untouched and start working again when it&apos;s switched back on.</>],
            ["It connects but sees nothing", <>Expected if the account holds no projects. Claude sees exactly what you see when you sign in — no more, and no less.</>],
          ].map(([symptom, fix]) => (
            <div key={String(symptom)} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
              <dt className="font-medium">{symptom}</dt>
              <dd className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{fix}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {/* ── 4. what to ask ─────────────────────────────────────────── */}
      <Card className="mb-6">
        <h2 className="text-base font-semibold">4. Ask it something</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Plain English. Claude picks the right tool itself.
        </p>
        <ul className="mt-4 space-y-2 text-sm">
          {[
            "Which of my projects still have uncategorised products?",
            "For the Vickerman project, which required columns would ship empty and why?",
            "Find every product with no barcode in MS-WM 2.",
            "How far through is the Mathis export, and what is left?",
            "What has Kimi cost over the last 14 days, by feature?",
            "Which templates do I have for Best Buy?",
          ].map((q) => (
            <li key={q} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
              &ldquo;{q}&rdquo;
            </li>
          ))}
        </ul>
        {writeEnabled ? (
          <Notice tone="warning" className="mt-4" title="Write tools are on">
            Claude can also change things — set a category, clear a wrong value, set an export
            default. Bulk changes show you what they would touch and write nothing until you
            confirm, and nothing can be done that you could not do in the browser. Switch them off
            with <code className="text-xs">MCP_WRITE_ENABLED=false</code>.
          </Notice>
        ) : (
          <Notice tone="info" className="mt-4" title="Read-only">
            Claude can look at anything you can look at, and change nothing. Write tools exist but
            are switched off — turn them on with{" "}
            <code className="text-xs">MCP_WRITE_ENABLED=true</code> once you have read what they do.
          </Notice>
        )}
      </Card>

      {/* ── tokens ─────────────────────────────────────────────────── */}
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Your tokens
      </h2>
      {active.length === 0 ? (
        <EmptyState title="No tokens yet">
          Create one above to connect Claude to Mercato.
        </EmptyState>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
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
      )}
    </div>
  );
}
