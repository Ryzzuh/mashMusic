import { test, expect } from "@playwright/test";
import { blockExternal, isHittable } from "./helpers.js";

/* Playlists. The built-in library is the default one; a playlist is imported
 * and then shown on its own.
 *
 * Every network call is stubbed. blockExternal() aborts docs.google.com and
 * youtube.com, and these routes are registered after it so they win —
 * Playwright matches the most recently registered route first. */

const SHEET = /docs\.google\.com\/spreadsheets/;
const OEMBED = /youtube\.com\/oembed/;
const SHEET_ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

/** Serve `body` for the Sheets CSV endpoint; returns the URLs requested. */
async function stubSheet(page, body, opts = {}) {
  const seen = [];
  await page.route(SHEET, async (route) => {
    seen.push(route.request().url());
    await route.fulfill({
      status: opts.status || 200,
      contentType: opts.contentType || "text/csv",
      body,
    });
  });
  return seen;
}

/** Serve oEmbed metadata; returns the ids asked about.
 *  `opts.gone` is a list of ids YouTube should 404 on;
 *  `opts.fail` is a list whose requests never land at all. */
async function stubOembed(page, opts = {}) {
  const seen = [];
  const gone = new Set(opts.gone || []);
  const fail = new Set(opts.fail || []);
  await page.route(OEMBED, async (route) => {
    const u = new URL(route.request().url());
    const id = new URL(u.searchParams.get("url")).searchParams.get("v");
    seen.push(id);
    if (fail.has(id)) return route.abort();
    if (gone.has(id)) return route.fulfill({ status: 404, body: "" });
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        title: `Title ${id}`, author_name: `Channel ${id}`,
        thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      }),
    });
  });
  return seen;
}

/** Rows as the reader sees them. A name is in one of three states, and the
 *  suite has to be able to tell them apart: resolved, still resolving, or
 *  resolved-and-came-back-with-nothing, which is the only one that shows the
 *  bare id. */
const rowsShown = (page) => page.$$eval(".trow", (rs) => rs.map((r) => ({
  name: r.querySelector(".t-name").textContent,
  pending: r.querySelector(".t-name").classList.contains("is-pending"),
  unresolved: r.querySelector(".t-name").classList.contains("is-unresolved"),
  dead: r.classList.contains("is-dead"),
})));

const lists = (page) => page.evaluate(() =>
  JSON.parse(localStorage.getItem("mash.playlists.v1") || "[]"));
const importedStore = (page) => page.evaluate(() =>
  JSON.parse(localStorage.getItem("mash.imported.v1") || "{}"));
const rowCount = (page) => () => page.locator(".trow").count();

/** A stand-in YT IFrame player, installed before the app runs.
 *
 * The suite blocks youtube.com, so the real API never loads and the duration
 * resolver would simply never start. This provides the same surface the
 * resolver uses — cueVideoById, getDuration, and a state-5 (CUED) event — so
 * the production loop runs unchanged against known answers.
 * `durations` maps id -> seconds, or a negative number to raise that error
 * code instead; an id that is absent never answers at all. */
async function fakeYT(page, durations, opts = {}) {
  await page.addInitScript(({ table, delay }) => {
    let current = null;
    // Recorded so a test can assert nothing was ever PLAYED, only cued.
    window.__yt = { cued: [], loaded: [] };
    window.YT = {
      PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, CUED: 5 },
      Player: function (host, opts) {
        const ev = (opts && opts.events) || {};
        this.mute = () => {};
        this.getDuration = () => (current !== null && table[current] > 0 ? table[current] : 0);
        this.cueVideoById = (id) => {
          current = id;
          window.__yt.cued.push(id);
          setTimeout(() => {
            const v = table[id];
            if (v === undefined) return;                 // never answers: timeout
            if (v < 0) ev.onError && ev.onError({ data: -v });
            else ev.onStateChange && ev.onStateChange({ data: 5 });
          }, delay);
        };
        /* Deliberately NOT an alias for cueVideoById. Playing a video reaches
           state 1, never state 5, which is what makes "the resolver plays
           instead of cueing" detectable at all — aliasing them made the two
           indistinguishable and a mutation check went MISSED. */
        this.loadVideoById = (id) => {
          current = id;
          window.__yt.loaded.push(id);
          setTimeout(() => {
            const v = table[id];
            if (v === undefined) return;
            if (v < 0) ev.onError && ev.onError({ data: -v });
            else ev.onStateChange && ev.onStateChange({ data: 1 });   // PLAYING
          }, 5);
        };
        this.pauseVideo = this.stopVideo = this.playVideo = () => {};
        this.getCurrentTime = () => 0;
        setTimeout(() => ev.onReady && ev.onReady({ target: this }), 0);
      },
    };
    if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady();
  }, { table: durations, delay: opts.delay ?? 5 });
}

