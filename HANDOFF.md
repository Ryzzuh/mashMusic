# HANDOFF

Written 2026-09-07. Task state only — durable project knowledge is in
`/Users/Rhys/Projects/claude/mashmusic/CLAUDE.md`.

## Current task

Nothing is in flight. The overnight feature spec is complete and every item is
either built or deliberately dropped. The last change — making the theme palette
SVG the clickable control — is merged, deployed and verified in production.

"Done" for the current phase means: `main` is green, deployed, and no branch is
open. That is the state as of this writing.

## State

**Finished and live** at https://ryzzuh.github.io/mashMusic/ :

- All nine milestones of the feature spec (Jukebox 1, 2, 3, 11; QoL 1, 2, 4, 5,
  6, 7, 8, 10; touchups 1, 2).
- 130 Playwright tests, 51 mutation checks in `tools/mutate.sh`, all passing.
- Fonts self-hosted in `assets/fonts/`.
- SoundCloud spectral envelopes merged into `Ryzzuh/mashMusic-eq` `main` and
  serving: 241/312 SoundCloud tracks (77%), 633/945 YouTube (66%).
- `gh` CLI installed at `~/.local/bin/gh` and authenticated as `Ryzzuh`.

**Merged pull requests**, all on `Ryzzuh/mashMusic`: #1 (the overnight spec run),
#2 (replacements sidecar 404), #3 (self-hosted fonts), #4 (list-mode picker +
clickable palette), #5 (HIDDEN filters unavailable), #6 (palette becomes the SVG
control).

**In progress:** nothing.

**Untouched / not started:**

- The YouTube half of replacement search. `tools/find-replacements.mjs` is
  written and tested against a stubbed response but **has never been run** — it
  needs a YouTube Data API key. `data/replacements.json` does not exist.

**Rollback:** both repos carry the tag `pre-spec-2026-09-03`.
`Ryzzuh/mashMusic` at that tag is commit `537acf6` — the exact build that was
live before any of this work. `Ryzzuh/mashMusic-eq` at that tag is `e285ec8`,
the YouTube-only envelope set.

## Decisions made

**`buildView()` is the only place a filter may live.** Search, favourites,
contributors, sources, played and hidden-unavailable are all predicates in one
chain. Rationale: each one then reaches the tracklist, the counts, autoplay and
the wheel for free and cannot desynchronise. Adding a filter elsewhere is the
single easiest way to break this app.

**The equalizer is precomputed, not live.** Web Audio cannot reach inside a
cross-origin iframe, so the page can never analyse YouTube or SoundCloud audio
while it plays. `tools/build-envelopes.py` analyses offline and ships 24 log
bands at 25 fps, 4 bits each (~300 B/s). The page replays it against the
player's own clock.

**Envelopes live in a separate repo** (`Ryzzuh/mashMusic-eq`) because binary
files do not delta-compress in git; committing a regenerated set into the app
repo would weld another full copy into its history permanently.

**The envelopes are publicly served, knowingly.** The eq repo is private, but
GitHub Pages serves publicly regardless (access-controlled Pages needs
Enterprise Cloud), and `index.json` enumerates all 874 ids. A public static site
cannot fetch private data without exposing it, so the choice was the spectrum
working for visitors *or* the envelopes not being public. Rhys chose to leave it,
asked directly. Separately: the *acquisition* used `yt-dlp`, which breaches
YouTube's terms on downloading; that is unaffected by how the files are served.

**Fonts self-hosted after a measured before/after.** The risk was shifting the
geometry the suite pins, so advance widths, element boxes and both collapse
boundaries were measured with Google's files and again with local ones:
identical to 0.01px, boundaries 685/440 both times. latin + latin-ext only —
exactly one character in the library falls outside latin.

**HIDDEN filters unavailable tracks instead of redacting titles**, at Rhys's
request. Cost: `hide` used to keep titles out of the DOM entirely, surviving
devtools and select-all — a real privacy capability, now gone. `OBFUSCATED`
remains but is cosmetic by design. Note the three modes now sit on two axes
(SHOWN/OBFUSCATED restyle; HIDDEN filters), so "Track list visibility" no longer
describes the group.

**The list-mode picker lists all three modes.** It previously listed only the
two you were not in, so leaving SHOWN removed it from the interface entirely and
the only way back was a pill whose affordance was a `title` attribute.

**The palette is an `<svg role="button">`, positioned from JS.** The two theme
labels are content-sized, so the join is not at 50% of the switch and CSS cannot
ask where one sibling ends. It is 24×20, under WCAG 2.5.8's 24×24, kept under
the criterion's *Equivalent* exception — both theme buttons are 34px and do the
same job. The test asserts that exception holds rather than assuming it.

