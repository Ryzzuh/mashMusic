# Decisions log

Judgement calls made without checking in, so they can be scanned and reversed
quickly. Newest first. Each entry says what was unclear, what I chose, and how
to undo it.

---

## 2026-09-05 — The replacements sidecar is asked for only when it can help

**Unclear:** how to "skip the fetch when there is no sidecar", which is what
the 404 in production needed. Strictly, you cannot: a missing file is only
detectable by asking for it, and that request *is* the detection.

**Chosen:** ask only when the answer could matter. Replacements are consulted
for dead tracks and nothing else, so with nothing dead there is nothing to look
up. `mergeReplacements()` now returns early unless some track is known dead,
and is attempted at most once per load. It is retried when the offline liveness
merge lands (which can reveal dead tracks) and when a player reports one dead
mid-session.

**Effect:** zero requests, and so zero 404s, on an ordinary page load —
verified 0 with nothing dead, 1 with a dead track. If a visitor does have a
dead track and the sidecar still is not deployed, they get exactly one 404,
which is honest: the file was genuinely wanted.

**The alternative I did not take:** committing an empty `data/replacements.json`
of `{}`, which is what `data/liveness.json` already does. It would also silence
the 404, in one line, with no logic. I preferred not asking at all over asking
and being told nothing, but it is a fair swap if you would rather have the
symmetry with liveness.

**Reverse:** two guard lines at the top of `mergeReplacements()`.

---

## 2026-09-05 — Never run git while tools/mutate.sh is running

I flagged this hazard days ago, in the entry about holding off milestone 6
while a reviewer might invoke the harness. Then I did it anyway.

`mutate.sh` edits `app.js` and `app.css` in place and restores them from
`.bak`. While it was mid-run I used `git stash` to A/B a test, which captured a
transient *mutated* tree; the pop then planted a deliberately broken tube
colour (`--c-next: #3a2a20`, the 3:1 contrast mutation) into my working files.

Two false conclusions came out of that before I noticed:

1. I reported that my sidecar change broke the artwork-to-scrubber gap test —
   "fails with, passes without". Both halves were measured against a tree that
   was not what I thought it was. Run cleanly, the change breaks nothing.
2. The harness reported MISSED for the contrast check, which was the leaked
   mutation confusing its own bookkeeping, not a weak test.

**Rule:** no `git stash`, `checkout`, or `commit` while the harness is running.
Wait for it. The `git status` after every run is worth reading, too — the
leaked hex value was visible there the whole time.

---

## 2026-09-05 — The scroll-anchoring test was a one-in-three gate

Reintroducing the bug made the behavioural test fail **once in three runs**:
whether the compensation fires depends on scroll timing, so asserting the
symptom is inherently flaky. It now also asserts the declaration —
`getComputedStyle(document.documentElement).overflowAnchor === "none"` — which
is what a regression would actually delete, and which fails every time. Caught
3/3 after the change.

A test that only catches its bug a third of the time reports the same green as
one that catches it always. The mutation harness is the only reason I knew the
difference.

---

## 2026-09-05 — Milestone 9: the library half works, the YouTube half is unrun

**What is done:** a dead row grows a swap control that opens a dialog of
candidates. The library search — normalised Levenshtein over titles, scored
against every live track — covers **both** sources and needs no network. It
finds the real twins: the library holds 13 exactly-duplicated titles across 26
tracks, so a dead entry often has a working copy sitting a few hundred rows
away.

**What is not done, and cannot be by me:** the YouTube fallback needs a Data
API key, which cannot ship in a static page. `tools/find-replacements.mjs` is
written and follows the `check-liveness.mjs` pattern, but **I have no key, so
I have never run it and `data/replacements.json` does not exist.** The app
merges that file when present and says so in the dialog when it is not. The
sidecar path is tested against a stubbed response, not a real one.

Worth knowing before you run it: `search.list` bills **100 quota units per
call** against a 10,000/day default. That is 100 dead tracks per day, not
10,000. The script only looks at tracks already known dead, skips ones it has
already solved, stops at `--limit`, and bails out on a quota error.

**SoundCloud gets the library half only**, as the plan said — its public API
has been closed to new registrations since 2019, so there is nothing to call.
The dialog says that rather than silently offering less.

**Correcting the plan:** it claimed three copies of "Ben Pearce - What I Might
Do". There are two.

**Reverse:** the replacement block in `app.js`, `#swapModal` in `index.html`,
the styles at the end of `app.css`, and `tests/replace.spec.js`.

---

## 2026-09-05 — A row rendered after playback started never marked itself

Found by a milestone-9 test, but the bug is older and wider.

`markCurrentRow()` only reaches rows that already exist. Play a track from
beyond the 60-row render window — through the wheel, or now a replacement
chosen for a dead track — and the list showed nothing highlighted, even after
scrolling down to the row. `buildRow()` now marks itself when it builds the
current track's row.

**Why it survived this long:** autoplay renders up to the target row *before*
calling `play()`, so the common path always had a row to mark.

---

## 2026-09-05 — Two performance claims I had to walk back

I measured the replacement search at 1,836ms through Playwright and treated it
as a UI problem. Measured in-page, the search is **54–126ms cold, 53–89ms
warm**; the rest was harness round-trip.

