# Decisions log

Judgement calls made without checking in, so they can be scanned and reversed
quickly. Newest first. Each entry says what was unclear, what I chose, and how
to undo it.

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
