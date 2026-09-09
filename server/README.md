# Metadata resolve API

A single Vercel function that answers YouTube metadata for a batch of video
ids, so the API key never reaches the browser.

```
GET /api/resolve?ids=<up to 50 comma-separated ids>
-> { "YT:<id>": { t, v, d, a, e } | { gone: true }, ... }
```

`t` title · `v` channel · `d` duration in seconds · `a` thumbnail ·
`e` embeddable. `videos.list` is the only source that gives all five at once,
and it bills **one quota unit per call of up to 50 ids** — 2,007 tracks is 41
units of a free 10,000/day allowance.

This tier is optional. With no endpoint configured the site resolves titles
from oEmbed and durations by cueing a hidden player: keyless, slower, and the
only path a visitor gets if you never deploy this.

## Deploy

1. **Create the key** — [console.cloud.google.com](https://console.cloud.google.com)
   → new project → APIs & Services → Library → enable **YouTube Data API v3**
   → Credentials → Create credentials → API key. Free, no card.

2. **Restrict it** (see below for why these settings and not others):
   - **Application restrictions: None**
   - **API restrictions → Restrict key → YouTube Data API v3** only

3. **Deploy this directory.** In Vercel, import the repo and set
   **Root Directory** to `server`. No build step, no framework.

4. **Set the environment variables** in the Vercel project:

   | Name | Value |
   |---|---|
   | `YOUTUBE_API_KEY` | the key from step 1 |
   | `ALLOWED_ORIGINS` | `https://ryzzuh.github.io,http://localhost:8412` |

   `ALLOWED_ORIGINS` has that default baked in, so it is only needed if your
   origins differ.

5. **Point the site at it** — edit `config.js` in the repo root:

   ```js
   window.MASH_CONFIG = window.MASH_CONFIG || {
     metaApi: "https://<your-project>.vercel.app/api/resolve"
   };
   ```

6. **Check it**, replacing the host:

   ```
   curl "https://<your-project>.vercel.app/api/resolve?ids=dQw4w9WgXcQ"
   ```

   Expect a title and `"d":213`. `503 no key configured` means step 4 did not
   take; `429 quota exhausted` means the day's allowance is gone.

## Why the key is not IP-restricted

Because it cannot be. Google allows exactly **one** application restriction per
key, and neither option fits a serverless function:

- **IP addresses** would need a stable egress address. Vercel functions egress
  from shared, rotating IPs; a fixed one is Static IPs, **$100/month per
  project on Pro or Enterprise**, with Hobby excluded outright.
- **HTTP referrers** are for browser keys. A server sends no `Referer`, so
  this would reject every call.

So the restriction that *is* available and does matter is the **API**
restriction: limited to YouTube Data API v3, a leaked key cannot touch anything
else on the project.

## What actually protects this

The endpoint is public. Anyone reading the site's source can find the URL and
call it, and no allowlist changes that. Three things make it a non-event:

1. **Caching, which is the real defence.** Responses carry
   `s-maxage=86400, stale-while-revalidate=604800`. A title does not change, so
   a given id costs quota once and is then served from Vercel's CDN. Repeat
   visitors and repeat imports cost nothing.
2. **Strict input validation.** Ids must match `[A-Za-z0-9_-]{11}` and there
   can be at most 50. Without this the endpoint is an open proxy that would
   forward anything to googleapis.com on the key's behalf. This is what
   `api/resolve.test.mjs` mostly tests.
3. **CORS pinned to the site's origins.** Stops other websites using it from a
   browser. It does **not** stop `curl`, and is not pretending to.

The worst case is someone burning a free 10,000/day allowance that resets at
midnight Pacific. There is no billing attached, so there is no bill to run up.

If that ever became a real nuisance, the fix is a rate limit per IP or a
Vercel KV cache in front of the CDN — not a secret in the frontend, which is
extractable by anyone who can already read the endpoint URL.

## Tests

```bash
node server/resolve.test.mjs
```

Runs the handler directly with fake request/response objects: no network, no
key, no Vercel. `tests/pipeline.spec.js` runs it too, so it cannot rot.

It sits beside `api/`, not inside it, on purpose: Vercel deploys **every** file
in `api/` as a function, so a test in there becomes a public endpoint and can
fail the build for having no handler export.
