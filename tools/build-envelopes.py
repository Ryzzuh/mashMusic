#!/usr/bin/env python3
"""Precompute spectral envelopes so the equalizer can follow embedded playback.

    uv run --python 3.12 --with yt-dlp --with av --with numpy \
        python tools/build-envelopes.py --limit 20

Web Audio cannot reach inside a cross-origin iframe, so the player can never
analyse YouTube's audio while it plays. This does the analysis ahead of time
and stores the result: 24 log-spaced band levels, 25 times a second, 4 bits
each — about 300 bytes per second of audio, or 122 KB for a typical track.

Audio is streamed and decoded in memory and never written to disk. The output
is a spectrum, not a recording, and cannot be inverted back into one.

Output goes to the sibling mashMusic-eq repo: <trackId>.bin per track, for
either source; plus index.json listing what exists.
Resumable — tracks with an existing .bin are skipped.

Format of a .bin, little-endian:

    offset  size  field
    0       4     magic "MEQ1"
    4       1     bands       (24)
    5       1     fps         (25)
    6       1     bits        (4)
    7       1     db_range    (60)
    8       4     frames      uint32
    12      4     reserved
    16      ...   frames x ceil(bands/2) bytes, two 4-bit levels per byte,
                  low nibble = even band. 0 = db_range below the track's
                  peak, 15 = at the peak.

Levels are stored untilted, so the page keeps control of tilt, attack and
release at playback time.
"""
import argparse
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import av
import numpy as np
import yt_dlp

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TRACKS = os.path.join(ROOT, "data", "tracks.js")
LIVENESS = os.path.join(ROOT, "data", "liveness.json")
OUTDIR = os.path.join(os.path.dirname(ROOT), "mashMusic-eq")

MAGIC = b"MEQ1"
BANDS = 24
FPS = 25
BITS = 4
DB_RANGE = 60.0
SR = 32000
WINDOW = 4096            # 7.8 Hz bins; 2048 leaves the lowest bands sharing bins
HOP = SR // FPS          # 1280 samples = exactly one frame, 3.2x overlap
F_LO, F_HI = 40.0, 16000.0
ABS_FLOOR_DB = -60.0     # keeps a silent track from being gained up to full scale

_print_lock = threading.Lock()


def log(*a):
    with _print_lock:
        print(*a, flush=True)


# ----------------------------------------------------------------- analysis

