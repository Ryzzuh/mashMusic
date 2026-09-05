import { test, expect } from "@playwright/test";

test("the page loads and the dataset is present", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("mashmusic");
  const count = await page.evaluate(() => window.MASH_TRACKS.length);
  expect(count).toBe(1257);
});
