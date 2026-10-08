"use client";

import { useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { Card, Notice, PageHeader } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/**
 * The page people reach when something has gone wrong, written for the
 * moment they reach it.
 *
 * Every prompt is copyable, because a retyped prompt is a mangled prompt and
 * the mangling is invisible — the model answers something plausible for what
 * was actually typed. Every limit is passed in from the code that enforces
 * it rather than written here, so this page cannot be confidently wrong
 * about a number six months from now.
 *
 * Ordered by how often a thing is hit, not by how the pipeline is built:
 * blank cells first, because that is most of the support traffic.
 */

export type HelpLimits = {
  runsPerDay: number;
  maxRows: number;
  maxWrite: number;
  categorizeBatch: number;
  categorizeBatchMax: number;
  gapsBatch: number;
  gapsBatchMax: number;
  uploadMb: number;
  downloadMinutes: number;
};

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard refused — an insecure origin, or permission denied. The
      // text is on screen and selectable either way, so say nothing rather
      // than raise an error about a convenience.
    }
  }

  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-4 pr-12 text-[13px] leading-relaxed text-foreground">
        {text}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy prompt"}
        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition hover:text-foreground"
      >
        {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="space-y-4">
      <PageHeader as="section" title={title} subtitle={subtitle} className="mb-0" />
      {children}
    </Card>
  );
}

function Collapsible({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Card inset={false}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-5 text-left"
      >
        <span className="text-sm font-medium text-foreground">{title}</span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition", open && "rotate-180")} />
      </button>
      {open ? <div className="space-y-3 border-t border-border/60 p-5 pt-4">{children}</div> : null}
    </Card>
  );
}

