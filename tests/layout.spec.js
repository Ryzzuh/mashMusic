import { test, expect } from "@playwright/test";
import { blockExternal, playFirstMatch, rects, canvasTopmostPaintedRow, waitForCanvasPaint } from "./helpers.js";

/* The geometry established by hand while building the stage. These are the
 * numbers that drift silently when anything nearby is restyled. */

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
});

test("the stage column gap matches the video-to-scrubber distance", async ({ page }) => {
  const r = await rects(page, [".stage-media", ".stage-side", "#scrubber"]);
  const columnGap = Math.round(r[".stage-side"].left - r[".stage-media"].right);
  const toScrubber = Math.round(r["#scrubber"].top - r[".stage-media"].bottom);

  expect(columnGap).toBe(toScrubber);
  expect(columnGap).toBe(33);
});

test("the side column is exactly as tall as the video", async ({ page }) => {
  const r = await rects(page, [".stage-media", ".stage-side"]);
  // The side column must contribute no intrinsic height of its own; if it does,
  // the fr tracks inflate and the stage grows far past the video.
  expect(Math.abs(r[".stage-side"].h - r[".stage-media"].h)).toBeLessThanOrEqual(1);
});

test("the now-playing text and spectrum split the side column 2:1", async ({ page }) => {
  const r = await rects(page, [".stage-meta", ".eq"]);
  expect(r[".stage-meta"].h / r[".eq"].h).toBeCloseTo(2.0, 1);
});

test("the scrubber paints flush to the top of its canvas, with an envelope", async ({ page }) => {
  await playFirstMatch(page, "Ben Pearce");
  await waitForCanvasPaint(page, "#scrubber");

  expect(await canvasTopmostPaintedRow(page, "#scrubber", "--ink")).toBe(0);

  // and therefore the gap the eye sees equals the gap the CSS sets
  const r = await rects(page, [".stage-media", ".stage-side", "#scrubber"]);
  const perceived = Math.round(r["#scrubber"].top - r[".stage-media"].bottom);
  const columnGap = Math.round(r[".stage-side"].left - r[".stage-media"].right);
  expect(perceived).toBe(columnGap);
});

test("the scrubber paints flush to the top with no envelope either", async ({ page }) => {
  // Find a track that genuinely has no envelope rather than assuming a source
  // has none — envelopes are still being generated for both.
  const title = await page.evaluate(async () => {
    const idx = await fetch("../mashMusic-eq/index.json").then((r) => r.json());
    const have = new Set(idx.ids);
    const t = window.MASH_TRACKS.find((x) => !have.has(x.i));
    return t ? t.t : null;
  });
  test.skip(!title, "every track now has an envelope");

  await playFirstMatch(page, title.slice(0, 30));
  await waitForCanvasPaint(page, "#scrubber");

  await expect(page.locator("#eqTag")).toHaveText(/no envelope/);
  expect(await canvasTopmostPaintedRow(page, "#scrubber", "--ink")).toBe(0);
});

test("the spectrum canvas is sized to its box, not left at the default", async ({ page }) => {
  const { attr, expected } = await page.evaluate(() => {
    const c = document.getElementById("eqScope");
    const r = c.getBoundingClientRect();
    // mirror app.js exactly: it rounds the CSS width first, then scales
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width));
    return { attr: [c.width, c.height], expected: Math.round(w * dpr) };
  });
  // 300x150 means the resize observer never ran and nothing will ever draw.
  expect(attr).not.toEqual([300, 150]);
  expect(attr[0]).toBe(expected);
});

test("a SoundCloud track drives the spectrum from its own envelope", async ({ page }) => {
  // The spectrum was YouTube-only until the analysis run covered both sources.
  const title = await page.evaluate(async () => {
    const idx = await fetch("../mashMusic-eq/index.json").then((r) => r.json());
    const have = new Set(idx.ids);
    const t = window.MASH_TRACKS.find((x) => x.s === "SC" && have.has(x.i));
    return t ? t.t : null;
  });
  test.skip(!title, "no SoundCloud envelopes present");

  await playFirstMatch(page, title.slice(0, 28));
  await expect(page.locator("#eqTag")).toHaveText(/24 bands/);
  await expect(page.locator("#eqTag")).toHaveClass(/live/);
  await waitForCanvasPaint(page, "#eqScope");
});
