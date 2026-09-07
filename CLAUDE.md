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

`tools/serve.py` exists rather than `python3 -m http.server` for two reasons: it
sends `no-store`, and it maps `/mashMusic-eq/` to the sibling envelope checkout
so the spectrum works locally.

## Architecture, such as it is

**`buildView()` in `app.js` is the single predicate chain.** Every filter lives
there — search, favourites, contributors, sources, played, hidden-unavailable.
Adding a predicate there reaches the tracklist, the counts, autoplay and the
wheel at once. Filtering anywhere else will desynchronise them. This is the most
important convention in the codebase.

State that survives reloads is in `localStorage` under `mash.*`:
`mash.favs.v1`, `mash.prefs.v1`, `mash.liveness.v1`, `mash.played.v1`,
`mash.contributors.v1`, `mash.sources.v1`, `mash.wheel.v1`,
`mash.replacements.v1`.

Sidecar files in `data/` carry perishable facts so `tracks.js` — a historical
record — is never rewritten: `liveness.json` (which ids the platforms lost) and
`replacements.json` (what to play instead; **not generated yet**). Both are
merged on load and are optional.

## Testing discipline

The suite exists because nine defects shipped in one unassisted session, several
of them live. Two rules earned the hard way:

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

Known weakness: **`isHittable()` in `tests/helpers.js` accepts a hit on an
ancestor** (`hit.contains(el)`), so it can pass for an element that cannot be
clicked — `elementFromPoint` returns the thing behind it. 20 assertions across
6 files rely on current behaviour. Where it matters, assert strictly that the
topmost element *is* the target.

`tools/mutate.sh` edits `app.js` and `app.css` in place and restores from
`.bak`. **Never run git while it is running.** A `git stash` mid-run captured a
mutated tree and planted a deliberately broken value into the working files,
which then produced two false conclusions.

Also: check `uptime` before trusting a timing measurement. Concurrent suite runs
drove load average to 209 and manufactured failures that looked like real bugs.

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
