"use client";

import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { REPORT_INK, SERIES_HEX } from "@/lib/viz/series-colors";
import { formatDate, formatDateTime, formatYmd } from "@/lib/format-date";

/**
 * The usage report as a real PDF.
 *
 * It used to be an HTML page with a Print button, which meant the artefact
 * someone actually took into a meeting was whatever their browser's print
 * dialog produced — page furniture, headers and footers included, and only if
 * they remembered to pick "Save as PDF" rather than a printer.
 *
 * This renders the document directly: vector text that stays sharp and stays
 * selectable, one file, the same on every machine. The layout is authored for
 * A4 rather than reflowed from a web page, so the page breaks fall where they
 * were put instead of wherever the text happened to run out.
 *
 * Drawn with Views rather than Svg — a stacked bar is a column of coloured
 * boxes, and flexbox describes that exactly, with no second layout model to
 * keep in step.
 */

// ── Types, matching /api/admin/usage ─────────────────────────────────────────

type Row = {
  calls: number;
  input: number;
  output: number;
  units: number;
  failed: number;
  estCostUsd: number | null;
};

export type ReportData = {
  days: number;
  since: string;
  actualSpendUsd: number | null;
  actualByDay?: Record<string, number>;
  balanceReadings: number;
  teamScoped?: boolean;
  byDay: (Row & { day: string; service: string })[];
  byService: (Row & { service: string })[];
  byFeature: (Row & { service: string; feature: string })[];
  byProject: (Row & { projectId: string | null; name: string | null })[];
  byModel: (Row & { model: string })[];
};

const SERVICES = ["kimi", "keepa", "synccentric"] as const;
const SERVICE_LABELS: Record<string, string> = {
  kimi: "Kimi (AI)",
  keepa: "Keepa",
  synccentric: "Synccentric",
};
const SERVICE_ROLE: Record<string, string> = {
  kimi: "Categorisation, verification and export fills",
  keepa: "Amazon catalogue data",
  synccentric: "Product lookup by UPC/ASIN",
};
const UNIT_LABELS: Record<string, string> = { keepa: "tokens", synccentric: "searches" };
const FEATURE_LABELS: Record<string, string> = {
  categorize: "Categorisation",
  spec_product_type: "Walmart product type",
  verify_image: "Image verification",
  verify_title: "Title verification",
  export_dropdown: "Export — dropdown fill",
  export_mandatory: "Export — mandatory cells",
  generate_title: "Title generation",
  template_detect: "Template detection",
  compare_images: "Image compare",
  unknown: "Unattributed",
  products_search: "Product search",
  product: "Product lookup",
  search: "Keyword search",
  query: "Query",
  token: "Balance check",
};

const fmt = (n: number) => n.toLocaleString("en-US");
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);
const tok = (n: number) => (n === 0 ? "—" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : fmt(n));
const pct = (n: number) => `${Math.round(n * 100)}%`;

type Daily = { day: string; values: Record<string, number>; total: number };

function toDailySeries(
  rows: { day: string; service: string }[],
  value: (r: never) => number,
  days: number,
  timeZone = "Asia/Kolkata",
): Daily[] {
  const byDay = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const bucket = byDay.get(r.day) ?? {};
    bucket[r.service] = (bucket[r.service] ?? 0) + value(r as never);
    byDay.set(r.day, bucket);
  }
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const out: Daily[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = f.format(new Date(Date.now() - i * 86_400_000));
    const values = byDay.get(key) ?? {};
    out.push({ day: key, values, total: Object.values(values).reduce((a, b) => a + b, 0) });
  }
  return out;
}

