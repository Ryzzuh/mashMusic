/* Batched YouTube metadata, with the API key kept off the client.
 *
 *   GET /api/resolve?ids=<up to 50 comma-separated video ids>
 *   -> { "YT:<id>": { t, v, d, a, e } | { gone: true }, ... }
 *
 * Why this exists: videos.list is the only source that gives title, channel,
 * duration AND embeddable together, and it needs a key that must never ship in
 * a static page. The key lives here, in a Vercel environment variable.
 *
 * On restrictions, since it is the obvious question: the key CANNOT be locked
 * to an IP. Vercel functions egress from shared, rotating addresses, and a
 * stable one is a $100/month Pro/Enterprise feature. Nor can a referrer
 * restriction help — a server sends no Referer. The right settings are
 * therefore "Application restrictions: None" plus "API restrictions: YouTube
 * Data API v3 only", which caps what a leaked key could ever reach.
 *
 * That makes THIS ENDPOINT the thing worth protecting, not the key. The
 * defence is caching rather than secrecy: video metadata is effectively
 * immutable, so a long CDN cache means a given id costs quota once and never
 * again, and quota exhaustion stops being a realistic outcome. CORS is pinned
 * to the site's own origins, which stops other websites but not curl — that is
 * understood and accepted. The worst case is a free 10,000/day allowance that
 * resets at midnight Pacific, with no billing attached.
 */

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_IDS = 50;                 // videos.list maximum, and 1 quota unit either way

const ALLOWED = (process.env.ALLOWED_ORIGINS ||
  "https://ryzzuh.github.io,http://localhost:8412,http://127.0.0.1:8412")
  .split(",").map((s) => s.trim()).filter(Boolean);

/** "PT1H2M3S" -> seconds. */
function isoSeconds(v) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(v || "");
  if (!m) return 0;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + Math.round(+m[3] || 0);
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
    return res.status(204).end();
  }
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const raw = (req.query.ids || "").toString();
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];

  /* Validated strictly, not passed through. Without this the endpoint is an
     open proxy: anything in `ids` would be forwarded to googleapis.com on the
     key's behalf. */
  if (!ids.length) return res.status(400).json({ error: "no ids" });
  if (ids.length > MAX_IDS) return res.status(400).json({ error: `at most ${MAX_IDS} ids` });
  const bad = ids.find((id) => !YT_ID.test(id));
  if (bad) return res.status(400).json({ error: "not a youtube id: " + bad.slice(0, 20) });

  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(503).json({ error: "no key configured" });

  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,contentDetails,status");
  url.searchParams.set("id", ids.join(","));
  url.searchParams.set("key", key);

  let body;
  try {
    const upstream = await fetch(url);
    body = await upstream.json();
    if (!upstream.ok) {
      const reason = body?.error?.errors?.[0]?.reason || "";
      /* 429 rather than 500 for quota, so the caller knows to fall back to its
         keyless path today and try again tomorrow rather than treat it as a
         bug. Never echo the upstream body: it can contain the key. */
      const quota = /quota/i.test(reason) || upstream.status === 403;
      return res.status(quota ? 429 : 502).json({
        error: quota ? "quota exhausted" : "upstream error",
        reason: String(reason).slice(0, 60),
      });
    }
  } catch (e) {
    return res.status(502).json({ error: "upstream unreachable" });
  }

  const found = new Map((body.items || []).map((v) => [v.id, v]));
  const out = {};
  for (const id of ids) {
    const v = found.get(id);
    // Absent from the response means deleted or private.
    if (!v) { out["YT:" + id] = { gone: true }; continue; }
    out["YT:" + id] = {
      t: v.snippet?.title || "",
      v: v.snippet?.channelTitle || "",
      d: isoSeconds(v.contentDetails?.duration),
      a: v.snippet?.thumbnails?.high?.url || "",
      e: v.status?.embeddable !== false,
    };
  }

  /* The whole cost model. A title does not change, so the same ids should
     never cost quota twice: the CDN serves them for a day, then keeps serving
     the stale copy for a week while it refreshes in the background. */
  res.setHeader("Cache-Control",
    "public, s-maxage=86400, stale-while-revalidate=604800");
  return res.status(200).json(out);
}
