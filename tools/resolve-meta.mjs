/* Offline metadata resolution — the batched, keyed path.
 *
 *   YOUTUBE_API_KEY=... node tools/resolve-meta.mjs --sheet <url or id>
 *   YOUTUBE_API_KEY=... node tools/resolve-meta.mjs --ids abc123,def456
 *
 * Writes data/meta.json, which the app merges on load and consults BEFORE
 * asking YouTube about anything. Its point is to make a key unnecessary
 * everywhere else: run this once on the machine that has one, commit the
 * result, and every other workstation — and every visitor — gets resolved
 * titles and durations instantly with no key and nothing to sync.
 *
 * localStorage does not sync between machines and a key does not belong in a
 * URL, so the key stays here, in an environment variable, on one machine. What
 * travels is the output, which is not secret.
 *
 * Why this and not the in-app path: videos.list takes 50 ids per call and
 * bills ONE quota unit regardless, and returns title, channel, duration and
 * embeddable together. 2,000 tracks is 40 calls and 40 units of a 10,000/day
 * allowance — against ~2,000 oEmbed requests plus ~17 minutes of cueing a
 * hidden player for durations the API hands over for free.
 *
 * Resumable: existing entries are kept and their ids skipped.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "data/meta.json");
const BATCH = 50;                       // videos.list maximum, and 1 unit either way

const SHEET_ID = /\/spreadsheets\/d\/(?:e\/)?([A-Za-z0-9_-]{16,})/;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_IN_URL = /(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/;

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const flag = (name) => process.argv.includes(name);

/** "PT1H2M3S" -> seconds. Same shape build-tracks.py parses for the library. */
export function isoSeconds(v) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(v || "");
  if (!m) return 0;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + Math.round(+m[3] || 0);
}

/** Every YouTube id in a blob of CSV, in order, deduped. */
export function idsFromCsv(text) {
  const out = [], seen = new Set();
  for (const cell of text.split(/[\r\n,]+/)) {
    const v = cell.replace(/^"+|"+$/g, "").trim();
    if (!v) continue;
    const m = v.match(YT_IN_URL);
    const id = m ? m[1] : (YT_ID.test(v) ? v : null);
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

export function sheetRef(input) {
  const raw = (input || "").trim();
  const m = raw.match(SHEET_ID);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{16,}$/.test(raw) ? raw : null;
}

const chunk = (a, n) =>
  Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function fetchSheet(ref) {
  const url = `https://docs.google.com/spreadsheets/d/${ref}/gviz/tq?tqx=out:csv`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sheet ${res.status}`);
  const text = await res.text();
  // An unshared sheet answers 200 with a sign-in page, not an error.
  if (/^\s*<(?:!doctype|html)/i.test(text)) {
    throw new Error("that sheet is not shared — set it to “anyone with the link can view”");
  }
  return text;
}

async function main() {
  const key = process.env.YOUTUBE_API_KEY;
  const sheet = arg("--sheet");
  const idsArg = arg("--ids");

  if (!sheet && !idsArg) {
    console.error("Nothing to do. Pass --sheet <url or id> or --ids a,b,c");
    return 2;
  }

  let ids = [];
  if (sheet) {
    const ref = sheetRef(sheet);
    if (!ref) { console.error("Not a Sheets link or document id: " + sheet); return 2; }
    console.log("reading sheet %s", ref);
    ids = idsFromCsv(await fetchSheet(ref));
  }
  if (idsArg) {
    for (const id of idsArg.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (YT_ID.test(id) && !ids.includes(id)) ids.push(id);
    }
  }
  if (!ids.length) { console.error("No YouTube ids found."); return 1; }

  let out = {};
  if (!flag("--recheck")) {
    try { out = JSON.parse(await readFile(OUT, "utf8")); } catch { out = {}; }
  }
  const pending = ids.filter((id) => !out["YT:" + id]);

  console.log("%d ids, %d already resolved, %d to fetch (~%d quota units)",
    ids.length, ids.length - pending.length, pending.length,
    Math.ceil(pending.length / BATCH));

  if (!pending.length) { console.log("nothing to do"); return 0; }

  /* The sheet half needs no key and has already run, so a missing key is
     reported only now — after the ids have been read and counted. */
  if (!key) {
    console.error("\nYOUTUBE_API_KEY is not set, so nothing can be resolved.");
    console.error("Create one free at console.cloud.google.com (enable YouTube Data API v3),");
    console.error("then: YOUTUBE_API_KEY=... node tools/resolve-meta.mjs --sheet <id>");
    return 1;
  }

  let got = 0, missing = 0;
  for (const [i, batch] of chunk(pending, BATCH).entries()) {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,contentDetails,status");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("key", key);

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      console.error("\nyoutube %d: %s", res.status, body.slice(0, 200));
      if (/quota/i.test(body)) console.error("quota is spent; rerun tomorrow (it resumes)");
      break;
    }
    const body = await res.json();
    const found = new Map((body.items || []).map((v) => [v.id, v]));

    for (const id of batch) {
      const v = found.get(id);
      const k = "YT:" + id;
      if (!v) {
        /* Absent from the response means deleted or private. Flagged, not
           given a `t` — `t` is the title everywhere else in this codebase and
           reusing it for a timestamp here would be a trap for the reader. */
        out[k] = { gone: true };
        missing++;
        continue;
      }
      out[k] = {
        t: v.snippet?.title || "",
        v: v.snippet?.channelTitle || "",
        d: isoSeconds(v.contentDetails?.duration),
        a: v.snippet?.thumbnails?.high?.url || "",
        e: v.status?.embeddable !== false,     // the one thing oEmbed cannot say
      };
      got++;
    }
    process.stdout.write(`\r  ${i + 1}/${Math.ceil(pending.length / BATCH)} batches`);
  }
  process.stdout.write("\n");

  await writeFile(OUT, JSON.stringify(out, null, 0) + "\n");
  const blocked = Object.values(out).filter((r) => r.e === false).length;
  console.log("wrote data/meta.json — %d resolved, %d gone, %d embedding-disabled, %d total",
    got, missing, blocked, Object.keys(out).length);
  return 0;
}

/* Only when run directly. Importing this file must not start a network job —
   the pure parts above are covered by tests that import them. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error(String(e.message || e));
    process.exit(1);
  });
}
