# mashMusic — working notes

A static jukebox for 1,257 mashups friends posted between 2012 and 2015.
Vanilla JS, no framework, no build step: `index.html`, `app.css`, `app.js`, and
`data/tracks.js`. Published by GitHub Pages from `main`, so **a merge to `main`
is a deploy**.

The 2015 AngularJS original is preserved unmodified in `legacy/`. Do not
"fix" anything in there; it is an archive.

## Commands

```bash
npx playwright test                 # full suite, ~4-5 min
npx playwright test tests/x.spec.js -g "name"
./tools/mutate.sh                   # mutation checks, ~25 min
python3 tools/serve.py 8412         # dev server (prefer the Browser pane's preview_start)
```

`tools/serve.py` exists rather than `python3 -m http.server` for three reasons:
it sends `no-store`, it maps `/mashMusic-eq/` to the sibling envelope checkout
so the spectrum works locally, and it is **threaded**. That last one is not
cosmetic: the stdlib `HTTPServer` serves one request at a time, and a browser
opens ~6 connections for index.html, app.css, app.js, the 1,257-track
`data/tracks.js`, five fonts, the liveness sidecar and an envelope per track
played. Serialising those cost the suite 22% and made its most timing-sensitive
test exceed a 60s budget while taking 6.5s alone.

**Do not reach for more Playwright workers.** Measured on this machine (2
physical cores, 8GB): workers 1 = 6.0 min wall / 410s CPU / load ~15; workers 2
= 5.8 min / 508s CPU / load ~48. 3% faster for 24% more CPU, and the extra load
is exactly what makes the timing-sensitive tests flake. `playwright.config.js`
carries the numbers.

## Architecture, such as it is

**`buildView()` in `app.js` is the single predicate chain.** Every filter lives
there — search, favourites, contributors, sources, played, hidden-unavailable.
Adding a predicate there reaches the tracklist, the counts, autoplay and the
wheel at once. Filtering anywhere else will desynchronise them. This is the most
important convention in the codebase.

## The spectrum

Two sources, and they must agree. `tools/build-envelopes.py` precomputes 24 log
bands offline; "go live" analyses the tab's own audio through
`getDisplayMedia` + `AnalyserNode`. Web Audio still cannot reach inside the
cross-origin iframe — a MediaStream is the way in, and it needs the reader's
consent, so live mode is opt-in and never starts on its own.

**Reduce each band by its PEAK bin, not its mean.** `build-envelopes.py` does
`mag[:, b0:b1].max(axis=1)`; the live path must match or the two look like
different instruments. Averaging also scales a band with its own width — the
top band is ~143 bins against the bottom band's ~2.

The capture must pass **`selfBrowserSurface: "include"`** and
`preferCurrentTab: true`. Chromium has excluded the capturing tab from its own
picker by default since 107, so without these the one tab worth sharing is the
only one not listed.

Live is the only option for an imported playlist: envelopes exist for 874
tracks, and 0 of the first 2,007 imported ids had one.

## Playlists

`TRACKS` is **not** a constant: it is the built-in library (`BUILTIN`, what
`build-tracks.py` shipped) plus whatever playlists have imported, rebuilt by
`rebuildLibrary()`. Anything derived from the whole library — `ALL_WHO`, the
contributor panel, the liveness pool — must be recomputed there, not captured
once at load.

Membership is one predicate in `buildView()`, like every other filter. One
playlist is visible at a time; the built-in library is the default and shows no
imported tracks.

Use **`scopeCount()`, not `TRACKS.length`**, for anything the user reads as a
total. `TRACKS` includes tracks imported by playlists that are not on screen.

Imported titles are fetched **lazily** — the first screenful during the import,
the rest as their rows render — so a 2,007-id sheet imports as fast as a 20-id
one. A title that is not known yet is stored as `""` and **never as the id**;
writing the id into the title field turns a fetch failure into permanent data.
The import must not use the `mash.livecheck.v1` ledger: that is a budget for
background politeness, and spending it on a foreground import produced a list
of 1,900 bare ids.

**With an endpoint configured, the whole playlist resolves at once**
(`resolveAllMeta`), in background batches of 50, and the cue-based duration
resolver runs only afterwards on whatever is left. Backfilling per rendered
chunk is the right shape only when a title costs its own request — it is what
happens with no endpoint, and it is wrong with one: a 2,007-track sheet is 41
calls, so waiting for the reader to scroll is pure delay, and it left the cue
resolver spending ~17 minutes on durations the same call returns.

Anything the endpoint answers 200 for but omits must be struck off, or the loop
asks for it again forever.

