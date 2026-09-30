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
  '    openListMenu(false, true);
    // "Shown" -> "Obfuscated" widens the pill and moves the collapse boundary' \
  '    openListMenu(false, true);
    if (false)' \
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
    }' \
  '    void track;' \
  tests/replace.spec.js 'choosing a replacement plays it'

mut 'scroll anchoring is left on' app.css \
  'html { height: 100%; overflow-anchor: none; }' \
  'html { height: 100%; }' \
  tests/stage.spec.js 'scroll anchoring does not drag'

mut 'the sidecar is fetched even with nothing dead' app.js \
  '    if (!TRACKS.some(isDead)) return;          // nothing to replace' \
  '    ' \
  tests/replace.spec.js 'not requested when nothing is dead'

# ---------------------------------------------------------- self-hosted fonts

mut 'the Google Fonts import comes back' app.css \
  '/* Self-hosted fonts.' \
  '@import url("https://fonts.googleapis.com/css2?family=Archivo:wght@600;700&display=swap");
/* Self-hosted fonts.' \
  tests/fonts.spec.js 'nothing is fetched from a font CDN'

mut 'a font file path is broken' app.css \
  "  src: url('assets/fonts/archivo-latin.woff2') format('woff2');" \
  "  src: url('assets/fonts/archivo-missing.woff2') format('woff2');" \
  tests/fonts.spec.js 'real families are in use'

mut 'the latin-ext subset is dropped' app.css \
  "  src: url('assets/fonts/barlow-400-latin-ext.woff2') format('woff2');" \
  "  src: url('assets/fonts/barlow-400-latin.woff2') format('woff2');" \
  tests/fonts.spec.js 'latin-ext covers the one title'

# ------------------------------------------------ list-mode picker + palette

mut 'the picker drops the mode you are already in' index.html \
  '        <button data-listmode="show">Shown</button>
' \
  '' \
  tests/topbar.spec.js 'offers every mode'

mut 'the palette does nothing when clicked' app.js \
  '  skinBadge.addEventListener("click", flipSkin);' \
  '  skinBadge.addEventListener("noop", flipSkin);' \
  tests/topbar.spec.js 'switches between the two profiles'

# Two checks on the same defect, deliberately. isHittable() in tests/helpers.js
# used to accept a hit on an ancestor, which is precisely what elementFromPoint
# returns for an unclickable element — so this mutation stayed green until the
# helper was made strict. The second check is on a different control, so a
# helper tuned to the palette alone would show as MISSED here.
mut 'the palette goes back to being decoration' app.css \
  '.skin-badge {' \
  '.skin-badge {
  pointer-events: none;' \
  tests/topbar.spec.js 'a real target, not decoration'

mut 'the Spin button stops taking clicks' app.css \
  '.wheel-spin {' \
  '.wheel-spin {
  pointer-events: none;' \
  tests/wheel.spec.js 'stays reachable on a short viewport'

mut 'the palette is not placed over the join' app.js \
  '    if (first) skinBadge.style.left = first.offsetWidth + "px";' \
  '    if (first) skinBadge.style.left = "0px";' \
  tests/topbar.spec.js 'badge sits on the divider'

mut 'hidden mode stops filtering unavailable tracks' app.js \
  '      if (state.listMode === "hide" && isSkippable(t)) return false;' \
  '      if (false && isSkippable(t)) return false;' \
  tests/behaviour.spec.js 'drops the tracks the platforms have lost'

mut 'obfuscated mode filters too' app.js \
  '      if (state.listMode === "hide" && isSkippable(t)) return false;' \
  '      if (state.listMode !== "show" && isSkippable(t)) return false;' \
  tests/behaviour.spec.js 'still shows every track'

mut 'the palette loses its keyboard handler' app.js \
  '    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flipSkin(); }' \
  '    void e;' \
  tests/topbar.spec.js 'responds to the keyboard'

# ---------------------------------------------------------------- liveness
# The oembed checker writes to the same store as playback and as the offline
# file, so the checks that matter are the ones about precedence and about not
# recording a verdict the network never gave.

mut 'the batch rechecks tracks that already have a record' app.js \
  '  const uncheckedTracks = () => TRACKS.filter((t) => !liveness[t.k]);' \
  '  const uncheckedTracks = () => TRACKS.slice();' \
  tests/liveness.spec.js 'never rechecks a track that already has a record'

mut 'the day budget stops limiting the batch' app.js \
  '    const budget = Math.min(want, checkRemaining(), pending.length);' \
  '    const budget = Math.min(want, pending.length);' \
  tests/liveness.spec.js 'ledger caps how many'

mut 'the ledger never rolls over to a new day' app.js \
  '    return led && led.day === today() ? led : { day: today(), spent: 0 };' \
  '    return led || { day: today(), spent: 0 };' \
  tests/liveness.spec.js "yesterday's does not"

mut 'a failed request is recorded as gone' app.js \
  '      return res.ok ? "ok" : "gone";
    } catch (e) {
      return null;
    }' \
  '      return res.ok ? "ok" : "gone";
    } catch (e) {
      return "gone";
    }' \
  tests/liveness.spec.js 'never gets an answer records nothing'

mut 'the offline file overwrites a stronger verdict' app.js \
  '        if (conf(liveness[k]) >= conf(incoming)) continue;' \
  '        if (false) continue;' \
  tests/liveness.spec.js 'never a playback one'

mut 'a record with no provenance is treated as the weakest' app.js \
  '  const conf = (rec) => (rec ? (LIVE_CONF[rec.v] ?? LIVE_CONF.playback) : -1);' \
  '  const conf = (rec) => (rec ? (LIVE_CONF[rec.v] ?? 0) : -1);' \
  tests/liveness.spec.js 'before the provenance field survives'

mut 'selecting a track no longer checks it' app.js \
  '    checkOne(track);            // unbatched, alongside the load — see checkOne' \
  '    void track;' \
  tests/liveness.spec.js 'checks that track alone'

mut 'the batch claims playback confidence for an oembed verdict' app.js \
  '        markLiveness(t, status, status === "gone" ? 404 : null, "oembed");' \
  '        markLiveness(t, status, status === "gone" ? 404 : null, "playback");' \
  tests/liveness.spec.js 'records oembed verdicts'

# ---------------------------------------------------------------- playlists
# Membership is one predicate in buildView(); the counters and the importer's
# failure modes are the rest of the surface worth breaking.

mut 'the playlist predicate stops filtering' app.js \
  '      if (playlistKeys) { if (!playlistKeys.has(t.k)) return false; }' \
  '      if (playlistKeys) { if (false) return false; }' \
  tests/playlist.spec.js 'becomes a playlist and the view switches'

mut 'the library stops excluding imported tracks' app.js \
  '      else if (t.imported) return false;' \
  '      else if (false) return false;' \
  tests/playlist.spec.js 'imported tracks stay out of the library'

mut 'an unshared sheet is not recognised' app.js \
  '    if (/^\s*<(?:!doctype|html)/i.test(text)) {' \
  '    if (false) {' \
  tests/playlist.spec.js 'permissions problem'

mut 'ids already in the library are fetched again' app.js \
  '      if (!TRACKS.some((t) => t.k === k) && !imported[k]) fresh.push({ k, i: id });' \
  '      fresh.push({ k, i: id });' \
  tests/playlist.spec.js 'reused, not fetched again'

mut 'an imported duration is never written back' app.js \
  '    if (!track || track.d || !imported[track.k]) return;' \
  '    if (true) return;' \
  tests/playlist.spec.js 'learns its duration'

# Not checked: dropping the `!imported[track.k]` clause alone. Every built-in
# track has a non-zero duration from the 2015 dataset, so `track.d` returns
# first and the clause is unreachable for them — the mutant turns a no-op into
# a throw, which no assertion can see. The `track.d` clause below is the part
# of the guard that has observable behaviour.
mut 'a learned duration can be revised by a later reading' app.js \
  '    if (!track || track.d || !imported[track.k]) return;' \
  '    if (!track || !imported[track.k]) return;' \
  tests/playlist.spec.js 'learned once and not revised'

mut 'a placeholder import quietly succeeds' app.js \
  '    paste:  async () => ({ ok: false, error: NOT_BUILT.paste }),' \
  '    paste:  async () => ({ ok: true, id: null, count: 0, added: 0 }),' \
  tests/playlist.spec.js 'refuse rather than pretend'

mut 'the counters go back to counting every known track' app.js \
  '  const scopeCount = () => (playlistKeys ? playlistKeys.size : BUILTIN.length);' \
  '  const scopeCount = () => TRACKS.length;' \
  tests/playlist.spec.js 'imported tracks stay out of the library'

mut 'any open dialog stops owning the keyboard' app.js \
  '    if (document.querySelector("dialog[open]")) return;' \
  '    if (false) return;' \
  tests/playlist.spec.js 'arrow keys inside the dialog'

mut 'a missing title is stored as the id' app.js \
  '        t: "", v: "",' \
  '        t: item.i, v: "",' \
  tests/playlist.spec.js 'never lands leaves the track pending'

mut 'a 404 title is not recorded as a dead track' app.js \
  '          markLiveness(TRACKS.find((x) => x.k === k) || imported[k],' \
  '          if (false) markLiveness(TRACKS.find((x) => x.k === k) || imported[k],' \
  tests/playlist.spec.js '404s marks the track dead'

mut 'an unanswered title request is recorded as dead' app.js \
  '        } else if (res.gone) {' \
  '        } else if (true) {' \
  tests/playlist.spec.js 'never lands leaves the track pending'

mut 'rendered rows never ask for their missing titles' app.js \
  '    backfillRendered();' \
  '    void 0;' \
  tests/playlist.spec.js 'beyond the first screen arrive'

# ------------------------------------------------------------ live spectrum
# The band mapping is the part with real arithmetic in it, so break it in a way
# that still draws something — a check that only proves "bars appeared" would
# pass against a wrong mapping.

mut 'the live source is ignored in favour of the envelope' app.js \
  '    const useLive = liveActive();' \
  '    const useLive = false;' \
  tests/liveeq.spec.js 'no envelope'

mut 'band edges are linear in frequency, not logarithmic' app.js \
  '      const lo = 40 * Math.pow(16000 / 40, i / n);
      const hi = 40 * Math.pow(16000 / 40, (i + 1) / n);' \
  '      const lo = 40 + (16000 - 40) * (i / n);
      const hi = 40 + (16000 - 40) * ((i + 1) / n);' \
  tests/liveeq.spec.js 'lights the band it belongs in'

mut 'the spectrum tilt is dropped from the live path' app.js \
  '      const tilted = db + EQ_TILT * Math.log2(Math.max(eqCentres[i], 40) / 200);' \
  '      const tilted = db;' \
  tests/liveeq.spec.js 'spectrum is tilted'

# The live path must reduce each band the same way tools/build-envelopes.py
# does (peak bin, not mean) or the two sources look like different instruments.
mut 'the live path averages a band instead of taking its peak' app.js \
  '      let db = -Infinity;
      for (let j = a; j < b; j++) if (live.bins[j] > db) db = live.bins[j];' \
  '      let db = 0;
      for (let j = a; j < b; j++) db += live.bins[j] / (b - a);' \
  tests/liveeq.spec.js 'spectrum is tilted'

mut 'a share carrying no audio is accepted anyway' app.js \
  '    if (!audio) {' \
  '    if (false) {' \
  tests/liveeq.spec.js 'no audio is reported'

mut 'the screen capture keeps running after live mode stops' app.js \
  '    try { live.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* already gone */ }' \
  '    try { void live; } catch (e) { /* already gone */ }' \
  tests/liveeq.spec.js 'releases the capture'

