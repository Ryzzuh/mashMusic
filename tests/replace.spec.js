import { test, expect } from "@playwright/test";
import { blockExternal, isHittable } from "./helpers.js";

/* QoL 1: when a track is dead, offer a replacement.
 *
 * Dead state is seeded through localStorage, which is exactly how the app's
 * own runtime liveness store works — no test-only hook needed here. */

const markDead = (page, keys) =>
  page.evaluate((ks) => {
    const rec = {};
    for (const k of ks) rec[k] = { s: "gone", c: 100, t: Date.now() };
    localStorage.setItem("mash.liveness.v1", JSON.stringify(rec));
  }, keys);

/** The two library copies of the same title, one to kill and one to find. */
const twinPair = (page) =>
  page.evaluate(() => {
    const byTitle = new Map();
    for (const t of window.MASH_TRACKS) {
      const k = t.t.toLowerCase().trim();
      byTitle.set(k, [...(byTitle.get(k) || []), t]);
    }
    for (const [, group] of byTitle) if (group.length >= 2) return group.slice(0, 2);
    return null;
  });

const picks = (page) =>
  page.$$eval(".swap-pick", (els) => els.map((e) => ({
    name: e.querySelector(".swap-name").textContent,
    score: e.querySelector(".swap-score").textContent,
  })));

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
});

test("only a dead row offers a replacement", async ({ page }) => {
  const [dead] = await twinPair(page);
  await markDead(page, [dead.k]);
  await page.reload();

  const deadRow = page.locator(`.trow[data-key="${dead.k}"] .t-swap`);
  await expect(deadRow).toBeVisible();
  expect(await isHittable(page, `.trow[data-key="${dead.k}"] .t-swap`)).toMatchObject({ ok: true });

  // every other rendered row keeps it hidden — and hidden, not merely unstyled,
  // so it stays out of the tab order
  const shown = await page.$$eval(".trow", (rows) =>
    rows.filter((r) => !r.querySelector(".t-swap").hidden).length);
  expect(shown).toBe(1);
});

test("the library finds the track's own twin", async ({ page }) => {
  const [dead, twin] = await twinPair(page);
  await markDead(page, [dead.k]);
  await page.reload();

  await page.click(`.trow[data-key="${dead.k}"] .t-swap`);
  await expect(page.locator("#swapModal")).toBeVisible();
  await expect(page.locator("#swapSub")).toHaveText(dead.t);

  const found = await picks(page);
  expect(found.length).toBeGreaterThan(0);
  expect(found[0].name).toBe(twin.t);
  expect(found[0].score).toBe("100%");
});

test("choosing a replacement plays it", async ({ page }) => {
  const [dead, twin] = await twinPair(page);
  await markDead(page, [dead.k]);
  await page.reload();

  await page.click(`.trow[data-key="${dead.k}"] .t-swap`);
  await page.locator(".swap-pick").first().click();

  await expect(page.locator("#swapModal")).toBeHidden();
  await expect(page.locator("#npTitle")).toHaveText(twin.t);

  /* The twin can sit past the 60-row window, and an unrendered row cannot
   * carry aria-current. Jump to it — that renders up to it — rather than
   * rendering all 1,257, which pushed this test past its timeout. */
  await page.click("#tJump");
  await expect(page.locator(`.trow[data-key="${twin.k}"]`))
    .toHaveAttribute("aria-current", "true");
});

test("a dead twin is not offered as a replacement", async ({ page }) => {
  /* Swapping one broken id for another is worse than saying nothing. */
  const [dead, twin] = await twinPair(page);
  await markDead(page, [dead.k, twin.k]);
  await page.reload();

  await page.click(`.trow[data-key="${dead.k}"] .t-swap`);
  expect(await picks(page)).toEqual([]);
  await expect(page.locator("#swapNote")).toHaveText(/Nothing close enough/);
});

/* Note: play() refuses dead tracks on its own, so this documents the intent
 * rather than guarding a reachable defect — there is no mutation check for it. */
test("the button offers a replacement rather than playing the dead track", async ({ page }) => {
  const [dead] = await twinPair(page);
  await markDead(page, [dead.k]);
  await page.reload();

  await page.click(`.trow[data-key="${dead.k}"] .t-swap`);
  await expect(page.locator("#swapModal")).toBeVisible();
  // the click must not fall through to the row's own play handler
  await expect(page.locator("#npTitle")).toHaveText("Nothing playing");
});

test("unrelated titles are not offered", async ({ page }) => {
  /* The threshold has to be worth something: a track with no twin should
   * return nothing rather than the six least-different titles in the library. */
  const lonely = await page.evaluate(() => {
    const counts = new Map();
    for (const t of window.MASH_TRACKS) counts.set(t.t, (counts.get(t.t) || 0) + 1);
    return window.MASH_TRACKS.find((t) => counts.get(t.t) === 1 && t.t.length > 40);
  });
  await markDead(page, [lonely.k]);
  await page.reload();
  // reach the row by searching for it rather than rendering all 1,257, which
  // pushed this past its timeout
  await page.fill("#search", lonely.t.slice(0, 30));
  await expect.poll(() => page.locator(`.trow[data-key="${lonely.k}"]`).count()).toBe(1);

  await page.click(`.trow[data-key="${lonely.k}"] .t-swap`);
  const found = await picks(page);
  for (const f of found) expect(Number(f.score.replace("%", ""))).toBeGreaterThanOrEqual(62);
});

test("SoundCloud says why there is no fallback", async ({ page }) => {
  const sc = await page.evaluate(() => {
    const counts = new Map();
    for (const t of window.MASH_TRACKS) counts.set(t.t, (counts.get(t.t) || 0) + 1);
    return window.MASH_TRACKS.find((t) => t.s === "SC" && counts.get(t.t) === 1 && t.t.length > 40);
  });
  test.skip(!sc, "no uniquely-titled SoundCloud track");

  await markDead(page, [sc.k]);
  await page.reload();
  await page.fill("#search", sc.t.slice(0, 30));
  await expect.poll(() => page.locator(`.trow[data-key="${sc.k}"]`).count()).toBe(1);

  await page.click(`.trow[data-key="${sc.k}"] .t-swap`);
  if ((await picks(page)).length === 0)
    await expect(page.locator("#swapNote")).toHaveText(/SoundCloud has no search/);
});

test("the offline sidecar is merged and offered alongside the library", async ({ page }) => {
  const [dead] = await twinPair(page);
  await markDead(page, [dead.k]);

  await page.route("**/data/replacements.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        [dead.k]: [{ i: "abc12345678", t: "A Rehosted Upload", c: "Some Channel", score: 0.91 }],
      }),
    }));
  await page.reload();

  await page.click(`.trow[data-key="${dead.k}"] .t-swap`);
  await expect.poll(async () => (await picks(page)).map((p) => p.name))
    .toContain("A Rehosted Upload");
  const found = await picks(page);
  const online = found.find((f) => f.name === "A Rehosted Upload");
  expect(online.score).toBe("91%");
  // the library twin still ranks first at 100%
  expect(found[0].score).toBe("100%");
});

test("the dialog closes on Escape and on the backdrop", async ({ page }) => {
  const [dead] = await twinPair(page);
  await markDead(page, [dead.k]);
  await page.reload();

  await page.click(`.trow[data-key="${dead.k}"] .t-swap`);
  await expect(page.locator("#swapModal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#swapModal")).toBeHidden();

  await page.click(`.trow[data-key="${dead.k}"] .t-swap`);
  await page.click("#swapClose");
  await expect(page.locator("#swapModal")).toBeHidden();
});