**Scroll anchoring is disabled** (`html { overflow-anchor: none }`). The pinned
stage grows ~258px as the scroll nears the top, which is exactly what anchoring
compensates for, leaving jump-to-top resting 73px short. Measured: 73 with
anchoring, 0 without.

**One test-only seam exists:** `document.addEventListener("mash:completed")`.
Both players' end events fire inside a cross-origin iframe and the suite blocks
those hosts, so without it the central rule of the decaying tracklist — *a skip
is not a listen* — would ship untested.

## Dead ends

- **A self-correcting jump-to-top handler** that re-checked the scroll position
  and snapped it. Written for a 73px resting error later proven to be scroll
  anchoring. It broke two other tests by fighting their programmatic scrolls.
  Reverted; `#tTop` is three lines.
- **Diagnosing the 73px error as machine load.** It was real. The machine
  genuinely was at load average 209 from concurrent suite runs, which caused
  *other* spurious failures — but not that one.
- **Blaming a 165px gap reading on a corrupted working tree.** The corruption
  was real (a leaked mutation), but was not the cause. The same number returned
  with a clean tree; it is a layout race.
- **`brew install gh`.** No bottles on this Intel Ventura machine; it would
  compile from source without full Xcode. The official precompiled zip works.
- **Testing canvas animation in the Browser pane.** It suspends
  `requestAnimationFrame` while hidden, which freezes the clock and the spectrum
  and looks exactly like a stalled player.

## Key files

| Path | Role |
|---|---|
| `app.js` | The whole player. `buildView()` is the filter chain. |
| `app.css` | Two complete theme token sets, `jukebox` and `night`. |
| `index.html` | Markup, SVG symbol defs, dialogs. |
| `data/tracks.js` | The 1,257-track library. A historical record; do not rewrite. |
| `data/liveness.json` | Sidecar: ids the platforms have lost. Currently `{}`. |
| `assets/fonts/` | Self-hosted Archivo, Barlow, IBM Plex Mono + OFL licence. |
| `tools/mutate.sh` | Mutation harness. Edits app files in place — never run git alongside it. |
| `tools/build-envelopes.py` | Offline spectral analysis → `mashMusic-eq`. |
| `tools/find-replacements.mjs` | YouTube replacement search. **Never run; needs an API key.** |
| `tools/serve.py` | Dev server; no-store, maps `/mashMusic-eq/`. |
| `tests/helpers.js` | Shared helpers. `isHittable()` is strict; do not add an opt-out. |
| `DECISIONS.md` | 54 entries, newest first. Read before relitigating anything. |
| `legacy/` | The 2015 AngularJS original, preserved. |
| `PR-BODY.md` | Description used for PR #1. Historical; safe to delete. |

## Gotchas

- **A merge to `main` deploys.** Pages builds from `main` on both repos.
- **Pushing over HTTPS needs** `git config http.postBuffer 524288000`; the 1MB
  default fails with `RPC failed; HTTP 400`.
- **Several YouTube ids start with `-`**, so `ls *.bin` treats them as flags.
  Use `find`.
- **`tools/find-replacements.mjs` costs 100 quota units per call**
  (`search.list`) against a 10,000/day default — 100 dead tracks per day, not
  10,000. It only looks at tracks already known dead, skips solved ones, honours
  `--limit` and bails on a quota error.
- **The full suite takes 4–5 minutes; the mutation harness ~25.** Do not run
  them concurrently.
- **Playing a YouTube track still contacts Google** from the embed's own iframe
  (`fonts.gstatic.com`, `jnn-pa.googleapis.com`). The page itself makes zero
  third-party requests on load.

## Open TODOs

1. **Run `tools/find-replacements.mjs`** once a YouTube Data API key is
   available, then commit `data/replacements.json`. Mind the 100-units-per-call
   quota. Blocked on the key; nothing else stands in the way.
2. **Consider renaming the HIDDEN list mode.** It no longer hides titles, and
   "Track list visibility" no longer describes the group it sits in.
3. **Delete `PR-BODY.md`** — it was a stopgap for a machine without `gh`, and
   `gh` is now installed.
4. **Decide what to do with `.claude/launch.json`.** It was added on
   2026-09-07 so the Browser pane can start `tools/serve.py` on port 8412
   without the config being re-derived each session. It is untracked and
   `.gitignore` does not cover `.claude/`, so it shows as a dirty tree. Commit
   it or ignore it.
5. **No favicon.** The browser requests `/favicon.ico` on every load and gets a
   404. Cosmetic only.

## Next step

Nothing is blocking. The largest remaining item, running
`tools/find-replacements.mjs`, needs a YouTube Data API key that is not on this
machine; ask Rhys for one before starting it. Everything else in Open TODOs is
small and independent.