/** A round number at or above the peak, so the axis label is readable. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((s) => s * mag).find((c) => c >= v) ?? 10 * mag;
}

const shortDay = (ymd: string): string => {
  const [, m, d] = ymd.split("-");
  return `${Number(d)}/${Number(m)}`;
};

// ── Styles ───────────────────────────────────────────────────────────────────

const C = REPORT_INK;
const s = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 46,
    paddingHorizontal: 44,
    fontSize: 9,
    fontFamily: "Helvetica",
    color: C.text,
    backgroundColor: "#ffffff",
  },

  masthead: { borderBottomWidth: 2, borderBottomColor: C.ruleStrong, paddingBottom: 12, marginBottom: 20 },
  mastheadRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  eyebrow: { fontSize: 7.5, letterSpacing: 1.6, color: C.faint, fontFamily: "Helvetica-Bold" },
  title: { fontSize: 20, marginTop: 4, fontFamily: "Helvetica-Bold" },
  metaLine: { fontSize: 7.5, color: C.muted, textAlign: "right", lineHeight: 1.5 },
  metaStrong: { fontSize: 7.5, color: C.text, textAlign: "right", fontFamily: "Helvetica-Bold" },

  kpiRow: { flexDirection: "row", gap: 10, marginBottom: 14 },
  kpi: { flex: 1, borderWidth: 1, borderColor: C.panelEdge, borderRadius: 4, padding: 9 },
  kpiLabel: { fontSize: 6.8, letterSpacing: 0.9, color: C.faint, fontFamily: "Helvetica-Bold" },
  kpiValue: { fontSize: 16, marginTop: 4, fontFamily: "Helvetica-Bold" },
  kpiNote: { fontSize: 6.8, color: C.faint, marginTop: 2 },

  panel: {
    borderWidth: 1, borderColor: C.panelEdge, borderRadius: 4,
    backgroundColor: C.panel, padding: 11, marginBottom: 14,
  },
  panelTitle: { fontSize: 10, marginBottom: 6, fontFamily: "Helvetica-Bold" },
  bullet: { flexDirection: "row", marginBottom: 4 },
  dot: { width: 9, fontSize: 9, color: C.faint },
  bulletText: { flex: 1, fontSize: 8.5, lineHeight: 1.55, color: "#262626" },

  section: { marginBottom: 14 },
  sectionTitle: {
    fontSize: 7.5, letterSpacing: 1.3, color: C.faint,
    fontFamily: "Helvetica-Bold", marginBottom: 6,
  },
  sectionNote: { fontSize: 7.5, color: C.muted, marginBottom: 6, lineHeight: 1.5 },

  th: {
    flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#a3a3a3",
    paddingBottom: 4, marginBottom: 2,
  },
  thText: { fontSize: 6.8, letterSpacing: 0.8, color: C.faint, fontFamily: "Helvetica-Bold" },
  tr: {
    flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#ededed",
    paddingVertical: 5, alignItems: "center",
  },
  td: { fontSize: 8.5 },
  tdMuted: { fontSize: 8, color: C.muted },
  right: { textAlign: "right" },
  swatch: { width: 6, height: 6, borderRadius: 1.5, marginRight: 5 },

  chartRow: { flexDirection: "row", gap: 18, marginBottom: 14 },
  // 76pt left most of a 30-day window as slivers a few pixels tall, and left
  // a third of page one empty underneath. A quiet day should still read as a
  // mark, and a busy one should have somewhere to go.
  plot: { flexDirection: "row", alignItems: "flex-end", height: 108, gap: 1.5 },
  plotFrame: { borderBottomWidth: 0.7, borderBottomColor: "#a3a3a3" },
  plotCeiling: { borderTopWidth: 0.5, borderTopColor: "#ededed" },
  axisLabel: { fontSize: 6.5, color: C.faint, marginBottom: 3 },
  tickRow: { flexDirection: "row", marginTop: 3, gap: 1.5 },
  tick: { flex: 1, fontSize: 5.5, color: C.faint, textAlign: "center" },
  legend: { flexDirection: "row", gap: 12, marginTop: 6 },
  legendItem: { flexDirection: "row", alignItems: "center" },
  legendText: { fontSize: 7, color: C.muted },

  track: { height: 4, flex: 1, backgroundColor: C.track, borderRadius: 2 },
  fill: { height: 4, borderRadius: 2 },

  footNote: { borderTopWidth: 1, borderTopColor: C.rule, paddingTop: 8 },
  footTitle: { fontSize: 8, fontFamily: "Helvetica-Bold", marginBottom: 3 },
  footText: { fontSize: 7.2, color: C.muted, lineHeight: 1.6 },
  pageNum: {
    position: "absolute", bottom: 24, left: 44, right: 44,
    flexDirection: "row", justifyContent: "space-between",
  },
  pageNumText: { fontSize: 6.8, color: C.faint },
});

// ── Pieces ───────────────────────────────────────────────────────────────────

function Kpi({ label, value, note, alert }: { label: string; value: string; note: string; alert?: boolean }) {
  return (
    <View style={s.kpi}>
      <Text style={s.kpiLabel}>{label.toUpperCase()}</Text>
      <Text style={[s.kpiValue, alert ? { color: C.alert } : {}]}>{value}</Text>
      <Text style={s.kpiNote}>{note}</Text>
    </View>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <View style={s.bullet}>
      <Text style={s.dot}>•</Text>
      <Text style={s.bulletText}>{children}</Text>
    </View>
  );
}

/**
 * A stacked column chart, drawn as boxes.
 *
 * Bars carry a 2px surface gap between them and the segments inside a column
 * sit flush, so a column reads as one bar rather than three. Only the first and
 * last day are ticked: a 90-day window cannot label every column, and labelling
 * some of them arbitrarily reads as noise.
 */
