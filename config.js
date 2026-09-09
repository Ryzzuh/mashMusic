/* Deployment configuration. Edit this file; nothing else needs changing.
 *
 * metaApi — a deployed server/api/resolve.js, e.g.
 *           "https://mashmusic-meta.vercel.app/api/resolve"
 *
 * Empty is the default and a supported state: the app resolves titles from
 * oEmbed and durations by cueing, which needs no key and no server. Setting
 * this only makes it faster.
 *
 * A plain script rather than JSON so the site still works opened from disk,
 * for the same reason data/tracks.js is one. It does not overwrite an existing
 * value, so tests can set one before the page loads.
 */
window.MASH_CONFIG = window.MASH_CONFIG || {
  metaApi: "https://mash-music-meta.vercel.app/api/resolve"
};