Metadata resolves in three tiers, each falling through to the next:
`data/meta.json` → the resolve API (`config.js` → `metaApi`, see
`server/README.md`) → oEmbed and cueing. **Empty configuration is a supported
state**, not a broken one: a visitor who deploys nothing still gets a working
site. Deployment config lives in `config.js`, never in `app.js` — a constant
there cannot be set by a test and forces an application edit to deploy.

**`data/meta.json` is the keyed shortcut, and the reason no key is needed
anywhere else.** `tools/resolve-meta.mjs` runs once on whichever machine has a
YouTube API key — `videos.list`, 50 ids per call, 1 quota unit, returning
title, channel, duration and `embeddable` together — and its output is
committed. Every other workstation and every visitor then resolves instantly
with no key. `localStorage` does not sync between machines and a key does not
belong in a URL; the results are not secret, so they travel with the repo
instead. The app consults it before asking YouTube anything, and applies its
gone/blocked verdicts on **every** load, not only when a title changes.

Everything below is the keyless fallback, used when the sidecar has no entry.

**Durations come from cueing, not playing.** oEmbed has none and `videos.list`
needs a key, but the IFrame API reports a duration from a CUED video — nothing
streams, so it is not a view. ~0.5s per track; a 2,000-track sheet resolves in
about 17 minutes in the background. **Wait for the cue event; never poll
`getDuration()`** — it returns whatever the player loaded last, which made an
early measurement report 8s per track and wrong durations. Persist as you go:
writing only at the end lost 157 resolved durations to one reload.

An oEmbed **404 is a liveness verdict**, not a slow title — one request both
names the track and settles whether it exists. A request that never lands
records nothing.

Import is keyless by design: Google Sheets' gviz CSV endpoint and YouTube's
oEmbed both answer cross-origin with no key. Two traps, both with tests:
an unshared sheet returns an **HTML sign-in page with a 200**, and oEmbed
**never returns duration** — imported tracks start at `d: 0` and learn it from
the player on first play.

**Deployment config must never reach the test suite.** `blockExternal()` in
`tests/helpers.js` neutralises `window.MASH_CONFIG` before every page load.
Without it, every test inherits whatever endpoint `config.js` is deployed with
and starts calling a live service — which is exactly what happened when the
site was first pointed at its own API: five specs failed because the real
endpoint correctly reported their fake ids as gone, and a dead track will not
play. `EXTERNAL` also blocks `vercel.app`, but that is a guess about hosting;
the config guard is the one that holds wherever it lives, and there is a test
asserting `metaApi` is empty during tests.

**Do not give a new control a class that an existing one uses.** Sharing
`.listmode`, `.listmode-menu` and `.search` for styling broke
`COLLAPSE_ORDER`'s `querySelector`, the outside-click handler and two test
selectors. Give it its own class and extend the CSS selector instead.

State that survives reloads is in `localStorage` under `mash.*`:
`mash.favs.v1`, `mash.prefs.v1`, `mash.liveness.v1`, `mash.played.v1`,
`mash.contributors.v1`, `mash.sources.v1`, `mash.wheel.v1`,
`mash.replacements.v1`, `mash.livecheck.v1`, `mash.playlists.v1`,
`mash.imported.v1`, `mash.playlist.v1`.

Sidecar files in `data/` carry perishable facts so `tracks.js` — a historical
record — is never rewritten: `liveness.json` (which ids the platforms lost) and
`replacements.json` (what to play instead; **not generated yet**). Both are
merged on load and are optional.

## The resolve API (`server/`)

Deployed separately to Vercel with **Root Directory = `server`**, so paths are
relative to `server/` and `server/api/resolve.js` is served at `/api/resolve`.
GitHub Pages keeps serving the jukebox from the repo root; the two deployments
read the same repository and ignore each other's files.

Two rules, both learned by breaking them:

- **Nothing but functions goes in `server/api/`.** Vercel deploys *every* file
  there as a serverless function, so a test file becomes a public endpoint and,
  having no handler export, can fail the build — which 404s every route.
  `server/resolve.test.mjs` sits beside `api/`, never inside it.
- **`server/package.json` must keep `"type": "module"`.** Without it the
  runtime may parse `export default` in a `.js` file as CommonJS, which is a
  syntax error: the module never loads and every request returns
  `FUNCTION_INVOCATION_FAILED`.

`/` returning 404 on that deployment is **correct** — `server/` has no
`index.html`. Do not read it as a misconfiguration.

`curl -I` sends HEAD. The handler accepts it, but remember that a method the
handler rejects returns headers from the error path, which once looked exactly
like `Cache-Control` failing to apply.

## Liveness has three writers and one store

