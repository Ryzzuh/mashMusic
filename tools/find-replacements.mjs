/* Offline replacement search — the YouTube half of QoL 1.
 *
 *   YOUTUBE_API_KEY=... node tools/find-replacements.mjs
 *
 * Writes data/replacements.json, which the app merges on load alongside
 * data/liveness.json. The app's own library search — Levenshtein over titles
 * against live tracks — needs none of this and covers both sources; this only
 * adds candidates from outside the library, and only for YouTube.
 *
 * SoundCloud gets nothing here on purpose. Its public API has been closed to
 * new registrations since 2019, so there is no search endpoint to call.
 *
 * Runs offline for the same two reasons as check-liveness.mjs: the endpoint is
 * CORS-blocked from the browser, and the key must not ship to the client.
 *
 * Cost matters. search.list bills **100 quota units per call** against a
 * 10,000/day default — that is 100 dead tracks per day, not 10,000. The script
 * therefore only ever looks at tracks already known to be dead, skips any it
 * has already solved, and stops at --limit.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "data/replacements.json");
const SEARCH_COST = 100;

async function loadTracks() {
  const src = await readFile(join(ROOT, "data/tracks.js"), "utf8");
  return JSON.parse(src.slice(src.indexOf("["), src.lastIndexOf("]") + 1));
}

async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

/* Same scoring as the app, so the offline suggestions rank on the same scale
   as the library ones and can be listed together without surprising anyone. */
const normalise = (s) => s.toLowerCase().replace(/[‘’']/g, "")
  .replace(/[^a-z0-9]+/g, " ").trim();
const coreOf = (s) => normalise(s.replace(/[([][^)\]]*[)\]]/g, " "));

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return a.length || b.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  const cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur.slice();
  }
  return prev[b.length];
}

const form = (x, y) => (!x || !y ? 0 : 1 - levenshtein(x, y) / Math.max(x.length, y.length));
const similarity = (a, b) =>
  Math.max(form(normalise(a), normalise(b)), form(coreOf(a), coreOf(b)));

async function api(path, params, key) {
  const url = new URL("https://www.googleapis.com/youtube/v3/" + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", key);
  const res = await fetch(url, { headers: { "User-Agent": "mashmusic-replacements/1.0" } });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 180)}`);
  return res.json();
}

async function main() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    console.error("YOUTUBE_API_KEY is not set. Nothing to do.");
    return 1;
  }
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 25;

  const tracks = await loadTracks();
  const liveness = await loadJson(join(ROOT, "data/liveness.json"), {});
  const out = await loadJson(OUT, {});

  const dead = tracks.filter((t) => {
    const rec = liveness[t.k];
    return t.s === "YT" && rec && (rec.s === "gone" || rec.s === "blocked") && !out[t.k];
  }).slice(0, limit);

  if (!dead.length) {
    console.log("nothing to search — no unsolved dead YouTube tracks");
    return 0;
  }
  console.log(`${dead.length} dead tracks, ~${dead.length * SEARCH_COST} quota units`);

  let found = 0;
  for (const t of dead) {
    try {
      const res = await api("search", {
        part: "snippet", type: "video", maxResults: 8,
        videoEmbeddable: "true", videoSyndicated: "true", q: t.t,
      }, key);

      const cands = (res.items || [])
        .map((it) => ({
          i: it.id.videoId,
          t: it.snippet.title,
          c: it.snippet.channelTitle,
          score: +similarity(t.t, it.snippet.title).toFixed(3),
        }))
        .filter((c) => c.i && c.i !== t.i && c.score >= 0.55)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      if (cands.length) { out[t.k] = cands; found++; }
      console.log(`  ${t.k}  ${cands.length} candidate(s)  ${t.t.slice(0, 52)}`);
    } catch (e) {
      console.error(`  FAIL ${t.k}: ${e.message}`);
      if (/quota/i.test(e.message)) break;      // stop rather than burn the rest
    }
  }

  await writeFile(OUT, JSON.stringify(out, null, 0));
  console.log(`wrote ${OUT}: ${Object.keys(out).length} tracks with suggestions (${found} new)`);
  return 0;
}

main().then((c) => process.exit(c));
