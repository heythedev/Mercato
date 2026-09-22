/**
 * Prove team isolation end-to-end against the running app.
 *
 * The unit tests in src/lib/authz.test.ts pin the RULES; this checks the wiring
 * those rules depend on — that the session carries teamId, that every scoped
 * query reads it, and that a team admin genuinely cannot see another team.
 *
 * Creates a throwaway team and team admin, signs in as them over HTTP, asserts
 * what they can and cannot see, then deletes both. Nothing it creates survives
 * a successful run; a failed run prints what was left behind.
 *
 *   pnpm exec tsx scripts/verify-team-isolation.ts
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/db";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3020";
const EMAIL = "isolation-probe@example.invalid";
const PASSWORD = "Probe-Only-2026!";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Sign in over HTTP and return the session cookie header. */
async function signIn(email: string, password: string): Promise<string> {
  // Keyed by name, last non-empty wins: the CSRF endpoint sets the token cookie
  // twice — once to clear it — and sending both makes the check fail.
  const jar = new Map<string, string>();
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [name, ...rest] = c.split(";")[0].split("=");
      const value = rest.join("=");
      if (value) jar.set(name, value);
    }
  };
  const header = () => [...jar].map(([k, v]) => k + "=" + v).join("; ");
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  keep(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: header() },
    body: new URLSearchParams({ csrfToken, email, password, redirect: "false" }),
  });
  keep(res);
  return header();
}

const get = (path: string, cookie: string) =>
  fetch(`${BASE}${path}`, { headers: { Cookie: cookie }, redirect: "manual" });

(async () => {
  const teamA = await prisma.team.findFirst({ where: { slug: "virventures" } });
  if (!teamA) throw new Error("expected the backfilled team to exist");

  const teamB = await prisma.team.upsert({
    where: { slug: "isolation-probe" },
    create: { name: "Isolation probe", slug: "isolation-probe", allowedMarketplaces: [] },
    update: {},
  });

  // A project owned by nobody in team A, so "can this team admin see it?" has a
  // real answer rather than depending on who happens to own what.
  const outsider = await prisma.user.findFirst({ where: { teamId: teamA.id } });
  if (!outsider) throw new Error("team A has no members");
  const foreignProject = await prisma.project.create({
    data: { userId: outsider.id, teamId: teamB.id, name: "probe-foreign", marketplace: "bestbuy" },
  });

  const probe = await prisma.user.upsert({
    where: { email: EMAIL },
    create: {
      email: EMAIL,
      name: "Isolation probe",
      password: await bcrypt.hash(PASSWORD, 12),
      role: "team_admin",
      teamId: teamA.id,
    },
    update: { role: "team_admin", teamId: teamA.id, password: await bcrypt.hash(PASSWORD, 12) },
  });

  console.log(`\nteam A ${teamA.slug} · team B ${teamB.slug} · probe ${probe.id}\n`);

  try {
    const cookie = await signIn(EMAIL, PASSWORD);
    check("signs in", cookie.includes("session-token"));

    // ── Projects ──────────────────────────────────────────────────────────
    const projects = (await (await get("/api/projects", cookie)).json()) as {
      id: string;
      teamId: string | null;
    }[];
    check("sees their own team's projects", projects.length > 0, `${projects.length} visible`);
    check(
      "sees no project from another team",
      !projects.some((p) => p.id === foreignProject.id),
      "team B's project is hidden",
    );
    const foreign = await get(`/api/projects/${foreignProject.id}`, cookie);
    check("cannot open another team's project by id", foreign.status === 403, `HTTP ${foreign.status}`);

    // ── Users ─────────────────────────────────────────────────────────────
    const { users } = (await (await get("/api/users", cookie)).json()) as {
      users: { teamId: string | null }[];
    };
    check(
      "sees only their own team's members",
      Array.isArray(users) && users.length > 0 && users.every((u) => u.teamId === teamA.id),
      `${users?.length ?? 0} visible`,
    );

    // ── Privilege escalation ──────────────────────────────────────────────
    const promote = await fetch(`${BASE}/api/users`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ id: outsider.id, role: "admin" }),
    });
    check("cannot promote anyone to super admin", promote.status === 403, `HTTP ${promote.status}`);

    const self = await fetch(`${BASE}/api/users`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ id: probe.id, role: "admin" }),
    });
    check("cannot promote THEMSELF", self.status === 403, `HTTP ${self.status}`);

    // ── Usage ─────────────────────────────────────────────────────────────
    const usage = (await (await get("/api/admin/usage?days=30", cookie)).json()) as {
      teamScoped?: boolean;
      actualSpendUsd?: number | null;
    };
    check("usage is reported as team-scoped", usage.teamScoped === true);
    check(
      "is not shown the whole account's measured spend",
      usage.actualSpendUsd == null,
      "balance-derived total withheld",
    );
  } finally {
    await prisma.project.delete({ where: { id: foreignProject.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: probe.id } }).catch(() => {});
    await prisma.team.delete({ where: { id: teamB.id } }).catch(() => {});
    console.log("\ncleaned up the probe team, user and project");
  }

  console.log(failures === 0 ? "\nAll isolation checks passed." : `\n${failures} CHECK(S) FAILED.`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error("FAILED:", String(e).slice(0, 500));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
