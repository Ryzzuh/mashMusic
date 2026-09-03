import { test, expect } from "@playwright/test";
import { blockExternal, setListMode, isHittable } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
});

test("the list-mode control shows one mode and hides the rest behind a picker", async ({ page }) => {
  await expect(page.locator("#listModeCurrent")).toHaveText("Shown");
  await expect(page.locator("#listModeMenu")).toBeHidden();

  await page.click("#listModeMore");
  await expect(page.locator("#listModeMenu")).toBeVisible();
  // toBeVisible() does not model ancestor clipping: this menu once sat inside
  // an overflow:hidden container and was invisible while passing that check
  expect(await isHittable(page, "#listModeMenu")).toMatchObject({ ok: true });
  expect(await isHittable(page, '.listmode-menu [data-listmode="hide"]')).toMatchObject({ ok: true });
  await expect(page.locator(".listmode-menu button")).toHaveCount(2);

  await page.click('.listmode-menu [data-listmode="hide"]');
  await expect(page.locator("#listModeCurrent")).toHaveText("Hidden");
  await expect(page.locator("#listModeMenu")).toBeHidden();
  expect(await page.locator(".trow .t-name").first().textContent()).toMatch(/^Track \d{4}$/);

  // the visible pill is the way back to plain titles
  await page.click("#listModeCurrent");
  await expect(page.locator("#listModeCurrent")).toHaveText("Shown");
});

test("the picker closes on Escape and on an outside click", async ({ page }) => {
  await page.click("#listModeMore");
  await expect(page.locator("#listModeMenu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#listModeMenu")).toBeHidden();

  await page.click("#listModeMore");
  await expect(page.locator("#listModeMenu")).toBeVisible();
  await page.click(".brand");
  await expect(page.locator("#listModeMenu")).toBeHidden();
});

test("the chosen mode survives a reload", async ({ page }) => {
  await setListMode(page, "blur");
  await expect(page.locator("#listModeCurrent")).toHaveText("Obfuscated");
  await page.reload();
  await expect(page.locator("#listModeCurrent")).toHaveText("Obfuscated");
});

test("the palette badge carries three colours from the active theme", async ({ page }) => {
  const read = () =>
    page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const fill = (sel) => getComputedStyle(document.querySelector(sel)).fill;
      const asRgb = (hex) => {
        const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
        return m ? `rgb(${[0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).join(", ")})` : hex.trim();
      };
      return {
        drops: [fill(".pal-a"), fill(".pal-b"), fill(".pal-c")],
        tokens: ["--accent", "--tint", "--ok"].map((t) => asRgb(cs.getPropertyValue(t))),
        body: fill(".pal-body"),
        raised: asRgb(cs.getPropertyValue("--raised")),
      };
    });

  await page.click('button[data-skin="jukebox"]');
  const juke = await read();
  expect(juke.drops).toEqual(juke.tokens);
  expect(juke.body).toBe(juke.raised);

  await page.click('button[data-skin="night"]');
  const night = await read();
  expect(night.drops).toEqual(night.tokens);
  expect(night.drops).not.toEqual(juke.drops);      // it actually changed
});

test("the badge sits on the divider between the two theme buttons", async ({ page }) => {
  const geo = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const juke = r('button[data-skin="jukebox"]'), badge = r(".skin-badge svg"), night = r('button[data-skin="night"]');
    return {
      badgeCentre: badge.left + badge.width / 2,
      divider: (juke.right + night.left) / 2,
    };
  });
  expect(Math.abs(geo.badgeCentre - geo.divider)).toBeLessThanOrEqual(1.5);
});

test("starting the next track does not move the view", async ({ page }) => {
  await page.evaluate(() => window.scrollTo(0, 400));
  const before = await page.evaluate(() => window.scrollY);
  await page.click("#bNext");
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test("the theme divider does not escape the control", async ({ page }) => {
  // the badge span stretches to full control height, so a -17px inset made this
  // 68px tall and it only looked right because an ancestor clipped it
  const g = await page.evaluate(() => {
    const sw = document.querySelector(".skin-switch").getBoundingClientRect();
    const el = document.querySelector(".skin-badge");
    const d = getComputedStyle(el, "::before");
    const r = el.getBoundingClientRect();
    return { switchTop: sw.top, switchBottom: sw.bottom, badgeTop: r.top, badgeBottom: r.bottom,
             insetTop: d.top, insetBottom: d.bottom };
  });
  expect(g.badgeTop).toBeGreaterThanOrEqual(g.switchTop - 1);
  expect(g.badgeBottom).toBeLessThanOrEqual(g.switchBottom + 1);
  expect(g.insetTop).toBe("0px");
  expect(g.insetBottom).toBe("0px");
});

test("an open picker owns the keyboard", async ({ page }) => {
  await page.click("#bNext");
  await page.waitForTimeout(300);
  const playing = await page.locator("#npTitle").textContent();

  await page.click("#listModeMore");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  expect(await page.locator("#npTitle").textContent()).toBe(playing);   // no skip
  await expect(page.locator("#listModeMenu")).toBeVisible();
});

test("Space activates the focused control instead of the transport", async ({ page }) => {
  await page.focus("#listModeMore");
  await page.keyboard.press(" ");
  await expect(page.locator("#listModeMenu")).toBeVisible();
});

test("closing the picker returns focus to it", async ({ page }) => {
  await page.click("#listModeMore");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.activeElement.id)).toBe("listModeMore");
});

test("the pill is highlighted only when a non-default mode is active", async ({ page }) => {
  const active = () => page.evaluate(() => document.getElementById("listModeCurrent").classList.contains("is-active"));
  expect(await active()).toBe(false);
  await setListMode(page, "hide");
  expect(await active()).toBe(true);
  await page.click("#listModeCurrent");
  expect(await active()).toBe(false);
});