async function importSheet(page, value = SHEET_ID) {
  await page.click("#plMore");
  await page.click('[data-playlist="new"]');
  await page.fill("#plUrl", value);
  await page.click("#plGo");
}

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
});

test("the library is the default playlist", async ({ page }) => {
  await expect(page.locator("#plCurrent")).toHaveText("Library");
  await expect(page.locator("#brandCount")).toHaveText("1257 tracks");
  expect(await isHittable(page, "#plCurrent")).toMatchObject({ ok: true });
});

test("the picker offers the library and a way to add", async ({ page }) => {
  await page.click("#plMore");
  await expect(page.locator("#plMenu")).toBeVisible();
  const items = await page.$$eval("#plMenu button", (b) => b.map((x) => x.textContent));
  expect(items).toEqual(["Library", "Add playlist…"]);
});

test("a sheet of ids becomes a playlist and the view switches to it", async ({ page }) => {
  await stubSheet(page, "youtubeId\nAAAAAAAAAAA\nBBBBBBBBBBB\nCCCCCCCCCCC\n");
  const asked = await stubOembed(page);
  await importSheet(page);

  await expect(page.locator("#plCurrent")).toHaveText(/Sheet /);
  await expect.poll(rowCount(page)).toBe(3);
  await expect(page.locator("#brandCount")).toHaveText("3 tracks");
  expect(asked.sort()).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC"]);

  // the title came from oEmbed, not from the bare id
  await expect(page.locator(".trow").first()).toContainText("Title AAAAAAAAAAA");
  expect((await lists(page))[0]).toMatchObject({ type: "sheets", source: SHEET_ID });
});

test("full sheet URLs work as well as a bare id", async ({ page }) => {
  await stubSheet(page, "AAAAAAAAAAA\n");
  await stubOembed(page);
  await importSheet(page, `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=42`);
  await expect.poll(rowCount(page)).toBe(1);
});

test("links are accepted in cells, not just bare ids, and duplicates collapse", async ({ page }) => {
  await stubSheet(page, [
    "https://www.youtube.com/watch?v=AAAAAAAAAAA",
    "https://youtu.be/BBBBBBBBBBB",
    "https://www.youtube.com/embed/CCCCCCCCCCC",
    "AAAAAAAAAAA",                       // the same track again
    "not a video",
  ].join("\n"));
  await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(3);
});

test("imported tracks stay out of the library", async ({ page }) => {
  await stubSheet(page, "AAAAAAAAAAA\nBBBBBBBBBBB\n");
  await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(2);

  await page.click("#plMore");
  await page.click('[data-playlist=""]');
  await expect(page.locator("#plCurrent")).toHaveText("Library");
  await expect(page.locator("#brandCount")).toHaveText("1257 tracks");

  /* Search, not a scan of the rendered rows. Imported tracks are appended to
     the end of the library, past position 1,257, and only the first chunk of
     60 renders — so scanning .trow could never have seen them whether they
     were filtered out or not. The mutation harness caught that. */
  await page.fill("#search", "Title AAAAAAAAAAA");
  await expect.poll(rowCount(page)).toBe(0);

  // and the same search inside the playlist does find it
  await page.click("#plMore");
  await page.click(`[data-playlist="${(await lists(page))[0].id}"]`);
  await expect.poll(rowCount(page)).toBe(1);
});

test("a playlist and its tracks survive a reload", async ({ page }) => {
  await stubSheet(page, "AAAAAAAAAAA\nBBBBBBBBBBB\n");
  await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(2);

  await page.reload();
  await expect(page.locator("#plCurrent")).toHaveText(/Sheet /);
  await expect.poll(rowCount(page)).toBe(2);
  // and without asking Google again
  await expect(page.locator(".trow").first()).toContainText("Title AAAAAAAAAAA");
});

test("a track already in the library is reused, not fetched again", async ({ page }) => {
  const known = await page.evaluate(() => window.MASH_TRACKS.find((t) => t.s === "YT").i);
  await stubSheet(page, `${known}\nAAAAAAAAAAA\n`);
  const asked = await stubOembed(page);
  await importSheet(page);

  await expect.poll(rowCount(page)).toBe(2);
  expect(asked).toEqual(["AAAAAAAAAAA"]);          // the known id was not asked about
  expect(Object.keys(await importedStore(page))).toEqual(["YT:AAAAAAAAAAA"]);
});

test("an unshared sheet is reported as a permissions problem", async ({ page }) => {
  /* Google answers an unshared sheet with a sign-in PAGE and a 200. Reporting
     that as "no ids found" sends you looking at the sheet's contents. */
  await stubSheet(page, "<!doctype html><html><head><title>Sign in</title>", { contentType: "text/html" });
  await importSheet(page);
  await expect(page.locator("#plStatus")).toContainText("not shared");
  await expect(page.locator("#plStatus")).toHaveClass(/is-bad/);
  expect(await lists(page)).toEqual([]);
});

