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
  if [[ "$res" == *failed* ]]; then
    print -- "  CAUGHT   $name"
  else
    print -- "  MISSED   $name   <-- the test does not detect this"
    fails=$((fails + 1))
  fi
}

print "mutation checks (each should be CAUGHT)"

mut "#tTop ignores the sticky topbar height" app.js \
  'const y = window.scrollY + $("tracklist").getBoundingClientRect().top - bar;' \
  'const y = window.scrollY + $("tracklist").getBoundingClientRect().top;' \
  tests/transport.spec.js "jumps to the top"

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

print ""
if (( fails )); then print "$fails missed"; exit 1; else print "all caught"; fi