function Problem({ when, children }: { when: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">{when}</p>
      <div className="space-y-2 text-[13px] leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}

function Msg({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <code className="text-[13px] text-foreground">{text}</code>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

export function HelpClient({ limits, mcpUrl }: { limits: HelpLimits; mcpUrl: string }) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <PageHeader
        title="Help"
        subtitle="What to say to Claude, and what to do when something comes back wrong."
      />

      {/* ── 1. Blank cells. Most of the traffic. ───────────────────────── */}
      <Section
        title="Cells are blank in my export file"
        subtitle="The most common one, and usually not a bug."
      >
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Ask Claude to fill the gaps. It works through the required columns nothing has
          answered, {limits.gapsBatch} products at a time, and looks up what it cannot read
          off the product itself.
        </p>
        <CopyBlock
          text={`Work on the Mercato project called <PROJECT NAME>.

Pull the export gaps and fill them, in batches, until none are left.

For each product, in this order:
1. Use what the product itself gives you: its name, description and vendor data.
2. If that doesn't answer the column, look it up. Search the manufacturer's
   own page or a retailer listing for that exact model number.
3. If a column has a fixed list of options, pick one of those strings exactly.
4. If you still can't answer it, leave it blank.

Rules:
- Match the exact model number. A similar product in the same range is not
  the same product — if you can't confirm it's that SKU, treat it as not found.
- Never estimate a measurement. A dimension is either stated somewhere or
  it's blank.
- Don't answer Proposition 65, PFAS or battery questions at all.

When you're done, list every value you looked up: the product, the column,
the value, and the page you took it from.

Then run the export and give me the download link. If it asks which template
to use, show me the list and wait.`}
        />
        <Notice tone="warning" title="Some columns stay blank on purpose">
          Proposition 65, PFAS and embedded-battery columns are legal declarations, not facts
          to look up. Claude will not answer them and neither will Mercato. Set them once under
          Export Defaults and every export carries them.
        </Notice>
        <Problem when="It only filled the required columns">
          <p>
            That is the default. Ask for the rest explicitly: <em>&ldquo;also fill the
            non-mandatory columns where you can&rdquo;</em>.
          </p>
        </Problem>
      </Section>

      {/* ── 2. Categorisation ──────────────────────────────────────────── */}
      <Section title="The products need categorising" subtitle="Works with no AI credit at all.">
        <CopyBlock
          text={`Work on the Mercato project called <PROJECT NAME>.

Categorise every uncategorised product. Take a batch, pick one exact path
from the marketplace's own list for each product, submit it, and keep going
until none are left.

Give a low confidence rather than guessing — those stay flagged for review.`}
        />
        <Problem when="Some products never get a category">
          <p>
            They are bare vendor codes with no title, description or vendor category — there is
            nothing to classify from, and any category chosen would be invented. Run Categorize
            in Mercato first; it resolves those codes to real titles. Then come back.
          </p>
        </Problem>
        <Problem when="It says no category list is available">
          <p>
            That marketplace has no taxonomy loaded yet, so nothing could be checked against one.
            Categorise it in Mercato instead, and tell us — that is ours to fix.
          </p>
        </Problem>
      </Section>

      {/* ── 3. Connecting ──────────────────────────────────────────────── */}
      <Section title="Claude can't connect, or shows the wrong account">
        <Problem when="Add this as the connector URL">
          <code className="text-[13px] text-foreground">{mcpUrl}</code>
        </Problem>
        <Notice tone="critical" title="Check the email on the consent screen">
          It signs in whoever that browser is already signed into Mercato as — which on a shared
          machine is often a colleague. If the email shown is not yours, click{" "}
          <strong>Not you?</strong> and sign in again. Approving it binds Claude to that account,
          not yours.
        </Notice>
        <Problem when="Claude only shows me some of the tools">
          <p>
            Read tools are always there. Write tools are per person and off by default — tick the
            ones you need under <strong>Connect to Claude</strong>. That is why a colleague sees
            more tools than you do.
          </p>
        </Problem>
        <Problem when="No valid Mercato token">
          <p>Your connection has ended. Reconnect from Connect to Claude.</p>
        </Problem>
      </Section>

      {/* ── 4. eBay ────────────────────────────────────────────────────── */}
      <Section title="eBay" subtitle="It works differently from the other marketplaces.">
        <ul className="list-disc space-y-2 pl-5 text-[13px] leading-relaxed text-muted-foreground">
          <li>
            <strong className="text-foreground">No verification step.</strong> There is no live
            eBay listing to check a product against, so the flow is upload → categorise → export.
          </li>
          <li>
            <strong className="text-foreground">Categorise through Claude.</strong> eBay has
            18,095 categories — too many to put in one request — so Mercato&rsquo;s own
            categoriser refuses and Claude narrows the list a level at a time instead.
          </li>
          <li>
            <strong className="text-foreground">The category is written twice:</strong> eBay&rsquo;s
            numeric id in <code>Category</code>, the readable path in{" "}
            <code>Store Category Name 1</code>.
          </li>
          <li>
            <strong className="text-foreground">No quote marks in any cell.</strong> A 72&quot;
            garland ships as <code>72</code>. Applied automatically.
          </li>
          <li>
            <strong className="text-foreground">Restricted keywords are removed and reported.</strong>{" "}
            If your upload carried an Error column naming a refused term, that term is taken out of
            the title, description and brand. Check the report — removing a word can make a
            description read worse.
          </li>
        </ul>
      </Section>

      {/* ── 5. Data quality ────────────────────────────────────────────── */}
      <Section title="The data itself looks wrong">
        <Problem when="Brand is a number, or colour is a country code">
          <p>
            The source file was mis-parsed. <strong>Report it — do not fix the cells by hand.</strong>{" "}
            If it is wrong for one product it is wrong for all of them, and hand-fixing hides that.
          </p>
        </Problem>
        <Problem when="A value is right in Mercato but wrong in the file">
          <p>A column mapping problem. Send us the column name and the SKU.</p>
        </Problem>
        <Problem when="Upload .xlsx where you have the choice">
          <p>
            CSV works, but it has more ways to go subtly wrong — and a subtle parse problem does
            not look like one until the export is finished.
          </p>
        </Problem>
      </Section>

      {/* ── 6. The long tail ───────────────────────────────────────────── */}
      <Collapsible title="Other messages you might see">
        <Msg text={`You have started ${limits.runsPerDay} exports in the last 24 hours`}>
          That is the daily cap, per account, per kind of run. It clears on a rolling 24 hours.
        </Msg>
        <Msg text="done: false, with a jobId">
          Not an error. A large catalogue is built in slices — tell Claude to keep going.
        </Msg>
        <Msg text="This project has N templates. Which should the export use?">
          Also not an error. Answer it; the template decides the columns and the file the
          marketplace receives, so nothing picks one for you.
        </Msg>
        <Msg text="That export's payload is gone — run the export again">
          The download link expired. They last {limits.downloadMinutes} minutes.
        </Msg>
        <Msg text="You do not have access to create <marketplace> projects">
          Ask an admin to grant you that marketplace.
        </Msg>
        <Msg text="Categorization can't start — no balance">
          The AI credit has run out. Categorising through Claude still works; verification does not.
        </Msg>
        <Msg text="The file is too large to send">
          Anything over {limits.uploadMb}MB goes through Mercato&rsquo;s own upload screen instead
          of through Claude.
        </Msg>
      </Collapsible>

      {/* ── 7. Limits ──────────────────────────────────────────────────── */}
      <Section title="Limits" subtitle="Read from the code that enforces them.">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <tbody className="divide-y divide-border/60">
              {[
                ["Exports, verifications or categorisations", `${limits.runsPerDay} per day each`],
                ["Products per categorisation batch", `${limits.categorizeBatch} (up to ${limits.categorizeBatchMax})`],
                ["Products per batch of export gaps", `${limits.gapsBatch} (up to ${limits.gapsBatchMax})`],
                ["Values written in one call", String(limits.maxWrite)],
                ["Rows returned by one read", String(limits.maxRows)],
                ["File sent through Claude", `${limits.uploadMb}MB`],
                ["Download link", `${limits.downloadMinutes} minutes`],
              ].map(([label, value]) => (
                <tr key={label}>
                  <td className="py-2 pr-4 text-muted-foreground">{label}</td>
                  <td className="py-2 text-right font-medium text-foreground">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <p className="pb-4 text-center text-[13px] text-muted-foreground">
        Something here wrong or missing? Tell the team — this page is meant to be the answer.
      </p>
    </div>
  );
}