test("a sheet with no ids says so, and junk input is rejected", async ({ page }) => {
  await stubSheet(page, "name,email\nAlice,a@example.com\n");
  await importSheet(page);
  await expect(page.locator("#plStatus")).toContainText("No YouTube ids");

  await page.fill("#plUrl", "hello");
  await page.click("#plGo");
  await expect(page.locator("#plStatus")).toContainText("not a Sheets link");
  expect(await lists(page)).toEqual([]);
});

test("the other import methods are offered, and refuse rather than pretend", async ({ page }) => {
  await stubSheet(page, "AAAAAAAAAAA\n");     // would succeed if a type leaked through
  await stubOembed(page);
  await page.click("#plMore");
  await page.click('[data-playlist="new"]');

  for (const type of ["paste", "ytlist", "file", "scset"]) {
    const btn = page.locator(`[data-pltype="${type}"]`);
    await expect(btn).toBeVisible();          // shown, not hidden — the shape is the point
    await expect(btn).toContainText("Not built yet");

    await btn.click();
    await expect(btn).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#plUrl")).toBeDisabled();

    await page.click("#plGo");
    await expect(page.locator("#plStatus")).toContainText("not built yet");
    await expect(page.locator("#plStatus")).toHaveClass(/is-bad/);
  }
  // nothing was created, and the dialog is still open to say so
  expect(await lists(page)).toEqual([]);
  await expect(page.locator("#plModal")).toBeVisible();
});

test("an imported track learns its duration the first time it plays", async ({ page }) => {
  /* oEmbed carries no duration, so imports start at 0 and the readouts
     under-count until the player reports the real one. */
  await stubSheet(page, "AAAAAAAAAAA\n");
  await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(1);

  expect((await importedStore(page))["YT:AAAAAAAAAAA"].d).toBe(0);

  await page.click(".trow");
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("mash:duration", { detail: 212.4 })));
  await expect.poll(async () => (await importedStore(page))["YT:AAAAAAAAAAA"].d).toBe(212);

  await page.reload();
  expect((await importedStore(page))["YT:AAAAAAAAAAA"].d).toBe(212);
});

test("a duration is learned once and not revised afterwards", async ({ page }) => {
  /* The player reports a duration on every clock tick. Without the guard the
     first honest answer would be replaced by whatever an ad or a re-buffer
     reported next. */
  await stubSheet(page, "AAAAAAAAAAA\n");
  await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(1);

  await page.click(".trow");
  const say = (d) => page.evaluate((v) =>
    document.dispatchEvent(new CustomEvent("mash:duration", { detail: v })), d);

  await say(212.4);
  await expect.poll(async () => (await importedStore(page))["YT:AAAAAAAAAAA"].d).toBe(212);
  await say(9);
  await page.waitForTimeout(150);
  expect((await importedStore(page))["YT:AAAAAAAAAAA"].d).toBe(212);
});

test("a built-in track never has its duration overwritten", async ({ page }) => {
  const before = await page.evaluate(() => window.MASH_TRACKS[0].d);
  await page.click(".trow");
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("mash:duration", { detail: 1 })));
  const after = await page.evaluate(() => window.MASH_TRACKS[0].d);
  expect(after).toBe(before);
});

test("the dialog behaves like the app's other dialogs", async ({ page }) => {
  await page.click("#plMore");
  await page.click('[data-playlist="new"]');
  await expect(page.locator("#plModal")).toBeVisible();
  // focus lands on close, not on the action that does something
  expect(await page.evaluate(() => document.activeElement.id)).toBe("plClose");

  await page.keyboard.press("Escape");
  await expect(page.locator("#plModal")).toBeHidden();
});

test("arrow keys inside the dialog do not skip the track underneath", async ({ page }) => {
  await page.click(".trow");
  const playing = () => page.evaluate(() => document.getElementById("npTitle").textContent);
  const before = await playing();

  await page.click("#plMore");
  await page.click('[data-playlist="new"]');
  await page.locator("#plClose").focus();          // a button, not an input
  /* One press, not a pair. ArrowRight followed by ArrowLeft lands back on the
     same track, so the original version of this test passed with the guard
     deleted. */
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(150);

  expect(await playing()).toBe(before);
});


