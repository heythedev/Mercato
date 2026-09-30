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
}: {
  email: string;
  baseUrl: string;
  initialTokens: Token[];
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

      {fresh && (
        <Notice tone="warning" title="Copy this now — it cannot be shown again" className="mb-6">
          <div className="mt-2">
            <CopyBox value={fresh} label="token" />
          </div>
          <p className="mt-2">
            Mercato stores only a hash of it. If you lose it, revoke it and make another.
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
          Then restart Claude and run <code className="text-xs">/mcp</code> — it should list{" "}
          <strong>mercato</strong>. On claude.ai, add it under Settings → Connectors using the same
          URL and header.
        </p>
      </Card>

      {/* ── 3. what to ask ─────────────────────────────────────────── */}
      <Card className="mb-6">
        <h2 className="text-base font-semibold">3. Ask it something</h2>
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
        <Notice tone="info" className="mt-4" title="Read-only, for now">
          Claude can look at anything you can look at, and change nothing. Write actions — setting a
          category, starting an export — come once we know which ones people actually reach for.
        </Notice>
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
