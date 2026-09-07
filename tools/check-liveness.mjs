/* Offline liveness backfill.
 *
 *   YOUTUBE_API_KEY=... node tools/check-liveness.mjs [--limit N] [--recheck]
 *
 * Writes data/liveness.json, which the app merges on load.
 *
 * This runs offline for ONE reason: the YouTube key must not ship to a static
 * public page. An earlier version of this comment also claimed the endpoints
 * were CORS-blocked from the browser. They are not — measured 2026-09-07 from
 * the page's own origin, googleapis.com, youtube.com/oembed and
 * soundcloud.com/oembed all answer cross-origin. That is what the in-app batch
 * check in app.js relies on.
 *
 * So what is this script still FOR, given the app can check liveness itself?
 * One thing the app cannot do: videos.list reports `embeddable` and
 * `privacyStatus`, which is the only way to learn that a video exists but has
 * embedding disabled. oEmbed answers 200 for those exactly as it does for a
 * healthy video. Records from here are therefore tagged v:"api" and are
 * allowed to upgrade the app's cheaper v:"oembed" records — but never a
 * v:"playback" one, which watched the embed actually run.
 *
 * Resumes by default: existing records are loaded and their tracks skipped,
 * so a run costs only what is still unknown. Pass --recheck to start over.
 *
 * Cost: videos.list takes 50 ids per call and bills 1 quota unit per call
 * regardless, so the whole library is ~19 units against a 10,000/day quota.
 * There is no endpoint that reports remaining quota; the estimate printed
 * below is derived from what this run is about to ask for.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const UA = "mashmusic-liveness/1.0";

async function loadTracks() {
  const src = await readFile(join(ROOT, "data/tracks.js"), "utf8");
  const json = src.slice(src.indexOf("["), src.lastIndexOf("]") + 1);
  return JSON.parse(json);
}

const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function checkYouTube(tracks, key, out) {
  if (!key) {
    console.warn("! YOUTUBE_API_KEY not set — skipping %d YouTube tracks", tracks.length);
    return;
  }
  const batches = chunk(tracks, 50);
  for (const [i, batch] of batches.entries()) {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "status,contentDetails");
    url.searchParams.set("id", batch.map((t) => t.i).join(","));
    url.searchParams.set("key", key);

    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`youtube ${res.status}: ${await res.text()}`);
    const body = await res.json();
    const found = new Map(body.items.map((v) => [v.id, v]));

    for (const t of batch) {
      const v = found.get(t.i);
      if (!v) {
        out[t.k] = { s: "gone", c: 100, t: Date.now(), v: "api" };
      } else if (v.status?.privacyStatus === "private") {
        out[t.k] = { s: "gone", c: 100, t: Date.now(), v: "api" };
      } else if (v.status?.embeddable === false) {
        out[t.k] = { s: "blocked", c: 150, t: Date.now(), v: "api" };
      } else {
        out[t.k] = { s: "ok", c: null, t: Date.now(), v: "api" };
      }
    }
    process.stdout.write(`\r  youtube ${i + 1}/${batches.length} batches`);
  }
  process.stdout.write("\n");
}

async function checkSoundCloud(tracks, out, concurrency = 6) {
  let cursor = 0, done = 0;
  async function worker() {
    while (cursor < tracks.length) {
      const t = tracks[cursor++];
      const url = "https://soundcloud.com/oembed?format=json&url=" +
        encodeURIComponent("https://api.soundcloud.com/tracks/" + t.i);
      try {
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        /* oembed, not api: this is the same request the app makes, so it
           carries the same weakness — it cannot see embedding being off. */
        out[t.k] = res.ok
          ? { s: "ok", c: null, t: Date.now(), v: "oembed" }
          : { s: "gone", c: res.status, t: Date.now(), v: "oembed" };
      } catch (e) {
        /* leave unknown rather than record a false negative on a network blip */
      }
      done++;
      if (done % 20 === 0) process.stdout.write(`\r  soundcloud ${done}/${tracks.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write(`\r  soundcloud ${done}/${tracks.length}\n`);
}

const OUT_PATH = join(ROOT, "data/liveness.json");
const argFlag = (name) => process.argv.includes(name);
const argNum = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 && Number.isFinite(+process.argv[i + 1]) ? +process.argv[i + 1] : dflt;
};

const tracks = await loadTracks();
const recheck = argFlag("--recheck");
const limit = argNum("--limit", Infinity);

/* Resume. The file is its own record of what has been checked — every entry
   carries a status and a timestamp — so a second ledger could only disagree
   with it. --recheck throws that away deliberately. */
let out = {};
if (!recheck) {
  try { out = JSON.parse(await readFile(OUT_PATH, "utf8")); } catch { out = {}; }
}
const known = new Set(Object.keys(out));
const pending = tracks.filter((t) => !known.has(t.k)).slice(0, limit);
const yt = pending.filter((t) => t.s === "YT");
const sc = pending.filter((t) => t.s === "SC");

if (!pending.length) {
  console.log("nothing to check — %d tracks already recorded (--recheck to redo)", known.size);
  process.exit(0);
}
console.log(
  "%d already recorded, checking %d (%d youtube, %d soundcloud)",
  known.size, pending.length, yt.length, sc.length
);
console.log("  youtube quota: ~%d units of a 10,000/day default", Math.ceil(yt.length / 50));

await checkYouTube(yt, process.env.YOUTUBE_API_KEY, out);
await checkSoundCloud(sc, out);

const tally = Object.values(out).reduce((a, r) => ((a[r.s] = (a[r.s] || 0) + 1), a), {});
await writeFile(OUT_PATH, JSON.stringify(out, null, 0) + "\n");
console.log("wrote data/liveness.json —", tally);