test("a title that 404s marks the track dead rather than pending forever", async ({ page }) => {
  /* One request answers two questions. A title that will never arrive is not
     a slow title, it is a deleted video — measured against a real sheet, 11 of
     the first 60 ids were gone. Recording that here means the unavailable
     count, HIDDEN mode and the replacement finder all work off the same round
     trip that fetched the titles. */
  await stubSheet(page, "AAAAAAAAAAA\nBBBBBBBBBBB\n");
  await stubOembed(page, { gone: ["BBBBBBBBBBB"] });
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(2);

  await expect.poll(async () => (await rowsShown(page))[1].dead).toBe(true);
  const shown = await rowsShown(page);
  expect(shown[0]).toMatchObject({ name: "Title AAAAAAAAAAA", pending: false, dead: false });
  /* The id, alone, and no longer pending: the lookup happened and answered
     with nothing, which is the one case that earns showing it. */
  expect(shown[1]).toMatchObject({ name: "BBBBBBBBBBB", pending: false,
                                   unresolved: true, dead: true });

  await expect(page.locator("#statDead")).toHaveText("1 unavailable");
  const live = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("mash.liveness.v1") || "{}"));
  expect(live["YT:BBBBBBBBBBB"]).toMatchObject({ s: "gone", v: "oembed" });
  expect(live["YT:AAAAAAAAAAA"]).toBeUndefined();
});

test("a request that never lands leaves the track pending, not dead", async ({ page }) => {
  await stubSheet(page, "AAAAAAAAAAA\n");
  await stubOembed(page, { fail: ["AAAAAAAAAAA"] });
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(1);

  const shown = await rowsShown(page);
  /* No verdict, so no id: showing one would claim the lookup was over. */
  expect(shown[0]).toMatchObject({ name: "Resolving\u2026", pending: true,
                                   unresolved: false, dead: false });
  // no verdict was given, so none is recorded
  expect(await page.evaluate(() =>
    localStorage.getItem("mash.liveness.v1"))).toBeNull();
});

test("titles beyond the first screen arrive as their rows do", async ({ page }) => {
  /* The sheet this was built against holds 2,007 ids. Fetching every title up
     front is slow and rude, so the import covers the first chunk and the rest
     backfill on render. */
  const ids = Array.from({ length: 80 }, (_, i) =>
    "Z" + String(i).padStart(4, "0") + "aaaaaa");
  await stubSheet(page, ids.join("\n"));
  const asked = await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(60);          // one chunk rendered

  await expect.poll(async () =>
    (await rowsShown(page)).filter((r) => r.pending).length).toBe(0);
  const firstPass = asked.length;
  expect(firstPass).toBeLessThan(ids.length);          // not all 80 up front

  // reveal the rest, and their titles follow
  await page.evaluate(() => document.getElementById("listMore")?.click()
    || window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(rowCount(page)).toBe(80);
  await expect.poll(async () =>
    (await rowsShown(page)).filter((r) => r.pending).length).toBe(0);
  expect(asked.length).toBe(ids.length);
});


test("durations resolve in the background without playing anything", async ({ page }) => {
  /* oEmbed never returns a duration and videos.list needs a key, but the
     official IFrame API reports one from a CUED video — nothing streams and it
     is not a view. */
  await fakeYT(page, { AAAAAAAAAAA: 211, BBBBBBBBBBB: 355 });
  await page.reload();
  await stubSheet(page, "AAAAAAAAAAA\nBBBBBBBBBBB\n");
  await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(2);

  await expect.poll(async () => (await importedStore(page))["YT:AAAAAAAAAAA"].d).toBe(211);
  await expect.poll(async () => (await importedStore(page))["YT:BBBBBBBBBBB"].d).toBe(355);

  // and the rows show them, without a reload
  await expect.poll(() => page.locator('.trow[data-key="YT:AAAAAAAAAAA"] .t-dur').textContent())
    .toBe("3:31");
  /* Nothing was played. Cueing is not a view and nothing streams — that is
     the entire justification for resolving 2,000 durations this way. */
  const calls = await page.evaluate(() => window.__yt);
  expect(calls.loaded).toEqual([]);
  expect(calls.cued.sort()).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB"]);
  await expect(page.locator("#npTitle")).toHaveText("Nothing playing");
});

test("a track the player refuses is recorded, not retried forever", async ({ page }) => {
  await fakeYT(page, { AAAAAAAAAAA: 211, BBBBBBBBBBB: -150 });   // 150 = embed blocked
  await page.reload();
  await stubSheet(page, "AAAAAAAAAAA\nBBBBBBBBBBB\n");
  await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(2);

  await expect.poll(async () => (await importedStore(page))["YT:AAAAAAAAAAA"].d).toBe(211);
  const live = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("mash.liveness.v1") || "{}"));
  expect(live["YT:BBBBBBBBBBB"]).toMatchObject({ s: "blocked", c: 150 });
  expect((await importedStore(page))["YT:BBBBBBBBBBB"].d).toBe(0);
});