mut 'the video track is captured and kept' app.js \
  '    stream.getVideoTracks().forEach((t) => t.stop());' \
  '    void stream;' \
  tests/liveeq.spec.js 'video track is dropped'

mut "Chrome's Stop sharing leaves the app thinking it is live" app.js \
  '    audio.addEventListener("ended", () => stopLive());' \
  '    void audio;' \
  tests/liveeq.spec.js 'Stop sharing ends live mode'

mut 'the capturing tab is excluded from its own picker' app.js \
  '        selfBrowserSurface: "include",' \
  '        selfBrowserSurface: "exclude",' \
  tests/liveeq.spec.js 'asks for this tab'

mut 'the capture stops silencing nothing and mutes the tab' app.js \
  '        audio: { suppressLocalAudioPlayback: false },   // keep hearing it' \
  '        audio: { suppressLocalAudioPlayback: true },' \
  tests/liveeq.spec.js 'asks for this tab'

# ------------------------------------------------------ background durations

mut 'the duration resolver plays tracks instead of cueing them' app.js \
  '      try { durPlayer.cueVideoById(id); } catch (e) { finish({ error: true }); }' \
  '      try { durPlayer.loadVideoById(id); } catch (e) { finish({ error: true }); }' \
  tests/playlist.spec.js 'without playing anything'