I then added length pruning and a bounded Levenshtein. Measured honestly, that
takes the worst case from 184ms to 126ms — around 1.5x, not the order of
magnitude the first number implied. Both are fine for a click. I kept the
pruning because it is small and the direction is right, but the justification
in the commit message is the real 1.5x, not the phantom 15x.

---

## 2026-09-05 — One mutation check was unfalsifiable, so it is gone

The swap button calls `stopPropagation` so the click is not also a request to
play the dead row. I wrote a mutation removing it and the suite stayed green —
correctly, because `play()` opens with `if (isDead(track)) return;`. With two
guards, removing one proves nothing.

I kept the `stopPropagation` (it is the right semantic, and the row click may
grow behaviour later) and deleted the check rather than leave one that reports
CAUGHT for a reason unrelated to what it names.

---

## 2026-09-05 — The collapsing stage turned every fixed sleep into a race

**What happened:** after milestone 8 the suite started failing intermittently,
a different test each run, all of them passing in isolation. I chased them one
at a time — halo colour, halo hover, autoplay scroll, jump-to-top, jump-to-top
again — before recognising one cause behind all of them.

Milestone 6 made the stage animate its own height, and milestone 7 put the
transport buttons on a transition. Any assertion that read geometry or a
computed style after a fixed `waitForTimeout` became a race against a layout
that was still moving. `900ms` after a jump-to-top left the list 525px short of
its resting place.

**Chosen:** no fixed sleep before a geometry or computed-style assertion. Poll
for the settled value, or for the claim itself. The suite is green at 107.

**One test was wrong in a more interesting way.** "Starting the next track does
not move the view" scrolled to 400, read the position, clicked Next, and found
142. Nothing to do with autoplay: its own `scrollTo` collapsed the stage, which
shortened the document by ~258px over 300ms and clamped the position. The test
was blaming the next track for a move it had caused itself. It now lets the
layout settle before it takes its baseline.

---

## 2026-09-05 — CORRECTION: the 73px was real, and it was scroll anchoring

The entry below concluded that jump-to-top resting short of the document top
was an artefact of my own machine load. **That was wrong**, and the error was
mine twice over.

It reappeared on a quiet run. Two different `#tTop` implementations had both
come to rest at exactly 73px, which is far too stable for a starved animation —
that should have told me it was something scrolling *down* after the jump, not
a scroll failing to finish.

It is **scroll anchoring**. Chrome compensates when content above the viewport
changes size, and QoL 10 makes the stage grow by ~258px precisely as the scroll
approaches the top. Measured, unambiguously:

    default anchoring   ... 443  73  73  73  73     (rests short)
    overflow-anchor:none ... 815   0   0   0   0     (rests at 0)

Fixed with `overflow-anchor: none` on `html`. The tracklist only ever appends
rows *below* the viewport, so anchoring was doing nothing useful here.

**I had this hypothesis first and dismissed it on a broken probe.** My test
removed the `is-collapsed` class from a stage that was already expanded, so it
measured nothing and returned a delta of 0, and I took that as evidence
against. A probe that cannot fail is worth exactly as much as a test that
cannot fail — the lesson this whole branch keeps teaching.

What stands from the entry below: the machine really was at load average 209,
that really did make several tests fail spuriously, and running suites
concurrently really was a mistake. What does not stand is the conclusion I drew
about this particular defect.

---

## 2026-09-05 — Measurements taken on a machine at load average 209

**Worth recording because I nearly shipped a fix for it.**

Jump-to-top appeared to come to rest 72px short of the document top, which I
diagnosed as the document reflowing under a smooth scroll, and for which I
wrote a self-correcting handler that re-checked the position and snapped it.

Then I looked at the machine: load average **153 / 209 / 169**, from my own
back-to-back suite runs. The behaviour would not reproduce on a quiet machine,
nor under CPU throttling down to 1/8 speed. The correction was defensive
complexity built on an artefact of my own making, and it broke two other tests
by fighting their programmatic scrolls — so it is reverted and `#tTop` is three
lines again.

**The rule for next time:** check `uptime` before concluding anything from a
timing measurement, and do not run suites concurrently to save wall-clock time.
It cost far more than it saved.

---

## 2026-09-04 — Milestone 8: one seam in the app exists for the tests

**Unclear:** whether to add a hook to make completion testable, or to leave
the whole of Jukebox 3 unverified.

**The problem:** a track decays when it is *played to the end*. Both end
events — YouTube's `ENDED` and SoundCloud's `FINISH` — fire inside a
cross-origin iframe, and the suite blocks both hosts so runs stay hermetic.
There is no user-facing way to reach the end of a track offline: the scrubber's
position comes from the same blocked player.

**Chosen:** `document.addEventListener("mash:completed", completed)`. Tests
dispatch that event. I picked a DOM event over exposing internals on `window`
because it is a fair extension point in its own right — anything may declare a
track finished — and it carries no privilege the UI does not already have.

**Why I did it at all:** the alternative was shipping the feature with its
central rule untested. That rule is *skip is not a listen*, and there is now a
mutation check that rewires the Next button to completion and requires the
suite to go red. It does.

**Reverse:** delete the one `addEventListener` line in `app.js`. The feature
keeps working; only `tests/decay.spec.js` stops.