test("resolving picks up where the last session stopped", async ({ page }) => {
  await fakeYT(page, { AAAAAAAAAAA: 211, BBBBBBBBBBB: 355 });
  await page.evaluate(() => {
    localStorage.setItem("mash.imported.v1", JSON.stringify({
      "YT:AAAAAAAAAAA": { k: "YT:AAAAAAAAAAA", s: "YT", i: "AAAAAAAAAAA", t: "One", v: "", d: 211, a: "", c: "" },
      "YT:BBBBBBBBBBB": { k: "YT:BBBBBBBBBBB", s: "YT", i: "BBBBBBBBBBB", t: "Two", v: "", d: 0, a: "", c: "" },
    }));
    localStorage.setItem("mash.playlists.v1", JSON.stringify([
      { id: "p1", name: "Saved", type: "sheets", source: "x",
        keys: ["YT:AAAAAAAAAAA", "YT:BBBBBBBBBBB"], added: 1 },
    ]));
    localStorage.setItem("mash.playlist.v1", JSON.stringify("p1"));
  });
  await page.reload();
  await expect.poll(rowCount(page)).toBe(2);
  await expect.poll(async () => (await importedStore(page))["YT:BBBBBBBBBBB"].d).toBe(355);
});

test("a title still arriving says so and shows no id at all", async ({ page }) => {
  /* The id is not a placeholder. Until a lookup has answered, the honest thing
     is to say the lookup is running — an id here reads both as a track called
     that and as a finished answer, and it is neither. */
  await stubSheet(page, "AAAAAAAAAAA\n");
  await stubOembed(page, { fail: ["AAAAAAAAAAA"] });
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(1);
  await expect(page.locator(".t-name").first()).toHaveText("Resolving\u2026");
  await expect(page.locator(".t-name").first()).not.toContainText("AAAAAAAAAAA");
});


test("durations are saved as they resolve, not only when the run ends", async ({ page }) => {
  /* A 2,000-track run takes about 17 minutes. Writing only at the end means a
     reload or a closed tab throws all of it away — which is exactly what
     happened against the real sheet: 157 durations resolved in memory and none
     survived. */
  const ids = Array.from({ length: 30 }, (_, i) => "D" + String(i).padStart(4, "0") + "aaaaaa");
  const table = {};
  ids.forEach((id, i) => { table[id] = 100 + i; });
  await fakeYT(page, table, { delay: 60 });     // slow enough to observe mid-run
  await page.reload();

  await stubSheet(page, ids.join("\n"));
  await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(30);

  // some are on disk well before all 30 are done
  await expect.poll(async () => {
    const imp = await importedStore(page);
    return Object.values(imp).filter((v) => v.d > 0).length;
  }, { timeout: 15_000 }).toBeGreaterThanOrEqual(10);

  const partial = Object.values(await importedStore(page)).filter((v) => v.d > 0).length;
  expect(partial).toBeLessThan(30);             // and the run is still going
});


/* ---------------------------------------------------------- the resolve API */

/** Configure a resolve endpoint before the page loads. config.js keeps any
 *  value already set, which is what makes this possible. */
const setApi = (page) =>
  page.addInitScript(() => { window.MASH_CONFIG = { metaApi: "https://stub.test/api/resolve" }; });

/** Answer that endpoint the way server/api/resolve.js would. */
async function stubApi(page, table, opts = {}) {
  const calls = [];
  await page.route("**/stub.test/api/resolve*", async (route) => {
    const ids = new URL(route.request().url()).searchParams.get("ids").split(",");
    calls.push(ids);
    if (opts.status && opts.status !== 200) {
      return route.fulfill({ status: opts.status, contentType: "application/json",
                             body: JSON.stringify({ error: "nope" }) });
    }
    const out = {};
    for (const id of ids) if (table[id]) out["YT:" + id] = table[id];
    await route.fulfill({ status: 200, contentType: "application/json",
                          body: JSON.stringify(out) });
  });
  return calls;
}

test("the API tier resolves a batch, sparing oEmbed and the cue player", async ({ page }) => {
  await setApi(page);
  const calls = await stubApi(page, {
    AAAAAAAAAAA: { t: "API Title A", v: "Chan", d: 253, a: "", e: true },
    BBBBBBBBBBB: { t: "API Title B", v: "Chan", d: 411, a: "", e: true },
  });
  await fakeYT(page, {});                       // a cue would hang, proving none happens
  await page.reload();

  await stubSheet(page, "AAAAAAAAAAA\nBBBBBBBBBBB\n");
  const asked = await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(2);

  await expect(page.locator(".trow").first()).toContainText("API Title A");
  await expect(page.locator('.trow[data-key="YT:AAAAAAAAAAA"] .t-dur')).toHaveText("4:13");
  expect(asked).toEqual([]);                    // oEmbed untouched
  expect(await page.evaluate(() => window.__yt.cued)).toEqual([]);
  expect(calls.length).toBe(1);                 // one request for both ids
});