mut 'the resolver polls getDuration instead of waiting for the cue' app.js \
  '        onStateChange: (e) => { if (e.data === 5 && durCued) durCued({ ok: true }); },' \
  '        onStateChange: (e) => { void e; },' \
  tests/playlist.spec.js 'without playing anything'

mut 'a resolved duration never reaches the row' app.js \
  '    const row = rowFor(key);
    if (row) {
      const cell = row.querySelector(".t-dur");
      if (cell) cell.textContent = fmtDur(secs);
    }' \
  '    void key;' \
  tests/playlist.spec.js 'without playing anything'

mut 'a refused track is retried forever instead of recorded' app.js \
  '          durFailed.add(track.k);
          const status = res.code === 100 ? "gone"' \
  '          const status = res.code === 100 ? "gone"' \
  tests/playlist.spec.js 'refuses is recorded'

mut 'resolving does not resume from a previous session' app.js \
  '  resolveDurations();
  document.addEventListener("visibilitychange", () => {' \
  '  document.addEventListener("visibilitychange", () => {' \
  tests/playlist.spec.js 'picks up where the last session stopped'

mut 'an id is shown while its lookup is still open' app.js \
  '      name.textContent = "Resolving\u2026";
      name.classList.add("is-pending");' \
  '      name.textContent = track.i;
      name.classList.add("is-pending");' \
  tests/playlist.spec.js 'shows no id at all'

mut 'resolved durations are held in memory until the run ends' app.js \
  '        if (++sinceWrite >= 10) { sinceWrite = 0; store.write(K_IMPORT, imported); }' \
  '        sinceWrite++;' \
  tests/playlist.spec.js 'saved as they resolve'

# --------------------------------------------- resolution state on the record
#
# The metadata sidecar's mutations lived here. Two of them had live equivalents
# once the API became the resolver and moved in below; the third — embeddable
# checked after applyMeta's short-circuit — was dropped with the test that
# caught it, because a source that cannot arrive after the records it wrote
# makes the ordering unobservable. See DECISIONS.md.

mut 'a failed lookup is not recorded on the record' app.js \
  '        if (!rec.x) { rec.x = 1; metaFailed.add(k); n++; }' \
  '        if (!rec.x) { metaFailed.add(k); }' \
  tests/playlist.spec.js 'keeps showing its id across a reload'

mut 'a settled verdict is reopened by the keyless fallback' app.js \
  '    const left = want.filter((k) => imported[k] && !imported[k].t && !metaFailed.has(k));' \
  '    const left = want.filter((k) => imported[k] && !imported[k].t);' \
  tests/playlist.spec.js 'keeps showing its id across a reload'

mut 'a corrected record never reaches the rendered library' app.js \
  '      if (changed) rebuildLibrary();' \
  '      void changed;' \
  tests/playlist.spec.js 'before the endpoint existed'

mut 'the resolver settles for a title and leaves the duration' app.js \
  '      .filter((k) => (!imported[k].t || !imported[k].d) &&
                     !metaFailed.has(k) && !metaApiSkip.has(k));' \
  '      .filter((k) => !imported[k].t &&
                     !metaFailed.has(k) && !metaApiSkip.has(k));' \
  tests/playlist.spec.js 'before the endpoint existed'

# ----------------------------------------------------------- the resolve API

mut 'the API tier is skipped entirely' app.js \
  '      const res = await metaFromApi(slice.map((k) => imported[k].i));' \
  '      const res = null;' \
  tests/playlist.spec.js 'sparing oEmbed and the cue player'

mut 'an API failure is treated as an empty answer, not a fallback' app.js \
  '      if (!res.ok) return null;     // 429 quota, 503 no key, 502 upstream — all fall through' \
  '      if (!res.ok) return {};' \
  tests/playlist.spec.js 'asked once, not once per batch'

mut 'the API asks one id at a time instead of batching' app.js \
  '  const META_API_BATCH = 50;        // videos.list maximum; the endpoint enforces it too' \
  '  const META_API_BATCH = 1;' \
  tests/playlist.spec.js 'sparing oEmbed and the cue player'

mut 'a configured endpoint is ignored' app.js \
  '  const META_API = (window.MASH_CONFIG || {}).metaApi || "";' \
  '  const META_API = "";' \
  tests/playlist.spec.js 'records gone and blocked'

mut 'the whole playlist is never resolved, only what is rendered' app.js \
  '    if (!META_API || bulkRunning) return 0;' \
  '    if (true) return 0;' \
  tests/playlist.spec.js 'whole playlist resolves'

mut 'unanswerable ids are asked for forever' app.js \
  '        batch.forEach((k) => {
          if (!imported[k].t || !imported[k].d) metaApiSkip.add(k);
        });' \
  '        void batch;' \
  tests/playlist.spec.js 'do not spin the resolver forever'

mut 'the cue resolver races the API instead of following it' app.js \
  '    resolveAllMeta().then(resolveDurations);
  }' \
  '    resolveDurations();
  }' \
  tests/playlist.spec.js 'whole playlist resolves'

