# HANDOFF

Written 2026-09-09. Task state only — durable project knowledge is in
`/Users/Rhys/Projects/claude/mashmusic/CLAUDE.md`, and the reasoning behind
individual judgement calls is in `DECISIONS.md` (newest first).

## Current task

Nothing is in flight. `main` is clean, everything is pushed, no pull request is
open, and both deployments are serving.

"Done" for the current phase means: playlists can be imported from a Google
Sheet and resolve their metadata quickly; the spectrum can follow a track that
has no precomputed envelope. Both are built, deployed and working. What remains
is listed under Open TODOs, and item 1 is the only thing that has never been
exercised at all.

## State

**Live and verified** at https://ryzzuh.github.io/mashMusic/ :

- **Playlists.** The 1,257-track built-in library is the default playlist.
  Others are imported from a Google Sheets document holding one YouTube id or
  link per cell. One playlist is visible at a time. Four other import methods
  (paste a list, YouTube playlist URL, file upload, SoundCloud set) appear in
  the dialog, are selectable, and report that they are not built yet.
- **Metadata resolution through the resolve API**, which is now the resolver
  rather than the middle of three tiers: the whole playlist goes through it,
  fifty ids a call, up to a daily budget of 10,000 ids held in
  `mash.metabudget.v1`. YouTube oEmbed for titles and a hidden cued player for
  durations remain as the failure path, for ids it could not answer. The
  committed `data/meta.json` tier and `tools/resolve-meta.mjs` were removed.
- **The resolve API**, deployed at `https://mash-music-meta.vercel.app/api/resolve`
  and wired up in `/Users/Rhys/Projects/claude/mashmusic/config.js`. Verified
  live: returns title, channel, duration, thumbnail and `embeddable` for up to
  50 ids per request, `{gone:true}` for ids YouTube does not know, and
  `x-vercel-cache: HIT` on repeats.
- **A live spectrum** ("go live" button on the equalizer panel) that analyses
  the tab's own audio through `getDisplayMedia` and Web Audio.
- **A stage that peels before it pins**, on viewports above 860px. The expanded
  stage scrolls away with the page; once half of it has gone behind the top bar
  it collapses and the block pins in that short form, and the sequence reverses
  at the same point. The peel and the pin are one mechanism: `.pinned` sticks at
  `--topbar-h` minus `--stage-peel`, which `app.js` sets to half the measured
  expanded height and drops to 0 on collapse. Narrow viewports keep the old
  plain threshold untouched. Not yet exercised by hand in a real browser.
- **A pin on the now-playing source line**, in both stage modes, which locks the
  current mode and holds the block under the top bar. Locking is the absence of
  the peel: the variable is held at 0 and the scroll handler returns early. Both
  the control and the lock are gated on the same 860px breakpoint. Persisted as
  `stagePinned` in `mash.prefs.v1`.
- 192 Playwright tests, 100 mutation checks in `tools/mutate.sh`, all passing.
- Rollback tag `pre-spec-2026-09-03` exists on both repositories.

**Merged pull requests**, all on `Ryzzuh/mashMusic`: #1–#7 (earlier work),
#8 (playlists, live spectrum, offline metadata tool, resolve API), #9 (Vercel
module type), #10 (accept HEAD), #11 (bulk resolve, test hermeticity). Eleven
merged branches are still present on the remote; every previously merged branch
has been kept, so this appears deliberate.

**Untouched / never run:**

- The **live spectrum has never run against a real screen capture.** Every test
  drives it with a synthetic `MediaStream` built from an oscillator, which
  exercises the real `AudioContext`, bin-to-band mapping and draw loop but not
  the browser's capture prompt.
- `mash.liveness.v1` has never been populated by the in-app batch against the
  full built-in library.
- `tools/find-replacements.mjs` has never been run (needs a key, and needs dead
  tracks to exist first).

## Decisions made

**Playlist membership is a single predicate in `buildView()`.** Every other
filter — favourites, contributors, sources, played, hidden-unavailable — is
already one line in that chain, so the wheel, autoplay, the counts and the
transport readouts all follow a playlist switch without knowing playlists
exist. Filtering anywhere else desynchronises them.

**`TRACKS` is no longer a constant.** It is the built-in library plus whatever
playlists have imported, rebuilt by `rebuildLibrary()`. Anything derived from
the whole library — `ALL_WHO`, the contributor panel, the liveness pool — must
be recomputed there rather than captured once at load.

**Counters use `scopeCount()`, not `TRACKS.length`.** `TRACKS` includes tracks
imported by a playlist that is not on screen, so the brand count claimed a
total it was not showing.

**Google Sheets is read with no key.** The gviz CSV endpoint answers
cross-origin. An unshared sheet returns an **HTML sign-in page with a 200**, so
the importer inspects the body and not the status; without that it reports "no
ids found" for what is really a permissions problem.

**oEmbed never returns duration.** Durations therefore come from cueing:
`cueVideoById()` puts the official IFrame player in state 5 (CUED) and
`getDuration()` then answers. Nothing streams, so it is not a view. Measured at
about 0.5 s per track.

