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

/** Rows as the reader sees them: name, whether it is still provisional. */
const rowsShown = (page) => page.$$eval(".trow", (rs) => rs.map((r) => ({
  name: r.querySelector(".t-name").textContent,
  pending: r.querySelector(".t-name").classList.contains("is-pending"),
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
  expect(shown[1]).toMatchObject({ name: "Resolving — BBBBBBBBBBB", pending: true, dead: true });

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
  expect(shown[0]).toMatchObject({ name: "Resolving — AAAAAAAAAAA", pending: true, dead: false });
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

test("a title still arriving says so instead of showing a bare id", async ({ page }) => {
  await stubSheet(page, "AAAAAAAAAAA\n");
  await stubOembed(page, { fail: ["AAAAAAAAAAA"] });
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(1);
  await expect(page.locator(".t-name").first()).toHaveText("Resolving — AAAAAAAAAAA");
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


/* ---------------------------------------------------- the metadata sidecar */

/** Serve data/meta.json, as tools/resolve-meta.mjs would have written it. */
async function stubMeta(page, body) {
  await page.route("**/data/meta.json", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

test("a committed sidecar resolves an import with no lookups at all", async ({ page }) => {
  /* The point of tools/resolve-meta.mjs: run it once where a key exists,
     commit the output, and every other machine resolves instantly without a
     key, without oEmbed and without cueing anything. */
  await stubMeta(page, {
    "YT:AAAAAAAAAAA": { t: "Real Title A", v: "Real Channel", d: 253, a: "", e: true },
    "YT:BBBBBBBBBBB": { t: "Real Title B", v: "Real Channel", d: 411, a: "", e: true },
  });
  await fakeYT(page, {});                       // any cue would hang, proving none happens
  await page.reload();

  await stubSheet(page, "AAAAAAAAAAA\nBBBBBBBBBBB\n");
  const asked = await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(2);

  await expect(page.locator(".trow").first()).toContainText("Real Title A");
  await expect(page.locator('.trow[data-key="YT:AAAAAAAAAAA"] .t-dur')).toHaveText("4:13");
  await expect(page.locator('.trow[data-key="YT:BBBBBBBBBBB"] .t-dur')).toHaveText("6:51");

  expect(asked).toEqual([]);                    // oEmbed was never called
  const cued = await page.evaluate(() => window.__yt.cued);
  expect(cued).toEqual([]);                     // and nothing was cued
});

test("the sidecar carries embeddable, which neither oEmbed nor a cue reports", async ({ page }) => {
  await stubMeta(page, {
    "YT:AAAAAAAAAAA": { t: "Fine", v: "C", d: 100, a: "", e: true },
    "YT:BBBBBBBBBBB": { t: "Embedding off", v: "C", d: 200, a: "", e: false },
    "YT:CCCCCCCCCCC": { gone: true },
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
  const live = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("mash.liveness.v1") || "{}"));
  expect(live["YT:BBBBBBBBBBB"]).toMatchObject({ s: "blocked", v: "api" });
  expect(live["YT:CCCCCCCCCCC"]).toMatchObject({ s: "gone", v: "api" });
  expect(live["YT:AAAAAAAAAAA"]).toBeUndefined();
  await expect(page.locator("#statDead")).toHaveText("2 unavailable");
});

test("the sidecar fixes up a playlist imported before it existed", async ({ page }) => {
  /* The machine that imported first has oEmbed titles and no durations. When
     the sidecar lands it should correct them in place, not require a re-import. */
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
  await stubMeta(page, {
    "YT:AAAAAAAAAAA": { t: "Authoritative Title", v: "Chan", d: 321, a: "", e: true },
  });
  await fakeYT(page, {});
  await page.reload();

  await expect.poll(rowCount(page)).toBe(1);
  await expect(page.locator(".t-name").first()).toHaveText("Authoritative Title");
  await expect(page.locator(".t-dur").first()).toHaveText("5:21");
  expect((await importedStore(page))["YT:AAAAAAAAAAA"].d).toBe(321);
});

test("no sidecar changes nothing", async ({ page }) => {
  await page.route("**/data/meta.json", (r) => r.fulfill({ status: 404, body: "" }));
  await fakeYT(page, { AAAAAAAAAAA: 150 });
  await page.reload();
  await stubSheet(page, "AAAAAAAAAAA\n");
  const asked = await stubOembed(page);
  await importSheet(page);
  await expect.poll(rowCount(page)).toBe(1);

  // falls straight back to the keyless path
  expect(asked).toEqual(["AAAAAAAAAAA"]);
  await expect.poll(async () => (await importedStore(page))["YT:AAAAAAAAAAA"].d).toBe(150);
});


test("the sidecar's verdicts are applied on every load, not only when fields change", async ({ page }) => {
  /* A returning session: the imported records already match the sidecar
     exactly, so the field copying is skipped. The gone/blocked verdicts must
     still be recorded — they are facts about the track, not a side effect of
     writing a title. Getting this order wrong meant an import that had already
     pre-filled its fields recorded no blocked tracks at all. */
  await page.evaluate(() => {
    localStorage.setItem("mash.imported.v1", JSON.stringify({
      "YT:AAAAAAAAAAA": { k: "YT:AAAAAAAAAAA", s: "YT", i: "AAAAAAAAAAA",
                          t: "Settled", v: "C", d: 240, a: "", c: "" },
    }));
    localStorage.setItem("mash.playlists.v1", JSON.stringify([
      { id: "p1", name: "Saved", type: "sheets", source: "x",
        keys: ["YT:AAAAAAAAAAA"], added: 1 },
    ]));
    localStorage.setItem("mash.playlist.v1", JSON.stringify("p1"));
    localStorage.removeItem("mash.liveness.v1");        // nothing recorded yet
  });
  // identical title and duration, so the copy is short-circuited
  await stubMeta(page, {
    "YT:AAAAAAAAAAA": { t: "Settled", v: "C", d: 240, a: "", e: false },
  });
  await fakeYT(page, {});
  await page.reload();

  await expect.poll(async () => {
    const l = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("mash.liveness.v1") || "{}"));
    return l["YT:AAAAAAAAAAA"]?.s;
  }).toBe("blocked");
  await expect(page.locator("#statDead")).toHaveText("1 unavailable");
});