# Deployment config must not reach the suite. Without this line every test
# inherits config.js's real endpoint and calls a live service, which reports
# the fake ids in those tests as gone — and a dead track will not play.
mut "deployment config leaks into the test suite" tests/helpers.js \
  '  await page.addInitScript(() => { window.MASH_CONFIG = { metaApi: "" }; });' \
  '  void 0;' \
  tests/playlist.spec.js 'hermetic against whatever config'

# ------------------------------------------------------ the daily resolve budget

mut 'the daily limit is not enforced at all' app.js \
  '    spendMeta(ids.length);' \
  '    void ids;' \
  tests/playlist.spec.js 'one unit of budget per id'

# NOT mutation-checked, deliberately: metaFromApi()'s own `{capped}` return.
# Both callers trim their batch to the remaining budget first, so it is a race
# guard for two resolvers in flight together — unreachable in a single one, and
# a mutation there reports MISSED because no test can interleave them. The
# distinction it protects IS covered, at the callers, by the two checks around
# this comment.

mut 'a capped run marks its waiting tracks failed' app.js \
  '    if (capped) {
      left.forEach((k) => metaPending.delete(k));' \
  '    if (false) {
      left.forEach((k) => metaPending.delete(k));' \
  tests/playlist.spec.js 'reported as waiting'

# The total-remaining readout. Added when its test stopped sleeping at a fixed
# 1200ms and started polling, to prove the rewrite still measures the sum rather
# than merely waiting for any number to appear.
mut 'total remaining counts the whole list, not what is still queued' app.js \
  '    for (let i = inQueue ? pos + 1 : 0; i < state.order.length; i++) {' \
  '    for (let i = 0; i < state.order.length; i++) {' \
  tests/transport.spec.js 'still queued'

# ------------------------------------------------- the peeling stage (QoL 10b)
#
# Expanded, the stage scrolls away with the page; it collapses and pins once half
# of it has gone behind the top bar. The peel and the pin are one mechanism — a
# sticky offset of --topbar-h minus --stage-peel — so most of these break the
# variable rather than any branch.

mut 'the stage pins immediately instead of scrolling away' app.js \
  '    pinnedEl.style.setProperty("--stage-peel",
      (WIDE.matches && !stageCollapsed ? stagePeel : 0) + "px");' \
  '    pinnedEl.style.setProperty("--stage-peel", "0px");' \
  tests/stage.spec.js 'only the collapsed one pins'

