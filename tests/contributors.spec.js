import { test, expect } from "@playwright/test";
import { blockExternal, isHittable } from "./helpers.js";

/* The contributor panel doubles as a filter. Because the predicate lives in
 * buildView(), it has to reach every surface that reads state.view. */

const openPanel = (page) => page.click("#btnContrib");

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  // Playwright gives each test a fresh context, so localStorage starts empty.
  // An addInitScript that cleared it would also fire on reload and wipe the
  // very selection the persistence test is checking.
  await page.goto("/");
});

test("all contributors start selected and nothing is filtered", async ({ page }) => {
  await openPanel(page);
  await expect(page.locator(".contrib")).toHaveCount(71);
  const pressed = await page.locator('.contrib[aria-pressed="true"]').count();
  expect(pressed).toBe(71);
  await expect(page.locator("#contribFilterDot")).toBeHidden();
  await expect(page.locator("#contribSub")).toHaveText(/71 people/);
});

test("deselecting a contributor narrows the tracklist", async ({ page }) => {
  const total = await page.evaluate(() => window.MASH_TRACKS.length);
  await openPanel(page);

  // Beau Garcia is the largest contributor at 330 tracks
  const top = page.locator(".contrib").first();
  const count = Number(await top.locator(".contrib-n").textContent());
  expect(count).toBe(330);
  await top.click();

  await page.click("#contribClose");
  // toBeVisible() does not model ancestor clipping; isHittable does
  expect(await isHittable(page, "#contribFilterDot")).toMatchObject({ ok: true });
  await expect
    .poll(() => page.evaluate(() => document.getElementById("statLoaded").textContent))
    .toContain(String(total - count));
});

test("selecting a single contributor filters everything to them", async ({ page }) => {
  await openPanel(page);
  await page.click("#contribAll");                       // none
  await page.locator(".contrib").first().click();        // just Beau Garcia
  await page.click("#contribClose");

  const rows = await page.$$eval(".trow .t-via", (els) => els.map((e) => e.textContent));
  expect(rows.length).toBeGreaterThan(0);
  expect([...new Set(rows)]).toEqual(["via Beau Garcia"]);
});

test("the filter composes with the search box", async ({ page }) => {
  await openPanel(page);
  await page.click("#contribAll");
  await page.locator(".contrib").first().click();
  await page.click("#contribClose");

  await page.fill("#search", "Exploited");
  await page.waitForTimeout(300);
  const vias = await page.$$eval(".trow .t-via", (els) => els.map((e) => e.textContent));
  expect(vias.length).toBeGreaterThan(0);
  expect([...new Set(vias)]).toEqual(["via Beau Garcia"]);
});

test("the all/none button toggles the whole selection", async ({ page }) => {
  await openPanel(page);
  await page.click("#contribAll");                       // -> none
  expect(await page.locator('.contrib[aria-pressed="true"]').count()).toBe(0);
  await expect(page.locator("#contribAll")).toHaveText("All");

  await page.click("#contribAll");                       // -> all
  expect(await page.locator('.contrib[aria-pressed="true"]').count()).toBe(71);
  await expect(page.locator("#contribAll")).toHaveText("None");
  await expect(page.locator("#contribFilterDot")).toBeHidden();
});

test("the selection survives a reload", async ({ page }) => {
  await openPanel(page);
  await page.locator(".contrib").first().click();
  await page.click("#contribClose");
  const before = await page.evaluate(() => document.getElementById("statLoaded").textContent);

  await page.reload();
  await expect(page.locator("#contribFilterDot")).toBeVisible();
  expect(await page.evaluate(() => document.getElementById("statLoaded").textContent)).toBe(before);
});

test("autoplay stays inside the filtered set", async ({ page }) => {
  await openPanel(page);
  await page.click("#contribAll");
  await page.locator(".contrib").first().click();        // Beau Garcia only
  await page.click("#contribClose");

  for (let i = 0; i < 3; i++) {
    await page.click("#bNext");
    await page.waitForTimeout(250);
    await expect(page.locator("#npSub")).toContainText("via Beau Garcia");
  }
});

/* The bugs a first pass at this file could not have caught. */

test("the panel summary agrees with the status bar after a reload", async ({ page }) => {
  await openPanel(page);
  await page.locator(".contrib").first().click();        // drop Beau Garcia
  await page.click("#contribClose");
  await page.reload();

  const status = await page.evaluate(() => document.getElementById("statLoaded").textContent);
  const shown = Number(status.match(/of (\d+)\)/)?.[1] ?? status.match(/\/ (\d+)/)[1]);
  await openPanel(page);
  // the summary is built before the first render, so it once read "0 tracks"
  await expect(page.locator("#contribSub")).not.toContainText("· 0 tracks");
  await expect(page.locator("#contribSub")).toContainText("70 of 71");
});

test("the summary follows the view when another filter changes it", async ({ page }) => {
  await openPanel(page);
  await page.locator(".contrib").first().click();
  await page.click("#contribClose");

  await page.fill("#search", "the");
  await page.waitForTimeout(300);
  const viewCount = await page.evaluate(() => {
    const m = document.getElementById("statLoaded").textContent.match(/\/ (\d+)/);
    return Number(m[1]);
  });

  await openPanel(page);
  await expect(page.locator("#contribSub")).toContainText(viewCount.toLocaleString());
});

test("an explicit None selection persists", async ({ page }) => {
  await openPanel(page);
  await page.click("#contribAll");                       // -> none
  await page.click("#contribClose");
  await expect.poll(() => page.locator(".trow").count()).toBe(0);

  await page.reload();
  // an empty selection is a choice, not absent state
  expect(await page.evaluate(() => localStorage.getItem("mash.contributors.v1"))).toBe("[]");
  await expect.poll(() => page.locator(".trow").count()).toBe(0);
  expect(await isHittable(page, "#contribFilterDot")).toMatchObject({ ok: true });
});

test("opening the panel does not focus the button that wipes the selection", async ({ page }) => {
  await openPanel(page);
  expect(await page.evaluate(() => document.activeElement.id)).toBe("contribClose");
});

test("an active filter is in the button's accessible name", async ({ page }) => {
  await expect(page.locator("#btnContrib")).toHaveAttribute("aria-label", "Contributors");
  await openPanel(page);
  await page.locator(".contrib").first().click();
  await expect(page.locator("#btnContrib")).toHaveAttribute("aria-label", /filtered to 70 of 71/);
});

test("deselected rows stay legible and the focus ring is not clipped", async ({ page }) => {
  await openPanel(page);
  await page.locator(".contrib").first().click();

  const style = await page.evaluate(() => {
    const row = document.querySelector('.contrib[aria-pressed="false"]');
    const cs = getComputedStyle(row);
    const name = getComputedStyle(row.querySelector(".contrib-name"));
    const ink3 = getComputedStyle(document.documentElement).getPropertyValue("--ink-3").trim();
    const asRgb = (hex) => {
      const m = /^#([0-9a-f]{6})$/i.exec(hex);
      return m ? `rgb(${[0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).join(", ")})` : hex;
    };
    return { opacity: cs.opacity, outlineOffset: cs.outlineOffset, nameColour: name.color, ink3: asRgb(ink3) };
  });

  // opacity dimming composites at paint time, so no variable-based contrast
  // test can see it — the name must resolve to a token the gate already checks
  expect(style.opacity).toBe("1");
  expect(style.nameColour).toBe(style.ink3);
  expect(parseFloat(style.outlineOffset)).toBeLessThan(0);
});
