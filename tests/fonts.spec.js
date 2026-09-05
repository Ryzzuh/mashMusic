import { test, expect } from "@playwright/test";
import { blockExternal } from "./helpers.js";

/* The fonts are self-hosted.
 *
 * They used to come from fonts.googleapis.com, which helpers.js blocks so runs
 * stay hermetic — so every geometry assertion in this suite was measured
 * against fallback system fonts, in a layout no visitor ever saw. These tests
 * exist so that cannot come back silently. */

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
});

test("nothing is fetched from a font CDN", async ({ page }) => {
  /* blockExternal aborts these hosts, so a re-added @import would not fail
   * loudly — it would quietly fall back, exactly as before. Count attempts. */
  const attempts = [];
  page.on("request", (r) => {
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(r.url())) attempts.push(r.url());
  });
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  expect(attempts).toEqual([]);
});

test("every declared face loads from assets/fonts", async ({ page }) => {
  const served = [];
  page.on("response", (r) => {
    if (r.url().includes("/assets/fonts/")) served.push([r.status(), r.url().split("/").pop()]);
  });
  await page.reload();
  await page.evaluate(async () => {
    await document.fonts.ready;
    // unicode-range means a face only loads when its characters are used;
    // ask for each one explicitly
    await Promise.all([
      document.fonts.load("600 20px Archivo"),
      document.fonts.load("700 20px Archivo"),
      document.fonts.load("400 14px Barlow"),
      document.fonts.load("500 14px Barlow"),
      document.fonts.load("600 14px Barlow"),
      document.fonts.load('400 11px "IBM Plex Mono"'),
      document.fonts.load('500 11px "IBM Plex Mono"'),
    ]);
  });
  expect(served.length).toBeGreaterThan(0);
  expect(served.filter(([s]) => s !== 200)).toEqual([]);
});

test("the real families are in use, not a fallback", async ({ page }) => {
  const m = await page.evaluate(async () => {
    await document.fonts.ready;
    const specs = [
      ["600 20px Archivo", "mashmusic"],
      ["700 20px Archivo", "mashmusic"],
      ["400 14px Barlow", "Ben Pearce - What I Might Do (Original Mix)"],
      ['400 11px "IBM Plex Mono"', "295:38:53"],
    ];
    await Promise.all(specs.map(([f]) => document.fonts.load(f)));
    const c = document.createElement("canvas").getContext("2d");
    const out = {};
    for (const [font, text] of specs) {
      c.font = font;
      const real = c.measureText(text).width;
      c.font = font.replace(/(Archivo|Barlow|"IBM Plex Mono")/, '"NoSuchFamily-XYZ"');
      out[font] = { real: +real.toFixed(2), fallback: +c.measureText(text).width.toFixed(2),
                    available: document.fonts.check(font) };
    }
    return out;
  });

  for (const [font, v] of Object.entries(m)) {
    expect(v.available, `${font} not available`).toBe(true);
    // a fallback would render at a different advance; identical means the
    // real face never loaded and the browser substituted silently
    expect(Math.abs(v.real - v.fallback), `${font} matches the fallback`).toBeGreaterThan(1);
  }

  /* Pinned to the exact advances Google Fonts served before the move, measured
   * on the same build. These are what every geometry assertion in the suite
   * ultimately rests on, so a different file — a re-subset, a version bump —
   * should have to be noticed and accepted rather than slide in. */
  expect(m["600 20px Archivo"].real).toBeCloseTo(106.52, 1);
  expect(m["700 20px Archivo"].real).toBeCloseTo(110.36, 1);
  expect(m["400 14px Barlow"].real).toBeCloseTo(253.58, 1);
  expect(m['400 11px "IBM Plex Mono"'].real).toBeCloseTo(59.40, 1);
});

test("latin-ext covers the one title in the library that needs it", async ({ page }) => {
  /* The library holds 19 distinct non-ASCII characters, but only ONE of them
   * falls outside Google's "latin" range: e-with-dot-above, U+0117, in
   * "Downtown Party Network feat Egle Sirvydyte - Space Me Out". Everything
   * else (o-slash, a-umlaut, e-acute...) lives in U+00C0-00FF and ships with
   * latin.
   *
   * So latin-ext earns its 38KB for a single track. Dropping it would fall
   * back for that title alone, which is exactly the kind of thing nobody
   * notices for months — and the first version of this test would not have
   * caught it either, because I checked characters that were in latin all
   * along. The mutation harness found that. */
  const m = await page.evaluate(async () => {
    await document.fonts.ready;
    /* fonts.load() defaults to the test string "BESbswy", which is pure latin,
     * so it only ever pulls the latin face. The latin-ext face has to be asked
     * for by a character inside its unicode-range. */
    await document.fonts.load("400 14px Barlow", "\u0117");
    await document.fonts.load("400 14px Barlow", "\u00f8");
    const c = document.createElement("canvas").getContext("2d");
    const measure = (font, text) => { c.font = font; return +c.measureText(text).width.toFixed(2); };
    const glyphs = "\u0117\u0117\u0117\u0117\u0117\u0117\u0117\u0117";   // amplify one glyph
    return {
      extReal: measure("400 14px Barlow", glyphs),
      extFallback: measure('400 14px "NoSuchFamily-XYZ"', glyphs),
      // a character that latin already covers, as the control
      latinReal: measure("400 14px Barlow", "\u00f8\u00f8\u00f8\u00f8\u00f8\u00f8\u00f8\u00f8"),
      latinFallback: measure('400 14px "NoSuchFamily-XYZ"', "\u00f8\u00f8\u00f8\u00f8\u00f8\u00f8\u00f8\u00f8"),
    };
  });

  // the control proves the comparison method works at all
  expect(Math.abs(m.latinReal - m.latinFallback), "latin control").toBeGreaterThan(1);
  // and the real assertion: U+0117 renders from Barlow, not a substitute
  expect(Math.abs(m.extReal - m.extFallback), "U+0117 fell back to a system font")
    .toBeGreaterThan(1);
});
