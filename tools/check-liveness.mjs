/* Offline liveness backfill.
 *
 *   YOUTUBE_API_KEY=... node tools/check-liveness.mjs
 *
 * Writes data/liveness.json, which the app merges on load. Runs offline
 * because both endpoints are CORS-blocked from the browser, and because the
 * YouTube key must not ship to the client.
 *
 * Cost: videos.list takes 50 ids per call and bills 1 quota unit per call
 * regardless, so the whole library is ~19 units against a 10,000/day quota.
 * SoundCloud's oEmbed needs no key but is one request per track.
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
        out[t.k] = { s: "gone", c: 100, t: Date.now() };
      } else if (v.status?.privacyStatus === "private") {
        out[t.k] = { s: "gone", c: 100, t: Date.now() };
      } else if (v.status?.embeddable === false) {
        out[t.k] = { s: "blocked", c: 150, t: Date.now() };
      } else {
        out[t.k] = { s: "ok", c: null, t: Date.now() };
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
        out[t.k] = res.ok
          ? { s: "ok", c: null, t: Date.now() }
          : { s: "gone", c: res.status, t: Date.now() };
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

const tracks = await loadTracks();
const out = {};

console.log("checking %d tracks", tracks.length);
await checkYouTube(tracks.filter((t) => t.s === "YT"), process.env.YOUTUBE_API_KEY, out);
await checkSoundCloud(tracks.filter((t) => t.s === "SC"), out);

const tally = Object.values(out).reduce((a, r) => ((a[r.s] = (a[r.s] || 0) + 1), a), {});
await writeFile(join(ROOT, "data/liveness.json"), JSON.stringify(out, null, 0) + "\n");
console.log("wrote data/liveness.json —", tally);