`mash.liveness.v1` is written by the players' own error events, by the in-app
oEmbed batch, and by `data/liveness.json` from `tools/check-liveness.mjs`. Each
record carries `v` — `playback`, `api` or `oembed` — and **no writer may lower
a record's confidence** (`LIVE_CONF`/`conf()` in `app.js`). An `ok` from oEmbed
means "not deleted"; an `ok` from playback means "it actually played here". If
you add a fourth writer, give it a `v` and place it in that ordering.

A record with no `v` predates the field and counts as `playback` — everything
that wrote before it was the runtime player. Do not "tidy" that default to 0.

Both platforms answer oEmbed cross-origin with no key, which is why the in-app
check is possible at all (measured 2026-09-07; an older comment in
`check-liveness.mjs` claiming otherwise was wrong). oEmbed answers 200 for an
embed-disabled video exactly as for a healthy one, so it can never report
`blocked` — that is the only reason the offline `videos.list` script still
exists, and the only thing a YouTube API key is still needed for here.

There is no endpoint that reports remaining YouTube quota. `mash.livecheck.v1`
is our own per-day request ledger, not a reading of anything Google exposes.

## Testing discipline

**There is no CI on this repository.** Nothing re-runs the suite on GitHub, and
a merge to `main` deploys immediately. The only evidence behind any merge is a
local `npx playwright test` run, so run the full suite before merging and say
plainly in the pull request that this is the only verification there was.

The suite exists because nine defects shipped in one unassisted session, several
of them live. Two rules earned the hard way:

**0. There are two test-only seams**, both because the real event fires inside
a cross-origin iframe the suite blocks: `mash:completed` (a track finished) and
`mash:duration` (how long it turned out to be). Do not add a third without the
same justification.

**1. Never a fixed `waitForTimeout` before a geometry or computed-style
assertion.** The stage animates its height (QoL 10), the transport buttons
transition, and `.stage-side` is `height: 0; min-height: 100%` so its rows are
sized from the video box's 16:9 height. Measuring early has produced a 165px gap
that should be 33, a video column still 596px wide after it "closed", and a list
525px short of its resting place. Poll for the settled value, or poll the claim.

**2. A green test is not evidence until the defect turns it red.**
`tools/mutate.sh` breaks one line of `app.js` or `app.css` at a time and
requires the covering test to fail. It has caught eleven tests that passed for
the wrong reason, including several written minutes earlier. Add a check for
every non-trivial assertion.

**`isHittable()` in `tests/helpers.js` is strict and has no opt-out.** A hit on
a descendant passes (a button covered by its own icon is still clickable); a hit
on an *ancestor* fails, because that is what `elementFromPoint` returns when the
target is not in the hit-test at all. It used to accept the ancestor case and
therefore agreed with a `pointer-events: none` palette. Do not add a lenient
flag: a census over all 18 call sites found 13 hits on self, 5 on a descendant
and 0 on an ancestor, so nothing needs it, and an opt-out is only a lever to
reach for when the guard goes red. Its remaining limit is that it probes the
centre only, so it cannot see an edge hanging off screen —
`tests/transport.spec.js` checks flank overflow separately.

`tools/mutate.sh` edits `app.js` and `app.css` in place and restores from
`.bak`. **Never run git while it is running.** A `git stash` mid-run captured a
mutated tree and planted a deliberately broken value into the working files,
which then produced two false conclusions.

Also: check `uptime` before trusting a timing measurement. Concurrent suite runs
drove load average to 209 and manufactured failures that looked like real bugs.

But "it's load" is also the easiest wrong answer. Before accepting it: does the
failure reproduce at the same test on a second full run, and does the suite pass
at a *higher* load average? If both, it is not load. `paintStatus()` runs on
every repaint and is on the critical path of most timing-sensitive tests —
anything O(tracks) or touching `localStorage` there is a regression waiting to
surface five minutes into a full-suite run and nowhere else.

## Fonts

Archivo, Barlow and IBM Plex Mono are **self-hosted** in `assets/fonts/`
(latin + latin-ext, ~200KB, OFL). They were a `@import` from Google Fonts, which
`tests/helpers.js` blocks for hermeticity — so every geometry assertion was
measured against fallback metrics. Do not reintroduce the CDN import; there is a
test and a mutation check for it.

Exactly one character in the library needs latin-ext: U+0117, in "Downtown Party
Network feat Eglė Sirvydytė".

## Playwright

`channel: "chrome"` because Playwright ships no Chromium for macOS 13. The
Browser pane is fine for looking at things but **suspends `requestAnimationFrame`
while hidden**, which freezes the clock and the spectrum — never measure
animation there.

## Conventions

Comments explain *why*, not *what*, and are worth writing where a future reader
would otherwise undo something deliberate. `DECISIONS.md` records judgement
calls with what was ambiguous, what was chosen, why, and how to reverse it;
newest first. Add to it rather than relitigating.
