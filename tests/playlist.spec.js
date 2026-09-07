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

/** Serve oEmbed metadata; returns the ids asked about. */
async function stubOembed(page) {
  const seen = [];
  await page.route(OEMBED, async (route) => {
    const u = new URL(route.request().url());
    const id = new URL(u.searchParams.get("url")).searchParams.get("v");
    seen.push(id);
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

const lists = (page) => page.evaluate(() =>
  JSON.parse(localStorage.getItem("mash.playlists.v1") || "[]"));
const importedStore = (page) => page.evaluate(() =>
  JSON.parse(localStorage.getItem("mash.imported.v1") || "{}"));
const rowCount = (page) => () => page.locator(".trow").count();

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