mut 'the collapsed stage never comes back under the bar' app.js \
  '    stageEl.classList.toggle("is-collapsed", want);
    applyPeel();' \
  '    stageEl.classList.toggle("is-collapsed", want);' \
  tests/stage.spec.js 'only the collapsed one pins'

mut 'the trigger is a fixed scroll distance, not half the stage' app.js \
  '      ? stagePeel > 0 && y >= stagePeel' \
  '      ? y > NARROW_COLLAPSE_Y' \
  tests/stage.spec.js 'half the expanded stage'

mut 'the peel follows the class onto narrow viewports' app.js \
  '    const want = WIDE.matches
      ? stagePeel > 0 && y >= stagePeel
      : (stageCollapsed ? y > 4 : y > NARROW_COLLAPSE_Y);' \
  '    const want = stagePeel > 0 && y >= stagePeel;' \
  tests/stage.spec.js 'does not pin on a narrow viewport'

# Reading the expanded height while collapsed returns the collapsed one, which
# puts the trigger at roughly a quarter of where it belongs. Only a resize that
# happens while collapsed reaches it.
mut 'the expanded height is measured while collapsed' app.js \
  '    stageEl.classList.remove("is-collapsed");
    const expanded = stageEl.getBoundingClientRect().height;' \
  '    const expanded = stageEl.getBoundingClientRect().height;' \
  tests/stage.spec.js 'resize that happens while collapsed'

