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
            if (state.current) markLivenessOk(state.current);
          }
          if (e.data === YT.PlayerState.PAUSED) state.playing = false;
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
    "&auto_play=true&visual=false&hide_related=true&show_comments=false&color=%2328b0c0";

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
        rowFor(candidate.k)?.scrollIntoView({ block: "nearest" });
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

  document.querySelectorAll("[data-listmode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.listMode = btn.dataset.listmode;
      document.querySelectorAll("[data-listmode]").forEach((b) =>
        b.setAttribute("aria-pressed", String(b === btn)));
      prefs.listMode = state.listMode;
      store.write(K_PREF, prefs);
      render(false);
    });
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
    if (e.key === "ArrowRight") { e.preventDefault(); next(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
    if (e.key === " ") { e.preventDefault(); (state.playing ? $("bPause") : $("bPlay")).click(); }
  });

  // -------------------------------------------------------------------- go

  document.documentElement.dataset.skin = prefs.skin;
  document.querySelectorAll("button[data-skin]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.skin === prefs.skin)));
  document.querySelectorAll("[data-listmode]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.listmode === state.listMode)));

  $("npSub").textContent = TRACKS.length.toLocaleString() + " tracks, posted by friends between 2012 and 2015.";
  $("statNote").textContent = "liveness learned from playback";

  render(true);
  mergeOfflineLiveness();

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
