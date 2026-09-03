import { test, expect } from "@playwright/test";
import { blockExternal, playFirstMatch, isHittable, rects } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
});

test("the flank mirrors the tracklist's own columns", async ({ page }) => {
  const r = await rects(page, [
    ".tflank-left", ".tflank-fav", "#tJump", ".trow .t-fav", ".trow .t-index", ".trow .t-main",
  ]);

  // the box ends at the midpoint of the gap between number and name
  const midpoint = (r[".trow .t-index"].right + r[".trow .t-main"].left) / 2;
  expect(Math.abs(r[".tflank-left"].right - midpoint)).toBeLessThanOrEqual(1);

  // heart above the row hearts, jump above the track numbers
  expect(Math.abs(r[".tflank-fav"].left - r[".trow .t-fav"].left)).toBeLessThanOrEqual(1);
  expect(Math.abs(r["#tJump"].left - r[".trow .t-index"].left)).toBeLessThanOrEqual(1);
});

test("both flanks and their controls are actually on screen", async ({ page }) => {
  for (const sel of ["#tFav", "#tJump", "#tTop", "#tBottom", "#fltYT", "#fltSC", "#mAllRemain"]) {
    expect(await isHittable(page, sel), sel).toMatchObject({ ok: true });
  }
});

test("jump to current brings the playing row into view", async ({ page }) => {
  await playFirstMatch(page, "Ben Pearce");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400);

  await page.click("#tJump");
  await page.waitForTimeout(700);                 // smooth scroll

  const onScreen = await page.evaluate(() => {
    const row = document.querySelector('.trow[aria-current="true"]');
    if (!row) return false;
    const r = row.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
  expect(onScreen).toBe(true);
});

test("the tab jumps to the top and to the bottom of the list", async ({ page }) => {
  await page.click("#tBottom");
  await page.waitForTimeout(900);
  // the bottom of a windowed list means rendering the rest of it first
  expect(await page.locator(".trow").count()).toBe(1257);
  await expect(page.locator("#listEnd")).toBeVisible();

  await page.click("#tTop");
  await page.waitForTimeout(900);
  // "the top of the tracklisting", not the top of the document — the stage,
  // scrubber and transport sit above it
  const listTop = await page.evaluate(() =>
    Math.round(document.getElementById("tracklist").getBoundingClientRect().top));
  expect(Math.abs(listTop)).toBeLessThan(30);
});

test("the source switch filters the list", async ({ page }) => {
  const total = await page.evaluate(() => window.MASH_TRACKS.length);
  const yt = await page.evaluate(() => window.MASH_TRACKS.filter((t) => t.s === "YT").length);

  await page.click("#fltSC");                     // YouTube only
  await expect(page.locator("#fltSC")).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() => page.evaluate(() => document.getElementById("statLoaded").textContent))
    .toContain(String(yt));

  await page.click("#fltSC");
  await expect
    .poll(() => page.evaluate(() => document.getElementById("statLoaded").textContent))
    .toContain(String(total));
});

test("turning off both sources falls back to showing everything", async ({ page }) => {
  await page.click("#fltYT");
  await page.click("#fltSC");                     // would leave an empty library
  const pressed = await page.$$eval("[data-source]", (els) =>
    els.map((e) => e.getAttribute("aria-pressed")));
  expect(pressed).toEqual(["true", "true"]);
  expect(await page.locator(".trow").count()).toBeGreaterThan(0);
});

test("the source filter survives a reload", async ({ page }) => {
  await page.click("#fltSC");
  await page.reload();
  await expect(page.locator("#fltSC")).toHaveAttribute("aria-pressed", "false");
});

test("the readouts reflect what is queued", async ({ page }) => {
  const before = await page.evaluate(() => ({
    tracks: document.getElementById("mTracksLeft").textContent,
    all: document.getElementById("mAllRemain").textContent,
  }));
  expect(Number(before.tracks)).toBe(1257);       // nothing playing yet
  expect(before.all).toMatch(/^\d+:\d{2}(:\d{2})?$/);

  await playFirstMatch(page, "Ben Pearce");
  await expect
    .poll(() => page.evaluate(() => Number(document.getElementById("mTracksLeft").textContent)))
    .toBeLessThan(1257);
  await expect(page.locator("#mTrackRemain")).not.toHaveText("--:--");
});

test("the transport heart and the row heart stay in step", async ({ page }) => {
  const key = await playFirstMatch(page, "Ben Pearce");
  const rowHeart = page.locator(`.trow[data-key="${key}"] .t-fav`);

  await expect(page.locator("#tFav")).toHaveAttribute("aria-pressed", "false");
  await page.click("#tFav");
  await expect(page.locator("#tFav")).toHaveAttribute("aria-pressed", "true");
  await expect(rowHeart).toHaveAttribute("aria-pressed", "true");

  await rowHeart.click();
  await expect(page.locator("#tFav")).toHaveAttribute("aria-pressed", "false");
});
