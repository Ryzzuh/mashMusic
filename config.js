/* Deployment configuration. Edit this file; nothing else needs changing.
 *
 * metaApi — a deployed server/api/resolve.js, e.g.
 *           "https://mashmusic-meta.vercel.app/api/resolve"
 *
 * Set, this is THE resolver: the whole playlist goes through it, fifty ids a
 * call, up to a daily budget. Empty is still a supported state — the app falls
 * back to oEmbed titles and durations read off a cued player, which needs no
 * key and no server — but it is the slow path, one request per title and no
 * durations at all until each one is cued.
 *
 * A plain script rather than JSON so the site still works opened from disk,
 * for the same reason data/tracks.js is one. It does not overwrite an existing
 * value, so tests can set one before the page loads.
 */
window.MASH_CONFIG = window.MASH_CONFIG || {
  metaApi: "https://mash-music-meta.vercel.app/api/resolve"
};