---

## 2026-09-04 — Decay hides rather than dims, and always

**Unclear:** "tracks pop once played to completion" does not say whether a
played track is hidden or merely marked, nor whether the behaviour can be
turned off.

**Chosen:** the predicate goes in `buildView()` alongside search, favourites,
contributors and sources, so played tracks leave every surface at once — rows,
counts, autoplay, the wheel. Always on, with the reset control as the only
escape hatch, which is what the spec names. The row animates out first.

**Why:** "decaying" and "pop" both describe removal, not styling, and a
half-measure — dimming a row that autoplay still selects — would be worse than
either option. Putting it in the one predicate chain is why it took a single
line to reach six features.

**Two calls you may want to change:** there is no way to *view* played tracks
without resetting all of them, and no per-track undo. Both are small additions
if you want them; neither is in the spec.

**Reverse:** the `played` predicate in `buildView()` is one line.

---

## 2026-09-04 — Two tests assumed track titles are unique

They are not. The library holds genuine duplicates — the same title under
several ids — which the plan already noted as the thing that makes milestone
9's library-first replacement search work at all. I searched a title expecting
to isolate one track and got three. The tests now pick a track whose title
occurs exactly once. Worth remembering before writing anything else that
treats a title as a key.

---

## 2026-09-04 — Jump-to-top scrolls to the document top, not a computed offset

**Unclear:** where "the top of the list" is, once the chrome above it changes
height depending on where you are.

**What was wrong:** `#tTop` offset the scroll by the height of the sticky
chrome. With the pinned stage that calculation is circular — the tracklist's
document position depends on the pinned block's flow height, which depends on
whether the stage is collapsed, which depends on the very scroll position being
computed. It resolved to 0 on one run and came to rest **73px short on
another, permanently**, leaving the first rows behind the pinned block. Twelve
samples over five seconds showed it parked there, so this was not a transient.

**Chosen:** `window.scrollTo({ top: 0 })`. At y=0 the stage is expanded by
definition and the list begins directly below it, which is what the control
should mean anyway. `stickyOffset()` had no other caller and is deleted rather
than left as the sort of dead helper the milestone-5 review objected to.

**Reverse:** the `#tTop` handler in `app.js` is three lines.

---

## 2026-09-04 — Three tests that were reading mid-transition

Recording these together because they are one mistake with one shape: asserting
on a value while CSS was still animating it.

- **jump-to-top**, twice. A fixed 1000ms sampled the smooth scroll in flight at
  y=18; waiting for the scroll position to stop still caught the 300ms stage
  expansion that fires once it reaches 0. It now polls the claim itself.
- **the disabled halo** read 0.018px rather than 0 — the glow was still
  decaying through its .18s transition.
- **the button face** compared `backgroundColor` to `--raised` immediately
  after a theme switch, catching the .15s background transition partway. This
  one passed alone and failed under load, which is the worst kind: it would
  have become an intermittent failure for you, not for me.

**The lesson I keep relearning:** a fixed `waitForTimeout` before an assertion
is a guess about machine speed. Where the value settles, poll for it.

**On a claim I made and had to withdraw:** I reported the jump-to-top failure
as a deterministic ordering effect, because running `halo.spec.js` before
`stage.spec.js` reproduced it twice running. It was load sensitivity — the same
pair passes now. The underlying `#tTop` defect above was real and separate.

---

## 2026-09-04 — Milestone 7: the contrast gate could not see the halo at all

**Unclear:** the spec says the neon halo "must not regress the contrast gate."
It cannot. The gate in `tests/contrast.spec.js` compares CSS token pairs and
computes WCAG ratios from them — it never samples a pixel, so a `box-shadow`
is invisible to it. The requirement was satisfied before I wrote a line.

**What I found while checking:** none of the seven tube colours
(`--c-play`, `--c-next`, …) appear in that gate's `PAIRS` list, so the colour
of every transport icon was ungated. Measured, they are fine — 4.39:1 at worst
in Jukebox, 7.24:1 in Night, against the button face. Nothing was broken. But
nothing was watching either.

**Chosen:** added a second gate for them at **3:1**, not 4.5:1 — icons are
non-text graphics, so WCAG 1.4.11 is the applicable rule, and holding them to
the text bar would be wrong in the other direction. And the halo is a shadow
only: it never tints the button face, which is what keeps that measurement
describing what is actually on screen. There is a mutation check for each.

**Halo design:** colour comes from `--btn`, which every `.tbtn` already sets
for its own glyph, so the glow cannot drift out of step with the icon it
surrounds. Subtle at rest, brighter on hover, brightest when latched on or
pressed; disabled buttons do not glow. In Jukebox that is seven distinct hues;
the Night Dial palette collapses them to one amber, which is that theme's
character and correct there.

**Scope:** the eight `.tbtn` controls only, not the flank buttons (favourite,
jump, source filter). "Transport buttons" most naturally means the transport
row itself, and haloing the small square jump cells would read as a defect.

**If `color-mix` is unavailable** `--halo` is invalid at computed-value time
and `box-shadow` falls back to `none` — the buttons lose the glow and nothing
else moves.

