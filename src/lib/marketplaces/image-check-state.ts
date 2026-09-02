/**
 * Image-check state helpers shared by the server (verify library, sweep route)
 * and the browser (verify step). Deliberately free of server imports — keep it
 * that way so the client bundle can use the same predicate the sweep does.
 */

/** Marker text in the images note while no AI verdict exists yet. */
export const PENDING_MARKER = "not compared";

/**
 * Note fragments that mean the row was closed WITHOUT the AI ever judging the
 * images: the provider failed (account suspended, key rejected, model gone,
 * transport error) or answered with no text. Such a row is not a review
 * verdict, so it goes back into the queue instead of staying "manual review".
 * Genuine "the model looked and could not tell" or "image could not be
 * downloaded" outcomes are NOT in this list.
 */
export const REQUEUE_NOTE_FRAGMENTS = [
  "AI vision call failed",
  "AI unavailable",
  "No reason given",
  "AI returned an empty answer",
] as const;

export type ImageFieldLike = {
  field?: string;
  note?: string;
  stored?: string;
  liveImage?: string;
  severity?: string;
  match?: boolean;
  aiAttempts?: number;
};

const isUrl = (v: unknown): v is string => typeof v === "string" && v.startsWith("http");

/** Both a catalog image and a marketplace image exist to compare. */
export function hasComparablePair(f: ImageFieldLike): boolean {
  return isUrl(f.stored) && isUrl(f.liveImage);
}

/** The row was finalized without a verdict and should be re-queued. */
export function needsImageRequeue(f: ImageFieldLike): boolean {
  const note = f.note ?? "";
  if (note.includes(PENDING_MARKER)) return false;
  return REQUEUE_NOTE_FRAGMENTS.some((frag) => note.includes(frag));
}

/**
 * True when the background sweep should (still) process this images row: it
 * has both images and either carries the pending marker or was closed without
 * the AI ever answering.
 */
export function isImageCheckPending(f: ImageFieldLike): boolean {
  if (!hasComparablePair(f)) return false;
  return (f.note ?? "").includes(PENDING_MARKER) || needsImageRequeue(f);
}

/**
 * Put a wrongly-finalized images row back into the pending state: fresh
 * attempt budget, pending marker restored (which also returns the product to
 * its identity-based status in the rollup). Returns the short cause carried
 * into the new note.
 */
export function requeueImageField(f: ImageFieldLike): string {
  const cause = (f.note ?? "")
    .replace(/^Needs manual review\s*—\s*/i, "")
    .replace(/^Images not compared yet\s*—\s*/i, "")
    .replace(/\s*Automatic retry queued.*$/i, "")
    .trim();
  f.note =
    `Images ${PENDING_MARKER} yet — the earlier AI check could not run ` +
    `(${cause || "no verdict was recorded"}). Automatic retry queued.`;
  f.aiAttempts = 0;
  f.severity = "warning";
  f.match = false;
  return cause;
}