function Bars({ rows, series, format }: { rows: Daily[]; series: string[]; format: (n: number) => string }) {
  const peak = niceMax(Math.max(...rows.map((r) => r.total), 0));
  const label = (i: number) => (i === 0 || i === rows.length - 1 ? shortDay(rows[i].day) : "");
  return (
    <View>
      <Text style={s.axisLabel}>{format(peak)}</Text>
      {/* The ceiling is where the axis label is measured from; the baseline is
          what the bars stand on. Both stay faint — they are scaffolding. */}
      <View style={[s.plot, s.plotFrame, s.plotCeiling]}>
        {rows.map((r) => (
          <View key={r.day} style={{ flex: 1, height: "100%", justifyContent: "flex-end" }}>
            {series
              .filter((k) => (r.values[k] ?? 0) > 0)
              .map((k) => (
                <View
                  key={k}
                  style={{
                    height: `${Math.max(0.8, ((r.values[k] ?? 0) / peak) * 100)}%`,
                    backgroundColor: SERIES_HEX[k] ?? SERIES_HEX.kimi,
                  }}
                />
              ))}
          </View>
        ))}
      </View>
      <View style={s.tickRow}>
        {rows.map((r, i) => (
          <Text key={r.day} style={s.tick}>{label(i)}</Text>
        ))}
      </View>
    </View>
  );
}

function Legend({ services }: { services: string[] }) {
  return (
    <View style={s.legend}>
      {services.map((k) => (
        <View key={k} style={s.legendItem}>
          <View style={[s.swatch, { backgroundColor: SERIES_HEX[k] }]} />
          <Text style={s.legendText}>{SERVICE_LABELS[k]}</Text>
        </View>
      ))}
    </View>
  );
}

function Foot() {
  return (
    <View style={s.pageNum} fixed>
      <Text style={s.pageNumText}>Mercato · Usage &amp; spend</Text>
      <Text style={s.pageNumText} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
    </View>
  );
}

// ── The document ─────────────────────────────────────────────────────────────

