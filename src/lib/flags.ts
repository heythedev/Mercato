/**
 * Switches for everything added recently, so any of it can be turned off
 * without a code change or a rollback.
 *
 * Each flag names the thing it governs, says what happens when it is off, and
 * states its default. Read at call time rather than captured at module load,
 * so changing one in the platform's settings takes effect on the next request
 * instead of needing a deploy to notice.
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

const OFF = ["false", "0", "off", "no"];
const ALL = ["true", "1", "on", "yes", "all"];

/**
 * Which write tools are allowed: none, all, or a named few.
 *
 * A single on/off switch forced a choice nobody should have to make — turning
 * on category assignment also turned on clearing fields and setting a default
 * that governs every future export. The sensible rollout is one tool at a
 * time, so the variable takes a list:
 *
 *   MCP_WRITE_ENABLED=false                          nothing
 *   MCP_WRITE_ENABLED=true                           everything
 *   MCP_WRITE_ENABLED=submit_categorization,rename_project   those two
 *
 * Unknown names are kept rather than dropped. A typo then disables the tool
 * it was meant to enable, which someone notices; silently matching nothing
 * while reporting success is how a half-configured rollout looks healthy.
 */
export function mcpWriteTools(): "none" | "all" | string[] {
  const raw = process.env.MCP_WRITE_ENABLED;
  if (raw == null || raw.trim() === "") return "none";
  const v = raw.trim().toLowerCase();
  if (OFF.includes(v)) return "none";
  if (ALL.includes(v)) return "all";
  const names = v.split(",").map((s) => s.trim()).filter(Boolean);
  return names.length ? names : "none";
}

/** Whether one named write tool may be listed and called. */
export function writeToolEnabled(name: string): boolean {
  const allowed = mcpWriteTools();
  if (allowed === "none") return false;
  if (allowed === "all") return true;
  return allowed.includes(name.toLowerCase());
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
   * Off: they are not listed and are refused if called anyway, so a model
   * cannot discover them and try.
   *
   * Default OFF. Letting a language model change a live catalogue is a
   * decision a person should make deliberately, on a day they choose, having
   * read what the tools do — not one that arrives with a deploy.
   *
   * True when ANY write tool is enabled. To enable them one at a time, see
   * mcpWriteTools() — MCP_WRITE_ENABLED also accepts a comma-separated list.
   */
  mcpWrite: () => mcpWriteTools() !== "none",

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
