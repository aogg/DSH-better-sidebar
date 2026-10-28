/**
 * Row bound of ONE `fs.trees` batch request.
 *
 * Shared by both halves so they cannot drift: the host refuses a larger batch
 * outright (`too many paths (max N)`), and the client splits the visible set on
 * the same number — a session whose persisted expansion set reaches the cap
 * used to blank its WHOLE file tree on every mount/refresh. Kept free of
 * runtime dependencies so the browser bundle pulls nothing in with it.
 *
 * 10 (down from 64): one batch row is a whole directory listing, and a wide
 * mount used to ride them all in ONE request — the bound keeps a single
 * request's work (and its shared probe gate) cheap; the client chunks its
 * visible set at this width and queues the batches, so a deep tree still
 * loads, one bounded request at a time.
 */
export const FS_TREES_MAX_PATHS = 10
