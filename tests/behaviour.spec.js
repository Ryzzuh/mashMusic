import { test, expect } from "@playwright/test";
import { blockExternal, playFirstMatch, setListMode } from "./helpers.js";

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

test("hidden mode drops the tracks the platforms have lost", async ({ page }) => {
  /* "Hidden" used to redact titles — replace them with "Track 0042" and keep
   * the real ones out of the DOM. It now filters instead: the unavailable
   * tracks leave the list. The predicate lives in buildView(), so the rows,
   * the counts and autoplay all narrow together. */
  await page.goto("/");

  const marked = await page.evaluate(() => {
    const t = window.MASH_TRACKS, rec = {};
    [0, 1, 2].forEach((i) => (rec[t[i].k] = { s: "gone", c: 100, t: Date.now() }));
    rec[t[3].k] = { s: "blocked", c: 150, t: Date.now() };
    rec[t[4].k] = { s: "stalled", c: null, t: Date.now() };   // counted too
    localStorage.setItem("mash.liveness.v1", JSON.stringify(rec));
    return t.slice(0, 5).map((x) => x.k);
  });
  await page.reload();

  const total = () => page.evaluate(() => {
    const m = /showing \d+ \/ (\d+)/.exec(document.getElementById("statLoaded").textContent);
    return m ? Number(m[1]) : null;
  });

  await expect.poll(total).toBe(1257);
  await expect(page.locator("#statDead")).toHaveText("5 unavailable");

  await setListMode(page, "hide");
  await expect.poll(total).toBe(1252);
  for (const k of marked)
    expect(await page.evaluate((key) => !document.querySelector(`.trow[data-key="${key}"]`), k),
      `${k} still listed`).toBe(true);
  // nothing unavailable is left in the view, so the counter has nothing to say
  await expect(page.locator("#statDead")).toHaveText("");
  await expect(page.locator(".trow.is-dead, .trow.is-suspect")).toHaveCount(0);

  await setListMode(page, "show");
  await expect.poll(total).toBe(1257);
  await expect(page.locator("#statDead")).toHaveText("5 unavailable");
});

test("obfuscated mode still shows every track, including the dead ones", async ({ page }) => {
  // the two modes are on different axes now: one filters, one only restyles
  await page.goto("/");
  await page.evaluate(() => {
    const t = window.MASH_TRACKS;
    localStorage.setItem("mash.liveness.v1",
      JSON.stringify({ [t[0].k]: { s: "gone", c: 100, t: Date.now() } }));
  });
  await page.reload();

  await setListMode(page, "blur");
  await expect(page.locator(".tracklist")).toHaveClass(/mode-blur/);
  await expect(page.locator("#statDead")).toHaveText("1 unavailable");
  expect(await page.evaluate(() =>
    getComputedStyle(document.querySelector(".trow .t-name")).filter)).toMatch(/pixelate|blur/);
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
    await page.click(`button[data-skin="${skin}"]`);
    const missing = await page.evaluate((names) => {
      const cs = getComputedStyle(document.documentElement);
      return names.filter((n) => !cs.getPropertyValue(n).trim());
    }, tokens);
    expect(missing, `${skin} is missing tokens`).toEqual([]);
  }
});