# Chrome's voice defaults on a tab-audio track. Measured against a 120 Hz tone,
# leaving them on injected 70-80 dB of broadband noise into empty frequencies —
# a single low tone lit all 24 bands. Only the request is checkable here; the
# effect needs tools/live-capture-check.mjs, which is headed and run by hand.
mut 'the capture takes Chrome voice processing defaults' app.js \
  '          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,' \
  '          /* removed */' \
  tests/liveeq.spec.js 'not for a voice call'

# The stacked layout must undo the two-column height trick, or .stage-side
# collapses and .stage-meta's overflow:hidden clips the whole now-playing text.
mut 'the now-playing text collapses to nothing on a phone' app.css \
  '  .stage-side { grid-template-rows: auto 88px; height: auto; min-height: 0; }' \
  '  .stage-side { grid-template-rows: auto 88px; }' \
  tests/stage.spec.js 'visible on a phone'

# ------------------------------------------------- muting a preroll ad
#
# The signal is "the clock is running but the player has never reported
# PLAYING". Measured against three real ads: the embed reports the content's id
# and duration throughout and says nothing about the ad, so the previous
# id-comparison signal could never fire. These cover the replacement.

mut 'an inferred ad is not muted at all' app.js \
  '      yt.mute();
      adMuted = true;' \
  '      adMuted = true;' \
  tests/ads.spec.js 'clock running before the track starts'

mut 'the mute is never handed back' app.js \
  '    try { if (yt && yt.unMute && yt.isMuted && yt.isMuted()) yt.unMute(); } catch (e) {}' \
  '    try { void 0; } catch (e) {}' \
  tests/ads.spec.js 'handed back when the track itself starts'

# PLAYING is what says the preroll is over. Without disarming on it, the watch
# keeps running through the track and mutes ordinary playback.
mut 'the watch is never disarmed when the track starts' app.js \
  '    adAwaitingStart = 0;
    adClear();' \
  '    adClear();' \
  tests/ads.spec.js 'normal start is never muted'

# Time passing is not the signal; time passing ON THE CLOCK is. Without this a
# dead embed, which reports a clock of zero forever, reads as an ad.
mut 'a load that never starts is treated as an ad' app.js \
  '    if (!(t > AD_CLOCK)) { adPending = 0; return; }   // not started, or broken' \
  '    if (false) { adPending = 0; return; }' \
  tests/ads.spec.js 'never starts is not mistaken'

# Just after loadVideoById the clock can still be reporting the previous track.
mut 'a stale clock after a track change is trusted' app.js \
  '    if (Date.now() - adAwaitingStart < AD_GRACE) return;' \
  '    if (false) return;' \
  tests/ads.spec.js 'stale clock just after a track change'

mut "the reader's own mute is taken over" app.js \
  '      if (yt.isMuted && yt.isMuted()) return;' \
  '      if (false) return;' \
  tests/ads.spec.js 'reader made is left alone'

mut 'stopping mid-ad leaves the player muted forever' app.js \
  '    if (!state.playing && adTimer) { clearInterval(adTimer); adTimer = 0; adClear(); }' \
  '    if (!state.playing && adTimer) { clearInterval(adTimer); adTimer = 0; }' \
  tests/ads.spec.js 'hands the mute back'