**Reverse:** the neon-halo block in `app.css`, `tests/halo.spec.js`, and the
second gate at the end of `tests/contrast.spec.js`.

---

## 2026-09-04 — A focus ring that was really Chrome's

**Unclear:** nothing. Recording it because it is the same failure mode for the
ninth time, and this one was subtle.

The halo occupies `box-shadow`, so the focus ring has to be an `outline` or
the two fight over one property. I added the outline and a test asserting
`outline-style !== "none"` and `outline-width >= 2`. Deleting my rule entirely
left the test green: Chrome draws its own `:focus-visible` ring, which computes
to `outline-style: auto` and is wide enough to clear that bar. I was measuring
the browser, not the stylesheet.

The test now names the rule — `outline-style: solid`, a 2px offset, and the
colour equal to `--ink` — and asserts `:focus-visible` actually matched, so it
cannot silently measure nothing.

**Reverse:** n/a.

---

## 2026-09-04 — Milestone 6: the scrubber pins with the stage

**Unclear:** QoL 10 says scrolling "pins the stage so it never scrolls past the
top of the artwork and spectrum, preserving the same gap that runs from the
artwork's bottom to the scrubber." Pinning the stage alone satisfies the first
half and makes the second half meaningless — the scrubber scrolls away, and
the gap is to something no longer on screen.

**Chosen:** the stage and the scrubber pin together, in one sticky wrapper
(`.pinned`). The gap is then preserved by construction: it is still just the
stage's bottom padding and the scrubber's top padding in ordinary flow, and it
measures 33px in both states without anything recomputing it.

**Why:** it is the reading that makes the sentence coherent, and it is better
behaviour — you can see what is playing *and* seek it while browsing 1,257
rows. The alternative, recomputing a 33px offset in JS against a collapsed
height, is a constant that would drift the first time the strip is restyled.

**Collapse threshold:** above 40px of scroll, expanding again at or below 4px.
The wide band is not arbitrary — see below.

**Reverse:** remove `.pinned` from `index.html` (unwrap the two sections), the
collapsing-stage blocks in `app.css` and `app.js`, and `tests/stage.spec.js`.

---

## 2026-09-04 — The anti-flap guard is real, and three tests failed to prove it

**Unclear:** whether `updateStageCollapse`'s `room < 260` guard was defending
against anything, or was the same kind of dead defensive code the milestone-5
review told me to stop writing.

**What happened:** the mutation check said MISSED three times running, and each
time the cause was different and in my test, not the code.

1. The first version filtered the list to three rows. That is not scrollable at
   all, so `scrollY` never left 0 and the guard was never reached.
2. Six favourites put the document in the right zone (204px of scroll room,
   past the 40px threshold but less than the ~225px the collapse removes), but
   the test asserted the end state — which is `collapsed: false` either way,
   because the flap *resolves* to expanded. So I counted class changes instead.
3. The counter still read 0, because the collapse animates over 300ms and my
   settle helper waited two frames. Unguarded, the sequence is `collapsed:true`
   at +30ms and `collapsed:false` at ~+400ms. I was sampling in between.

**Chosen:** keep the guard. It prevents a genuine visible flicker, now proven:
with it, zero class changes; without it, two.

**Also fixed:** `tools/mutate.sh` reported MISSED when its `-g` pattern matched
no test at all, which is what happened after I renamed one. An empty selection
is a broken check, not a passing one — it now reports BROKEN and fails the run.
That hole cost me a debugging pass looking for a defect in the code.

**Reverse:** the guard is one line in `updateStageCollapse`.

---

## 2026-09-04 — Every layout test has been measuring the wrong fonts

**Unclear:** nothing was unclear. This is a defect in the suite that milestone
5 exposed, and it needs your decision because the fix touches production.

**What is wrong:** `app.css:1` imports Archivo, Barlow and IBM Plex Mono from
`fonts.googleapis.com`. `tests/helpers.js:11` blocks `googleapis.com` and
`gstatic.com` so runs are hermetic. Both are reasonable on their own; together
they mean **every geometry assertion in this suite has been measured against
fallback system fonts, in a layout no user ever sees.**

It surfaced because a mutation escaped. Restoring a 1px rounding tolerance in
the top bar leaks a pixel of horizontal scroll in a window exactly one pixel
wide, and the suite's 20px sweep stepped over it.

**Correction to what I first wrote here.** I originally recorded this as a
single leak window that "moves" from 684px under the fallback fonts to 440px
under the real ones. That was wrong, and the milestone-5 review caught it.
Scanning every integer width shows there are **two** collapse boundaries, one
per collapsible control, and the real fonts shift each by exactly **one pixel**:

    fallback fonts (what the suite runs):  boundaries at 684 and 439
    real fonts (what users see):           boundaries at 685 and 440

So the font-driven shift is 1px, not the ~244px I implied; 440 is simply the
second boundary, which I had misattributed to the first. The practical
consequence is worse than the version I wrote: a uniform sweep detects a
one-pixel window only if the boundary's parity happens to match the sweep's,
and self-hosting the fonts would have flipped one of these from caught to
missed without anything appearing to change.

**Chosen:** the sweep is gone. The test now binary-searches each boundary and
checks every integer width within 4px of it — about 40 resizes instead of 600,
faster, and immune to parity. This entry stands as the record of the fidelity
gap itself, which is unfixed.

