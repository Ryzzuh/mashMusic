import { test, expect } from "@playwright/test";
import { blockExternal } from "./helpers.js";

/* Jukebox 11: each transport button glows in its own tube colour. */

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
});

/** Blur radius of the outer (first) shadow, in px. 0 when there is none. */
const outerBlur = (page, sel) =>
  page.evaluate((s) => {
    const v = getComputedStyle(document.querySelector(s)).boxShadow;
    if (!v || v === "none") return 0;
    // "color(srgb r g b / a) 0px 0px 10px -3px, ... inset"
    const nums = v.split(",").find((p) => !p.includes("inset")) || v;
    const px = [...nums.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => parseFloat(m[1]));
    return px[2] || 0;                       // x, y, blur, spread
  }, sel);

/** The outer shadow's colour as [r,g,b] 0-255, and the element's own --btn. */
const haloVsBtn = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    const cs = getComputedStyle(el);
    const parse = (str) => {
      let m = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(str);
      if (m) return [1, 2, 3].map((i) => Math.round(parseFloat(m[i]) * 255));
      m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(str);
      if (m) return [1, 2, 3].map((i) => parseInt(m[i], 10));
      m = /^#([0-9a-f]{6})$/i.exec(str.trim());
      if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
      return null;
    };
    return { halo: parse(cs.boxShadow), btn: parse(cs.getPropertyValue("--btn")) };
  }, sel);

const BUTTONS = ["#bPrev", "#bPlay", "#bPause", "#bNext", "#bStop", "#bRandom", "#bFavs", "#bWheel"];

for (const skin of ["jukebox", "night"]) {
  test(`each button glows in its own tube colour (${skin})`, async ({ page }) => {
    await page.click(`button[data-skin="${skin}"]`);

    for (const sel of BUTTONS) {
      const { halo, btn } = await haloVsBtn(page, sel);
      expect(halo, `${sel} has no resolvable halo colour`).not.toBeNull();
      expect(btn, `${sel} has no --btn`).not.toBeNull();
      // the halo must be the button's own colour, not a shared accent
      for (let i = 0; i < 3; i++)
        expect(Math.abs(halo[i] - btn[i]), `${sel} channel ${i}`).toBeLessThanOrEqual(2);
    }
  });
}

test("the Jukebox halos are genuinely different colours per button", async ({ page }) => {
  /* Night collapses every tube to one amber, so sameness there is correct and
   * proves nothing. Jukebox has seven distinct hues, and a halo wired to a
   * single shared token would still pass the per-button check above if that
   * token happened to equal one button's colour. */
  await page.click('button[data-skin="jukebox"]');
  const seen = new Set();
  for (const sel of BUTTONS) {
    const { halo } = await haloVsBtn(page, sel);
    seen.add(halo.join(","));
  }
  expect(seen.size).toBeGreaterThanOrEqual(6);
});

test("the halo brightens on hover and when latched on", async ({ page }) => {
  const rest = await outerBlur(page, "#bFavs");
  expect(rest).toBeGreaterThan(0);

  await page.hover("#bFavs");
  const hover = await outerBlur(page, "#bFavs");
  expect(hover).toBeGreaterThan(rest);

  await page.click("#bFavs");
  await expect(page.locator("#bFavs")).toHaveAttribute("aria-pressed", "true");
  await page.hover("#bWheel");                       // move the pointer away
  expect(await outerBlur(page, "#bFavs")).toBeGreaterThan(rest);
});

test("a disabled button does not glow", async ({ page }) => {
  expect(await outerBlur(page, "#bPlay")).toBeGreaterThan(0);
  await page.evaluate(() => { document.getElementById("bPlay").disabled = true; });
  // the halo transitions over .18s, so an immediate read catches it mid-decay
  // (0.018px, not 0) — poll for the settled value rather than sleep a guess
  await expect.poll(() => outerBlur(page, "#bPlay")).toBe(0);
});

test("the halo never tints the button face", async ({ page }) => {
  /* The glow must stay outside the glyph's background, or the icon contrast
   * measured by the gate below stops describing what is on screen. */
  for (const skin of ["jukebox", "night"]) {
    await page.click(`button[data-skin="${skin}"]`);
    /* background is on a .15s transition, so switching themes and reading
     * immediately catches an intermediate colour. Poll for the settled value
     * rather than assert on whatever the frame happened to hold. */
    await expect.poll(async () => {
      const m = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        const btn = getComputedStyle(document.getElementById("bPlay"));
        const hex = cs.getPropertyValue("--raised").trim();
        const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16));
        return { face: btn.backgroundColor, expected: `rgb(${rgb.join(", ")})` };
      });
      return m.face === m.expected;
    }, { message: `${skin}: button face never settled to --raised` }).toBe(true);
  }
});

test("the focus ring survives the halo", async ({ page }) => {
  /* A glow is a box-shadow, so a focus ring drawn as one is fighting for the
   * same property and loses. The ring has to be an outline.
   *
   * Asserting merely "outline is not none" proved nothing: Chrome draws its
   * own :focus-visible ring, which computes to outline-style "auto" and is
   * wide enough to satisfy a >= 2px check. Deleting the rule entirely left
   * that version of this test green. These assertions name the rule. */
  await page.keyboard.press("Tab");
  const m = await page.evaluate(() => {
    const el = document.getElementById("bPlay");
    el.focus();
    const cs = getComputedStyle(el);
    const ink = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
    const hex = /^#([0-9a-f]{6})$/i.exec(ink);
    return {
      focusVisible: el.matches(":focus-visible"),
      style: cs.outlineStyle,
      width: parseFloat(cs.outlineWidth),
      offset: cs.outlineOffset,
      color: cs.outlineColor,
      inkRgb: hex ? `rgb(${[0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).join(", ")})` : null,
      shadow: cs.boxShadow,
    };
  });
  expect(m.focusVisible, "the rule under test never matched").toBe(true);
  expect(m.style, "the UA default computes to 'auto'").toBe("solid");
  expect(m.width).toBeGreaterThanOrEqual(2);
  expect(m.offset).toBe("2px");
  expect(m.color).toBe(m.inkRgb);
  // and focusing must not have cost the button its halo
  expect(m.shadow).not.toBe("none");
});
