import { test, expect } from "@playwright/test";
import { blockExternal, stubImage, playFirstMatch } from "./helpers.js";

/* YouTube answers 200 with a 120x90 grey stub for videos it has lost rather
 * than 404ing, so image size is the only signal that the art is real. */

test("a real thumbnail shows the cover tile", async ({ page }) => {
  await blockExternal(page);
  await stubImage(page, /ytimg\.com\/vi\/.*hqdefault\.jpg/, 480, 360);
  await page.goto("/");
  await playFirstMatch(page, "Ben Pearce");

  await expect(page.locator("#artPanel")).toBeVisible();
  const nat = await page.evaluate(() => {
    const i = document.getElementById("artImg");
    return [i.naturalWidth, i.naturalHeight];
  });
  expect(nat).toEqual([480, 360]);
});

test("a 120x90 stub hides the tile instead of showing a grey square", async ({ page }) => {
  await blockExternal(page);
  await stubImage(page, /ytimg\.com\/vi\/.*(hqdefault|default)\.jpg/, 120, 90);
  await page.goto("/");
  await playFirstMatch(page, "Ben Pearce");

  await expect.poll(() => page.locator("#artPanel").isHidden()).toBe(true);
});

test("with no artwork the spectrum takes the full width", async ({ page }) => {
  await blockExternal(page);
  await stubImage(page, /ytimg\.com\/vi\/.*\.jpg/, 120, 90);
  await page.goto("/");

  const strip = await page.evaluate(() => document.querySelector(".stage-strip").getBoundingClientRect().width);
  await playFirstMatch(page, "Ben Pearce");
  await expect.poll(() => page.locator("#artPanel").isHidden()).toBe(true);

  const eq = await page.evaluate(() => document.querySelector(".eq").getBoundingClientRect().width);
  expect(Math.round(eq)).toBe(Math.round(strip));
});
