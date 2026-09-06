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
  const K_WHO  = "mash.contributors.v1";
  const K_WHEEL = "mash.wheel.v1";
  const K_SRC  = "mash.sources.v1";
  const K_PLAYED = "mash.played.v1";
  const K_SWAP = "mash.replacements.v1";

  /* Liveness: { "YT:xyz": { s: "gone"|"blocked"|"stalled"|"ok", c: <code>, t: <epoch> } }
   * Seeded at runtime from the players' own error events. An offline batch
   * check (tools/check-liveness.mjs) can drop a data/liveness.json alongside
   * this, which is merged in on load — the two sources never disagree, since
   * the offline file only ever adds IDs the app has not tried yet. */
  const liveness = store.read(K_LIVE, {});
  const favs = new Set(store.read(K_FAV, []));

  /* Jukebox 3: tracks leave the list once they have been played to the end.
   * Persisted, because a work-through-the-library feature that forgets on
   * reload is pointless. Only the players' own end events write to this — a
   * skip is not a listen. */
  const played = new Set(store.read(K_PLAYED, []));

  /* QoL 1: suggestions for tracks the platforms have lost. The library half is
   * computed here; the YouTube half is a precomputed sidecar, because a search
   * API key cannot ship in a static page. SoundCloud gets the library half
   * only — its public API has been closed to new keys since 2019. */
  const replacements = store.read(K_SWAP, {});

  /* Which contributors are in play. Everyone is selected by default, so the
   * predicate in buildView() is a no-op until something is deselected. Names
   * come from the same field the panel ranks, so the two cannot drift. */
  const contributorOf = (t) => t.v || "Unattributed";
  const ALL_WHO = [...new Set(TRACKS.map(contributorOf))];
  const storedWho = store.read(K_WHO, null);
  const who = new Set(
    Array.isArray(storedWho) ? storedWho.filter((n) => ALL_WHO.includes(n)) : ALL_WHO
  );
  const everyoneSelected = () => ALL_WHO.every((n) => who.has(n));
  /* Source filter. Two independent toggles rather than a two-position switch:
   * a switch that can only ever select one source could never show the whole
   * library, which is not what a filter should do. */
  const ALL_SOURCES = ["YT", "SC"];
  const storedSrc = store.read(K_SRC, null);
  const sources = new Set(
    Array.isArray(storedSrc) ? storedSrc.filter((x) => ALL_SOURCES.includes(x)) : ALL_SOURCES
  );
  if (!sources.size) ALL_SOURCES.forEach((x) => sources.add(x));   // same guard as the click path

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

  /* ------------------------------------------- replacement search (QoL 1) */

  const normalise = (str) => str.toLowerCase()
    .replace(/[\u2018\u2019']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  /* Trailing qualifiers are the common difference between a track and its twin
   * — "(Original Mix)", "[Exploited]", "(Official Video)". Comparing with and
   * without them and keeping the better score finds pairs that a single form
   * misses in either direction. */
  const coreOf = (str) => normalise(str.replace(/[([][^)\]]*[)\]]/g, " "));

  const SWAP_MIN = 0.62;          // below this the "matches" are noise
  const SWAP_MAX = 6;

  /* Bounded: give up as soon as every cell in a row exceeds `max`, because the
   * distance can only grow from there. Scanning 1,257 titles unbounded took
   * 1.8s on a click, which is not an interaction. */
  function levenshtein(a, b, max) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    const cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      let best = cur[0];
      for (let j = 1; j <= b.length; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        const v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        cur[j] = v;
        if (v < best) best = v;
      }
      if (best > max) return max + 1;
      for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
  }

  /* Levenshtein is at least the difference in length, so a pair too different
   * in length to clear the threshold is rejected without any matrix at all.
   * That prunes most of the library on a single subtraction. */
  function scoreForm(x, y) {
    if (!x || !y) return 0;
    const longest = Math.max(x.length, y.length);
    const budget = Math.floor((1 - SWAP_MIN) * longest);
    if (Math.abs(x.length - y.length) > budget) return 0;
    const d = levenshtein(x, y, budget);
    return d > budget ? 0 : 1 - d / longest;
  }

  /* Normalised forms are computed once per track, not once per comparison. */
  const formCache = new Map();
  function formsOf(key, title) {
    let f = formCache.get(key);
    if (!f) {
      f = { full: normalise(title), core: coreOf(title) };
      formCache.set(key, f);
    }
    return f;
  }

  function similarity(a, b) {
    const fa = formsOf("a:" + a, a);
    const fb = formsOf("b:" + b, b);
    return Math.max(scoreForm(fa.full, fb.full), scoreForm(fa.core, fb.core));
  }

  /* Library first. It covers both sources, needs no network, and the library
   * genuinely holds twins — the same track posted more than once under
   * different ids, which is exactly what a dead entry needs. */
  function findReplacements(track) {
    const target = formsOf(track.k, track.t);
    const scored = [];
    for (const t of TRACKS) {
      if (t.k === track.k || isDead(t)) continue;
      const f = formsOf(t.k, t.t);
      const score = Math.max(scoreForm(target.full, f.full), scoreForm(target.core, f.core));
      if (score >= SWAP_MIN) scored.push({ track: t, score });
    }
    scored.sort((a, b) => b.score - a.score || a.track.n - b.track.n);
    return {
      library: scored.slice(0, SWAP_MAX),
      online: (replacements[track.k] || []).slice(0, SWAP_MAX),
    };
  }

  /* Only ask for the sidecar when it could possibly help.
   *
   * A missing file cannot be detected without requesting it — that request IS
   * the detection — so "don't fetch when it isn't there" is not literally
   * available. What is available: replacements are only ever consulted for a
   * dead track, so with nothing dead there is nothing to look up and no reason
   * to ask. That removes the request, and its 404, from every ordinary page
   * load. It is attempted at most once per load, and again only when a track
   * first turns out to be dead. */
  let sidecarTried = false;

  async function mergeReplacements() {
    if (sidecarTried) return;
    if (!TRACKS.some(isDead)) return;          // nothing to replace
    sidecarTried = true;
    try {
      const res = await fetch("data/replacements.json", { cache: "no-store" });
      if (!res.ok) return;
      const remote = await res.json();
      let added = 0;
      for (const [k, list] of Object.entries(remote)) {
        if (!replacements[k] && Array.isArray(list)) { replacements[k] = list; added++; }
      }
      if (added) store.write(K_SWAP, replacements);
    } catch (e) {
      /* no sidecar, or running from file:// — the library half stands alone */
    }
  }

  function markLiveness(track, status, code) {
    liveness[track.k] = { s: status, c: code ?? null, t: Date.now() };
    store.write(K_LIVE, liveness);
    const row = rowFor(track.k);
    if (row) decorateRow(row, track);
    paintStatus();
    // a track dying mid-session is the other moment the sidecar becomes useful
    if (isDead(track)) mergeReplacements();
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
      if (played.has(t.k)) return false;
      // "hide" no longer redacts titles; it drops the tracks the platforms
      // have lost — the same set the status bar counts as unavailable
      if (state.listMode === "hide" && isSkippable(t)) return false;
      if (state.favsOnly && !favs.has(t.k)) return false;
      if (!everyoneSelected() && !who.has(contributorOf(t))) return false;
      if (!sources.has(t.s)) return false;
      if (!q) return true;
      return t.t.toLowerCase().includes(q) || t.v.toLowerCase().includes(q);
    });
    state.order = state.view.map((_, i) => i);
    if (state.shuffle) shuffleOrder();
    state.shown = 0;
  }

  /* A stable random key per track rather than a fresh permutation each time.
   * shuffleOrder() used to rerun on every buildView(), so a search keystroke
   * reshuffled the queue and made "tracks remaining" meaningless. */
  let shuffleKeys = null;
  function reshuffle() {
    shuffleKeys = new Map(TRACKS.map((t) => [t.k, Math.random()]));
  }
  function shuffleOrder() {
    if (!shuffleKeys) reshuffle();
    state.order.sort((a, b) =>
      shuffleKeys.get(state.view[a].k) - shuffleKeys.get(state.view[b].k));
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

    name.textContent = track.t;
    via.textContent = track.v ? "via " + track.v : "";
    main.append(name, via);

    const src = document.createElement("span");
    src.className = "t-src";
    src.textContent = track.s;

    const dur = document.createElement("span");
    dur.className = "t-dur";
    dur.textContent = fmtDur(track.d);

    /* The swap control shares the last grid cell with the duration rather than
       adding a sixth column, which would leave a gap on every live row. */
    const swap = document.createElement("button");
    swap.className = "t-swap";
    swap.type = "button";
    swap.hidden = true;
    swap.title = "Find a replacement";
    swap.setAttribute("aria-label", "Find a replacement for this track");
    swap.innerHTML = '<svg><use href="#i-swap"></use></svg>';
    swap.addEventListener("click", (e) => {
      /* Not a request to play the dead one. play() also refuses dead tracks,
         so this changes no observable behaviour today — it is here because
         "this button is not the row" is the correct semantic, and the row
         click may grow other behaviour. There is deliberately no mutation
         check for it: with two guards, removing one proves nothing. */
      e.stopPropagation();
      openSwap(track);
    });

    const tail = document.createElement("div");
    tail.className = "t-tail";
    tail.append(dur, swap);

    li.append(fav, idx, main, src, tail);
    li.addEventListener("click", () => play(track));

    /* A row built after playback started must mark itself. markCurrentRow()
     * only reaches rows that already exist, so a track played from beyond the
     * render window — through the wheel, or a replacement chosen for a dead
     * one — left the list with nothing highlighted even after scrolling to it. */
    if (state.current && state.current.k === track.k) {
      li.setAttribute("aria-current", "true");
    }

    decorateRow(li, track);
    rowIndex.set(track.k, li);
    return li;
  }

  function decorateRow(li, track) {
    const rec = liveness[track.k];
    const dead = isDead(track);
    li.classList.toggle("is-dead", dead);
    li.classList.toggle("is-suspect", !dead && rec?.s === "stalled");
    const swap = li.querySelector(".t-swap");
    if (swap) swap.hidden = !dead;          // hidden, not just unstyled, so it
                                            // stays out of the tab order too
    li.title = dead
      ? "Unavailable — " + (rec.s === "blocked" ? "embedding disabled" : "removed or private")
      : rec?.s === "stalled" ? "Did not start last time — click to retry" : "";
  }

  let bulkRender = false;
  function renderChunk() {
    const frag = document.createDocumentFragment();
    const end = Math.min(state.shown + CHUNK, state.order.length);
    for (let i = state.shown; i < end; i++) {
      frag.appendChild(buildRow(state.view[state.order[i]]));
    }
    state.shown = end;
    listEl.appendChild(frag);
    $("listEnd").hidden = state.shown < state.order.length;
    if (!bulkRender) paintStatus();
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
    paintContributorState();
    paintTransportFlanks();
    $("statLoaded").textContent =
      `showing ${state.shown} / ${state.order.length}` +
      (state.order.length !== TRACKS.length ? ` (of ${TRACKS.length})` : "");
    $("statDead").textContent = deadCount ? `${deadCount} unavailable` : "";
    const pl = $("statPlayed");
    pl.hidden = !played.size;
    pl.textContent = `${played.size} played \u00b7 reset`;
    $("brandCount").textContent = `${TRACKS.length} tracks`;
  }

  // ------------------------------------------------------------------ favs

  function toggleFav(track, btn) {
    if (favs.has(track.k)) favs.delete(track.k); else favs.add(track.k);
    if (btn) btn.setAttribute("aria-pressed", String(favs.has(track.k)));
    store.write(K_FAV, [...favs]);
    if (state.favsOnly) render(true);
    paintTransportFlanks();
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
          if (e.data === YT.PlayerState.ENDED) completed();
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
    sc.bind(E.FINISH, () => completed());
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
    }
  }

  // --------------------------------------------------------- transport flanks

  /* Render enough chunks that `pos` exists in the DOM, then hand back the row. */
  function revealPosition(pos) {
    while (state.shown <= pos && state.shown < state.order.length) renderChunk();
    const track = state.view[state.order[pos]];
    return track ? rowFor(track.k) : null;
  }

  function jumpToCurrent() {
    if (!state.current) return false;
    const pos = positionOf(state.current);
    if (pos < 0) return false;                      // filtered out of the view
    const row = revealPosition(pos);
    if (!row) return false;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    return true;
  }

  $("tJump").addEventListener("click", jumpToCurrent);
  $("tJump").disabled = true;
  /* The document top, not a computed offset. Offsetting by the sticky chrome is
   * circular: the tracklist's document position depends on the pinned block's
   * flow height, which depends on whether the stage is collapsed, which depends
   * on the very scroll position being computed. At y=0 the stage is expanded by
   * definition and the list starts directly below it, which is what "top of the
   * list" should mean anyway. */
  $("tTop").addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("tBottom").addEventListener("click", () => {
    bulkRender = true;                       // one repaint, not one per chunk
    while (state.shown < state.order.length) renderChunk();
    bulkRender = false;
    paintStatus();
    $("listEnd").scrollIntoView({ block: "end", behavior: "smooth" });
  });

  // the transport heart mirrors the row hearts for whatever is playing
  /* ------------------------------------------ replacement dialog (QoL 1) */

  const swapModal = $("swapModal");
  let swapFor = null;

  function openSwap(track) {
    swapFor = track;
    const { library, online } = findReplacements(track);
    const list = $("swapList");
    list.innerHTML = "";

    $("swapSub").textContent = track.t;

    const add = (label, sub, score, onPick) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "swap-pick";
      const name = document.createElement("span");
      name.className = "swap-name";
      name.textContent = label;
      const via = document.createElement("span");
      via.className = "swap-via";
      via.textContent = sub;
      const pct = document.createElement("span");
      pct.className = "swap-score";
      pct.textContent = score == null ? "" : Math.round(score * 100) + "%";
      btn.append(name, via, pct);
      btn.addEventListener("click", onPick);
      li.appendChild(btn);
      list.appendChild(li);
    };

    for (const c of library)
      add(c.track.t, c.track.v ? "via " + c.track.v + " \u00b7 " + c.track.s : c.track.s,
          c.score, () => { swapModal.close(); play(c.track); });

    for (const r of online)
      add(r.t, (r.c ? r.c + " \u00b7 " : "") + "YouTube search", r.score ?? null,
          () => { swapModal.close(); play({ ...track, i: r.i, s: "YT", t: r.t }); });

    const note = $("swapNote");
    if (!library.length && !online.length) {
      note.textContent = track.s === "SC"
        ? "Nothing close enough in the library. SoundCloud has no search to fall back on — its public API has been closed since 2019."
        : "Nothing close enough in the library, and no offline suggestion for this one.";
    } else if (!online.length && track.s === "YT") {
      note.textContent = "Library matches only. Offline YouTube suggestions come from data/replacements.json, which is not present.";
    } else {
      note.textContent = "";
    }

    swapModal.showModal();
  }

  $("swapClose").addEventListener("click", () => swapModal.close());
  swapModal.addEventListener("click", (e) => {
    if (e.target === swapModal) swapModal.close();      // backdrop
  });

  $("statPlayed").addEventListener("click", resetPlayed);

  /* The only seam in the app that exists partly for the tests, and it is here
   * because the alternative is leaving Jukebox 3 unverified: both end events
   * fire inside a cross-origin iframe and cannot be synthesised from outside
   * it. It is a fair extension point in its own right — anything may declare
   * a track finished — and it carries no privilege the UI does not already
   * have. Everything else in the suite drives real controls. */
  document.addEventListener("mash:completed", completed);

  $("tFav").addEventListener("click", () => {
    if (!state.current) return;
    const row = rowFor(state.current.k);
    // one code path either way: the fallback used to skip toggleFav's
    // favourites-only rebuild, so un-favouriting an off-screen track left it
    // sitting in a favourites-only list
    toggleFav(state.current, row && row.querySelector(".t-fav"));
    paintTransportFlanks();
  });

  document.querySelectorAll("[data-source]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const src = btn.dataset.source;
      if (sources.has(src)) sources.delete(src); else sources.add(src);
      if (!sources.size) ALL_SOURCES.forEach((x) => sources.add(x));   // never empty
      store.write(K_SRC, [...sources]);
      render(true);            // repaints the buttons via paintTransportFlanks

    });
  });

  function paintTransportFlanks() {
    document.querySelectorAll("[data-source]").forEach((b) =>
      b.setAttribute("aria-pressed", String(sources.has(b.dataset.source))));

    const fav = state.current && favs.has(state.current.k);
    $("tFav").setAttribute("aria-pressed", String(!!fav));
    $("tFav").disabled = !state.current;

    // pos < 0 means the playing track is not in the current view, so it is not
    // part of the queue — both readouts have to agree about that
    const pos = state.current ? positionOf(state.current) : -1;
    const inQueue = pos >= 0;
    const clock = (secs) => (secs > 0 ? fmtDur(Math.round(secs)) : "0:00");

    $("mTracksLeft").textContent =
      String(inQueue ? state.order.length - pos - 1 : state.order.length);

    const dur = currentDuration();
    const left = dur ? Math.max(0, dur - mediaTime()) : 0;
    $("mTrackRemain").textContent = state.current ? clock(left) : "--:--";

    let total = inQueue ? left : 0;
    for (let i = inQueue ? pos + 1 : 0; i < state.order.length; i++) {
      total += state.view[state.order[i]].d || 0;
    }
    $("mAllRemain").textContent = state.order.length || inQueue ? clock(total) : "--:--";

    $("tJump").disabled = !inQueue;

    const filtered = sources.size !== ALL_SOURCES.length;
    $("statSrc").textContent = filtered ? [...sources].join("") + " only" : "";
  }
  setInterval(paintTransportFlanks, 1000);

  // ------------------------------------------------------------- transport

  function positionOf(track) {
    if (!track) return -1;
    const viewIdx = state.view.findIndex((t) => t.k === track.k);
    return viewIdx < 0 ? -1 : state.order.indexOf(viewIdx);
  }

  /* Played to completion, not skipped. Both players' end events land here and
   * nowhere else, so pressing Next can never decay a track. */
  function completed() {
    const track = state.current;
    if (!track) { next(); return; }

    // where it sat, so playback resumes at whatever moves up into its place
    const pos = positionOf(track);
    played.add(track.k);
    store.write(K_PLAYED, [...played]);

    let done = false;
    const advance = () => {
      if (done) return;
      done = true;
      render(true);                 // the track leaves the view here
      resumeFrom(pos);
      paintStatus();
    };

    const row = rowFor(track.k);
    if (!row) { advance(); return; }        // never rendered, nothing to pop
    row.classList.add("is-popping");
    row.addEventListener("animationend", advance, { once: true });
    // animationend never fires if the row is display:none, and reduced motion
    // caps the duration to .01ms — either way, do not strand playback
    setTimeout(advance, 600);
  }

  /* Resume at a position rather than a track: the one that was playing is no
   * longer in the view, so everything after it has shifted up by one. */
  function resumeFrom(pos) {
    if (!state.order.length) return;
    const start = pos < 0 ? 0 : pos % state.order.length;
    for (let i = 0; i < state.order.length; i++) {
      const idx = (start + i) % state.order.length;
      const candidate = state.view[state.order[idx]];
      if (!isSkippable(candidate)) {
        while (state.shown <= idx && state.shown < state.order.length) renderChunk();
        play(candidate);
        return;
      }
    }
  }

  function resetPlayed() {
    if (!played.size) return;
    played.clear();
    store.write(K_PLAYED, []);
    render(true);
    paintStatus();
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
    if (state.shuffle) reshuffle();          // a new order only on demand
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
  new MutationObserver(() => {
    readEqColors(); readScrubColors(); readWheelColors();
    if (wheelModal.open) drawWheel();
  })
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

  // -------------------------------------------------------------- wheel
  //
  // The by-person half of the random spec. Shuffle stays a pure uniform
  // permutation; this picks a contributor, then one of their tracks.
  // Weighted makes a contributor's odds proportional to how much they posted;
  // even odds gives all of them the same slice.

  const wheelCanvas = $("wheelCanvas");
  const wheelCtx = wheelCanvas.getContext("2d");
  const wheelModal = $("wheelModal");
  const storedWheel = store.read(K_WHEEL, null);
  let wheelWeighted = !storedWheel || storedWheel.weighted !== false;
  let wheelAngle = 0;            // radians; 0 puts segment 0 at twelve o'clock
  let wheelSpinning = false;
  let wheelRaf = 0;
  let wheelWinner = null;
  let wheelW = 0;

  const initialsOf = (name) => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || "?").slice(0, 2).toUpperCase();
  };

  /* Cached like EQC and SCOL: drawWheel runs ~190 times a spin and was calling
   * getComputedStyle twice per segment per frame. */
  let WCOL = {};
  function readWheelColors() {
    const cs = getComputedStyle(document.documentElement);
    const tok = (n, fb) => cs.getPropertyValue(n).trim() || fb;
    WCOL = {
      slices: [1, 2, 3, 4, 5, 6].map((i) => tok("--wheel-" + i, "#888")),
      seam: tok("--sunk", "#111"),
      hub: tok("--panel", "#222"),
      rim: tok("--line-hard", "#444"),
      label: tok("--check-ink", "#000"),
      mark: tok("--ink", "#fff"),
    };
  }
  readWheelColors();

  /* Derived from the current view, not the raw library, so the wheel composes
   * with search and favourites as well as the contributor filter. */
  function wheelSegments() {
    const tally = new Map();
    for (const t of state.view) {
      const n = contributorOf(t);
      tally.set(n, (tally.get(n) || 0) + 1);
    }
    const rows = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const total = rows.reduce((sum, [, c]) => sum + c, 0) || 1;
    let at = 0;
    return rows.map(([name, count]) => {
      const share = wheelWeighted ? count / total : 1 / rows.length;
      const seg = { name, count, start: at, end: at + share * Math.PI * 2 };
      at = seg.end;
      return seg;
    });
  }

  function sizeWheel() {
    const box = wheelCanvas.getBoundingClientRect();
    wheelW = Math.round(box.width);
    if (wheelW < 40) return false;               // closed, or not laid out yet
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(wheelW * dpr);
    if (wheelCanvas.width !== px) {
      wheelCanvas.width = px;
      wheelCanvas.height = px;
    }
    wheelCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }
  new ResizeObserver(() => { if (wheelModal.open && sizeWheel()) drawWheel(); })
    .observe(wheelCanvas);

  function drawWheel(segments) {
    // A negative radius throws IndexSizeError, which killed the spin loop
    // before its cleanup ran and left the Spin button dead until reload.
    if (!sizeWheel()) return;
    const segs = segments || wheelSegments();
    const size = wheelW, r = size / 2, cx = r, cy = r;
    wheelCtx.clearRect(0, 0, size, size);
    if (!segs.length) return;

    segs.forEach((seg, i) => {
      // -PI/2 puts angle 0 at twelve o'clock, where the pointer sits
      const a0 = seg.start + wheelAngle - Math.PI / 2;
      const a1 = seg.end + wheelAngle - Math.PI / 2;
      const won = wheelWinner === seg.name;

      wheelCtx.beginPath();
      wheelCtx.moveTo(cx, cy);
      wheelCtx.arc(cx, cy, r - 4, a0, a1);
      wheelCtx.closePath();
      wheelCtx.fillStyle = WCOL.slices[i % WCOL.slices.length];
      wheelCtx.fill();
      wheelCtx.strokeStyle = won ? WCOL.mark : WCOL.seam;
      wheelCtx.lineWidth = won ? 3 : 1;
      wheelCtx.stroke();

      // Radial labels: text runs outward, so it needs the segment's arc width
      // to clear its height rather than its length. Tangential labels vanished
      // entirely in even-odds mode, where all 71 segments are 0.089 rad.
      if (a1 - a0 >= 0.05) {
        const mid = (a0 + a1) / 2;
        wheelCtx.save();
        wheelCtx.translate(cx, cy);
        wheelCtx.rotate(mid);
        wheelCtx.translate(r * 0.62, 0);
        if (Math.cos(mid) < 0) wheelCtx.rotate(Math.PI);
        wheelCtx.fillStyle = WCOL.label;
        wheelCtx.font = "600 9px Archivo, sans-serif";
        wheelCtx.textAlign = "center";
        wheelCtx.textBaseline = "middle";
        wheelCtx.fillText(initialsOf(seg.name), 0, 0);
        wheelCtx.restore();
      }
    });

    wheelCtx.beginPath();
    wheelCtx.arc(cx, cy, r * 0.16, 0, Math.PI * 2);
    wheelCtx.fillStyle = WCOL.hub;
    wheelCtx.fill();
    wheelCtx.strokeStyle = WCOL.rim;
    wheelCtx.lineWidth = 1;
    wheelCtx.stroke();
  }

  function pickWinner(segments) {
    if (!segments.length) return null;
    if (!wheelWeighted) return segments[Math.floor(Math.random() * segments.length)];
    const total = segments.reduce((sum, s) => sum + s.count, 0);
    let roll = Math.random() * total;
    for (const seg of segments) {
      roll -= seg.count;
      if (roll <= 0) return seg;
    }
    return segments[segments.length - 1];
  }

  function playFromContributor(name) {
    // from the view, so a spin cannot start a track the list is filtering out
    const pool = state.view.filter((t) => contributorOf(t) === name && !isSkippable(t));
    if (!pool.length) {
      $("wheelSub").textContent = `${name} — nothing playable`;
      return;
    }
    const track = pool[Math.floor(Math.random() * pool.length)];
    $("wheelSub").textContent = `${name} — ${track.t}`;
    wheelCanvas.setAttribute("aria-label", `Wheel landed on ${name}`);
    play(track);
  }

  function endSpin() {
    if (wheelRaf) cancelAnimationFrame(wheelRaf);
    wheelRaf = 0;
    wheelSpinning = false;
    $("wheelSpin").disabled = !wheelSegments().length;
  }

  function spinWheel() {
    if (wheelSpinning) return;
    const segments = wheelSegments();
    const winner = pickWinner(segments);
    if (!winner) { paintWheel(); return; }

    wheelWinner = null;
    const mid = (winner.start + winner.end) / 2;
    const target = -mid + Math.PI * 2 * 4;          // four turns for the look
    const land = () => {
      wheelAngle = ((target % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      wheelWinner = winner.name;
      drawWheel(segments);
      endSpin();
      playFromContributor(winner.name);
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { land(); return; }

    wheelSpinning = true;
    $("wheelSpin").disabled = true;
    const from = wheelAngle, dur = 3200, t0 = performance.now();
    const ease = (p) => 1 - Math.pow(1 - p, 3);

    const step = (now) => {
      if (!wheelModal.open) { endSpin(); return; }   // dismissed mid-spin
      const p = Math.min(1, (now - t0) / dur);
      wheelAngle = from + (target - from) * ease(p);
      drawWheel(segments);
      if (p < 1) { wheelRaf = requestAnimationFrame(step); return; }
      land();
    };
    wheelRaf = requestAnimationFrame(step);
  }

  /* One painter for the panel chrome, so the open and toggle paths cannot
   * disagree about the empty case. */
  function paintWheel() {
    const segments = wheelSegments();
    $("wheelWeight").textContent = wheelWeighted ? "Even odds" : "Weighted";
    $("wheelSub").textContent = segments.length
      ? `${segments.length} in play · ${wheelWeighted ? "odds follow track count" : "equal odds"}`
      : "No contributors selected";
    $("wheelSpin").disabled = !segments.length;
    wheelCanvas.setAttribute(
      "aria-label",
      segments.length
        ? `Wheel of ${segments.length} contributors, ${wheelWeighted ? "weighted by track count" : "equal odds"}`
        : "Wheel with no contributors selected"
    );
    drawWheel(segments);
    return segments;
  }

  $("bWheel").addEventListener("click", () => {
    wheelWinner = null;
    endSpin();
    wheelModal.showModal();
    paintWheel();                 // after showModal, so the canvas has a size
  });
  $("wheelClose").addEventListener("click", () => wheelModal.close());
  wheelModal.addEventListener("close", endSpin);
  $("wheelSpin").addEventListener("click", spinWheel);
  $("wheelWeight").addEventListener("click", () => {
    wheelWeighted = !wheelWeighted;
    store.write(K_WHEEL, { weighted: wheelWeighted });
    wheelWinner = null;
    paintWheel();
  });
  wheelModal.addEventListener("click", (e) => {
    if (e.target === wheelModal) wheelModal.close();
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
    const frag = document.createDocumentFragment();

    rows.forEach(([name, count], i) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "contrib";
      btn.dataset.who = name;
      btn.setAttribute("aria-pressed", String(who.has(name)));
      btn.innerHTML =
        `<span class="contrib-rank">${String(i + 1).padStart(2, "0")}</span>` +
        `<span class="contrib-name"></span>` +
        `<span class="contrib-bar"><i style="width:${(count / top * 100).toFixed(1)}%"></i></span>` +
        `<span class="contrib-n">${count}</span>`;
      btn.querySelector(".contrib-name").textContent = name;
      btn.title = `${name} — ${count} ${count === 1 ? "track" : "tracks"}`;
      btn.addEventListener("click", () => {
        if (who.has(name)) who.delete(name); else who.add(name);
        btn.setAttribute("aria-pressed", String(who.has(name)));
        store.write(K_WHO, [...who]);
        render(true);            // repaints the summary via paintStatus
      });
      li.appendChild(btn);
      frag.appendChild(li);
    });

    $("contribList").replaceChildren(frag);
    paintContributorState();
  }

  /* One place that reflects the selection: the modal subtitle, the all/none
   * button, and a dot on the toolbar button so an active filter is visible
   * without opening the panel. */
  function paintContributorState() {
    if (!ALL_WHO.length) return;
    const filtered = !everyoneSelected();
    $("contribSub").textContent = filtered
      ? `${who.size} of ${ALL_WHO.length} selected  ·  ${state.view.length.toLocaleString()} tracks`
      : `${ALL_WHO.length} people  ·  ${TRACKS.length.toLocaleString()} tracks`;
    // an action, not a toggle: aria-pressed here would announce a state that
    // contradicts the label, which is the defect already fixed on the mode pill
    $("contribAll").textContent = filtered ? "All" : "None";
    $("contribFilterDot").hidden = !filtered;
    // the dot is the only visual cue, so say it in the accessible name too
    $("btnContrib").setAttribute(
      "aria-label",
      filtered ? `Contributors — filtered to ${who.size} of ${ALL_WHO.length}` : "Contributors"
    );
  }

  $("contribAll").addEventListener("click", () => {
    const filtered = !everyoneSelected();
    who.clear();
    if (filtered) ALL_WHO.forEach((n) => who.add(n));   // "All" restores everyone
    store.write(K_WHO, [...who]);
    $("contribList").querySelectorAll("[data-who]").forEach((b) =>
      b.setAttribute("aria-pressed", String(who.has(b.dataset.who))));
    render(true);
  });

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
    $("listModeCurrent").setAttribute("aria-expanded", String(open));
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
    pill.title = "Change how titles are shown";
    listModeMenu.querySelectorAll("[data-listmode]").forEach((b) =>
      b.setAttribute("aria-current", String(b.dataset.listmode === mode)));

    if (silent) return;
    prefs.listMode = mode;
    store.write(K_PREF, prefs);
    openListMenu(false, true);
    // "Shown" -> "Obfuscated" widens the pill and moves the collapse boundary
    // by ~37px. The ResizeObserver watches .topbar, whose size never changes,
    // so nothing else would notice until the next window resize.
    reflowTools();
    /* "hide" changes which tracks are in the view, so it has to be rebuilt —
       but keep the reader's scroll depth, which a plain render(true) discards.
       buildView() zeroes state.shown; render(false) reads it back as the depth
       to render to, so it is restored in between. */
    const depth = state.shown;
    buildView();
    state.shown = depth;
    render(false);
  }

  /* Both halves of the control open the picker. The pill used to be a shortcut
     back to plain titles, which meant that once you left "Shown" it vanished
     from the interface entirely — the menu only ever listed the other two, and
     the way back was a title attribute nobody reads. The menu now lists all
     three and marks the active one. */
  const toggleListMenu = (e) => {
    e.stopPropagation();
    openListMenu(listModeMenu.hidden);
  };
  $("listModeCurrent").addEventListener("click", toggleListMenu);
  listModeMore.addEventListener("click", toggleListMenu);
  listModeMenu.querySelectorAll("[data-listmode]").forEach((btn) => {
    btn.addEventListener("click", () => setListMode(btn.dataset.listmode));
  });
  document.addEventListener("click", (e) => {
    if (!listModeMenu.hidden && !e.target.closest(".listmode")) openListMenu(false);
  });
  /* One handler for both layers. Two separate listeners could not work: the
   * picker's own ran first and set listModeMenu.hidden synchronously, so the
   * panel's guard on that flag always read true and both layers collapsed on
   * a single press. */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!listModeMenu.hidden) { openListMenu(false, true); return; }
    if (!toolsPanel.hidden) { openToolsPanel(false); toolsMore.focus(); }
  });

  const ALL_SKINS = ["jukebox", "night"];

  function setSkin(name) {
    if (!ALL_SKINS.includes(name)) return;
    document.documentElement.dataset.skin = name;
    document.querySelectorAll("button[data-skin]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.skin === name)));
    prefs.skin = name;
    store.write(K_PREF, prefs);
  }

  document.querySelectorAll("button[data-skin]").forEach((btn) => {
    if (!btn.dataset.skin) return;
    btn.addEventListener("click", () => setSkin(btn.dataset.skin));
  });

  /* The palette straddles the divider between the two theme buttons, so it
     reads as the thing that sits between them — clicking it moves to the other
     profile. It carries the active theme's colours, which is what makes it
     legible as a switch rather than an ornament. */
  $("skinBadge").addEventListener("click", () => {
    const current = document.documentElement.dataset.skin;
    setSkin(ALL_SKINS[(ALL_SKINS.indexOf(current) + 1) % ALL_SKINS.length]);
  });

  /* --------------------------------------- collapsing stage (QoL 10)
   *
   * The stage is sticky under the top bar. Once the list is scrolled, the
   * video column closes and the now-playing text sits beside the artwork and
   * spectrum, so the pinned strip stays short enough to leave the list usable.
   *
   * Wide hysteresis (collapse above 40, expand at or below 4) because
   * collapsing shortens the document by ~225px: a narrow band would let that
   * shortening push the scroll position back across the threshold and flap. */
  const stageEl = document.querySelector(".stage");
  let stageCollapsed = false;

  function stageHeights() {
    const doc = document.documentElement;
    return { room: doc.scrollHeight - window.innerHeight, y: window.scrollY };
  }

  function updateStageCollapse() {
    const { room, y } = stageHeights();
    const want = stageCollapsed ? y > 4 : y > 40;
    // With a short list — one search result, say — there may not be enough
    // document left to stay past the threshold once the stage shrinks, and
    // the two states would alternate on every scroll event.
    if (want && !stageCollapsed && room < 260) return;
    if (want === stageCollapsed) return;
    stageCollapsed = want;
    stageEl.classList.toggle("is-collapsed", want);
  }

  window.addEventListener("scroll", updateStageCollapse, { passive: true });
  window.addEventListener("resize", updateStageCollapse);
  updateStageCollapse();

  /* ------------------------------------------ topbar overflow (QoL 2)
   *
   * The bar holds one height at every width. The search shrinks first, down to
   * its own floor; past that, whole controls move into a panel behind a "more"
   * button rather than wrapping the bar to a second row.
   *
   * Collapse order is least-used-first: the theme is set once and left alone,
   * the list-mode picker is reached for more often, and the search is never
   * collapsed because it is the only way to reach a specific track in 1,257.
   *
   * Every pass starts from fully expanded, so widening the window restores
   * controls to the bar instead of stranding them in the panel. */
  const COLLAPSE_ORDER = [".skin-switch", ".listmode"];
  const toolsEl = document.querySelector(".tools");
  const toolsPanel = $("toolsPanel");
  const toolsMore = $("toolsMore");

  function openToolsPanel(open) {
    toolsPanel.hidden = !open;
    toolsMore.setAttribute("aria-expanded", String(open));
    // the picker lives inside the panel while collapsed; closing the panel
    // around an open picker leaves it dangling with aria-expanded="true"
    if (!open) openListMenu(false);
  }

  function toolsOverflow() {
    // no tolerance: a 1px slack here is a 1px horizontal scrollbar on the
    // document, which is the same defect the transport flanks shipped with
    const bar = document.querySelector(".topbar");
    return bar.scrollWidth > bar.clientWidth;
  }

  /* No re-entrancy guard, deliberately. There is nothing to guard against:
   * .topbar has a fixed height and viewport width, so none of the moves below
   * can resize the observed box and re-fire the observer. A flag here would
   * advertise loop protection it does not actually provide — if this element
   * ever gains an intrinsic height, or if anything starts observing .tools
   * (which IS content-sized, and which reflowTools resizes), that is a real
   * feedback loop and it needs a real fix, not a synchronous boolean. */
  function reflowTools() {
    /* Moving a focused node between containers blurs it, and so does hiding
     * one — Chromium's focus fix-up drops it to <body> the moment scrollWidth
     * forces a layout flush. openListMenu already documents this trap; this
     * function has to handle the same one. */
    const prev = document.activeElement;
    const owned = prev && (prev === toolsMore ||
      toolsEl.contains(prev) || toolsPanel.contains(prev));

    openListMenu(false);            // a floating picker cannot survive a reparent

    for (const sel of COLLAPSE_ORDER) {
      const el = toolsPanel.querySelector(sel);
      if (el) toolsEl.insertBefore(el, toolsMore);
    }
    toolsMore.hidden = true;

    for (const sel of COLLAPSE_ORDER) {
      if (!toolsOverflow()) break;
      // unhide before measuring again: the button itself takes width
      toolsMore.hidden = false;
      const el = toolsEl.querySelector(sel);
      if (el) toolsPanel.appendChild(el);
    }

    if (!toolsPanel.children.length) {
      toolsMore.hidden = true;
      openToolsPanel(false);
    }

    if (owned && prev.isConnected && document.activeElement !== prev)
      prev.focus({ preventScroll: true });
  }

  toolsMore.addEventListener("click", (e) => {
    e.stopPropagation();
    openToolsPanel(toolsPanel.hidden);
  });
  document.addEventListener("click", (e) => {
    if (!toolsPanel.hidden && !e.target.closest(".tools-panel, .tools-more"))
      openToolsPanel(false);
  });

  new ResizeObserver(reflowTools).observe(document.querySelector(".topbar"));
  reflowTools();
  // web fonts change the width of every label; measuring before they land
  // leaves the bar collapsed one control too early
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(reflowTools);

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
  // liveness first: it can reveal dead tracks, which is what makes the
  // replacements sidecar worth asking for at all
  mergeOfflineLiveness().then(mergeReplacements);
  mergeReplacements();
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
