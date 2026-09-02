import { test, expect } from "@playwright/test";
import { blockExternal, playFirstMatch } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
});

test("the SoundCloud slot hides when a YouTube track takes over", async ({ page }) => {
  // Regression: #slotSC is an id selector and outranked .media-slot[hidden],
  // so the widget stayed on screen through YouTube tracks for two commits.
  await page.goto("/");
  await playFirstMatch(page, "Marek Hemmann - Left");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.getElementById("slotSC")).display))
    .toBe("flex");

  await playFirstMatch(page, "Ben Pearce");
  const state = await page.evaluate(() => {
    const sc = document.getElementById("slotSC");
    return { hidden: sc.hidden, display: getComputedStyle(sc).display };
  });
  expect(state.hidden).toBe(true);
  expect(state.display).toBe("none");        // the attribute must actually win
});

test("hidden list mode keeps titles out of the DOM entirely", async ({ page }) => {
  await page.goto("/");
  await page.click('[data-listmode="hide"]');

  const leaked = await page.evaluate(() => {
    const html = document.getElementById("tracklist").innerHTML;
    return window.MASH_TRACKS.slice(0, 60)
      .filter((t) => html.includes(t.t) || (t.v && html.includes(t.v))).length;
  });
  expect(leaked).toBe(0);

  // and the row still says something useful
  await expect(page.locator(".trow .t-name").first()).toHaveText(/^Track \d{4}$/);
});

test("shuffling and unshuffling restores the canonical order exactly", async ({ page }) => {
  await page.goto("/");
  const order = () => page.$$eval(".t-index", (els) => els.slice(0, 12).map((e) => e.textContent));

  const before = await order();
  await page.click("#bRandom");
  const shuffled = await order();
  await page.click("#bRandom");
  const after = await order();

  expect(shuffled).not.toEqual(before);
  expect(after).toEqual(before);
});

test("the list extends in chunks of 60 as you scroll", async ({ page }) => {
  await page.goto("/");
  const count = () => page.locator(".trow").count();
  expect(await count()).toBe(60);

  for (const expected of [120, 180]) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(count, { timeout: 5000 }).toBe(expected);
  }
});

test("tracks known to be dead are skipped by autoplay", async ({ page }) => {
  await page.goto("/");
  const [first, second, third, fourth] = await page.evaluate(() =>
    window.MASH_TRACKS.slice(0, 4).map((t) => ({ k: t.k, t: t.t }))
  );

  // mark the first three gone, then reload so the app reads them at boot
  await page.evaluate((keys) => {
    const live = {};
    keys.forEach((k) => (live[k] = { s: "gone", c: 100, t: Date.now() }));
    localStorage.setItem("mash.liveness.v1", JSON.stringify(live));
  }, [first.k, second.k, third.k]);
  await page.reload();

  await expect.poll(() => page.locator(".trow.is-dead").count()).toBeGreaterThanOrEqual(3);

  await page.click("#bNext");
  await expect(page.locator("#npTitle")).toHaveText(fourth.t);
});

test("both themes expose a full token set", async ({ page }) => {
  await page.goto("/");
  const tokens = [
    "--ground", "--panel", "--sunk", "--raised", "--ink", "--ink-2", "--ink-3",
    "--line", "--line-hard", "--accent", "--tint", "--check", "--check-ink",
    "--ok", "--warn", "--dead", "--c-play", "--eq-lo", "--eq-mid", "--eq-hi",
    "--stage-bg", "--shadow",
  ];
  for (const skin of ["jukebox", "night"]) {
    await page.click(`[data-skin="${skin}"]`);
    const missing = await page.evaluate((names) => {
      const cs = getComputedStyle(document.documentElement);
      return names.filter((n) => !cs.getPropertyValue(n).trim());
    }, tokens);
    expect(missing, `${skin} is missing tokens`).toEqual([]);
  }
});