test("the API falls back to oEmbed when it cannot answer", async ({ page }) => {
  /* 429 is quota, 503 is a missing key, 502 is upstream trouble. None of them
     should break an import — the keyless path is still there. */
  await setApi(page);
  await stubApi(page, {}, { status: 429 });
  await fakeYT(page, { AAAAAAAAAAA: 180 });
  await page.reload();

  await stubSheet(page, "AAAAAAAAAAA\n");
  const asked = await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(1);

  await expect(page.locator(".trow").first()).toContainText("Title AAAAAAAAAAA");
  expect(asked).toEqual(["AAAAAAAAAAA"]);       // oEmbed picked it up
  await expect.poll(async () => (await importedStore(page))["YT:AAAAAAAAAAA"].d).toBe(180);
});

test("the API records gone and blocked, not just titles", async ({ page }) => {
  await setApi(page);
  await stubApi(page, {
    AAAAAAAAAAA: { t: "Fine", v: "C", d: 100, a: "", e: true },
    BBBBBBBBBBB: { t: "No embedding", v: "C", d: 200, a: "", e: false },
    CCCCCCCCCCC: { gone: true },
  });
  await fakeYT(page, {});
  await page.reload();
  await stubSheet(page, "AAAAAAAAAAA\nBBBBBBBBBBB\nCCCCCCCCCCC\n");
  await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(3);

  await expect.poll(async () => {
    const l = await page.evaluate(() => JSON.parse(localStorage.getItem("mash.liveness.v1") || "{}"));
    return l["YT:BBBBBBBBBBB"]?.s;
  }).toBe("blocked");
  await expect(page.locator("#statDead")).toHaveText("2 unavailable");
});

test("no API configured keeps the keyless path exactly as it was", async ({ page }) => {
  await fakeYT(page, { AAAAAAAAAAA: 195 });
  await page.reload();
  await stubSheet(page, "AAAAAAAAAAA\n");
  const asked = await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(1);
  expect(asked).toEqual(["AAAAAAAAAAA"]);
  await expect.poll(async () => (await importedStore(page))["YT:AAAAAAAAAAA"].d).toBe(195);
});


test("a failing API is asked once, not once per batch", async ({ page }) => {
  /* Falling back is not enough: an endpoint that just returned 429 will return
     429 for the next batch too, and asking anyway is a burst of pointless
     requests at something already known to be down. */
  await setApi(page);
  const calls = await stubApi(page, {}, { status: 429 });
  const ids = Array.from({ length: 60 }, (_, i) => "E" + String(i).padStart(4, "0") + "aaaaaa");
  await fakeYT(page, {});
  await page.reload();

  await stubSheet(page, ids.join("\n"));
  const asked = await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(60);

  // 60 ids is two batches of 50 and 10; the second must never be attempted
  expect(calls.length).toBe(1);
  await expect.poll(() => asked.length).toBe(60);      // and oEmbed covered them all
});


test("with an endpoint the whole playlist resolves, not just the visible rows", async ({ page }) => {
  /* The reason this exists: backfilling per rendered chunk meant a 2,007-track
     sheet only resolved as far as you scrolled, while the cue resolver spent
     ~17 minutes on durations the same API call already returns. */
  const ids = Array.from({ length: 120 }, (_, i) => "F" + String(i).padStart(4, "0") + "aaaaaa");
  const table = {};
  ids.forEach((id, i) => { table[id] = { t: "Title " + id, v: "C", d: 100 + i, a: "", e: true }; });

  await setApi(page);
  const calls = await stubApi(page, table);
  await fakeYT(page, {});                       // a cue would hang, proving none is needed
  await page.reload();

  await stubSheet(page, ids.join("\n"));
  const asked = await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(60);   // one chunk rendered, as always

  // every track resolved, including the 60 never rendered
  await expect.poll(async () => {
    const imp = await importedStore(page);
    return Object.values(imp).filter((v) => v.t && v.d).length;
  }, { timeout: 20_000 }).toBe(120);

  expect(asked).toEqual([]);                    // oEmbed never needed
  expect(await page.evaluate(() => window.__yt.cued)).toEqual([]);  // nor cueing
  expect(calls.length).toBeLessThanOrEqual(4);  // 120 ids in batches of 50
});