I did not change how fonts load, because that is a production change you did
not ask for.

**What I would do:** self-host the three families in `assets/fonts/` and
replace the `@import` with local `@font-face` rules. All three are Open Font
License, so redistribution is fine. It makes the tests faithful, removes a
render-blocking third-party request from first paint, and stops every visitor's
browser announcing itself to Google. Roughly 200 KB in the repo. The one risk
is picking subtly different weights or subsets than the CDN serves, which would
shift the very geometry the suite pins — so it wants a careful before/after
comparison rather than a 2am change.

**Reverse:** nothing to reverse yet.

---

## 2026-09-04 — Milestone 5: priority-plus, and which control collapses first

**Unclear:** QoL 2 says the bar keeps one height and children "collapse into a
menu rather than wrapping", without saying which children or in what order.

**Chosen:** the search shrinks first, from 240px down to a 124px floor. Past
that, whole controls move into a panel behind a "more" button — the theme
switch first, then the list-mode picker. The search is never collapsed. Every
reflow starts from fully expanded, so widening restores controls to the bar.

**Why:** the theme is set once and left alone; the list-mode picker is reached
for more often; and the search is the only way to reach a specific track out of
1,257, so it is the last thing that should ever go behind a menu. Starting each
pass from expanded avoids hysteresis, where a control collapsed on the way down
stays collapsed on the way back up.

**Why the panel is `position: absolute`:** anything in normal flow inside the
bar can add to its height, which is the one thing this milestone promises it
cannot do. There is a mutation check for exactly that.

**Why no rounding tolerance:** `toolsOverflow()` compares `scrollWidth` to
`clientWidth` with no slack. A 1px tolerance is a 1px horizontal scrollbar on
the document — the same defect the transport flanks shipped with in milestone 4.

**Result:** 59px at every width from 360 to 1600, zero overflow, verified at
2px granularity. It was 59 / 103 / 149 / 147 before.

**Reverse:** `--topbar-h` and the `.topbar` rule in `app.css`; the topbar
overflow block in `app.js`; `#toolsMore` and `#toolsPanel` in `index.html`.

---

## 2026-09-04 — Mutation checks became a script, not a habit

**Unclear:** the plan says "any new pixel assertion gets checked by
deliberately breaking the thing it claims to measure". That was a habit I kept
by hand, and it kept failing — seven tests have now shipped green while
measuring nothing.

**Chosen:** `tools/mutate.sh`. Each entry patches one line of `app.js`, runs
the single test covering it, and requires a failure. Five checks so far.

**Why:** the milestone-4 review found `transport.spec.js` asserting
`|listTop| < 30`, a quantity that is true *precisely when* the sticky topbar is
covering the first rows — the assertion was calibrated to the defect. Fixing
the bug turned that test red, which is how it was found. Two of my replacement
tests then passed against stubbed-out implementations: "jump to current" was
satisfied by the focus-scroll that any transport click triggers, because the
playing track was row 0 and therefore already visible from the top of the
document; and the heart's fallback test never reached the fallback, because
favourites-only with a single favourite renders the row it needs to be missing.
Both are now written so the mutation turns them red.

**Reverse:** delete `tools/mutate.sh`. Nothing depends on it; it is not wired
into `npm test`, because it edits `app.js` in place and a crash would leave a
`.bak`.

---

## 2026-09-04 — Milestone 4 remediation, from the review

**Unclear:** how far to go on findings the reviewer raised but which were not in
the spec.

**Chosen:** fixed everything affecting correctness or reach, and left the two
that need a design decision. Fixed: the readouts flank overflowed the document
horizontally at every width from 761px up (137px of track holding 86.5px of
content, now 172px with ellipsis); the jump tab's cells were 23px against
WCAG 2.5.8's 24px minimum, because the tab was a flex item being shrunk past
its own `width`; shuffle was re-randomising on every `buildView()`, so any
keystroke in the search box reshuffled the queue; `#tBottom` triggered 21
repaints instead of one; the transport heart and the row heart could diverge;
the readouts showed stale counts when nothing was playing. Deferred: S2 (a
filter that hides the playing track rewinds the queue to index 0) and A2
(screen-reader announcement of the readouts).

**Why:** the overflow was live and affected every desktop width. S2 needs a
decision about whether filtering should preserve playback position or reset,
which is a product question, not a defect.

**Reverse:** each is a separate hunk in the milestone-4 remediation commit.

---

## 2026-09-03 — Milestone 4: source filter is two toggles, not a switch

**Unclear:** QoL 7 asks for "a switch between YT and SC — works as a filter".
A literal two-position switch can only ever select one source, so there would
be no way to see the whole library.

**Chosen:** two independent toggles, both on by default. Turning both off falls
back to showing everything rather than emptying the list.

**Why:** a filter that cannot express "both" is not a filter. Two toggles cover
the switch behaviour as a subset.

**Reverse:** make the two buttons mutually exclusive in the `[data-source]`
handler in `app.js`.

---

## 2026-09-03 — Milestone 4: the flank width is derived, not eyeballed

**Unclear:** "1/8th-ish box ... should align with the midpoint of the track
number and track name columns" gives two different sizes.

