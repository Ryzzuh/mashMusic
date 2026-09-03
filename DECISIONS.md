# Decisions log

Judgement calls made without checking in, so they can be scanned and reversed
quickly. Newest first. Each entry says what was unclear, what I chose, and how
to undo it.

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
