#!/bin/zsh
# Mutation checks: prove a test fails against the bug it claims to catch.
#
# This suite has now shipped seven tests that passed for the wrong reason —
# a control clipped out of view, a wheel landing at random, an assertion
# calibrated to the very offset it was meant to detect, and two in this file's
# own first draft. A green test is not evidence until the defect turns it red.
#
#   ./tools/mutate.sh          # run every check below
#
# Each entry breaks one thing in app.js, runs the test that covers it, and
# expects a failure. MISSED means the test does not measure what it claims.

set -u
cd "$(dirname "$0")/.."
fails=0

mut() {
  local name="$1" file="$2" from="$3" to="$4" spec="$5" grepfor="$6"
  cp "$file" "$file.bak"
  python3 - "$file" "$from" "$to" <<'PY' || { mv "$file.bak" "$file"; exit 1; }
import sys
p, f, t = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
assert f in s, "mutation target no longer present: " + f[:70]
open(p, 'w').write(s.replace(f, t, 1))
PY
  local res
  res=$(npx playwright test "$spec" -g "$grepfor" 2>&1 | grep -E '^\s+[0-9]+ (passed|failed)' | tr -d '\n')
  mv "$file.bak" "$file"
  # An empty result means the -g pattern matched no test at all — usually a
  # renamed test. That is a broken check, not a passing one, and reporting it
  # as MISSED sent me looking for a bug in the code instead of in this file.
  if [[ -z "$res" ]]; then
    print -- "  BROKEN   $name   <-- no test matches \"$grepfor\" in $spec"
    fails=$((fails + 1))
    return
  fi
  if [[ "$res" == *failed* ]]; then
    print -- "  CAUGHT   $name"
  else
    print -- "  MISSED   $name   <-- the test does not detect this"
    fails=$((fails + 1))
  fi
}

print "mutation checks (each should be CAUGHT)"


mut "positionOf always returns 0" app.js \
  '    const viewIdx = state.view.findIndex((t) => t.k === track.k);
    return viewIdx < 0 ? -1 : state.order.indexOf(viewIdx);' \
  '    return 0;' \
  tests/transport.spec.js "readouts count from"

mut "jumpToCurrent does nothing" app.js \
  '  $("tJump").addEventListener("click", jumpToCurrent);' \
  '  $("tJump").addEventListener("click", () => {});' \
  tests/transport.spec.js "brings the playing row into view"

mut "the heart's fallback skips the list rebuild" app.js \
  '    toggleFav(state.current, row && row.querySelector(".t-fav"));' \
  '    if (!row) { favs.delete(state.current.k); store.write(K_FAV, [...favs]); }
    else toggleFav(state.current, row.querySelector(".t-fav"));' \
  tests/transport.spec.js "unrendered row"

mut "a stored source filter is read but never applied" app.js \
  '    Array.isArray(storedSrc) ? storedSrc.filter((x) => ALL_SOURCES.includes(x)) : ALL_SOURCES' \
  '    ALL_SOURCES' \
  tests/transport.spec.js "survives a reload"

# ---------------------------------------------------------- milestone 5

# ONE property. The previous version of this check also deleted
# `height: var(--topbar-h)`, and it was the missing height that turned the test
# red — so it proved the height declaration exists, not that the bar cannot
# wrap. With the height kept, wrap-only spilled .tools 28px below the bar at
# 212 of 306 sampled widths while every assertion stayed green.
mut 'the top bar is allowed to wrap (wrap only)' app.css \
  '  flex-wrap: nowrap;' \
  '  flex-wrap: wrap;' \
  tests/topbar.spec.js 'holds one height and never wraps'

mut '1px of overflow tolerance comes back' app.js \
  '    return bar.scrollWidth > bar.clientWidth;' \
  '    return bar.scrollWidth > bar.clientWidth + 1;' \
  tests/topbar.spec.js 'within a pixel of either collapse boundary'

mut 'collapsed controls are never restored to the bar' app.js \
  '    for (const sel of COLLAPSE_ORDER) {
      const el = toolsPanel.querySelector(sel);
      if (el) toolsEl.insertBefore(el, toolsMore);
    }
    toolsMore.hidden = true;' \
  '    if (!toolsPanel.children.length) toolsMore.hidden = true;' \
  tests/topbar.spec.js 'come back when there is room'

