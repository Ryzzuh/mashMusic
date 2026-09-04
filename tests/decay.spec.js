import { test, expect } from "@playwright/test";
import { blockExternal } from "./helpers.js";

/* Jukebox 3: a track leaves the list once it has been played to the end.
 *
 * Completion is driven through the "mash:completed" event, because both
 * players' end events fire inside a cross-origin iframe and cannot be
 * synthesised from outside it. Everything else here drives real controls. */

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
});

const finish = (page) =>
  page.evaluate(() => document.dispatchEvent(new Event("mash:completed")));

const stored = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("mash.played.v1") || "[]"));

/* The library contains real duplicates — the same title under several ids —
 * so searching a title does not isolate one track. These tests need one that
 * appears exactly once. */
const uniqueTitled = (page) =>
  page.evaluate(() => {
    const counts = new Map();
    for (const t of window.MASH_TRACKS)
      counts.set(t.t, (counts.get(t.t) || 0) + 1);
    return window.MASH_TRACKS.find((t) => counts.get(t.t) === 1 && t.t.length > 12);
  });

const total = (page) =>
  page.evaluate(() => {
    const m = /showing \d+ \/ (\d+)/.exec(document.getElementById("statLoaded").textContent);
    return m ? Number(m[1]) : null;
  });

test("a track played to the end leaves the list and is remembered", async ({ page }) => {
  const key = await page.evaluate(() => window.MASH_TRACKS[0].k);
  await page.locator(".trow").first().click();
  expect(await total(page)).toBe(1257);

  await finish(page);
  await expect.poll(() => total(page)).toBe(1256);
  expect(await stored(page)).toEqual([key]);
  expect(await page.evaluate((k) =>
    !document.querySelector(`.trow[data-key="${k}"]`), key)).toBe(true);
});

test("skipping is not listening", async ({ page }) => {
  /* The whole point of binding to ENDED/FINISH rather than to next(): a track
   * you skipped past has not been heard and must stay in the library. */
  await page.locator(".trow").first().click();
  for (let i = 0; i < 3; i++) await page.click("#bNext");
  await page.waitForTimeout(400);

  expect(await stored(page)).toEqual([]);
  expect(await total(page)).toBe(1257);
  await expect(page.locator("#statPlayed")).toBeHidden();
});

test("playback continues with whatever moved up into the gap", async ({ page }) => {
  const next = await page.evaluate(() => window.MASH_TRACKS[1].t);
  await page.locator(".trow").first().click();
  await finish(page);

  // the finished track is gone, so everything after it shifted up by one —
  // resuming by track rather than by position would skip this one
  await expect.poll(() => page.locator("#npTitle").textContent()).toBe(next);
});

test("the decay survives a reload", async ({ page }) => {
  await page.locator(".trow").first().click();
  await finish(page);
  await expect.poll(() => total(page)).toBe(1256);

  await page.reload();
  await expect.poll(() => total(page)).toBe(1256);
  await expect(page.locator("#statPlayed")).toHaveText(/1 played/);
});

test("the reset control counts what is hidden and brings it back", async ({ page }) => {
  await expect(page.locator("#statPlayed")).toBeHidden();

  for (let i = 0; i < 3; i++) {
    await page.locator(".trow").first().click();
    await finish(page);
    await expect.poll(() => total(page)).toBe(1257 - (i + 1));
  }
  await expect(page.locator("#statPlayed")).toHaveText(/3 played/);

  await page.click("#statPlayed");
  await expect.poll(() => total(page)).toBe(1257);
  await expect(page.locator("#statPlayed")).toBeHidden();
  expect(await stored(page)).toEqual([]);
});

test("the row pops before it goes", async ({ page }) => {
  const key = await page.evaluate(() => window.MASH_TRACKS[0].k);
  await page.locator(".trow").first().click();

  // catch the class while it is on: the row is removed when the animation ends
  await page.evaluate((k) => {
    window.__popped = false;
    const row = document.querySelector(`.trow[data-key="${k}"]`);
    new MutationObserver(() => {
      if (row.classList.contains("is-popping")) window.__popped = true;
    }).observe(row, { attributes: true, attributeFilter: ["class"] });
  }, key);

  await finish(page);
  await expect.poll(() => page.evaluate(() => window.__popped)).toBe(true);
  await expect.poll(() => total(page)).toBe(1256);
});

test("a played track is gone from every surface, not just the rows", async ({ page }) => {
  /* The predicate lives in buildView(), so search, the counts and the
   * contributor totals all narrow together or none of them do. */
  const t = await uniqueTitled(page);
  await page.fill("#search", t.t);
  await expect.poll(() => page.locator(".trow").count()).toBe(1);
  await page.locator(".trow").first().click();
  await finish(page);

  await expect.poll(() => page.locator(".trow").count()).toBe(0);
  await page.fill("#search", "");
  await expect.poll(() => total(page)).toBe(1256);
});

test("finishing the last track in a view empties it without breaking", async ({ page }) => {
  const t = await uniqueTitled(page);
  await page.fill("#search", t.t);
  await expect.poll(() => page.locator(".trow").count()).toBe(1);

  await page.locator(".trow").first().click();
  await finish(page);
  await expect.poll(() => page.locator(".trow").count()).toBe(0);

  // and the app is still alive: clearing the search brings the rest back
  await page.fill("#search", "");
  await expect.poll(() => page.locator(".trow").count()).toBeGreaterThan(10);
  await expect.poll(() => total(page)).toBe(1256);
});