test("without an endpoint it still only resolves what is rendered", async ({ page }) => {
  /* The per-chunk behaviour is right when each title costs its own request —
     you pay only for what you look at. */
  const ids = Array.from({ length: 120 }, (_, i) => "G" + String(i).padStart(4, "0") + "aaaaaa");
  await fakeYT(page, {});
  await page.reload();
  await stubSheet(page, ids.join("\n"));
  const asked = await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(60);

  await expect.poll(() => asked.length, { timeout: 20_000 }).toBe(60);
  await page.waitForTimeout(500);
  expect(asked.length).toBe(60);                // and not the other 60
});


test("ids the endpoint cannot answer do not spin the resolver forever", async ({ page }) => {
  /* The bulk loop asks for whatever is still unresolved. If the endpoint
     answers 200 but omits an id — a video it knows nothing about — that id is
     still unresolved on the next pass, and without striking it off the loop
     asks for it again, and again. */
  await setApi(page);
  const calls = await stubApi(page, {
    AAAAAAAAAAA: { t: "Answered", v: "C", d: 120, a: "", e: true },
    // BBBBBBBBBBB deliberately absent from the table
  });
  await fakeYT(page, {});
  await page.reload();

  await stubSheet(page, "AAAAAAAAAAA\nBBBBBBBBBBB\n");
  /* BBBBBBBBBBB must be genuinely unresolvable. A plain oEmbed stub answers
     everything, which resolved it through the fallback and left the loop with
     nothing to spin on — the mutation check went MISSED until this aborted
     instead. An aborted request records no verdict by design, so the id stays
     unresolved, which is exactly the case that could loop. */
  await stubOembed(page, { fail: ["BBBBBBBBBBB"] });
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(2);
  await expect.poll(async () => (await importedStore(page))["YT:AAAAAAAAAAA"].t).toBe("Answered");

  // settle, then confirm it stopped asking rather than looping
  await page.waitForTimeout(1500);
  const settled = calls.length;
  await page.waitForTimeout(1500);
  expect(calls.length).toBe(settled);
  expect(settled).toBeLessThan(6);
});


test("the suite is hermetic against whatever config.js is deployed with", async ({ page }) => {
  /* config.js carries a real endpoint once the site is deployed, and every
     test inherits it — which is how five specs started calling a live service
     and failing, because it correctly reported their fake ids as gone.

     blockExternal() also blocks vercel.app, but that is a guess about where
     the endpoint is hosted. This is the guard that holds wherever it lives. */
  expect(await page.evaluate(() => window.MASH_CONFIG.metaApi)).toBe("");
});


/* ------------------------------------------- what the API replaced the sidecar with
 *
 * A committed data/meta.json used to sit in front of the API, written by a
 * tools script on a machine that had a key. It was removed: it returned
 * exactly what the endpoint returns and had to be regenerated by hand. These
 * two tests came from it, because the behaviour they cover is the API's now. */

test("the API corrects a playlist imported before the endpoint existed", async ({ page }) => {
  /* A machine that imported with no endpoint has oEmbed titles and no
     durations. When an endpoint is configured, videos.list is the more
     authoritative source and should correct them in place, without a
     re-import. */
  await page.evaluate(() => {
    localStorage.setItem("mash.imported.v1", JSON.stringify({
      "YT:AAAAAAAAAAA": { k: "YT:AAAAAAAAAAA", s: "YT", i: "AAAAAAAAAAA",
                          t: "oembed title", v: "", d: 0, a: "", c: "" },
    }));
    localStorage.setItem("mash.playlists.v1", JSON.stringify([
      { id: "p1", name: "Old", type: "sheets", source: "x", keys: ["YT:AAAAAAAAAAA"], added: 1 },
    ]));
    localStorage.setItem("mash.playlist.v1", JSON.stringify("p1"));
  });
  await setApi(page);
  await stubApi(page, {
    AAAAAAAAAAA: { t: "Authoritative Title", v: "Chan", d: 321, a: "", e: true },
  });
  await fakeYT(page, {});
  await page.reload();

  await expect.poll(rowCount(page)).toBe(1);
  await expect(page.locator(".t-name").first()).toHaveText("Authoritative Title");
  await expect(page.locator(".t-dur").first()).toHaveText("5:21");
  expect((await importedStore(page))["YT:AAAAAAAAAAA"].d).toBe(321);
});

/* The sidecar's "verdicts re-applied on every load" test died with it, and
 * deliberately has no replacement. It existed because a committed file could
 * arrive AFTER the records it described, so a record already carrying its
 * fields still needed its verdict read off. The API cannot arrive after the
 * records it wrote: whatever wrote the fields recorded the verdict in the same
 * pass. Nothing re-asks about a complete record now, which is the point of the
 * budget. */


/* ------------------------------------------------------ the daily resolve budget */

/** Pre-spend the day's allowance, leaving `left` ids of it. */
const spendBudget = (page, left) => page.addInitScript((remaining) => {
  localStorage.setItem("mash.metabudget.v1", JSON.stringify({
    day: new Date().toISOString().slice(0, 10),
    spent: 10000 - remaining,
  }));
}, left);