mut 'the search may shrink without a floor' app.css \
  '  min-width: 124px;
  max-width: 300px;' \
  '  min-width: 0;
  max-width: 300px;' \
  tests/topbar.spec.js 'search is never collapsed'

mut 'the overflow panel is laid out in flow' app.css \
  '.tools-panel {
  position: absolute;' \
  '.tools-panel {
  position: static;' \
  tests/topbar.spec.js 'collapsed theme'

mut 'a widening label never triggers a reflow' app.js \
  '    reflowTools();
    render(false);' \
  '    render(false);' \
  tests/topbar.spec.js 'near a boundary does not overflow'

mut 'focus is not restored after a reflow' app.js \
  '    if (owned && prev.isConnected && document.activeElement !== prev)
      prev.focus({ preventScroll: true });' \
  '    void owned;' \
  tests/topbar.spec.js 'throw keyboard focus away'

mut 'Escape falls through both layers at once' app.js \
  '    if (!listModeMenu.hidden) { openListMenu(false, true); return; }' \
  '    if (!listModeMenu.hidden) { openListMenu(false, true); }' \
  tests/topbar.spec.js 'one layer at a time'

mut 'closing the panel leaves the picker open behind it' app.js \
  '    if (!open) openListMenu(false);' \
  '    void open;' \
  tests/topbar.spec.js 'strand the picker'

# ---------------------------------------------------------- milestone 6

mut 'the stage and scrubber are not pinned' app.css \
  '  position: sticky;
  top: var(--topbar-h);' \
  '  position: static;
  top: var(--topbar-h);' \
  tests/stage.spec.js 'never scrolls past the top bar'

mut 'the stage never collapses' app.js \
  '    const want = stageCollapsed ? y > 4 : y > 40;' \
  '    const want = false && y;' \
  tests/stage.spec.js 'collapses when the list is scrolled'

mut 'the anti-flap guard is removed' app.js \
  '    if (want && !stageCollapsed && room < 260) return;' \
  '    void room;' \
  tests/stage.spec.js 'too little scroll room never collapses'


mut 'the collapsed stage loses its bottom padding' app.css \
  '.stage.is-collapsed {
  grid-template-columns: 0fr minmax(0, 1fr);' \
  '.stage.is-collapsed {
  padding-bottom: 8px;
  grid-template-columns: 0fr minmax(0, 1fr);' \
  tests/stage.spec.js 'gap from the artwork to the scrubber'

mut 'the collapsed side column stays stacked' app.css \
  '  grid-template-rows: none;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr);' \
  '  grid-template-rows: 2fr 1fr;' \
  tests/stage.spec.js 'left of the spectrum'

# ---------------------------------------------------------- milestone 7

mut 'the halo uses one shared accent, not each tube colour' app.css \
  '  --halo: color-mix(in srgb, var(--btn, var(--accent)) 55%, transparent);' \
  '  --halo: color-mix(in srgb, var(--accent) 55%, transparent);' \
  tests/halo.spec.js 'own tube colour .jukebox'

mut 'a disabled button still glows' app.css \
  '.tbtn[disabled] { box-shadow: none; }' \
  '.tbtn[disabled] { opacity: .35; }' \
  tests/halo.spec.js 'disabled button does not glow'

mut 'the halo does not respond to hover' app.css \
  '.tbtn:hover {
  box-shadow: 0 0 17px -2px var(--halo), inset 0 0 11px -5px var(--halo);
}' \
  '.tbtn:hover { box-shadow: 0 0 10px -3px var(--halo); }' \
  tests/halo.spec.js 'brightens on hover'

mut 'the halo tints the button face' app.css \
  '.tbtn {
  --halo: color-mix(in srgb, var(--btn, var(--accent)) 55%, transparent);' \
  '.tbtn {
  background: color-mix(in srgb, var(--btn, var(--accent)) 12%, var(--raised));
  --halo: color-mix(in srgb, var(--btn, var(--accent)) 55%, transparent);' \
  tests/halo.spec.js 'never tints the button face'

mut 'the focus ring is drawn as a shadow the halo can swallow' app.css \
  '.tbtn:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}' \
  '.tbtn:focus-visible { box-shadow: 0 0 0 2px var(--ink); }' \
  tests/halo.spec.js 'focus ring survives'

mut 'a tube colour drops below the 3:1 graphics bar' app.css \
  '  --c-next:      #fa1768;' \
  '  --c-next:      #3a2a20;' \
  tests/contrast.spec.js 'legible on the button face'

mut 'jump-to-top lands short of the top' app.js \
  '    window.scrollTo({ top: 0, behavior: "smooth" });' \
  '    window.scrollTo({ top: 400, behavior: "smooth" });' \
  tests/stage.spec.js 'clears the pinned stage'

mut 'jump-to-top leaves the list behind the chrome' app.js \
  '    window.scrollTo({ top: 0, behavior: "smooth" });' \
  '    window.scrollTo({ top: 400, behavior: "smooth" });' \
  tests/transport.spec.js 'jumps to the top'

# ---------------------------------------------------------- milestone 8

mut 'skipping counts as listening' app.js \
  '  $("bNext").addEventListener("click", next);' \
  '  $("bNext").addEventListener("click", completed);' \
  tests/decay.spec.js 'skipping is not listening'

mut 'a finished track is never recorded' app.js \
  '    played.add(track.k);' \
  '    void track.k;' \
  tests/decay.spec.js 'leaves the list and is remembered'

mut 'played tracks are not filtered out of the view' app.js \
  '      if (played.has(t.k)) return false;' \
  '      if (false && played.has(t.k)) return false;' \
  tests/decay.spec.js 'gone from every surface'

mut 'the decay is never persisted' app.js \
  '    store.write(K_PLAYED, [...played]);' \
  '    void K_PLAYED;' \
  tests/decay.spec.js 'survives a reload'

mut 'playback resumes one past the gap' app.js \
  '      resumeFrom(pos);' \
  '      resumeFrom(pos + 1);' \
  tests/decay.spec.js 'moved up into the gap'

mut 'the row is removed without popping' app.js \
  '    row.classList.add("is-popping");' \
  '    void row;' \
  tests/decay.spec.js 'row pops before it goes'

mut 'reset clears the view but not the store' app.js \
  '    played.clear();
    store.write(K_PLAYED, []);' \
  '    played.clear();' \
  tests/decay.spec.js 'brings it back'

# ---------------------------------------------------------- milestone 9

mut 'every row offers a replacement, not just dead ones' app.js \
  '    if (swap) swap.hidden = !dead;' \
  '    if (swap) swap.hidden = false;' \
  tests/replace.spec.js 'only a dead row offers'

mut 'dead tracks are offered as replacements' app.js \
  '      if (t.k === track.k || isDead(t)) continue;' \
  '      if (t.k === track.k) continue;' \
  tests/replace.spec.js 'dead twin is not offered'

mut 'the similarity threshold is abandoned' app.js \
  '  const SWAP_MIN = 0.62;          // below this the "matches" are noise' \
  '  const SWAP_MIN = 0;' \
  tests/replace.spec.js 'unrelated titles are not offered'


mut 'the offline sidecar is fetched but discarded' app.js \
  '        if (!replacements[k] && Array.isArray(list)) { replacements[k] = list; added++; }' \
  '        void list; void k;' \
  tests/replace.spec.js 'offline sidecar is merged'

mut 'a late-rendered row does not mark itself current' app.js \
  '    if (state.current && state.current.k === track.k) {
      li.setAttribute("aria-current", "true");
      revealRow(li, track);
    }' \
  '    void track;' \
  tests/replace.spec.js 'choosing a replacement plays it'

mut 'scroll anchoring is left on' app.css \
  'html { height: 100%; overflow-anchor: none; }' \
  'html { height: 100%; }' \
  tests/stage.spec.js 'scroll anchoring does not drag'

print ""
if (( fails )); then print "$fails missed"; exit 1; else print "all caught"; fi