export function UsageReportDoc({ data }: { data: ReportData }) {
  const kimi = data.byService.find((x) => x.service === "kimi");
  const totalCalls = data.byService.reduce((a, x) => a + x.calls, 0);
  const totalFailed = data.byService.reduce((a, x) => a + (x.failed ?? 0), 0);
  const spend = data.actualSpendUsd ?? kimi?.estCostUsd ?? 0;
  const measured = data.actualSpendUsd != null;

  const ai = data.byFeature.filter((f) => f.service === "kimi");
  const totalTokens = ai.reduce((a, f) => a + f.input + f.output, 0) || 1;
  const aiFeatures = ai
    .map((f) => ({ ...f, share: (f.input + f.output) / totalTokens }))
    .sort((a, b) => b.share - a.share);

  const callSeries = toDailySeries(data.byDay, (r: { calls: number }) => r.calls, data.days);
  const spendSeries = toDailySeries(
    data.byDay.filter((r) => r.service === "kimi"),
    (r: { day: string; estCostUsd: number | null }) => data.actualByDay?.[r.day] ?? r.estCostUsd ?? 0,
    data.days,
  );
  const activeDays = callSeries.filter((d) => d.total > 0).length;
  const perActiveDay = activeDays > 0 ? spend / activeDays : 0;

  const worstDay = (() => {
    if (totalFailed === 0) return null;
    const m = new Map<string, number>();
    for (const r of data.byDay) if (r.failed) m.set(r.day, (m.get(r.day) ?? 0) + r.failed);
    const top = [...m].sort((a, b) => b[1] - a[1])[0];
    return top ? { day: top[0], count: top[1], share: top[1] / totalFailed } : null;
  })();

  const present = SERVICES.filter((k) => data.byService.some((r) => r.service === k));

  return (
    <Document
      title={`Mercato — usage and spend, ${data.days} days`}
      author="Mercato"
      subject={`Usage and spend, ${formatDate(data.since)} to ${formatDate(new Date())}`}
    >
      {/* ── Page one: the answer ─────────────────────────────────────────── */}
      <Page size="A4" style={s.page}>
        <View style={s.masthead}>
          <View style={s.mastheadRow}>
            <View>
              <Text style={s.eyebrow}>MERCATO</Text>
              <Text style={s.title}>Usage &amp; spend report</Text>
            </View>
            <View>
              <Text style={s.metaStrong}>
                {formatDate(data.since)} – {formatDate(new Date())}
              </Text>
              <Text style={s.metaLine}>{data.days} days</Text>
              <Text style={s.metaLine}>Prepared {formatDateTime(new Date())}</Text>
              {data.teamScoped ? <Text style={s.metaStrong}>Your team only</Text> : null}
            </View>
          </View>
        </View>

        <View style={s.kpiRow}>
          <Kpi label="AI spend" value={usd(spend)} note={measured ? "measured from balance" : "estimated from tokens"} />
          <Kpi label="Billable calls" value={fmt(totalCalls)} note={`${activeDays} active days`} />
          <Kpi label="Average / active day" value={usd(perActiveDay)} note="AI only" />
          <Kpi
            label="Failed calls"
            value={fmt(totalFailed)}
            note={totalCalls > 0 ? `${pct(totalFailed / totalCalls)} of all calls` : "—"}
            alert={totalFailed > 0}
          />
        </View>

        <View style={s.panel}>
          <Text style={s.panelTitle}>Summary</Text>
          <Bullet>
            {usd(spend)} of AI credit was spent over {data.days} days across {fmt(kimi?.calls ?? 0)} model
            calls{measured
              ? ` — taken from the drop in the provider's own account balance across ${data.balanceReadings} readings, so no price list is involved.`
              : " — estimated from token counts at the configured rate."}
          </Bullet>
          {aiFeatures[0] ? (
            <Bullet>
              The largest consumer was {FEATURE_LABELS[aiFeatures[0].feature] ?? aiFeatures[0].feature}, at
              roughly {pct(aiFeatures[0].share)} of all tokens processed
              {aiFeatures[1]
                ? `, followed by ${FEATURE_LABELS[aiFeatures[1].feature] ?? aiFeatures[1].feature} at ${pct(aiFeatures[1].share)}`
                : ""}.
            </Bullet>
          ) : null}
          {totalFailed > 0 ? (
            <Bullet>
              {fmt(totalFailed)} calls failed and were still billed.{" "}
              {worstDay && worstDay.share > 0.4
                ? `${pct(worstDay.share)} of them fell on a single day, ${formatYmd(worstDay.day)}, which points at one incident rather than a persistent fault.`
                : "They are spread across the period rather than concentrated in one incident."}{" "}
              Their token counts are unknown, so every figure here is a floor, not a ceiling.
            </Bullet>
          ) : null}
          {data.byService
            .filter((x) => x.service !== "kimi")
            .map((x) => (
              <Bullet key={x.service}>
                {SERVICE_LABELS[x.service]} consumed {fmt(x.units)} {UNIT_LABELS[x.service] ?? "units"} over{" "}
                {fmt(x.calls)} calls. It is a flat quota plan, so it carries no per-call cost.
              </Bullet>
            ))}
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>SERVICES</Text>
          <View style={s.th}>
            <Text style={[s.thText, { flex: 2.1 }]}>SERVICE</Text>
            <Text style={[s.thText, { flex: 3 }]}>WHAT IT DOES</Text>
            <Text style={[s.thText, s.right, { flex: 1 }]}>CALLS</Text>
            <Text style={[s.thText, s.right, { flex: 2 }]}>CONSUMED</Text>
            <Text style={[s.thText, s.right, { flex: 1 }]}>FAILED</Text>
            <Text style={[s.thText, s.right, { flex: 1.2 }]}>COST</Text>
          </View>
          {present.map((k) => {
            const r = data.byService.find((x) => x.service === k)!;
            const isAi = k === "kimi";
            return (
              <View key={k} style={s.tr}>
                <View style={{ flex: 2.1, flexDirection: "row", alignItems: "center" }}>
                  <View style={[s.swatch, { backgroundColor: SERIES_HEX[k] }]} />
                  <Text style={s.td}>{SERVICE_LABELS[k]}</Text>
                </View>
                <Text style={[s.tdMuted, { flex: 3 }]}>{SERVICE_ROLE[k]}</Text>
                <Text style={[s.td, s.right, { flex: 1 }]}>{fmt(r.calls)}</Text>
                <Text style={[s.td, s.right, { flex: 2 }]}>
                  {isAi ? `${tok(r.input)} in / ${tok(r.output)} out` : `${fmt(r.units)} ${UNIT_LABELS[k] ?? ""}`}
                </Text>
                <Text style={[s.td, s.right, { flex: 1 }]}>{r.failed ? fmt(r.failed) : "—"}</Text>
                <Text style={[s.td, s.right, { flex: 1.2 }]}>
                  {isAi ? usd(measured ? spend : r.estCostUsd) : "quota plan"}
                </Text>
              </View>
            );
          })}
        </View>

        <View style={s.chartRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.sectionTitle}>CALLS PER DAY</Text>
            <Bars
              rows={callSeries}
              series={[...SERVICES]}
              format={(n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))}
            />
            <Legend services={[...present]} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.sectionTitle}>AI SPEND PER DAY</Text>
            <Bars
              rows={spendSeries}
              series={["kimi"]}
              format={(n) => (n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)}
            />
          </View>
        </View>

        {/* Page one had a third of itself empty under the charts while this
            sat alone at the top of page two. It is also the section someone
            reads straight after the headline figures, so it belongs here. */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>WHERE THE AI SPEND WENT</Text>
          <Text style={s.sectionNote}>
            Share of all tokens processed. The balance measures the account as a whole, not each
            feature, so these are proportions of work done rather than billed amounts.
          </Text>
          <View style={s.th}>
            <Text style={[s.thText, { flex: 3 }]}>FEATURE</Text>
            <Text style={[s.thText, s.right, { flex: 1 }]}>CALLS</Text>
            <Text style={[s.thText, s.right, { flex: 1.2 }]}>TOKENS</Text>
            <Text style={[s.thText, { flex: 3, paddingLeft: 12 }]}>SHARE</Text>
          </View>
          {aiFeatures.map((f) => (
            <View key={f.feature} style={s.tr}>
              <Text style={[s.td, { flex: 3 }]}>{FEATURE_LABELS[f.feature] ?? f.feature}</Text>
              <Text style={[s.td, s.right, { flex: 1 }]}>{fmt(f.calls)}</Text>
              <Text style={[s.td, s.right, { flex: 1.2 }]}>{tok(f.input + f.output)}</Text>
              <View style={{ flex: 3, flexDirection: "row", alignItems: "center", paddingLeft: 12 }}>
                <View style={s.track}>
                  <View
                    style={[s.fill, { width: `${Math.max(2, f.share * 100)}%`, backgroundColor: SERIES_HEX.kimi }]}
                  />
                </View>
                <Text style={[s.td, s.right, { width: 26 }]}>{pct(f.share)}</Text>
              </View>
            </View>
          ))}
        </View>

        <Foot />
      </Page>

      {/* ── Page two: the detail behind it ───────────────────────────────── */}
      <Page size="A4" style={s.page}>
        {data.byProject.length > 0 ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>BUSIEST PROJECTS</Text>
            <View style={s.th}>
              <Text style={[s.thText, { flex: 4 }]}>PROJECT</Text>
              <Text style={[s.thText, s.right, { flex: 1 }]}>CALLS</Text>
              <Text style={[s.thText, s.right, { flex: 1.2 }]}>TOKENS</Text>
              <Text style={[s.thText, s.right, { flex: 1.4 }]}>QUOTA UNITS</Text>
            </View>
            {data.byProject.slice(0, 12).map((p) => (
              <View key={p.projectId ?? "none"} style={s.tr}>
                <Text style={[s.td, { flex: 4 }]}>
                  {p.name ?? (p.projectId ? p.projectId.slice(0, 8) : "— no project —")}
                </Text>
                <Text style={[s.td, s.right, { flex: 1 }]}>{fmt(p.calls)}</Text>
                <Text style={[s.td, s.right, { flex: 1.2 }]}>{tok(p.input + p.output)}</Text>
                <Text style={[s.td, s.right, { flex: 1.4 }]}>{p.units ? fmt(p.units) : "—"}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {data.byModel.length > 0 ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>MODELS USED</Text>
            <View style={s.th}>
              <Text style={[s.thText, { flex: 3 }]}>MODEL</Text>
              <Text style={[s.thText, s.right, { flex: 1 }]}>CALLS</Text>
              <Text style={[s.thText, s.right, { flex: 1.2 }]}>TOKENS IN</Text>
              <Text style={[s.thText, s.right, { flex: 1.2 }]}>TOKENS OUT</Text>
            </View>
            {data.byModel.map((m) => (
              <View key={m.model} style={s.tr}>
                <Text style={[s.td, { flex: 3, fontFamily: "Courier" }]}>{m.model}</Text>
                <Text style={[s.td, s.right, { flex: 1 }]}>{fmt(m.calls)}</Text>
                <Text style={[s.td, s.right, { flex: 1.2 }]}>{tok(m.input)}</Text>
                <Text style={[s.td, s.right, { flex: 1.2 }]}>{tok(m.output)}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={s.footNote}>
          <Text style={s.footTitle}>How these figures are produced</Text>
          <Text style={s.footText}>
            Every billable call to a paid provider is recorded at the moment it is made, with the
            feature and project that caused it. Token counts come from the model&apos;s own responses,
            Keepa tokens from the value it returns on each call, and Synccentric searches from its
            quota headers — none of it is inferred.
            {measured
              ? " The dollar figure is the fall in the provider's account balance over the period, which is the provider's own arithmetic: no price list is involved and cached tokens are already accounted for. Top-ups are ignored rather than netted off, so a recharge inside the period cannot hide the spend either side of it."
              : " The dollar figure is estimated from tokens until two balance readings exist."}{" "}
            Keepa and Synccentric are flat quota plans rather than per-call billing, so their usage is
            reported in units; a dollar figure there would be invented. Failed calls are billed but
            report no tokens, so totals are a floor.
          </Text>
        </View>

        <Foot />
      </Page>
    </Document>
  );
}