**Chosen:** 130px, which is the measured midpoint of the gap between the
tracklist's number and name columns (18 padding + 40 heart + 12 gap + 54 index
+ 6). At 1100px that is 11.8% — close enough to an eighth that both readings
agree. The flank mirrors the row's grid, so the alignment holds structurally
rather than by tuning.

**Reverse:** the width and grid live together in `.transport` / `.tflank-left`.

---

## 2026-09-03 — Milestone 4: a test that was measuring the harness

The wheel distribution test began timing out after this milestone. Measured
rather than guessed: ten in-page clicks take 18 ms, ten Playwright clicks take
1,622 ms — about 162 ms each of actionability checking. Routing 120 spins
through the harness was ~20 s of overhead, and the extra DOM from the flanks
pushed it past the 30 s limit.

It now drives the spins in-page, since the test is about the distribution
`pickWinner` produces and real clicks are covered by the pointer test. That also
allowed raising the sample from 60 to 400, fixing a flake the reviewer had
flagged: at n=60 the weighted bound sat about 2.8 sigma from the true rate.

Also fixed here: the source filter restored from localStorage and filtered the
list, but nothing painted the buttons on boot, so after a reload the controls
claimed both sources were on while the list was filtered. Same species as the
milestone 2 summary desync. The buttons are painted from state now, and removing
that line fails two tests.

---

## 2026-09-03 — Milestone 3: the wheel, and tests that could not see it

**Unclear:** how "random: pure or by person, weighted or unweighted" should
surface, given the spec also asks for a spinning wheel of contributor initials.

**Chosen:** shuffle stays a pure uniform permutation; the wheel *is* the
by-person picker, with weighted/even-odds on it. Weighted makes a contributor's
segment and odds proportional to their track count; even odds gives all an
equal slice. Landing plays a random non-dead track of theirs.

**Why:** one control per idea, and the wheel is the natural home for the
weighting choice since it visibly changes the segment sizes.

**Reverse:** the wheel is self-contained in `app.js`; remove `#bWheel`, the
dialog, and the wheel block.

---

## 2026-09-03 — Milestone 3: my tests passed against a wheel that landed at random

**Unclear:** nothing. Recording because it is the same failure as milestone 1,
found a different way.

**What happened:** the reviewer replaced the resting-angle computation with
`Math.random()`, so the wheel stopped on a segment unrelated to the winner, and
**all five tests still passed**. Every assertion read `#wheelSub` or `#npSub`,
both written straight from `pickWinner()`'s return value. Nothing sampled a
canvas pixel, so the rotation, the pointer and `drawWheel` were untested. One
test was even named "the contributor it landed on".

**Chosen:** a test that filters to two contributors, spins eight times, and each
time samples the canvas pixel under the pointer and compares it to the announced
winner. Verified against the reviewer's exact mutation — it now fails on spin 1.

**Also worth recording:** when I mutation-tested the mid-spin recovery, two of my
assumptions about it were wrong. Removing the close guard passed; removing the
canvas size guard passed. Only removing `endSpin()` from the reopen path failed
it. The guards are defence in depth; the reopen reset is what the test holds up.
A test guards one line, and it is not always the line you wrote it for.

---

## 2026-09-03 — Milestone 3: reviewer findings addressed

**A crash that would have shipped.** Closing the dialog mid-spin left the canvas
at zero size, `arc()` threw on a negative radius, and the throw killed the rAF
callback *before* the lines that re-enable Spin — dead until reload. Now guarded
three ways: a size check in `drawWheel`, a `close` listener, and a reset on open.

**The Spin button was clipped away entirely below about 543px of viewport
height** — `.modal` has `overflow: hidden` and the wheel dialog had no scrollable
region, so there was no way to reach it. The stage now scrolls. That is the
fourth instance of this failure class here, and the first that no test could see
because nothing in the suite changed viewport size. One does now.

**The wheel borrowed the transport colour tokens**, which Night Dial
deliberately flattens to a single amber — three of six slice colours were
identical. It now has its own `--wheel-1..6` per theme.

**No segment was labelled in even-odds mode.** All 71 slices are 0.089 rad,
below the 0.14 threshold for tangential text. Labels are now radial, so they
need the arc width to clear their height rather than their length, and every
segment gets initials.

Also: the wheel now derives from `state.view` rather than the whole library, so
it composes with search and favourites and cannot start a track the list is
hiding; `store.read(K_WHEEL, ...).weighted` could throw at module scope on a
stored `"null"` and take the whole app down; colours are cached like `EQC` and
`SCOL` instead of two `getComputedStyle` calls per segment per frame; the canvas
has a text alternative; and the weighting button is labelled with its action to
match `#contribAll`.

---

## 2026-09-03 — Milestone 2: an empty contributor selection is honoured

**Unclear:** whether deselecting everyone should persist. Storing it means a
reload shows an empty library, which looks broken.

**Chosen:** it persists. `[]` is now distinguished from absent state, so
"None" survives a reload and the indicator dot stays lit.

**Why:** it is an explicit choice, and silently restoring all 71 people
overrides the user. The lit dot and the "0 tracks" summary make the cause
visible, and one click on All undoes it.

