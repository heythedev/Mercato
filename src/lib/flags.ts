/**
 * Switches for everything added recently, so any of it can be turned off
 * without a code change or a rollback.
 *
 * Each flag names the thing it governs, says what happens when it is off, and
 * states its default. Read at call time rather than captured at module load,
 * so nothing here is frozen into a bundle at build time.
 *
 * That is NOT the same as taking effect immediately on Vercel, and this
 * comment used to imply it did. Vercel injects environment variables into a
 * deployment when that deployment is created: changing one in the dashboard
 * leaves the running functions with the old value until you redeploy. The
 * value of reading at call time is that a redeploy is enough — no code
 * change, no rebuild of anything but the deployment itself — not that the
 * change lands on the next request.
 *
 * The defaults follow one rule: anything that only READS is on, anything that
 * WRITES is off until somebody decides otherwise. A feature nobody has asked
 * for should not be able to change data on the day it ships.
 */

/** "false", "0", "off" and "no" all mean off. Anything else means on. */
function on(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return !["false", "0", "off", "no"].includes(raw.trim().toLowerCase());
}

export const flags = {
  /**
   * The MCP endpoint at /api/mcp.
   *
   * Off: the route answers 404 and the Connect to Claude page says so rather
   * than handing out tokens that cannot be used. Existing tokens stop working
   * and are not revoked, so switching it back on restores them.
   *
   * Default ON — it only reads, and every tool is scoped to the token's owner.
   */
  mcp: () => on("MCP_ENABLED", true),

  /**
   * Write tools over MCP: setting a category, entering a compliance default,
   * starting a run.
   *
   * This is the kill switch, not the decision. WHICH write tools a person's
   * Claude may use is that person's choice, made on Settings → Connect to
   * Claude and stored on their account (User.mcpWriteTools) — so writes are
   * still off until somebody decides otherwise, and the somebody is the one
   * whose catalogue it is.
   *
   * Off: no write tool is listed or callable for anyone, whatever they chose.
   * Their choices are kept, and come back when it is switched on again.
   *
   * Default ON. An old comma-separated list of tool names also reads as on:
   * the per-tool decision moved to each account.
   */
  mcpWrite: () => on("MCP_WRITE_ENABLED", true),

  /**
   * Holding a run the AI balance cannot cover.
   *
   * Off: runs start whenever there is any credit at all, which is the old
   * behaviour — an export begins with $12, runs out two thirds through, and
   * ships blank cells to a client.
   *
   * Default ON. Kept switchable because the estimate is an estimate, and a
   * wrong one blocking real work must be removable in a minute rather than a
   * release.
   */
  spendGuard: () => on("AI_SPEND_GUARD", true),

  /**
   * The /ui-preview design-system page.
   *
   * Default ON in development, OFF in production — it is a working surface,
   * not a feature. MCP_ENABLED-style override is deliberate: set
   * UI_PREVIEW_ENABLED=true to show it on a deployment while reviewing.
   */
  uiPreview: () => on("UI_PREVIEW_ENABLED", process.env.NODE_ENV !== "production"),

  /**
   * The nightly cache cleanup at /api/cron/cleanup-caches.
   *
   * Off: the route answers 200 and deletes nothing, so the schedule keeps
   * firing harmlessly and can be re-enabled without touching the deployment
   * config. Answering 200 rather than an error is deliberate — a cron that
   * reports failure every night while working exactly as intended trains
   * everyone to ignore it.
   *
   * Default ON, but it deletes nothing unless CRON_SECRET is set as well: the
   * route refuses an unauthenticated call, so the schedule is inert until
   * somebody configures it.
   */
  cacheCleanup: () => on("CACHE_CLEANUP_ENABLED", true),
} as const;

/** For the Connect page and any diagnostics, so nobody has to guess. */
export function flagStates(): Record<string, boolean> {
  return {
    mcp: flags.mcp(),
    mcpWrite: flags.mcpWrite(),
    spendGuard: flags.spendGuard(),
    uiPreview: flags.uiPreview(),
    cacheCleanup: flags.cacheCleanup(),
  };
}