def band_edges():
    """Bin index ranges for BANDS log-spaced bands, matching app.js."""
    bin_hz = SR / WINDOW
    edges = []
    for i in range(BANDS):
        lo = F_LO * (F_HI / F_LO) ** (i / BANDS)
        hi = F_LO * (F_HI / F_LO) ** ((i + 1) / BANDS)
        b0 = max(1, int(round(lo / bin_hz)))
        b1 = max(b0 + 1, int(round(hi / bin_hz)))
        edges.append((b0, min(b1, WINDOW // 2)))
    return edges


EDGES = band_edges()
WIN = np.hanning(WINDOW).astype(np.float32)


def envelope(pcm):
    """mono float32 -> (frames, BANDS) uint8 of 4-bit levels."""
    n_frames = max(1, 1 + (len(pcm) - WINDOW) // HOP) if len(pcm) >= WINDOW else 1
    if len(pcm) < WINDOW:
        pcm = np.pad(pcm, (0, WINDOW - len(pcm)))

    # One strided view over the signal: no per-frame copying.
    frames = np.lib.stride_tricks.as_strided(
        pcm,
        shape=(n_frames, WINDOW),
        strides=(pcm.strides[0] * HOP, pcm.strides[0]),
        writeable=False,
    )

    out = np.empty((n_frames, BANDS), dtype=np.float32)
    # Chunked so peak memory stays flat on a three-hour DJ set.
    CHUNK = 2048
    for start in range(0, n_frames, CHUNK):
        block = frames[start:start + CHUNK] * WIN
        mag = np.abs(np.fft.rfft(block, axis=1))
        for i, (b0, b1) in enumerate(EDGES):
            out[start:start + len(block), i] = mag[:, b0:b1].max(axis=1)

    db = 20.0 * np.log10(np.maximum(out, 1e-10))
    # Per-track normalisation so quiet tracks still fill the display, floored so
    # that silence stays silent instead of being amplified to full scale.
    ref = max(float(db.max()), ABS_FLOOR_DB)
    level = (db - (ref - DB_RANGE)) / DB_RANGE       # 0..1 across the window
    np.clip(level, 0.0, 1.0, out=level)
    return np.rint(level * 15).astype(np.uint8)


def pack(levels):
    """(frames, BANDS) uint8 0..15 -> bytes, two bands per byte."""
    n_frames = levels.shape[0]
    lo = levels[:, 0::2]
    hi = levels[:, 1::2]
    if hi.shape[1] < lo.shape[1]:                     # odd band count
        hi = np.pad(hi, ((0, 0), (0, 1)))
    packed = (lo | (hi << 4)).astype(np.uint8)

    header = bytearray(16)
    header[0:4] = MAGIC
    header[4] = BANDS
    header[5] = FPS
    header[6] = BITS
    header[7] = int(DB_RANGE)
    header[8:12] = n_frames.to_bytes(4, "little")
    return bytes(header) + packed.tobytes()


# ------------------------------------------------------------------ fetching

def source_url(track):
    """yt-dlp resolves SoundCloud by its numeric api.soundcloud.com id, which is
    what the 2015 dataset stores. Permalinks from that era no longer resolve."""
    if track["s"] == "SC":
        return "https://api.soundcloud.com/tracks/" + track["i"]
    return "https://www.youtube.com/watch?v=" + track["i"]


def audio_url(track):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "format": "bestaudio/best",
        "skip_download": True,
        "noplaylist": True,
        "socket_timeout": 30,
    }
    with yt_dlp.YoutubeDL(opts) as y:
        info = y.extract_info(source_url(track), download=False)
    return info["url"], info


def decode(url):
    """Stream and decode to mono float32 at SR. Never touches disk."""
    container = av.open(url, timeout=30)
    try:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=SR)
        chunks = []
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray()[0].copy())
        for out in resampler.resample(None):          # flush
            chunks.append(out.to_ndarray()[0].copy())
    finally:
        container.close()
    if not chunks:
        raise RuntimeError("no audio frames decoded")
    return np.concatenate(chunks)


def process(track, force=False):
    vid = track["i"]
    dest = os.path.join(OUTDIR, vid + ".bin")
    if os.path.exists(dest) and not force:
        return ("skip", vid, 0.0, os.path.getsize(dest))

    t0 = time.time()
    url, _info = audio_url(track)
    pcm = decode(url)
    blob = pack(envelope(pcm))

    tmp = dest + ".part"
    with open(tmp, "wb") as f:
        f.write(blob)
    os.replace(tmp, dest)
    return ("ok", vid, time.time() - t0, len(blob))


# ---------------------------------------------------------------------- main

def load_tracks():
    src = open(TRACKS).read()
    return json.loads(src[src.index("["):src.rindex("]") + 1])


def load_dead():
    try:
        with open(LIVENESS) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return set()
    return {k for k, v in data.items() if v.get("s") in ("gone", "blocked")}


def write_index():
    ids = sorted(
        f[:-4] for f in os.listdir(OUTDIR)
        if f.endswith(".bin") and not f.endswith(".part")
    )
    with open(os.path.join(OUTDIR, "index.json"), "w") as f:
        json.dump({"bands": BANDS, "fps": FPS, "bits": BITS,
                   "dbRange": int(DB_RANGE), "ids": ids}, f, separators=(",", ":"))
    return len(ids)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="stop after N new tracks")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--force", action="store_true", help="rebuild existing")
    ap.add_argument("--only", nargs="*", help="specific track ids")
    ap.add_argument("--source", choices=["YT", "SC"], help="limit to one source")
    args = ap.parse_args()

    os.makedirs(OUTDIR, exist_ok=True)
    dead = load_dead()

    tracks = [t for t in load_tracks()
              if not args.source or t["s"] == args.source]
    if args.only:
        wanted = set(args.only)
        tracks = [t for t in tracks if t["i"] in wanted]
    else:
        tracks = [t for t in tracks if t["k"] not in dead]
        if not args.force:
            tracks = [t for t in tracks
                      if not os.path.exists(os.path.join(OUTDIR, t["i"] + ".bin"))]
        if args.limit:
            tracks = tracks[:args.limit]

    if not tracks:
        log("nothing to do —", write_index(), "envelopes already present")
        return 0

    log("analysing %d tracks with %d workers (%d known-dead skipped)"
        % (len(tracks), args.workers, len(dead)))

    done = fail = 0
    total_bytes = 0
    times = []
    t0 = time.time()

    def run(t):
        nonlocal done, fail, total_bytes
        try:
            status, vid, secs, size = process(t, args.force)
        except Exception as e:                        # one bad track must not stop the run
            fail += 1
            log("  FAIL %-12s %s: %s" % (t["i"], type(e).__name__, str(e)[:90]))
            return
        done += 1
        total_bytes += size
        if status == "ok":
            times.append(secs)
            log("  %4d/%d  %-12s %6.1fs  %6.1f KB  %s"
                % (done, len(tracks), vid, secs, size / 1024, t["t"][:44]))

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(run, tracks))

    elapsed = time.time() - t0
    count = write_index()
    log("")
    log("done: %d ok, %d failed in %.1f min" % (done, fail, elapsed / 60))
    if times:
        log("per track: %.1fs mean, %.1fs median (wall %.2fs/track at %d workers)"
            % (sum(times) / len(times), sorted(times)[len(times) // 2],
               elapsed / max(1, done), args.workers))
    log("wrote %.1f MB this run; %d envelopes now present"
        % (total_bytes / 1024 / 1024, count))
    return 0


if __name__ == "__main__":
    sys.exit(main())
