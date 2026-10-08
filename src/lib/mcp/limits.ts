/**
 * The numbers a person hits, in one place.
 *
 * Every one of these was a `const` beside the code that enforced it, which is
 * the right place for enforcing and the wrong place for explaining. The Help
 * page has to state them, and a Help page that states them from its own copy
 * is a Help page that is wrong six months from now — confidently, and in the
 * one document somebody reads precisely because they do not know the answer.
 *
 * So the limits live here and both sides import them: the tools enforce these
 * values and the page prints these values, and they cannot drift.
 *
 * No imports, deliberately. The page is a server component and pulling in the
 * tool registry to read a number would drag Prisma and every marketplace
 * loader into rendering a static page.
 */

/** Runs of one kind — exports, verifications, categorisations — per account
 *  per 24 hours. */
export const RUNS_PER_DAY = 20;

/** Rows a single read tool will return. */
export const MAX_ROWS = 200;

/** Rows a single write tool will accept. Larger batches are refused rather
 *  than truncated: a half-applied write is worse than a refused one. */
export const MAX_WRITE = 500;

/** Products handed over per categorisation batch, and the most that may be
 *  asked for. */
export const CATEGORIZE_BATCH = 40;
export const CATEGORIZE_BATCH_MAX = 100;

/** Products per batch of export gaps, and the ceiling. */
export const EXPORT_GAPS_BATCH = 25;
export const EXPORT_GAPS_BATCH_MAX = 60;

/** A file sent inline through a tool call, as raw bytes before base64. Bigger
 *  files go through Mercato's own upload screen. */
export const MAX_INLINE_UPLOAD_BYTES = 8 * 1024 * 1024;

/** How long a download link works. Long enough to click or to curl; short
 *  enough that a link left in a transcript stops working before it matters. */
export const DOWNLOAD_TICKET_TTL_MS = 15 * 60 * 1000;
