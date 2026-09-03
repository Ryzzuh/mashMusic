/* mashmusic — prototype
 *
 * Three things this prototype is actually testing:
 *   1. Windowed, in-order rendering of the full 1,257-track list.
 *   2. A liveness store, so IDs that YouTube or SoundCloud have lost are
 *      never attempted twice.
 *   3. Two selectable skins over one layout.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const CHUNK = 60;

  const TRACKS = (window.MASH_TRACKS || []).map((t, i) => ({ ...t, n: i + 1 }));

  // ------------------------------------------------------------------ stores

  const store = {
    read(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
      } catch (e) { return fallback; }
    },
    write(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
    }
  };

  const K_LIVE = "mash.liveness.v1";
  const K_FAV  = "mash.favs.v1";
  const K_PREF = "mash.prefs.v1";

  /* Liveness: { "YT:xyz": { s: "gone"|"blocked"|"stalled"|"ok", c: <code>, t: <epoch> } }
   * Seeded at runtime from the players' own error events. An offline batch
   * check (tools/check-liveness.mjs) can drop a data/liveness.json alongside
   * this, which is merged in on load — the two sources never disagree, since
   * the offline file only ever adds IDs the app has not tried yet. */
  const liveness = store.read(K_LIVE, {});
  const favs = new Set(store.read(K_FAV, []));
  const prefs = Object.assign({ skin: "jukebox", listMode: "show" }, store.read(K_PREF, {}));

  /* "gone" and "blocked" are verdicts — the platform told us. "stalled" is a
   * suspicion raised by the watchdog, which a slow network can also trigger,
   * so it only removes a track from auto-advance; clicking it still tries
   * again, and a successful play clears the record. */
  const isDead = (t) => {
    const rec = liveness[t.k];
    return !!rec && (rec.s === "gone" || rec.s === "blocked");
  };

  const isSkippable = (t) => isDead(t) || liveness[t.k]?.s === "stalled";

  function markLiveness(track, status, code) {
    liveness[track.k] = { s: status, c: code ?? null, t: Date.now() };
    store.write(K_LIVE, liveness);
    const row = rowFor(track.k);
    if (row) decorateRow(row, track);
    paintStatus();
  }

  async function mergeOfflineLiveness() {
    try {
      const res = await fetch("data/liveness.json", { cache: "no-store" });
      if (!res.ok) return;
      const remote = await res.json();
      let added = 0;
      for (const [k, rec] of Object.entries(remote)) {
        if (!liveness[k]) { liveness[k] = rec; added++; }
      }
      if (added) {
        store.write(K_LIVE, liveness);
        render(true);
        $("statNote").textContent = added + " from offline check";
      }
    } catch (e) {
      /* no sidecar, or running from file:// — the runtime store stands alone */
    }
  }

  // ------------------------------------------------------------------- view

  const state = {
    query: "",
    favsOnly: false,
    shuffle: false,
    listMode: prefs.listMode,
    view: [],
    order: [],       // indices into view; identity unless shuffled
    shown: 0,
    current: null,   // track object
    playing: false
  };

  function buildView() {
    const q = state.query.trim().toLowerCase();
    state.view = TRACKS.filter((t) => {
      if (state.favsOnly && !favs.has(t.k)) return false;
      if (!q) return true;
      return t.t.toLowerCase().includes(q) || t.v.toLowerCase().includes(q);
    });
    state.order = state.view.map((_, i) => i);
    if (state.shuffle) shuffleOrder();
    state.shown = 0;
  }

  function shuffleOrder() {
    // A permutation over positions, so the canonical order is never destroyed.
    for (let i = state.order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.order[i], state.order[j]] = [state.order[j], state.order[i]];
    }
  }

  // ---------------------------------------------------------------- rendering

  const listEl = $("tracklist");
  const rowIndex = new Map();
  const rowFor = (key) => rowIndex.get(key);

  function fmtDur(s) {
    if (!s) return "--:--";
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`;
  }

  function buildRow(track) {
    const li = document.createElement("li");
    li.className = "trow";
    li.dataset.key = track.k;

    const fav = document.createElement("button");
    fav.className = "t-fav";
    fav.type = "button";
    fav.title = "Favourite";
    fav.setAttribute("aria-pressed", String(favs.has(track.k)));
    fav.innerHTML = '<svg><use href="#i-heart"></use></svg>';
    fav.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFav(track, fav);
    });

    const idx = document.createElement("span");
    idx.className = "t-index";
    idx.textContent = String(track.n).padStart(4, "0");

    const main = document.createElement("div");
    main.className = "t-main";
    const name = document.createElement("span");
    name.className = "t-name";
    const via = document.createElement("span");
    via.className = "t-via";

    // "hide" keeps the title out of the document entirely, so it survives
    // devtools and select-all. "blur" is cosmetic by design.
    if (state.listMode === "hide") {
      name.classList.add("is-redacted");
      name.textContent = "Track " + String(track.n).padStart(4, "0");
      via.textContent = "";
    } else {
      name.textContent = track.t;
      via.textContent = track.v ? "via " + track.v : "";
    }
    main.append(name, via);

    const src = document.createElement("span");
    src.className = "t-src";
    src.textContent = track.s;

    const dur = document.createElement("span");
    dur.className = "t-dur";
    dur.textContent = fmtDur(track.d);

    li.append(fav, idx, main, src, dur);
    li.addEventListener("click", () => play(track));

    decorateRow(li, track);
    rowIndex.set(track.k, li);
    return li;
  }

  function decorateRow(li, track) {
    const rec = liveness[track.k];
    const dead = isDead(track);
    li.classList.toggle("is-dead", dead);
    li.classList.toggle("is-suspect", !dead && rec?.s === "stalled");
    li.title = dead
      ? "Unavailable — " + (rec.s === "blocked" ? "embedding disabled" : "removed or private")
      : rec?.s === "stalled" ? "Did not start last time — click to retry" : "";
  }

  function revealRow(li, track) {
    if (state.listMode !== "hide") return;
    const name = li.querySelector(".t-name");
    const via = li.querySelector(".t-via");
    name.classList.remove("is-redacted");
    name.textContent = track.t;
    via.textContent = track.v ? "via " + track.v : "";
  }

  function renderChunk() {
    const frag = document.createDocumentFragment();
    const end = Math.min(state.shown + CHUNK, state.order.length);
    for (let i = state.shown; i < end; i++) {
      frag.appendChild(buildRow(state.view[state.order[i]]));
    }
    state.shown = end;
    listEl.appendChild(frag);
    $("listEnd").hidden = state.shown < state.order.length;
    paintStatus();
  }

  function render(rebuild) {
    // A mode or skin change must not throw away how far the reader had got,
    // so re-render up to the same depth rather than back to the first chunk.
    const depth = rebuild ? 0 : state.shown;
    if (rebuild) buildView();
    listEl.innerHTML = "";
    rowIndex.clear();
    state.shown = 0;
    listEl.className = "tracklist mode-" + state.listMode;
    do { renderChunk(); }
    while (state.shown < depth && state.shown < state.order.length);
    if (state.current) markCurrentRow(state.current);
  }

  const sentinel = $("sentinel");
  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && state.shown < state.order.length) {
      renderChunk();
    }
  }, { rootMargin: "600px 0px" }).observe(sentinel);

  function paintStatus() {
    const deadCount = state.view.reduce((n, t) => n + (isSkippable(t) ? 1 : 0), 0);
    $("statLoaded").textContent =
      `showing ${state.shown} / ${state.order.length}` +
      (state.order.length !== TRACKS.length ? ` (of ${TRACKS.length})` : "");
    $("statDead").textContent = deadCount ? `${deadCount} unavailable` : "";
    $("brandCount").textContent = `${TRACKS.length} tracks`;
  }

  // ------------------------------------------------------------------ favs

  function toggleFav(track, btn) {
    if (favs.has(track.k)) favs.delete(track.k); else favs.add(track.k);
    btn.setAttribute("aria-pressed", String(favs.has(track.k)));
    store.write(K_FAV, [...favs]);
    if (state.favsOnly) render(true);
  }

  // ---------------------------------------------------------------- players

  let yt = null, ytReady = false;
  let sc = null, scReady = false;
  let watchdog = 0;

  window.onYouTubeIframeAPIReady = () => {
    yt = new YT.Player("ytPlayer", {
      host: "https://www.youtube-nocookie.com",
      playerVars: { rel: 0, playsinline: 1, modestbranding: 1 },
      events: {
        onReady: () => { ytReady = true; },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED) next();
          if (e.data === YT.PlayerState.PLAYING) {
            clearTimeout(watchdog);
            state.playing = true;
            anchorClock();
            if (state.current) markLivenessOk(state.current);
          }
          if (e.data === YT.PlayerState.PAUSED) { state.playing = false; anchorClock(); }
        },
        onError: (e) => {
          clearTimeout(watchdog);
          const code = e.data;
          const status = code === 100 ? "gone" : (code === 101 || code === 150) ? "blocked" : "error";
          if (state.current) {
            markLiveness(state.current, status, code);
            flagCurrent(status);
            if (status !== "error") setTimeout(next, 600);
          }
        }
      }
    });
  };

  function loadScript(src) {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    document.head.appendChild(s);
  }

  const scTrackUrl = (id) => "https://api.soundcloud.com/tracks/" + id;

  const scWidgetUrl = (id) =>
    "https://w.soundcloud.com/player/?url=" + encodeURIComponent(scTrackUrl(id)) +
    "&auto_play=true&visual=false&hide_related=true&show_comments=false&show_artwork=false&color=%2328b0c0";

  /* SC.Widget() can only attach to an iframe that is already pointed at a
   * widget URL, so the first SoundCloud track is played by setting src and
   * binding afterwards; every later one goes through load(), which keeps the
   * existing event bindings alive. */
  function scFrame() {
    return $("slotSC").querySelector("iframe");
  }

  function bindSC() {
    const frame = scFrame();
    if (sc || !window.SC || !frame) return;
    sc = SC.Widget(frame);
    const E = SC.Widget.Events;
    sc.bind(E.READY, () => { scReady = true; });
    sc.bind(E.PLAY, () => {
      clearTimeout(watchdog);
      state.playing = true;
      if (state.current) markLivenessOk(state.current);
    });
    sc.bind(E.PAUSE, () => { state.playing = false; });
    sc.bind(E.FINISH, () => next());
    if (E.ERROR) {
      sc.bind(E.ERROR, () => {
        clearTimeout(watchdog);
        if (state.current) {
          markLiveness(state.current, "gone", null);
          flagCurrent("gone");
          setTimeout(next, 600);
        }
      });
    }
  }

  function playSC(track) {
    showSlot("SC");
    if (sc && scReady) {
      sc.load(scTrackUrl(track.i), { auto_play: true });
      return;
    }
    let frame = scFrame();
    if (!frame) {
      frame = document.createElement("iframe");
      frame.title = "SoundCloud player";
      frame.allow = "autoplay";
      frame.scrolling = "no";
      $("slotSC").appendChild(frame);
    }
    frame.src = scWidgetUrl(track.i);
    const poll = setInterval(() => {
      if (window.SC) { clearInterval(poll); bindSC(); }
    }, 120);
  }

  function markLivenessOk(track) {
    const rec = liveness[track.k];
    if (rec && rec.s === "ok") return;
    liveness[track.k] = { s: "ok", c: null, t: Date.now() };
    store.write(K_LIVE, liveness);
    const row = rowFor(track.k);
    if (row) decorateRow(row, track);
  }

  function flagCurrent(status) {
    const kind = status === "stalled" ? "warn" : "dead";
    const label = status === "blocked" ? "Embedding disabled"
                : status === "gone" ? "Removed or private"
                : status === "stalled" ? "Did not start — skipped in autoplay"
                : "Playback error";
    $("npFlags").innerHTML = `<span class="flag flag-${kind}">${label}</span>`;
  }

  /* Cover art. We hold a thumbnail url for 1,248 of the 1,257 tracks, but the
   * stored ones are small — YouTube's default.jpg is 120x90, SoundCloud's
   * -large.jpg is 100px. Both have bigger variants at predictable urls, so ask
   * for those first and fall back to the stored one. */
  function artUrl(track) {
    if (track.s === "YT") return "https://i.ytimg.com/vi/" + track.i + "/hqdefault.jpg";
    if (track.a) return track.a.replace(/-large\.jpg$/, "-t500x500.jpg");
    return "";
  }

  function setArtwork(track) {
    const panel = $("artPanel"), img = $("artImg");
    const first = track ? artUrl(track) : "";
    if (!first) { panel.hidden = true; img.removeAttribute("src"); return; }

    const stored = track.a && track.a !== first ? track.a : null;
    let triedStored = false;

    img.onload = () => {
      // YouTube answers 200 with a 120x90 grey placeholder for videos it has
      // lost, so size is the only way to tell a real thumbnail from a stub.
      if (img.naturalWidth && img.naturalWidth < 200) {
        if (stored && !triedStored) { triedStored = true; img.src = stored; return; }
        panel.hidden = true;
        return;
      }
      panel.hidden = false;
    };
    img.onerror = () => {
      if (stored && !triedStored) { triedStored = true; img.src = stored; return; }
      panel.hidden = true;
      img.removeAttribute("src");
    };

    img.src = first;
  }

  function showSlot(which) {
    $("slotYT").hidden = which !== "YT";
    $("slotSC").hidden = which !== "SC";
    $("slotIdle").hidden = which !== "idle";
  }

  function play(track) {
    if (isDead(track)) return;
    state.current = track;
    state.playing = true;

    $("npSource").textContent = track.s === "YT" ? "YouTube" : "SoundCloud";
    $("npTitle").textContent = track.t;
    $("npSub").textContent = [track.v ? "via " + track.v : "", track.c, fmtDur(track.d)]
      .filter(Boolean).join("  ·  ");
    $("npFlags").innerHTML = "";

    markCurrentRow(track);
    setArtwork(track);
    loadEnvelope(track);

    clearTimeout(watchdog);
    // If nothing has started within 9s, the embed is silently broken.
    watchdog = setTimeout(() => {
      if (state.current === track) {
        markLiveness(track, "stalled", null);
        flagCurrent("stalled");
      }
    }, 9000);

    if (track.s === "YT") {
      showSlot("YT");
      if (yt && ytReady) yt.loadVideoById(track.i);
      else pendingYT = track.i;
      if (sc && scReady) sc.pause();
    } else {
      playSC(track);
      if (yt && ytReady) yt.pauseVideo();
    }
  }

  let pendingYT = null;

  function markCurrentRow(track) {
    listEl.querySelectorAll('.trow[aria-current="true"]').forEach((r) => r.removeAttribute("aria-current"));
    const row = rowFor(track.k);
    if (row) {
      row.setAttribute("aria-current", "true");
      revealRow(row, track);
    }
  }

  // ------------------------------------------------------------- transport

  function positionOf(track) {
    if (!track) return -1;
    const viewIdx = state.view.findIndex((t) => t.k === track.k);
    return viewIdx < 0 ? -1 : state.order.indexOf(viewIdx);
  }

  function step(delta) {
    if (!state.order.length) return;
    let pos = positionOf(state.current);
    if (pos < 0) pos = delta > 0 ? -1 : 0;
    for (let i = 0; i < state.order.length; i++) {
      pos = (pos + delta + state.order.length) % state.order.length;
      const candidate = state.view[state.order[pos]];
      if (!isSkippable(candidate)) {
        // Make sure the row exists before we try to highlight it.
        while (state.shown <= pos && state.shown < state.order.length) renderChunk();
        play(candidate);
        return;
      }
    }
  }

  const next = () => step(1);
  const prev = () => step(-1);

  $("bNext").addEventListener("click", next);
  $("bPrev").addEventListener("click", prev);

  $("bPlay").addEventListener("click", () => {
    if (!state.current) { next(); return; }
    if (state.current.s === "YT" && ytReady) yt.playVideo();
    if (state.current.s === "SC" && scReady) sc.play();
    state.playing = true;
  });

  $("bPause").addEventListener("click", () => {
    if (ytReady) yt.pauseVideo();
    if (scReady) sc.pause();
    state.playing = false;
  });

  $("bStop").addEventListener("click", () => {
    clearTimeout(watchdog);
    if (ytReady) yt.stopVideo();
    if (scReady) { sc.pause(); sc.seekTo(0); }
    state.playing = false;
    state.current = null;
    listEl.querySelectorAll('.trow[aria-current="true"]').forEach((r) => r.removeAttribute("aria-current"));
    showSlot("idle");
    setArtwork(null);
    eqData = null;
    clockAnchor = null;
    mediaDuration = 0;
    scrubWave = null;
    scrubDrag = null;
    lastTimeLabel = "";
    setEqTag("no envelope", false);
    $("npSource").textContent = "—";
    $("npTitle").textContent = "Nothing playing";
    $("npSub").textContent = TRACKS.length.toLocaleString() + " tracks, posted by friends between 2012 and 2015.";
    $("npFlags").innerHTML = "";
  });

  $("bRandom").addEventListener("click", (e) => {
    state.shuffle = !state.shuffle;
    e.currentTarget.setAttribute("aria-pressed", String(state.shuffle));
    render(true);
  });

  $("bFavs").addEventListener("click", (e) => {
    state.favsOnly = !state.favsOnly;
    e.currentTarget.setAttribute("aria-pressed", String(state.favsOnly));
    render(true);
  });

  // ---------------------------------------------------------- equalizer
  //
  // Web Audio cannot reach inside the YouTube iframe, so nothing here
  // analyses audio. tools/build-envelopes.py did that offline; this reads
  // the result back in step with the player's own clock.

  const eqCanvas = $("eqScope");
  const eqCtx = eqCanvas.getContext("2d");

  // Envelopes live in the sibling mashMusic-eq repo, published as its own Pages
  // site. "../" resolves to /mashMusic-eq/ both from /mashMusic/ in production
  // and from / on a local server, since browsers clamp ".." at the root.
  const EQ_BASE = "../mashMusic-eq/";

  const EQ_TILT = 2.6;              // dB per octave above 200 Hz
  const EQ_ATTACK = 0.55;
  const EQ_RELEASE = 0.11;

  let eqIndex = null;               // ids that have an envelope
  let eqData = null;                // decoded header + body of the current track
  let eqToken = 0;                  // guards against a slow fetch landing late
  let eqLevels = null, eqPeaks = null, eqPeakVel = null, eqHold = null;
  let clockAnchor = null;           // { media, wall } — re-taken 4x a second
  let mediaDuration = 0;
  // True when the player is playing something other than the track we analysed
  // — an ad, or a different upload. getDuration() reports whatever is actually
  // loaded, so it stops matching the envelope's own length.
  let contentMismatch = false;
  // Generous by design: across 633 envelopes the largest honest disagreement
  // with the real duration was 3.9 s, while an ad differs by whole minutes.
  const contentTolerance = (secs) => Math.max(5, secs * 0.02);
  let mismatchStrikes = 0;
  let eqRaf = 0, eqLastT = 0;

  // Scrubber. Its waveform is the same envelope the spectrum reads, collapsed
  // across bands. It is a picture of the whole track, so it stays drawn at all
  // times — seeking does not make it stale.
  const scrubCanvas = $("scrubber");
  const sCtx = scrubCanvas.getContext("2d");
  let scrubW = 0, scrubH = 0;
  let scrubWave = null;             // per-pixel peak, or null for the plain style
  let scrubDrag = null;             // seconds while dragging, else null
  let lastTimeLabel = "";

  // Same geometric spacing the analyser used, for the tilt curve.
  function bandCentres(n, fLo, fHi) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lo = fLo * Math.pow(fHi / fLo, i / n);
      const hi = fLo * Math.pow(fHi / fLo, (i + 1) / n);
      out[i] = Math.sqrt(lo * hi);
    }
    return out;
  }
  let eqCentres = bandCentres(24, 40, 16000);

  let EQC = {};
  function readEqColors() {
    const cs = getComputedStyle(document.documentElement);
    const rgb = (name, fb) => {
      const m = /^#([0-9a-f]{6})$/i.exec(cs.getPropertyValue(name).trim());
      if (!m) return fb;
      const h = m[1];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    };
    EQC = {
      lo: rgb("--eq-lo", [80, 192, 176]),
      mid: rgb("--eq-mid", [72, 192, 224]),
      hi: rgb("--eq-hi", [240, 144, 24]),
      grid: (cs.getPropertyValue("--line").trim() || "#d8dcef"),
      cap: (cs.getPropertyValue("--ink-3").trim() || "#8f95b8")
    };
  }
  readEqColors();
  new MutationObserver(() => { readEqColors(); readScrubColors(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });

  function eqRamp(v) {
    const a = v < 0.6 ? EQC.lo : EQC.mid;
    const b = v < 0.6 ? EQC.mid : EQC.hi;
    const u = v < 0.6 ? v / 0.6 : Math.min(1, (v - 0.6) / 0.4);
    return "rgb(" + Math.round(a[0] + (b[0] - a[0]) * u) + ","
                  + Math.round(a[1] + (b[1] - a[1]) * u) + ","
                  + Math.round(a[2] + (b[2] - a[2]) * u) + ")";
  }

  let eqW = 0, eqH = 0;
  function eqResize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = eqCanvas.getBoundingClientRect();
    eqW = Math.max(1, Math.round(r.width));
    eqH = Math.max(1, Math.round(r.height));
    eqCanvas.width = Math.round(eqW * dpr);
    eqCanvas.height = Math.round(eqH * dpr);
    eqCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(eqResize).observe(eqCanvas);

  function setEqTag(text, live) {
    const el = $("eqTag");
    el.textContent = text;
    el.classList.toggle("live", !!live);
  }

  async function loadEqIndex() {
    try {
      const res = await fetch(EQ_BASE + "index.json", { cache: "no-store" });
      if (!res.ok) return;
      const meta = await res.json();
      eqIndex = new Set(meta.ids || []);
      if (meta.bands) eqCentres = bandCentres(meta.bands, 40, 16000);
    } catch (e) {
      /* no envelopes published yet — the strip just stays idle */
    }
  }

  function allocBands(n) {
    if (!eqLevels || eqLevels.length !== n) {
      eqLevels = new Float32Array(n);
      eqPeaks = new Float32Array(n);
      eqPeakVel = new Float32Array(n);
      eqHold = new Float32Array(n);
    }
  }

  async function loadEnvelope(track) {
    const token = ++eqToken;
    eqData = null;
    clockAnchor = null;
    mediaDuration = 0;
    contentMismatch = false;
    mismatchStrikes = 0;
    scrubWave = null;
    scrubDrag = null;
    lastTimeLabel = "";

    if (!track || !eqIndex || !eqIndex.has(track.i)) {
      setEqTag("no envelope", false);
      return;
    }
    setEqTag("loading", false);
    try {
      const res = await fetch(EQ_BASE + track.i + ".bin");
      if (!res.ok) throw new Error(res.status);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (token !== eqToken) return;                     // superseded by a newer track

      if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== "MEQ1") {
        throw new Error("bad magic");
      }
      const bands = buf[4], fps = buf[5], frames =
        buf[8] | (buf[9] << 8) | (buf[10] << 16) | (buf[11] << 24);
      const stride = (bands + 1) >> 1;

      eqData = { bands, fps, frames, stride, seconds: frames / fps,
                 body: buf.subarray(16) };
      allocBands(bands);
      eqCentres = bandCentres(bands, 40, 16000);
      buildScrubWave();
      setEqTag(bands + " bands · " + fps + " fps", true);
    } catch (e) {
      eqData = null;
      setEqTag("no envelope", false);
    }
  }

  // The player's clock only resolves to about a quarter second, so sample it
  // periodically and run a local clock in between.
  function anchorClock() {
    const track = state.current;
    if (!track) return;
    const ok = (v) => typeof v === "number" && isFinite(v) && v >= 0;
    try {
      if (track.s === "YT" && yt && ytReady) {
        const pos = yt.getCurrentTime(), dur = yt.getDuration();
        if (ok(dur) && dur > 0 && eqData) {
          const was = contentMismatch;
          const off = Math.abs(dur - eqData.seconds) > contentTolerance(eqData.seconds);
          mismatchStrikes = off ? mismatchStrikes + 1 : 0;
          contentMismatch = mismatchStrikes >= 2;
          if (contentMismatch !== was) {
            setEqTag(contentMismatch
              ? "paused — ad or different cut"
              : eqData.bands + " bands · " + eqData.fps + " fps", !contentMismatch);
          }
        }
        if (ok(pos)) clockAnchor = { media: pos, wall: performance.now() };
        // Hold the content duration through an ad so the scrubber does not
        // rescale itself to a 15-second pre-roll.
        if (ok(dur) && dur > 0 && !contentMismatch) mediaDuration = dur;
      } else if (track.s === "SC" && sc && scReady) {
        // The widget answers by callback rather than return value.
        sc.getPosition((ms) => {
          if (ok(ms)) clockAnchor = { media: ms / 1000, wall: performance.now() };
        });
        sc.getDuration((ms) => { if (ok(ms) && ms > 0) mediaDuration = ms / 1000; });
      }
    } catch (e) { /* player not ready yet */ }
  }

  // Player-reported duration when we have it, dataset duration until then.
  function currentDuration() {
    return mediaDuration || (state.current ? state.current.d : 0) || 0;
  }

  function seekMedia(seconds) {
    const track = state.current;
    if (!track) return;
    const dur = currentDuration();
    const target = Math.max(0, dur ? Math.min(dur, seconds) : seconds);

    if (track.s === "YT" && yt && ytReady) yt.seekTo(target, true);
    else if (track.s === "SC" && sc && scReady) sc.seekTo(target * 1000);
    else return;

    // Move the clock immediately rather than waiting for the next poll, so the
    // spectrum resumes from the right place instead of replaying stale frames.
    clockAnchor = { media: target, wall: performance.now() };
  }
  setInterval(anchorClock, 250);

  function mediaTime() {
    if (!clockAnchor) return 0;
    if (!state.playing) return clockAnchor.media;
    return clockAnchor.media + (performance.now() - clockAnchor.wall) / 1000;
  }

  // Two frames either side of the playhead, linearly blended.
  function sampleEnvelope(seconds, out) {
    const { bands, fps, frames, stride, body } = eqData;
    const pos = seconds * fps;
    let i0 = Math.floor(pos);
    if (i0 < 0) i0 = 0;
    if (i0 > frames - 1) i0 = frames - 1;
    const i1 = Math.min(frames - 1, i0 + 1);
    const mix = Math.min(1, Math.max(0, pos - i0));
    const o0 = i0 * stride, o1 = i1 * stride;

    for (let i = 0; i < bands; i++) {
      const shift = (i & 1) ? 4 : 0;
      const a = ((body[o0 + (i >> 1)] >> shift) & 0x0F) / 15;
      const b = ((body[o1 + (i >> 1)] >> shift) & 0x0F) / 15;
      let v = a + (b - a) * mix;
      // stored untilted: 1.0 is the track peak, 0 is 60 dB below it
      const db = (v - 1) * 60 + EQ_TILT * Math.log2(Math.max(eqCentres[i], 40) / 200);
      v = db / 60 + 1;
      out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }

  let SCOL = {};
  function readScrubColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, fb) => cs.getPropertyValue(n).trim() || fb;
    SCOL = {
      track: v("--line", "#d8dcef"),
      played: v("--accent", "#28b0c0"),
      head: v("--ink", "#161a22"),
      ahead: v("--line-hard", "#b6bcdd")
    };
  }
  readScrubColors();

  function scrubResize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = scrubCanvas.getBoundingClientRect();
    scrubW = Math.max(1, Math.round(r.width));
    scrubH = Math.max(1, Math.round(r.height));
    scrubCanvas.width = Math.round(scrubW * dpr);
    scrubCanvas.height = Math.round(scrubH * dpr);
    sCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(scrubResize).observe(scrubCanvas);

  // Collapse the envelope to a fixed number of buckets. Deliberately not tied
  // to the canvas width: a ResizeObserver can deliver a transient zero-width
  // measurement, and rebuilding on every resize meant one bad reading wiped the
  // waveform for the rest of the track.
  const WAVE_BUCKETS = 2048;

  function buildScrubWave() {
    if (!eqData) { scrubWave = null; return; }
    const { bands, frames, stride, body } = eqData;
    const n = WAVE_BUCKETS;
    const out = new Float32Array(n);
    let mx = 0;
    for (let x = 0; x < n; x++) {
      const f0 = Math.floor(x * frames / n);
      const f1 = Math.max(f0 + 1, Math.floor((x + 1) * frames / n));
      const step = Math.max(1, Math.floor((f1 - f0) / 16));   // subsample long spans
      let peak = 0;
      for (let f = f0; f < f1; f += step) {
        const o = f * stride;
        let sum = 0;
        for (let i = 0; i < bands; i++) {
          sum += (body[o + (i >> 1)] >> ((i & 1) ? 4 : 0)) & 0x0F;
        }
        const v = sum / (bands * 15);
        if (v > peak) peak = v;
      }
      out[x] = peak;
      if (peak > mx) mx = peak;
    }
    if (mx > 0) for (let x = 0; x < n; x++) out[x] /= mx;
    scrubWave = out;
  }

  function drawScrubber() {
    const W = scrubW, H = scrubH;
    if (W < 2) return;
    sCtx.clearRect(0, 0, W, H);

    const dur = currentDuration();
    const pos = scrubDrag != null ? scrubDrag : Math.min(mediaTime(), dur || Infinity);
    const frac = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
    const mid = H / 2;

    if (scrubWave) {
      for (let x = 0; x < W; x++) {
        const v = scrubWave[Math.min(scrubWave.length - 1,
                              Math.floor(x / W * scrubWave.length))];
        const h = Math.max(1, v * H);          // flush to the canvas edges
        sCtx.fillStyle = x / W <= frac ? SCOL.played : SCOL.ahead;
        sCtx.fillRect(x, mid - h / 2, 1, h);
      }
    } else {
      // No envelope for this track. Drawn full height rather than as a thin
      // centred line so its bounding box starts at the canvas top too — the
      // gap below the video then reads the same in both states.
      sCtx.fillStyle = SCOL.track;
      sCtx.fillRect(0, 0, W, H);
      sCtx.fillStyle = SCOL.played;
      sCtx.fillRect(0, 0, W * frac, H);
    }

    if (state.current) {
      sCtx.fillStyle = SCOL.head;
      sCtx.fillRect(Math.max(0, Math.min(W - 2, W * frac - 1)), 0, 2, H);
    }

    const label = fmtDur(Math.round(pos)) + "|" + fmtDur(Math.round(dur));
    if (label !== lastTimeLabel) {          // touch the DOM only when it changes
      lastTimeLabel = label;
      const parts = label.split("|");
      $("scrubNow").textContent = state.current ? parts[0] : "0:00";
      $("scrubEnd").textContent = parts[1];
      scrubCanvas.setAttribute("aria-valuemax", String(Math.round(dur)));
      scrubCanvas.setAttribute("aria-valuenow", String(Math.round(pos)));
      scrubCanvas.setAttribute("aria-valuetext", parts[0] + " of " + parts[1]);
    }
  }

  const scrubTimeAt = (e) => {
    const r = scrubCanvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    return frac * currentDuration();
  };

  scrubCanvas.addEventListener("pointerdown", (e) => {
    if (!state.current || !currentDuration()) return;
    try { scrubCanvas.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    scrubDrag = scrubTimeAt(e);
  });
  scrubCanvas.addEventListener("pointermove", (e) => {
    if (scrubDrag != null) scrubDrag = scrubTimeAt(e);
  });
  scrubCanvas.addEventListener("pointerup", (e) => {
    if (scrubDrag == null) return;
    const target = scrubTimeAt(e);
    scrubDrag = null;
    seekMedia(target);
  });
  scrubCanvas.addEventListener("pointercancel", () => { scrubDrag = null; });

  scrubCanvas.addEventListener("keydown", (e) => {
    if (!state.current) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();               // keep it off the track-skip shortcuts
    const delta = e.key === "ArrowRight" ? 5 : -5;
    seekMedia(mediaTime() + delta);
  });

  function eqFrame(now) {
    eqRaf = requestAnimationFrame(eqFrame);
    const dt = Math.min(0.05, (now - eqLastT) / 1000) || 0.016;
    eqLastT = now;

    eqCtx.clearRect(0, 0, eqW, eqH);

    const active = eqData && state.current && state.playing && !contentMismatch;
    const n = eqData ? eqData.bands : 24;
    allocBands(n);

    if (active) {
      const target = new Float32Array(n);
      sampleEnvelope(mediaTime(), target);
      for (let i = 0; i < n; i++) {
        const v = target[i];
        const k = v > eqLevels[i] ? EQ_ATTACK : EQ_RELEASE;
        eqLevels[i] += (v - eqLevels[i]) * k;
      }
    } else {
      for (let i = 0; i < n; i++) eqLevels[i] *= 0.88;
    }

    for (let i = 0; i < n; i++) {
      if (eqLevels[i] >= eqPeaks[i]) {
        eqPeaks[i] = eqLevels[i];
        eqPeakVel[i] = 0;
        eqHold[i] = 0.4;
      } else if (eqHold[i] > 0) {
        eqHold[i] -= dt;
      } else {
        eqPeakVel[i] += 1.5 * dt;
        eqPeaks[i] = Math.max(eqLevels[i], eqPeaks[i] - eqPeakVel[i] * dt);
      }
    }

    const padX = 12, floorY = eqH - 8, topY = 10;
    const usable = floorY - topY;
    const gap = 3;
    const bw = Math.max(2, (eqW - padX * 2 - gap * (n - 1)) / n);

    eqCtx.fillStyle = EQC.grid;
    eqCtx.fillRect(padX, floorY + 1, eqW - padX * 2, 1);

    for (let i = 0; i < n; i++) {
      const v = eqLevels[i];
      const x = padX + i * (bw + gap);
      const h = v * usable;
      if (h > 0.7) {
        eqCtx.fillStyle = eqRamp(v);
        eqCtx.fillRect(x, floorY - h, bw, h);
      }
      if (eqPeaks[i] > 0.02) {
        eqCtx.fillStyle = EQC.cap;
        eqCtx.fillRect(x, floorY - eqPeaks[i] * usable - 2, bw, 1.5);
      }
    }

    drawScrubber();
  }

  // ------------------------------------------------------- contributors

  function contributorCounts() {
    const tally = new Map();
    for (const t of TRACKS) {
      const name = t.v || "Unattributed";
      tally.set(name, (tally.get(name) || 0) + 1);
    }
    return [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  function buildContributors() {
    const rows = contributorCounts();
    const top = rows[0]?.[1] || 1;
    const list = $("contribList");
    const frag = document.createDocumentFragment();

    rows.forEach(([name, count], i) => {
      const li = document.createElement("li");
      li.className = "contrib";
      li.innerHTML =
        `<span class="contrib-rank">${String(i + 1).padStart(2, "0")}</span>` +
        `<span class="contrib-name"></span>` +
        `<span class="contrib-bar"><i style="width:${(count / top * 100).toFixed(1)}%"></i></span>` +
        `<span class="contrib-n">${count}</span>`;
      li.querySelector(".contrib-name").textContent = name;
      li.title = `${name} — ${count} ${count === 1 ? "track" : "tracks"}`;
      frag.appendChild(li);
    });

    list.replaceChildren(frag);
    $("contribSub").textContent =
      `${rows.length} people  ·  ${TRACKS.length.toLocaleString()} tracks`;
  }

  const contribModal = $("contribModal");

  $("btnContrib").addEventListener("click", () => contribModal.showModal());
  $("contribClose").addEventListener("click", () => contribModal.close());
  contribModal.addEventListener("click", (e) => {
    // clicking the backdrop lands on the dialog element itself
    if (e.target === contribModal) contribModal.close();
  });

  buildContributors();

  // ----------------------------------------------------------------- chrome

  let searchTimer = 0;
  $("search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => { state.query = v; render(true); }, 140);
  });

  const LIST_MODE_LABEL = { show: "Shown", blur: "Obfuscated", hide: "Hidden" };
  const listModeMenu = $("listModeMenu");
  const listModeMore = $("listModeMore");

  function openListMenu(open, restoreFocus) {
    listModeMenu.hidden = !open;
    listModeMore.setAttribute("aria-expanded", String(open));
    // hiding the container while a menu item holds focus drops focus to <body>,
    // which tabs the user straight past this control
    if (!open && restoreFocus) listModeMore.focus();
  }

  function setListMode(mode, opts) {
    if (!LIST_MODE_LABEL[mode]) mode = "show";      // a stray stored value
    const silent = opts && opts.silent;
    state.listMode = mode;

    const pill = $("listModeCurrent");
    pill.textContent = LIST_MODE_LABEL[mode];
    pill.dataset.listmode = mode;
    // not a toggle: it names the active mode and returns you to plain titles,
    // so aria-pressed would announce the inverse of what is on screen
    pill.classList.toggle("is-active", mode !== "show");
    pill.title = mode === "show" ? "Titles are shown" : "Back to plain titles";
    listModeMenu.querySelectorAll("[data-listmode]").forEach((b) =>
      b.setAttribute("aria-current", String(b.dataset.listmode === mode)));

    if (silent) return;
    prefs.listMode = mode;
    store.write(K_PREF, prefs);
    openListMenu(false, true);
    render(false);
  }

  // the visible pill names the active mode and clicking it returns to plain
  $("listModeCurrent").addEventListener("click", () => setListMode("show"));
  listModeMore.addEventListener("click", (e) => {
    e.stopPropagation();
    openListMenu(listModeMenu.hidden);
  });
  listModeMenu.querySelectorAll("[data-listmode]").forEach((btn) => {
    btn.addEventListener("click", () => setListMode(btn.dataset.listmode));
  });
  document.addEventListener("click", (e) => {
    if (!listModeMenu.hidden && !e.target.closest(".listmode")) openListMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !listModeMenu.hidden) openListMenu(false, true);
  });

  document.querySelectorAll("[data-skin]").forEach((btn) => {
    if (!btn.dataset.skin || btn.tagName !== "BUTTON") return;
    btn.addEventListener("click", () => {
      document.documentElement.dataset.skin = btn.dataset.skin;
      document.querySelectorAll("button[data-skin]").forEach((b) =>
        b.setAttribute("aria-pressed", String(b === btn)));
      prefs.skin = btn.dataset.skin;
      store.write(K_PREF, prefs);
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea")) return;
    if (contribModal.open) return;
    if (!listModeMenu.hidden) return;          // the open picker owns the keys
    // Space on a focused button must activate that button, not the transport
    if (e.key === " " && e.target.matches("button")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); next(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
    if (e.key === " ") { e.preventDefault(); (state.playing ? $("bPause") : $("bPlay")).click(); }
  });

  // -------------------------------------------------------------------- go

  document.documentElement.dataset.skin = prefs.skin;
  document.querySelectorAll("button[data-skin]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.skin === prefs.skin)));
  setListMode(state.listMode, { silent: true });

  $("npSub").textContent = TRACKS.length.toLocaleString() + " tracks, posted by friends between 2012 and 2015.";
  $("statNote").textContent = "liveness learned from playback";

  render(true);
  mergeOfflineLiveness();
  loadEqIndex();
  eqResize();
  scrubResize();
  eqLastT = performance.now();
  eqRaf = requestAnimationFrame(eqFrame);

  loadScript("https://www.youtube.com/iframe_api");
  loadScript("https://w.soundcloud.com/player/api.js");

  // The YT API may land after a track was already chosen.
  const ytPoll = setInterval(() => {
    if (ytReady) {
      clearInterval(ytPoll);
      if (pendingYT) { yt.loadVideoById(pendingYT); pendingYT = null; }
    }
  }, 200);
})();
