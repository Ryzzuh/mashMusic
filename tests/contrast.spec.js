import { test, expect } from "@playwright/test";
import { blockExternal } from "./helpers.js";

/* The Jukebox retheme shipped a muted text tone at 3.27:1 because the colour
 * was sampled from a photograph and never measured. This is that check. */

const PAIRS = [
  ["--ink", "--panel"], ["--ink", "--ground"], ["--ink", "--sunk"],
  ["--ink-2", "--panel"], ["--ink-3", "--panel"], ["--ink-3", "--sunk"],
  ["--accent", "--panel"], ["--tint", "--panel"],
  ["--ok", "--panel"], ["--warn", "--panel"], ["--dead", "--panel"],
  ["--check-ink", "--check"],
];

test("every ink-on-surface pair meets WCAG AA in both themes", async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");

  for (const skin of ["jukebox", "night"]) {
    await page.click(`[data-skin="${skin}"]`);
    const results = await page.evaluate((pairs) => {
      const cs = getComputedStyle(document.documentElement);
      const rgb = (name) => {
        const v = cs.getPropertyValue(name).trim();
        const m = /^#([0-9a-f]{6})$/i.exec(v);
        if (!m) return null;
        return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
      };
      const lum = (c) => {
        const f = (x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
      };
      return pairs.map(([fg, bg]) => {
        const a = rgb(fg), b = rgb(bg);
        if (!a || !b) return { fg, bg, ratio: null };
        const la = lum(a), lb = lum(b);
        const hi = Math.max(la, lb), lo = Math.min(la, lb);
        return { fg, bg, ratio: +((hi + 0.05) / (lo + 0.05)).toFixed(2) };
      });
    }, PAIRS);

    const failures = results.filter((r) => r.ratio !== null && r.ratio < 4.5);
    expect(
      failures,
      `${skin}: ${failures.map((f) => `${f.fg} on ${f.bg} = ${f.ratio}:1`).join(", ")}`
    ).toEqual([]);
  }
});