# ------------------------------------------- giving up on a long ad
#
# The tolerance is the reader's, so both halves need cover: the stopwatch that
# decides when an ad has run too long, and the stepper that sets the number.

mut 'an ad runs as long as it likes' app.js \
  '    if (Date.now() - adSince >= adTol * 1000) adBail();' \
  '    void adBail;' \
  tests/ads.spec.js 'costs the track, not the reader'

mut 'the tolerance is ignored and every ad takes the track' app.js \
  '    if (Date.now() - adSince >= adTol * 1000) adBail();' \
  '    if (Date.now() - adSince >= 0) adBail();' \
  tests/ads.spec.js 'inside the tolerance is left to finish'

# The stopwatch has to start once. Restarted on every sample it never reaches
# the tolerance, which looks exactly like the feature being off.
mut 'the stopwatch restarts on every sample' app.js \
  '    if (!adSince) adSince = Date.now();' \
  '    adSince = Date.now();' \
  tests/ads.spec.js 'costs the track, not the reader'

# Pressing Next does not decay a track and neither does this: the song was
# never heard, and marking it played would delete it from the session.
mut 'the abandoned track is marked played' app.js \
  '    $("statNote").textContent = `skipped a track \u00b7 ad over ${adTol}s`;
    next();' \
  '    played.add(state.current.k);
    store.write(K_PLAYED, [...played]);
    next();' \
  tests/ads.spec.js 'costs the track, not the reader'

mut 'a single playable track is skipped onto itself' app.js \
  '    if (playable < 2) return;' \
  '    if (false) return;' \
  tests/ads.spec.js 'nowhere to go'

mut 'the steps move by one second, not five' app.js \
  '  if ($("adSkipDown")) $("adSkipDown").addEventListener("click", () => setAdTol(adTol - AD_TOL.step));' \
  '  if ($("adSkipDown")) $("adSkipDown").addEventListener("click", () => setAdTol(adTol - 1));' \
  tests/ads.spec.js 'steps by five'

mut 'the scale has no ends' app.js \
  '    return Math.min(AD_TOL.max, Math.max(AD_TOL.min, n));' \
  '    return n;' \
  tests/ads.spec.js 'off the scale is brought back'

mut 'a step at a limit still looks live' app.js \
  '    if (down) down.disabled = adTol <= AD_TOL.min;
    if (up) up.disabled = adTol >= AD_TOL.max;' \
  '    if (down) down.disabled = false;
    if (up) up.disabled = false;' \
  tests/ads.spec.js 'steps by five'

mut 'the tolerance is forgotten on reload' app.js \
  '    prefs.adSkip = adTol;
    store.write(K_PREF, prefs);' \
  '    prefs.adSkip = adTol;' \
  tests/ads.spec.js 'steps by five'

# ------------------------------------------------ the background-playback tip

mut 'the tip is shown at every width, not just on a phone' app.js \
  '    const want = !prefs.bgTipSeen && !WIDE.matches &&' \
  '    const want = !prefs.bgTipSeen &&' \
  tests/resume.spec.js 'not shown on a desktop-width viewport'

mut 'the tip is shown for SoundCloud, which never stops' app.js \
  '      state.playing && !!state.current && state.current.s === "YT";' \
  '      state.playing && !!state.current;' \
  tests/resume.spec.js 'stays away for a SoundCloud track'

mut 'dismissing the tip is forgotten on reload' app.js \
  '    prefs.bgTipSeen = true;
    store.write(K_PREF, prefs);' \
  '    prefs.bgTipSeen = true;' \
  tests/resume.spec.js 'dismissing the tip is permanent'

# Switching source changes the answer without changing whether anything plays,
# so the state.playing setter never fires and this is the only thing that paints.
mut 'switching from SoundCloud to YouTube leaves the tip hidden' app.js \
  '    /* Also here, not only from the state.playing setter: switching from a
       SoundCloud track to a YouTube one changes the answer without changing
       whether anything is playing, so the setter never fires. */
    paintBgTip();' \
  '    void 0;' \
  tests/resume.spec.js 'brings the tip up'

# ---------------------------------------------------------- the screen wake lock