**Reverse:** restore the `&& storedWho.length` guard in `app.js`.

---

## 2026-09-03 — Milestone 2: reviewer findings addressed

The filter's own logic was sound — ordering in `buildView()` is correct and it
composes with search and favourites — but four things around it were not.

**The panel summary was wrong or stale in most states.** It quotes
`state.view.length`, but only repainted when a contributor was toggled. On a
reload with a stored selection it ran before the first render and read "0
tracks"; after a search or a favourites toggle it kept a number the view no
longer had. It now repaints from `paintStatus()`, so it follows the view
wherever the view moves. Reverting that fix fails five tests.

**Selection was tested by cardinality, not membership.** `who.size !==
ALL_WHO.length` is only equivalent to "everyone is selected" while the stored
names are a subset of the current ones. A 72nd contributor in `data/tracks.js`
would have booted every returning user into a filter they never chose. Now
`ALL_WHO.every(n => who.has(n))`.

**Dimming deselected rows to `opacity: .38` broke contrast** — the name fell to
2.8:1 and the focus ring to 1.6:1. No variable-based contrast test can see this,
because opacity composites at paint time. Selection is now marked with an accent
bar and deselected names use `--ink-3`, which the contrast gate does check.

**The focus ring was clipped on both sides** by `.contrib-list`'s scroll
overflow, drawing as two open-ended rules. `outline-offset: -2px` puts it
inside. That is the third instance of this failure mode in this project.

Also: opening the panel autofocused the All/None button, so one Space wiped the
whole selection — the close button is now `autofocus`; `aria-pressed` on an
action button announced a state contradicting its label, so it is gone; and the
filter is now in `#btnContrib`'s accessible name with `aria-live` on the summary,
since a dot says nothing to a screen reader.

---

## 2026-09-03 — Milestone 1: the picker shipped invisible, and the tests approved it

**Unclear:** nothing. Recording because it is the most serious thing that has
gone wrong in this project.

**What happened:** I put the list-mode dropdown inside `.switch`, which has had
`overflow: hidden` since long before this change for its rounded corners. The
menu was clipped away completely — `elementFromPoint` at its centre returned
`.stage-meta`, i.e. nothing of the menu was painted. Obfuscated and Hidden were
unreachable in the real UI. Six new tests passed anyway, because Playwright's
`toBeVisible()` checks bounding box and computed style but does not model
ancestor clipping, and `page.click()` scrolls a clipped ancestor before
hit-testing. The suite actively certified a control the user could not see.

The badge divider was broken in the same way and hidden by the same clip: the
`::before` used `top/bottom: -17px` against a span that stretches to the full
34px control height, making it 68px tall and poking above and below the bar. The
two defects were propping each other up — fixing the overflow alone would have
revealed a line running out of the topbar into the page.

**Chosen:** the list-mode control no longer uses `.switch`. It has its own
container with the same look and `overflow` left alone, corners rounded
per-child. The divider inset is `0`. `tests/helpers.js` gained `isHittable()`,
which uses `elementFromPoint`, and the picker tests now use it.

**Why it matters beyond this bug:** `toBeVisible()` is not a visibility check.
Any future assertion that something is on screen should use `isHittable`.

**Reverse:** not recommended.

---

## 2026-09-03 — Milestone 10 pulled forward: the spectrum reads both sources

**Unclear:** the plan scheduled lifting the YouTube-only guard for last, but the
SoundCloud analysis run is producing envelopes now.

**Chosen:** lifted it immediately. `loadEnvelope()` no longer checks the source;
`eqIndex` already gates on what actually exists.

**Why:** leaving it meant the run would spend the night writing files the client
was hardcoded to ignore. The reviewer flagged the same producer/consumer split
independently.

**Reverse:** restore the `track.s !== "YT"` condition in `loadEnvelope()`.

---

## 2026-09-03 — Milestone 1: reviewer findings addressed

Beyond the two above: `aria-pressed` on the mode pill announced the inverse of
what was on screen, so it is now a class rather than a toggle state; the global
keydown handler let ArrowLeft/Right skip tracks while the picker was open and
swallowed Space so the picker could not be opened by keyboard; Escape dropped
focus to `<body>`, tabbing the user past the whole control; `role="menu"`
promised arrow-key navigation that does not exist and was dropped; `.switch
button` rules leaked a stray 1px border and a fixed 34px height into the menu
items; and an unnecessary `!important` was removed. Each has a test.

Left as-is deliberately: `--ok` drives one palette drop, which couples a status
token to decoration, and the drop-shadow uses a hardcoded black. Both are fine
for two dark themes and would want revisiting if a light theme returns.

---

## 2026-09-03 — Milestone 1: the list-mode pill returns to Shown

**Unclear:** T1 asked for "just SHOWN, with a narrow clickable modal button to
pick one of OBFUSCATED|HIDDEN". It did not say what clicking the visible pill
should do once a non-default mode is active.

**Chosen:** the pill always names the active mode, and clicking it returns to
Shown. The narrow caret opens the menu of the other two.

**Why:** two controls that both open the same menu would be redundant. This
gives the pill a job — one click back to plain titles — and keeps the menu for
choosing an obfuscation.

**Reverse:** in `app.js`, change the `#listModeCurrent` handler to open the menu
instead of calling `setListMode("show")`.

