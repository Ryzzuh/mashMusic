# mashmusic

A jukebox for 1,257 mashups, mixes and edits that friends posted to Facebook
between 2012 and 2015, played back through embedded YouTube and SoundCloud.

The original was built in AngularJS 1.2 in January 2015 and lived at
`ryzzuh.github.io`. This repository is a static rebuild of it. The 2015 app is
kept intact in [`legacy/`](legacy/), and its full commit history — 30 commits
from January 2015 to March 2025 — is preserved in this repository's log.

## Running it

There is no build step:

```bash
python3 tools/serve.py 8412
```

Then open <http://localhost:8412>. Use this rather than `python3 -m
http.server` — it maps `/mashMusic-eq/` to the sibling envelope checkout so
local paths match the published ones, and it disables caching so you are not
debugging a stale `app.js`. Serve over HTTP rather than opening `index.html`
off disk; YouTube's embed API is unreliable from a `file://` origin.

## What it does

**Windowed track list.** The list renders 60 rows at a time and extends as you
scroll. Order is canonical; shuffle applies a permutation over positions
rather than re-sorting, so switching it off restores the original sequence
exactly.

**Three list visibility modes.** *Shown* is the default. *Obfuscated* pixelates
titles with an SVG `feTile` filter — this is cosmetic, and the text is still in
the DOM. *Hidden* never writes titles into the document at all; rows read
`0121 · YT · 7:41` until a track is played, which reveals just that row.

**A liveness store.** A large share of the library no longer plays. Analysing
every YouTube id found ~34% unavailable — worse than the ~24% a 120-track
sample had predicted — and sampling put SoundCloud around 20%. The app records each verdict in `localStorage`
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

**A real spectrum analyser.** The equalizer follows the actual audio, which
takes some explaining: Web Audio cannot reach inside a cross-origin iframe, so
the page can never analyse YouTube's output while it plays. Instead the analysis
happens offline, once, and the result ships as data. `tools/build-envelopes.py`
streams each track, runs an STFT, and stores 24 log-spaced band levels 25 times
a second at 4 bits each — about 300 bytes per second of audio. At playback the
page reads that back in step with the player's own clock. No FFT runs in the
browser at all.

The envelopes live in a separate repository,
[mashMusic-eq](https://github.com/Ryzzuh/mashMusic-eq), published as its own
Pages site and fetched from `../mashMusic-eq/`. Tracks without one fall back to
a flat display and say so.

**Scrubber.** Draws its waveform from that same envelope, collapsed across all
bands into a fixed 2,048 buckets — deliberately not tied to the canvas width,
since a ResizeObserver can report a transient 1px measurement and rebuilding on
every resize meant one bad reading wiped the waveform for the rest of the track. Dragging previews without seeking; releasing commits it. The
waveform is a picture of the whole track, so it stays drawn at all times —
seeking does not make it stale. It binds to both players — `getCurrentTime` and
`seekTo` for YouTube, the widget's callback-style equivalents for SoundCloud.

**Contributors panel.** The ⓘ beside the track count opens a ranked list of the
71 people who posted these tracks. Beau Garcia alone accounts for 330 of them.

## Layout

```
index.html            the player
app.css               both themes, as complete token sets
app.js                list, transport, liveness, players
data/tracks.js        1,257 tracks, loaded via <script> so file:// works
data/liveness.json    optional offline verdicts, merged on load
tools/                data pipelines, liveness checker, dev server
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

**`tools/build-envelopes.py`** produces the spectral envelopes described above,
writing to the sibling `mashMusic-eq` checkout. It is resumable, skipping ids
that already have a file, and one dead track never stops the run.

```bash
uv run --python 3.12 --with yt-dlp --with av --with numpy \
    python tools/build-envelopes.py --workers 6
```

**`tools/serve.py`** is a static server for development. It differs from
`python3 -m http.server` in two ways that matter: it sends `Cache-Control:
no-store`, because the stdlib server sends none and browsers will happily serve
a stale `app.js` while you debug it; and it maps `/mashMusic-eq/` to the sibling
checkout, so local paths match the published ones exactly.

Both liveness endpoints are CORS-blocked from the browser, which is why this runs
offline; the YouTube key must not ship to the client in any case. YouTube's
`videos.list` accepts 50 IDs per request and costs 1 quota unit per call
regardless, so the whole library is about 19 units against a 10,000/day free
quota. SoundCloud closed public API registration in 2019, but its oEmbed
endpoint still resolves legacy numeric track IDs without a key — one request
per track.

The API key is optional. Without it the SoundCloud half is still checked, and
the app keeps learning from playback either way.

## Known limits

**Analysis is not live.** The spectrum is a recording of what the audio looked
like, replayed against the player's clock, so it is only as accurate as that
clock — which resolves to about a quarter second and is interpolated in between.
It cannot react to anything the analysis did not see, such as YouTube's own
volume normalisation.

It can, however, tell when it is being shown the wrong audio. `getDuration()`
reports whatever is actually loaded, so during an ad — or on a different upload
of the same video — it stops agreeing with the envelope's own length. When
content really is playing the two agree to within about 0.15 s, against ads of
5-30 s, so the test is not close. On a mismatch the spectrum flattens and says
so rather than animating to audio nobody is hearing, and the scrubber keeps the
content duration instead of rescaling itself to a 15-second pre-roll. The
waveform stays drawn throughout — it depicts the track, not what is currently
audible, so it remains true during an ad.

The tolerance is deliberately loose: envelope length comes from the audio
stream, which can legitimately run a few seconds past the reported video
duration. Across 633 envelopes the largest honest disagreement was 3.9 s, while
an ad differs by whole minutes. A mismatch must also survive two consecutive
polls, so one odd reading while the player re-buffers after a seek cannot
blank anything.

**Roughly a third of the library is gone.** The full analysis run found ~34% of
YouTube ids unavailable, which is worse than a 120-track sample had suggested
(~24%). Those tracks get no envelope and are skipped during autoplay.

**SoundCloud has no envelopes.** The pipeline is YouTube-only for now. The
scrubber still works there — it just stays in its plain style.

The genuinely live alternative, capturing the tab with
`getDisplayMedia({audio: true})`, does work, but costs a permission prompt every
session and is Chrome-or-Edge only. Precomputing is cheaper for the viewer and
needs nothing from them.