**A 404 from oEmbed, and a cue error 100/101/150, are liveness verdicts.** One
request both names a track and settles whether it exists, so the unavailable
count, HIDDEN mode and the replacement finder all work off the same round trip.
A request that never lands records nothing, because no verdict was given.

**A missing title is stored as `""` and never as the id.** Writing the id into
the title field turns a transient fetch failure into permanent data that
nothing can later distinguish from a track genuinely named that.

**The YouTube API key lives in exactly one place, and it is not the browser.**
`localStorage` does not sync between machines and a key does not belong in a
URL, so an in-app key field was rejected: it optimises for one machine, adds a
settings surface for a single-user convenience, and does nothing for visitors.
The deployed resolve API is the one path. A committed `data/meta.json`, written
by a tools script on the machine with the key, was the other; it was removed on
2026-09-09 because it returned exactly what the endpoint returns and never once
existed on disk.

**OAuth would not help, and the intuition that it would is wrong.** YouTube
quota is charged to the Google Cloud *project*, never to the signed-in user, so
making visitors sign in would let them read their own data while still spending
the project owner's 10,000/day. There is no per-user quota in the Data API.

**The resolve API's key cannot be IP-restricted.** Google allows exactly one
application restriction per key. IP addresses need a stable egress address, and
Vercel functions egress from shared rotating IPs — a fixed one is Static IPs at
$100/month per project on Pro or Enterprise, with Hobby excluded. HTTP
referrers are for browser keys and a server sends no `Referer`. The restriction
that *is* available and does matter is the **API** restriction: limited to
YouTube Data API v3, a leaked key cannot reach anything else on the project.

**So the endpoint, not the key, is what is protected — by caching first.**
`s-maxage=86400, stale-while-revalidate=604800`: metadata does not change, so
an id costs quota once and is then served by the CDN. Strict id validation
(`[A-Za-z0-9_-]{11}`, at most 50) matters next, because without it the endpoint
is an open proxy forwarding anything to googleapis.com on the key's behalf.
CORS pinned to the site's origins stops other websites but not `curl`, and is
not pretending to. Worst case is a free allowance resetting at midnight
Pacific, with no billing attached. A shared secret in the frontend was rejected
as extractable by anyone who can already read the endpoint URL.

**With an endpoint configured, the whole playlist resolves at once.**
Backfilling per rendered chunk is correct only when a title costs its own
request; with 50 per call it is pure delay, and it left the cue-based duration
resolver spending ~17 minutes on durations the same call returns. Per-chunk
backfill is kept for the no-endpoint case.

**The live spectrum is opt-in and never starts itself.** A page that asks to
capture your screen unprompted is not one to trust; there is a test asserting
the app has not called `getDisplayMedia` on its own. The capture passes
`preferCurrentTab: true` and `selfBrowserSurface: "include"` because Chromium
has excluded the capturing tab from its own picker by default since version
107 — without those, the one tab worth sharing is the only one not listed.

**The live spectrum takes each band's peak bin, not its average.**
`tools/build-envelopes.py` takes the peak, and averaging scales a band by its
own width — the top band spans ~143 bins against the bottom band's ~2, which
diluted a pure tone by about 18 dB and almost exactly cancelled the tilt. The
two sources have to look like one instrument.

**Placeholder import methods are selectable, not disabled.** Disabling them
made the dispatcher unreachable, so "a placeholder quietly succeeds" could not
be caught by any test.

## Dead ends

- **An in-app API key field.** Built as a constant in `app.js`, then rejected
  entirely. See Decisions. Configuration now lives in `config.js`.
- **IP-restricting the resolve API's key.** Not possible on a Vercel Hobby
  plan; see Decisions for the numbers.
- **Sharing CSS class names between controls.** The playlist picker began as
  `class="listmode playlist"` to reuse the list-mode styling. That broke
  `COLLAPSE_ORDER`'s `querySelector(".listmode")`, the outside-click handler,
  `.listmode-menu button` (5 elements instead of 3) and `.search` (2 instead of
  1). Shared styling is fine; shared class names are not, when JavaScript and
  tests select on them.
- **Polling `getDuration()` after cueing.** It returns whatever the player
  loaded last, which produced wrong durations and an 8-second-per-track
  measurement that would have killed the feature. Waiting for the cue event
  gives ~0.5 s and correct answers.
- **Gating the duration resolver on `document.hidden`.** Backwards: a
  17-minute background job should keep going when the tab is not in front.
- **Persisting resolved durations only at the end of the run.** 157 resolved in
  memory and every one was lost on reload.
- **"Scroll to the bottom to pull every chunk through."** Wrong advice.
  Scrolling loads exactly 60 rows per intersection and each load pushes the
  bottom further away, so a 2,007-track list needs ~33 separate scrolls.
- **Sweeping 1600→320px in 8px steps** to derive the top bar's collapse order.
  160 viewport resizes at two animation frames each overran the 30 s test
  budget. Three binary searches cost about 30 resizes for the same answer.

## Key files