test("the resolver stops at the daily limit instead of resolving anyway", async ({ page }) => {
  await setApi(page);
  await spendBudget(page, 0);
  const calls = await stubApi(page, {
    AAAAAAAAAAA: { t: "Would have resolved", v: "C", d: 100, a: "", e: true },
  });
  await fakeYT(page, {});
  await page.reload();

  await stubSheet(page, "AAAAAAAAAAA\n");
  const asked = await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(1);
  await page.waitForTimeout(800);

  expect(calls.length).toBe(0);                 // the endpoint was never asked
  expect(asked).toEqual([]);                    // and it did NOT fall back
});

test("hitting the limit is reported as waiting, never as a failed track", async ({ page }) => {
  /* The distinction the whole budget rests on. An id we chose not to ask about
     today is not an id that came back with nothing: it keeps saying it is
     resolving, shows no id, records no verdict, and is picked up tomorrow. */
  await setApi(page);
  await spendBudget(page, 0);
  await stubApi(page, {});
  await fakeYT(page, {});
  await page.reload();

  await stubSheet(page, "AAAAAAAAAAA\n");
  await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(1);

  await expect(page.locator("#statNote")).toContainText("daily resolve limit");
  const shown = await rowsShown(page);
  expect(shown[0]).toMatchObject({ name: "Resolving\u2026", pending: true, unresolved: false });
  expect((await importedStore(page))["YT:AAAAAAAAAAA"].x).toBeUndefined();
  expect(await page.evaluate(() =>
    localStorage.getItem("mash.liveness.v1"))).toBeNull();
});

test("a run spends one unit of budget per id asked about", async ({ page }) => {
  const ids = Array.from({ length: 60 }, (_, i) => "H" + String(i).padStart(4, "0") + "aaaaaa");
  const table = {};
  ids.forEach((id, i) => { table[id] = { t: "T" + i, v: "C", d: 100, a: "", e: true }; });

  await setApi(page);
  await stubApi(page, table);
  await fakeYT(page, {});
  await page.reload();

  await stubSheet(page, ids.join("\n"));
  await stubOembed(page);
  await importSheet(page);
  await expect.poll(async () => {
    const imp = await importedStore(page);
    return Object.values(imp).filter((v) => v.t).length;
  }, { timeout: 20_000 }).toBe(60);

  const led = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("mash.metabudget.v1") || "{}"));
  expect(led.spent).toBe(60);
  expect(led.day).toBe(new Date().toISOString().slice(0, 10));
});

test("a budget only partly spent still resolves what it can", async ({ page }) => {
  /* 30 left and 60 wanted. The point is that it resolves 30 rather than
     refusing outright, and that the rest wait rather than failing. */
  const ids = Array.from({ length: 60 }, (_, i) => "J" + String(i).padStart(4, "0") + "aaaaaa");
  const table = {};
  ids.forEach((id, i) => { table[id] = { t: "T" + i, v: "C", d: 100, a: "", e: true }; });

  await setApi(page);
  await spendBudget(page, 30);
  await stubApi(page, table);
  await fakeYT(page, {});
  await page.reload();

  await stubSheet(page, ids.join("\n"));
  const asked = await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(60);

  await expect.poll(async () => {
    const imp = await importedStore(page);
    return Object.values(imp).filter((v) => v.t).length;
  }, { timeout: 20_000 }).toBe(30);

  await page.waitForTimeout(800);
  const imp = await importedStore(page);
  expect(Object.values(imp).filter((v) => v.t).length).toBe(30);   // and no further
  expect(Object.values(imp).filter((v) => v.x).length).toBe(0);    // none marked failed
  expect(asked).toEqual([]);                                       // no keyless overspill
});

test("a failed id keeps showing its id across a reload", async ({ page }) => {
  /* The verdict is on the record, not in a set, precisely so this holds. If it
     were in memory the row would go back to claiming it was still resolving
     every time the page loaded, and re-ask about a video already known gone. */
  await setApi(page);
  await stubApi(page, { AAAAAAAAAAA: { gone: true } });
  await fakeYT(page, {});
  await page.reload();

  await stubSheet(page, "AAAAAAAAAAA\n");
  await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(1);
  await expect.poll(async () => (await rowsShown(page))[0].unresolved).toBe(true);
  expect((await importedStore(page))["YT:AAAAAAAAAAA"].x).toBe(1);

  await page.reload();
  await expect.poll(rowCount(page)).toBe(1);
  const shown = await rowsShown(page);
  expect(shown[0]).toMatchObject({ name: "AAAAAAAAAAA", pending: false, unresolved: true });
});