---

## 2026-09-03 — Milestone 1: the palette badge body follows --raised

**Unclear:** T2 said "the pallet color should change from light to dark
accordingly". Both themes are now dark, since the Jukebox retheme moved it to
mahogany-and-neon, so there is no light theme for it to swing against.

**Chosen:** the palette body uses `--raised` and the three drops use
`--accent`, `--tint` and `--ok`. In Jukebox that is magenta, amber and green
off the neon tubes; in Night Dial, amber, muted cyan and green.

**Why:** `--raised` is the theme's own lifted surface, so the body tracks the
theme exactly as described — it simply reads dark in both today. If a light
theme is ever added the token follows it with no further change. Using `--ink`
instead would have inverted the intent, since ink is light *on* dark themes.

**Reverse:** change the `.pal-body` fill in `app.css`.

---

## 2026-09-03 — Milestone 1: autoplay no longer follows the current track

**Unclear:** QoL 6 said not to move the screen when a new track starts, but the
spec also asks (QoL 4, QoL 7) for a jump-to-current-track control.

**Chosen:** removed the `scrollIntoView` from `step()` outright. Following the
current track becomes deliberate, via the control built in milestone 4.

**Why:** the two requests only reconcile if the automatic movement goes and an
explicit one replaces it.

**Reverse:** restore the line in `step()` in `app.js`.

---

## 2026-09-03 — Milestone 1: a whole class of test selector was wrong

**Unclear:** nothing — recording because it nearly invalidated the contrast gate.

**Chosen:** every theme selector in `tests/` is now scoped to `button[data-skin=...]`.

**Why:** `<html>` carries `data-skin` as the theme attribute, so a bare
`[data-skin="jukebox"]` matched the root element. Inside `page.evaluate`,
`document.querySelector` silently returned `<html>` — a badge geometry test was
measuring a 1100px-wide root element instead of a 96px button. Playwright's own
strict mode caught the `page.click` cases only because the two theme clicks
happened to alternate; a run starting in Jukebox would have matched two
elements and thrown. The contrast gate was genuinely exercising both themes —
it had already caught real failures in each — but it was one page-load away
from silently checking one theme twice.

**Reverse:** not recommended.

---

## 2026-09-03 — Test harness drives system Chrome, not bundled Chromium

**Unclear:** the plan assumed `npx playwright install chromium`.

**Chosen:** `channel: "chrome"` in `playwright.config.js`, driving the installed
Google Chrome 152.

**Why:** the install fails outright — *"Playwright does not support chromium on
mac13"*. This machine runs macOS 13.7.8, and current Playwright no longer ships
a Chromium build for it. Driving the system Chrome needs no download and works.

**Reverse:** if the machine is ever upgraded past macOS 13, drop the `channel`
line and run `npx playwright install chromium` for a version-pinned browser.

---

## 2026-09-03 — Night Dial contrast raised to meet AA

**Unclear:** the new contrast test failed on Night Dial, a theme I was not asked
to change. Exempting it or fixing it were both defensible.

**Chosen:** fixed it. `--ink-3` `#6f6a5f` → `#918875` (3.15:1 → 4.82:1) and
`--dead` `#9c6a5a` → `#b98274` (3.80:1 → 5.35:1).

**Why:** those tokens carry the `via …` bylines, timestamps and the
"unavailable" marker — small text that was below AA. Exempting a theme from the
gate would have made the gate meaningless on the next retheme. Both values keep
the warm cast the theme is built on.

**Reverse:** restore the two hex values in the `html[data-skin="night"]` block
and delete the corresponding pairs from `tests/contrast.spec.js`.

---

## 2026-09-03 — Two layout bugs fixed, found by the new suite

**Unclear:** nothing — these were defects the tests surfaced immediately.

**Chosen:** fixed both in `app.css`.

1. `.stage-strip` had implicit column placement, so when the artwork tile hid
   itself the spectrum fell into the `auto` column and sized to content —
   170px instead of 435px. Columns are now pinned (`.art { grid-column: 1 }`,
   `.eq { grid-column: 2 }`).
2. The strip's `gap: 14px` still applied to the hidden column, leaving the
   spectrum 14px short. The gap now lives as `margin-right` on `.art`, so it
   disappears with the tile.

**Why:** both only appear on tracks with no cover art, which is why screenshots
of tracks that had covers never showed them.

**Reverse:** `git revert` the harness commit; neither fix is load-bearing for
anything else.

---

## 2026-09-03 — A test that passed for the wrong reason

**Unclear:** nothing — worth recording because it nearly shipped as false
confidence.

**Chosen:** `canvasTopmostPaintedRow()` now takes a colour to ignore, and the
scrubber assertions pass `--ink`.

**Why:** the playhead is drawn `fillRect(x, 0, 2, H)`, full canvas height. Row 0
therefore always had a painted pixel whenever a track was current, so the
"paints flush to the top" assertion passed no matter where the waveform
actually started. Deliberately reintroducing the old `v * (H - 6)` inset did not
fail the test. With the playhead excluded it now reports `Received: 3`, the
exact inset.

**Reverse:** not recommended. If the playhead is ever restyled off full height,
the exclusion can be dropped.
