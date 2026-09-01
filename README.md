# mashmusic

A jukebox for 1,257 mashups, mixes and edits that friends posted to Facebook
between 2012 and 2015, played back through embedded YouTube and SoundCloud.

The original was built in AngularJS 1.2 in January 2015 and lived at
`ryzzuh.github.io`. This repository is a static rebuild of it. The 2015 app is
kept intact in [`legacy/`](legacy/), and its full commit history — 30 commits
from January 2015 to March 2025 — is preserved in this repository's log.

## Running it

There is no build step. Any static file server will do:

```bash
python3 -m http.server 8412
```

Then open <http://localhost:8412>. Serve it over HTTP rather than opening
`index.html` off disk — YouTube's embed API is unreliable from a `file://`
origin.

## What it does

**Windowed track list.** The list renders 60 rows at a time and extends as you
scroll. Order is canonical; shuffle applies a permutation over positions
rather than re-sorting, so switching it off restores the original sequence
exactly.

**Three list visibility modes.** *Shown* is the default. *Obfuscated* pixelates
titles with an SVG `feTile` filter — this is cosmetic, and the text is still in
the DOM. *Hidden* never writes titles into the document at all; rows read
`0121 · YT · 7:41` until a track is played, which reveals just that row.

**A liveness store.** Roughly a quarter of the library no longer plays: sampling
found ~21% of YouTube IDs removed or private, ~3% with embedding disabled, and
~20% of SoundCloud tracks gone. The app records each verdict in `localStorage`
as it learns it, from the players' own error events — YouTube error 100 is
removed or private, 101 and 150 mean the owner disabled embedding — and skips
those tracks during autoplay instead of stalling on them. A track that simply
never starts is marked `stalled`: skipped by autoplay, but still clickable, so
a slow network doesn't permanently condemn it.

**Two themes.** *Jukebox* takes its palette from the original 2015 button
artwork — each transport control keeps its own colour, `#f8f078` is the pressed
state exactly as it was the "checked" state then, and `#283088`, the Next
button's indigo, is the body ink. *Night Dial* is a lit receiver dial: warm
amber on deep blue-black. The choice is stored locally and is independent of
your OS light/dark setting.

**Contributors panel.** The ⓘ beside the track count opens a ranked list of the
71 people who posted these tracks. Beau Garcia alone accounts for 330 of them.

## Layout

```
index.html            the player
app.css               both themes, as complete token sets
app.js                list, transport, liveness, players
data/tracks.js        1,257 tracks, loaded via <script> so file:// works
data/liveness.json    optional offline verdicts, merged on load
tools/                data pipeline and the liveness checker
legacy/               the 2015 AngularJS app, untouched
```

## Tools

**`tools/build-tracks.py`** regenerates `data/tracks.js` from
`legacy/data/data.json`. It drops 61 duplicate source+id pairs (1,318 rows in,
1,257 out) and normalises YouTube's ISO-8601 durations and SoundCloud's
milliseconds to plain seconds.

**`tools/check-liveness.mjs`** verifies IDs in bulk and writes
`data/liveness.json`, which the app merges on load without overwriting anything
it learned at runtime.

```bash
YOUTUBE_API_KEY=... node tools/check-liveness.mjs
```

Both endpoints are CORS-blocked from the browser, which is why this runs
offline; the YouTube key must not ship to the client in any case. YouTube's
`videos.list` accepts 50 IDs per request and costs 1 quota unit per call
regardless, so the whole library is about 19 units against a 10,000/day free
quota. SoundCloud closed public API registration in 2019, but its oEmbed
endpoint still resolves legacy numeric track IDs without a key — one request
per track.

The API key is optional. Without it the SoundCloud half is still checked, and
the app keeps learning from playback either way.

## Known limits

The equalizer you might expect next isn't possible over these players. Both are
cross-origin iframes, and Web Audio can only analyse a source the page owns — a
decoded buffer, a same-origin media element, or a `MediaStream`. Nothing
reaches inside a third-party iframe's audio. Capturing the tab with
`getDisplayMedia({audio: true})` does work, at the cost of a permission prompt
every session and Chrome-or-Edge only.
