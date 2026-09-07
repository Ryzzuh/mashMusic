import { test, expect } from "@playwright/test";
import { blockExternal, isHittable } from "./helpers.js";

/* Liveness checking, both halves of Option C:
 *
 *   - the in-app batch, which asks oEmbed (keyless, CORS-open) about tracks
 *     nothing has an opinion on yet, and
 *   - data/liveness.json from tools/check-liveness.mjs, which knows things
 *     oEmbed cannot and is allowed to upgrade the cheaper verdict.
 *
 * Every oEmbed response here is stubbed. blockExternal() aborts youtube.com
 * and soundcloud.com, and these routes are registered afterwards so they take
 * precedence — Playwright matches the most recently registered route first. */

const OEMBED = /(?:youtube\.com|soundcloud\.com)\/oembed/;

/** Stub every oEmbed call with `status`, counting the requests. */
async function stubOembed(page, status = 200, opts = {}) {
  const seen = [];
  await page.route(OEMBED, async (route) => {
    seen.push(route.request().url());
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    if (status === "abort") return route.abort();
    await route.fulfill({
      status, contentType: "application/json",
      body: JSON.stringify({ title: "stub", thumbnail_url: "x" }),
    });
  });
  return seen;
}

const liveness = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("mash.liveness.v1") || "{}"));

const seedLiveness = (page, rec) =>
  page.evaluate((r) => localStorage.setItem("mash.liveness.v1", JSON.stringify(r)), rec);

const seedLedger = (page, led) =>
  page.evaluate((l) => localStorage.setItem("mash.livecheck.v1", JSON.stringify(l)), led);

const today = () => new Date().toISOString().slice(0, 10);

/** Wait for a batch to finish rather than for a fixed time. */
const batchDone = (page) =>
  expect.poll(() => page.locator("#statCheck").textContent(), { timeout: 15000 })
    .not.toContain("checking");

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
});

test("the check control offers the unchecked remainder and is a real target", async ({ page }) => {
  const btn = page.locator("#statCheck");
  await expect(btn).toBeVisible();
  await expect(btn).toHaveText("check 25 of 1257");
  expect(await isHittable(page, "#statCheck")).toMatchObject({ ok: true });
});

test("the control disappears once every track has a record", async ({ page }) => {
  await page.evaluate(() => {
    const rec = {};
    for (const t of window.MASH_TRACKS) rec[t.k] = { s: "ok", c: null, t: 1, v: "oembed" };
    localStorage.setItem("mash.liveness.v1", JSON.stringify(rec));
  });
  await page.reload();
  await expect(page.locator("#statCheck")).toBeHidden();
});

test("a batch records oembed verdicts and stops at the batch size", async ({ page }) => {
  const seen = await stubOembed(page, 200);
  await page.click("#statCheck");
  await batchDone(page);

  const rec = await liveness(page);
  expect(Object.keys(rec)).toHaveLength(25);
  expect(seen).toHaveLength(25);
  for (const v of Object.values(rec)) expect(v).toMatchObject({ s: "ok", v: "oembed" });
});

test("a 404 from oembed is recorded as gone, and the track counts as unavailable", async ({ page }) => {
  await stubOembed(page, 404);
  await page.click("#statCheck");
  await batchDone(page);

  const rec = await liveness(page);
  expect(Object.values(rec).every((r) => r.s === "gone" && r.v === "oembed")).toBe(true);
  await expect(page.locator("#statDead")).toHaveText("25 unavailable");
});

test("a request that never gets an answer records nothing", async ({ page }) => {
  /* The app is offline far more often than a track is deleted, and a false
     "gone" is sticky — it would hide a healthy track from the list for good. */
  await stubOembed(page, "abort");
  await page.click("#statCheck");
  await batchDone(page);
  expect(await liveness(page)).toEqual({});
});

test("the batch never rechecks a track that already has a record", async ({ page }) => {
  const first = await page.evaluate(() => window.MASH_TRACKS[0].k);
  await seedLiveness(page, { [first]: { s: "gone", c: 100, t: 1, v: "oembed" } });
  await page.reload();
  const seen = await stubOembed(page, 200);
  await page.click("#statCheck");
  await batchDone(page);

  const rec = await liveness(page);
  expect(rec[first]).toMatchObject({ t: 1 });                  // untouched
  expect(seen.some((u) => u.includes(encodeURIComponent(first.slice(3))))).toBe(false);
  expect(Object.keys(rec)).toHaveLength(26);                   // 1 seeded + 25 new
});

test("playing an unchecked track checks that track alone", async ({ page }) => {
  const seen = await stubOembed(page, 200);
  const key = await page.evaluate(() => window.MASH_TRACKS[0].k);
  await page.click(".trow");
  await expect.poll(async () => Object.keys(await liveness(page)).length).toBe(1);
  expect(seen).toHaveLength(1);
  expect((await liveness(page))[key]).toMatchObject({ v: "oembed" });
});

test("the day ledger caps how many a batch will check", async ({ page }) => {
  await seedLedger(page, { day: today(), spent: 295 });
  await page.reload();
  await expect(page.locator("#statCheck")).toHaveText("check 5 of 1257");

  const seen = await stubOembed(page, 200);
  await page.click("#statCheck");
  await batchDone(page);
  expect(seen).toHaveLength(5);
});

test("a spent budget disables the control, and yesterday's does not", async ({ page }) => {
  await seedLedger(page, { day: today(), spent: 300 });
  await page.reload();
  await expect(page.locator("#statCheck")).toBeDisabled();

  await seedLedger(page, { day: "2020-01-01", spent: 300 });
  await page.reload();
  await expect(page.locator("#statCheck")).toBeEnabled();
  await expect(page.locator("#statCheck")).toHaveText("check 25 of 1257");
});

test("the offline file upgrades an oembed record but never a playback one", async ({ page }) => {
  const [a, b] = await page.evaluate(() => window.MASH_TRACKS.slice(0, 2).map((t) => t.k));
  await seedLiveness(page, {
    [a]: { s: "ok", c: null, t: 1, v: "oembed" },     // weak: upgradeable
    [b]: { s: "ok", c: null, t: 1, v: "playback" },   // strong: must survive
  });
  await page.route("**/data/liveness.json", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        [a]: { s: "blocked", c: 150, t: 2, v: "api" },
        [b]: { s: "blocked", c: 150, t: 2, v: "api" },
      }),
    })
  );
  await page.reload();

  await expect.poll(async () => (await liveness(page))[a].s).toBe("blocked");
  const rec = await liveness(page);
  expect(rec[a]).toMatchObject({ s: "blocked", v: "api" });
  expect(rec[b]).toMatchObject({ s: "ok", v: "playback" });
});

test("a record written before the provenance field survives the offline merge", async ({ page }) => {
  /* Anyone who used the app before `v` existed has records with no `v`. They
     came from playback, so the file must not overwrite them. */
  const key = await page.evaluate(() => window.MASH_TRACKS[0].k);
  await seedLiveness(page, { [key]: { s: "ok", c: null, t: 1 } });
  await page.route("**/data/liveness.json", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ [key]: { s: "gone", c: 100, t: 2, v: "api" } }),
    })
  );
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll(".trow").length > 0);
  await expect.poll(async () => (await liveness(page))[key].s).toBe("ok");
});