mut 'the screen is held for the life of the page, not while playing' app.js \
  '    const want = state.playing && !document.hidden;' \
  '    const want = !document.hidden;' \
  tests/resume.spec.js 'nothing is held while nothing is playing'

# The lock is released the moment the page hides and is not handed back. A
# version that requests once looks correct until somebody leaves.
mut 'the lock is never re-taken after the page hides' app.js \
  '    syncWakeLock();
    if (document.hidden) {' \
  '    if (document.hidden) {' \
  tests/resume.spec.js 'taken again on return'

mut 'a lock the platform revoked is still believed held' app.js \
  '        wakeLock.addEventListener("release", () => { wakeLock = null; });' \
  '        void 0;' \
  tests/resume.spec.js 'takes back is not believed'

# state.playing is an accessor so this cannot be forgotten at one of seven
# assignment sites. Severing it is the same as forgetting all seven.
mut 'playing no longer drives the wake lock at all' app.js \
  '      playingFlag = v;
      syncWakeLock();' \
  '      playingFlag = v;' \
  tests/resume.spec.js 'held while a track plays'

# ------------------------------------------------------- resume on return
#
# The embed pauses itself when the page is hidden, on a phone. Nothing here can
# stop that; these cover what the app does about it.

mut 'coming back does not resume what the embed paused' app.js \
  '    if (yt.getPlayerState() === YT.PlayerState.PLAYING) return;   // never stopped
    yt.playVideo();' \
  '    if (yt.getPlayerState() === YT.PlayerState.PLAYING) return;   // never stopped' \
  tests/resume.spec.js 'resumed on return'

# Snapshotting at hide is what separates "the embed paused it" from "the reader
# paused it". Both look identical by the time the tab is visible again.
mut 'the reader pausing before they leave is forgotten' app.js \
  '      playingWhenHidden = state.playing && !!state.current;' \
  '      playingWhenHidden = true;' \
  tests/resume.spec.js 'stays paused'

# The mirrored flag depends on a PAUSED event surviving a backgrounded tab. The
# player is asked instead, so a resume only fires when something really stopped.
mut 'the player is trusted to have stopped rather than asked' app.js \
  '    if (yt.getPlayerState() === YT.PlayerState.PLAYING) return;   // never stopped' \
  '    if (false) return;' \
  tests/resume.spec.js 'never stopped is not restarted'

# ------------------------------------------------------------------- the pin
#
# Locking is the absence of the peel, so most of these break the same variable
# from a different direction.

mut 'the lock is ignored and scrolling still decides the mode' app.js \
  '    if (stageLocked && WIDE.matches) return;' \
  '    if (false) return;' \
  tests/stage.spec.js 'holds the expanded stage under the bar'

mut 'a pinned stage still peels away' app.js \
  '      (WIDE.matches && !stageCollapsed && !stageLocked ? stagePeel : 0) + "px");' \
  '      (WIDE.matches && !stageCollapsed ? stagePeel : 0) + "px");' \
  tests/stage.spec.js 'holds the expanded stage under the bar'

mut 'the lock follows onto viewports where nothing pins' app.js \
  '    if (stageLocked && WIDE.matches) return;' \
  '    if (stageLocked) return;' \
  tests/stage.spec.js 'not offered, or obeyed'

mut 'releasing the pin waits for the next scroll' app.js \
  '    applyPeel();
    /* Unlocking has to catch up with where the scroll already is: it can have
       run well past the trigger while the stage was held expanded, and without
       this the stage stays expanded until the next scroll event. */
    updateStageCollapse();
  });' \
  '    applyPeel();
  });' \
  tests/stage.spec.js 'catches up with the scroll position'

mut 'a pinned stage looks exactly like an unpinned one' app.css \
  '.np-pin[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); }' \
  '.np-pin[aria-pressed="true"] { border-color: var(--accent); }' \
  tests/stage.spec.js 'holds the expanded stage under the bar'

mut 'the pin is forgotten on reload' app.js \
  '    stageLocked = !stageLocked;
    prefs.stagePinned = stageLocked;
    store.write(K_PREF, prefs);' \
  '    stageLocked = !stageLocked;
    prefs.stagePinned = stageLocked;' \
  tests/stage.spec.js 'survives a reload'

print ""
if (( fails )); then print "$fails missed"; exit 1; else print "all caught"; fi