| Path | Role |
|---|---|
| `app.js` | The whole player. `buildView()` is the single filter chain. |
| `config.js` | Deployment configuration — currently just `metaApi`. Edited to deploy; never read by tests. |
| `app.css` | Two complete theme token sets, `jukebox` and `night`. |
| `index.html` | Markup, SVG symbol defs, dialogs. |
| `data/tracks.js` | The 1,257-track library. A historical record; do not rewrite. |
| `data/liveness.json` | Sidecar: ids the platforms have lost. Currently `{}`. |
| `server/api/resolve.js` | The Vercel function. Batches 50 ids per `videos.list` call. |
| `server/resolve.test.mjs` | Handler tests — no network, no key. Beside `api/`, never inside it. |
| `server/README.md` | Deploy steps, key restrictions, and what actually protects the endpoint. |
| `tools/check-liveness.mjs` | Offline liveness. Resumable. Needs a key for the YouTube half. |
| `tools/find-replacements.mjs` | YouTube replacement search. Never run; needs a key. |
| `tools/build-envelopes.py` | Offline spectral analysis → the `mashMusic-eq` repository. |
| `tools/mutate.sh` | Mutation harness. Edits app files in place — never run git alongside it. |
| `tools/serve.py` | Dev server. Threaded; sends `no-store`; maps `/mashMusic-eq/`. |
| `tests/helpers.js` | Shared helpers. `blockExternal()` also neutralises `config.js`. |
| `DECISIONS.md` | Judgement calls with reasoning, newest first. Read before relitigating. |
| `~/start-mashmusic.sh` | Starts the dev server from a terminal. Outside the repo. |

## Gotchas

- **A merge to `main` deploys.** GitHub Pages builds from `main`.
- **There are no CI checks on this repository.** The only evidence behind any
  merge is a local `npx playwright test` run.
- **The full suite takes 6–12 minutes** depending on machine load, and the
  mutation harness far longer. Do not run them concurrently, and never run git
  while `tools/mutate.sh` is running.
- **`legacy/angular startAgain - backup/jukebox.js:207` contains a hardcoded
  Google API key**, public since 2026-09-01. Pre-existing and unrelated to
  recent work. Deleting the line does not help — it is in git history on a
  public repository. Revoking the key is the only fix.
- **Vercel builds a preview on every push to this repository**, including
  pushes that only touch the jukebox. Harmless. `Settings → Git → Ignored
  Build Step` with `git diff --quiet HEAD^ HEAD -- server` would stop it.
- **Playlists live in `localStorage`**, so `Cmd+Shift+R` does not clear them —
  that clears the HTTP cache only. To reset:
  `["mash.playlists.v1","mash.imported.v1","mash.playlist.v1","mash.liveness.v1"].forEach(k=>localStorage.removeItem(k)); location.reload();`
- **There is no way to delete a playlist from the interface.** Re-importing the
  same sheet creates a second entry; the tracks dedupe but the playlist entries
  stack up.

## Open TODOs

1. **Try the live spectrum against a real capture.** Click "go live" on the
   equalizer panel in a browser. This is the only feature built recently that
   has never run outside a synthetic test. Expect a "Share this tab?" prompt.
   On macOS, Chromium delivers audio only for a **tab** share — a window or
   whole-screen share yields no audio track, which the app reports rather than
   failing silently.
2. **Revoke the exposed legacy Google API key.** See Gotchas.
3. **Add a way to delete a playlist.** See Gotchas. A control on each entry in
   the playlist picker, removing the playlist and any imported tracks no other
   playlist still references.
4. **Consider whether the daily resolve cap should be enforced server-side.**
   It is a per-browser politeness ledger today. A real global cap needs a
   key-value store on the Vercel side, which was judged disproportionate for a
   limit set at two percent of the quota allowance. See `DECISIONS.md`.
5. **Populate liveness for the built-in library.** The `check N of M` control
   in the status bar needs no key: 25 tracks a click, 300 requests a day.
   `mash.liveness.v1` has never been populated for the 1,257 built-in tracks.
6. **Run `tools/check-liveness.mjs`** with a key to find videos that exist but
   have embedding disabled — neither oEmbed nor a cue reports that cleanly for
   the built-in library. About 19 quota units for the whole library; resumable.
7. **Run `tools/find-replacements.mjs`** once items 5 or 6 have found dead
   tracks. It only looks at tracks already marked dead. 100 quota units each.
8. **Consider renaming the HIDDEN list mode.** It filters unavailable tracks
   rather than hiding titles, and "Track list visibility" no longer describes
   the group it sits in.
9. **Delete `PR-BODY.md`** — a stopgap from before `gh` was installed.
10. **No favicon.** `/favicon.ico` 404s on every page load. Cosmetic.

## Next step

Item 1: open https://ryzzuh.github.io/mashMusic/ , play any track, and click
**go live** on the equalizer panel. Allow the capture prompt with tab audio
enabled. The tag beside the spectrum should read `live · tab audio` and the
bars should follow the music. If the prompt does not offer this tab, that is
the `selfBrowserSurface` behaviour described in Decisions and the deployed code
already sets both options that address it — so report what the prompt actually
shows rather than assuming the fix did not land.
