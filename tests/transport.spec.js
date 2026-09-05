import { test, expect } from "@playwright/test";
import { blockExternal, playFirstMatch, isHittable, rects } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
});

test("the flank mirrors the tracklist's own columns", async ({ page }) => {
  const r = await rects(page, [
    ".tflank-left", ".tflank-fav", "#tJump", ".trow .t-fav", ".trow .t-index", ".trow .t-main",
  ]);

  // the box ends at the midpoint of the gap between number and name
  const midpoint = (r[".trow .t-index"].right + r[".trow .t-main"].left) / 2;
  expect(Math.abs(r[".tflank-left"].right - midpoint)).toBeLessThanOrEqual(1);

  // heart above the row hearts, jump above the track numbers
  expect(Math.abs(r[".tflank-fav"].left - r[".trow .t-fav"].left)).toBeLessThanOrEqual(1);
  expect(Math.abs(r["#tJump"].left - r[".trow .t-index"].left)).toBeLessThanOrEqual(1);
});

test("the flank contents stay inside the flank and inside the viewport", async ({ page }) => {
  for (const sel of ["#tFav", "#tJump", "#tTop", "#tBottom", "#fltYT", "#fltSC", "#mAllRemain"]) {
    expect(await isHittable(page, sel), sel).toMatchObject({ ok: true });
  }
  // isHittable probes the centre, so it cannot see an edge hanging off screen —
  // the readouts overflowed the viewport by 2px and passed it
  const escapes = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".tflank *").forEach((el) => {
      const r = el.getBoundingClientRect();
      const f = el.closest(".tflank").getBoundingClientRect();
      if (r.width && (r.right > f.right + 1 || r.left < f.left - 1)) out.push(el.className || el.id);
    });
    return { escapes: out, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(escapes.escapes).toEqual([]);
  expect(escapes.doc).toBe(0);
});

test("WCAG target size on the jump tab", async ({ page }) => {
  for (const sel of ["#tTop", "#tBottom"]) {
    const box = await page.locator(sel).boundingBox();
    expect(box.width, sel).toBeGreaterThanOrEqual(24);
    expect(box.height, sel).toBeGreaterThanOrEqual(24);
  }
});

test("jump to current brings the playing row into view", async ({ page }) => {
  /* The playing track must be deep in the list. Clicking any transport button
   * focus-scrolls the document back to the top, and with row 0 playing that
   * lands the row on screen on its own — this test passed with jumpToCurrent
   * stubbed out to an empty function. Row 600 is only reachable by scrolling
   * to it deliberately. */
  await page.click("#tBottom");                   // render all 1257
  await page.waitForTimeout(700);
  await page.locator(".trow").nth(600).click();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);

  const offScreen = () => page.evaluate(() => {
    const r = document.querySelector('.trow[aria-current="true"]').getBoundingClientRect();
    return r.bottom < 0 || r.top > window.innerHeight;
  });
  expect(await offScreen(), "the row must start off screen or this proves nothing").toBe(true);

  await page.click("#tJump");
  // a smooth scroll across ~35,000px takes well over a second; poll rather
  // than guess a timeout
  await expect.poll(offScreen, { timeout: 8000 }).toBe(false);
  const r = await page.locator('.trow[aria-current="true"]').boundingBox();
  expect(r.y).toBeGreaterThanOrEqual(0);          // boundingBox is x/y, not top
  expect(r.y + r.height).toBeLessThanOrEqual(820);
});

test("the tab jumps to the top and to the bottom of the list", async ({ page }) => {
  await page.click("#tBottom");
  // the bottom of a windowed list means rendering the rest of it first
  await expect.poll(() => page.locator(".trow").count()).toBe(1257);
  await expect(page.locator("#listEnd")).toBeVisible();

  /* No fixed sleep before a geometry read. Since QoL 10 the stage animates
   * its own height, so the layout is still moving after the smooth scroll
   * nominally ends — 900ms left this 525px short of its resting place. */
  await page.click("#tTop");
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)),
    { timeout: 15_000 }).toBe(0);
  await expect.poll(async () => {
    const g = await page.evaluate(() => {
      const pinned = document.querySelector(".pinned");
      const sticky = getComputedStyle(pinned).position === "sticky";
      const chrome = (sticky ? pinned : document.querySelector(".topbar")).getBoundingClientRect();
      const list = document.querySelector("#tracklist").getBoundingClientRect();
      return Math.abs(list.top - chrome.bottom);
    });
    return g < 6;
  }, { timeout: 10_000, message: "the list never settled below the sticky chrome" }).toBe(true);
  /* Landing the list at y=0 buries its first rows behind the sticky chrome.
   * Asserting |listTop| < 30 was satisfied by exactly that bug. The chrome is
   * the top bar plus, since QoL 10, the pinned stage and scrubber — so the
   * target is the bottom of whatever is actually pinned above the list. */
  const geo = await page.evaluate(() => {
    const pinned = document.querySelector(".pinned");
    const sticky = getComputedStyle(pinned).position === "sticky";
    return {
      listTop: document.querySelector("#tracklist").getBoundingClientRect().top,
      chromeBottom: (sticky ? pinned : document.querySelector(".topbar"))
        .getBoundingClientRect().bottom,
      firstRowTop: document.querySelector(".trow").getBoundingClientRect().top,
    };
  });
  expect(Math.abs(geo.listTop - geo.chromeBottom)).toBeLessThan(6);
  expect(geo.firstRowTop).toBeGreaterThanOrEqual(geo.chromeBottom - 1);
});

test("the source switch filters the list", async ({ page }) => {
  const total = await page.evaluate(() => window.MASH_TRACKS.length);
  const yt = await page.evaluate(() => window.MASH_TRACKS.filter((t) => t.s === "YT").length);

  await page.click("#fltSC");                     // YouTube only
  await expect(page.locator("#fltSC")).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() => page.evaluate(() => document.getElementById("statLoaded").textContent))
    .toContain(String(yt));

  await page.click("#fltSC");
  await expect
    .poll(() => page.evaluate(() => document.getElementById("statLoaded").textContent))
    .toContain(String(total));
});

test("turning off both sources falls back to showing everything", async ({ page }) => {
  await page.click("#fltYT");
  await page.click("#fltSC");                     // would leave an empty library
  const pressed = await page.$$eval("[data-source]", (els) =>
    els.map((e) => e.getAttribute("aria-pressed")));
  expect(pressed).toEqual(["true", "true"]);
  expect(await page.locator(".trow").count()).toBeGreaterThan(0);
});

test("the source filter survives a reload and is actually applied", async ({ page }) => {
  const yt = await page.evaluate(() => window.MASH_TRACKS.filter((t) => t.s === "YT").length);
  await page.click("#fltSC");
  await page.reload();

  await expect(page.locator("#fltSC")).toHaveAttribute("aria-pressed", "false");
  // the button paint alone was passing while the list could have been unfiltered
  await expect
    .poll(() => page.evaluate(() => document.getElementById("statLoaded").textContent))
    .toContain(String(yt));
  expect(await page.$$eval(".trow .t-src", (e) => [...new Set(e.map((x) => x.textContent))]))
    .toEqual(["YT"]);
});

test("a stored source filter that would empty the library is ignored", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("mash.sources.v1", JSON.stringify(["MIXCLOUD"])));
  await page.reload();
  expect(await page.locator(".trow").count()).toBeGreaterThan(0);
});

test("an active source filter is visible even where the flanks are hidden", async ({ page }) => {
  await page.click("#fltSC");
  await expect(page.locator("#statSrc")).toHaveText(/only/);
  await page.setViewportSize({ width: 600, height: 820 });
  await expect(page.locator(".tflank-right")).toBeHidden();
  await expect(page.locator("#statSrc")).toHaveText(/only/);   // still discoverable
});

test("the readouts count from the playing track's position", async ({ page }) => {
  const tracksLeft = () =>
    page.evaluate(() => Number(document.getElementById("mTracksLeft").textContent));

  expect(await tracksLeft()).toBe(1257);          // nothing playing

  // Play rows at known positions. "less than 1257" was satisfied by the search
  // filter alone, so replacing positionOf() with 0 left the old test green.
  for (const [nth, expected] of [[4, 1252], [30, 1226]]) {
    await page.locator(".trow").nth(nth).click();
    await expect.poll(tracksLeft).toBe(expected);
  }
  await expect(page.locator("#mTrackRemain")).not.toHaveText("--:--");
});

test("total remaining matches the sum of what is still queued", async ({ page }) => {
  await page.locator(".trow").nth(10).click();
  await page.waitForTimeout(1200);

  const { shown, expected } = await page.evaluate(() => {
    const parse = (s) => {
      const p = s.split(":").map(Number);
      return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    };
    // everything after position 10, computed from the dataset independently
    const after = window.MASH_TRACKS.slice(11).reduce((n, t) => n + t.d, 0);
    return { shown: parse(document.getElementById("mAllRemain").textContent), expected: after };
  });
  // plus whatever is left of the playing track, which is at most its duration
  expect(shown).toBeGreaterThanOrEqual(expected);
  expect(shown).toBeLessThanOrEqual(expected + 700);
});

test("the transport heart and the row heart stay in step", async ({ page }) => {
  const key = await playFirstMatch(page, "Ben Pearce");
  const rowHeart = page.locator(`.trow[data-key="${key}"] .t-fav`);

  await expect(page.locator("#tFav")).toHaveAttribute("aria-pressed", "false");
  await page.click("#tFav");
  await expect(page.locator("#tFav")).toHaveAttribute("aria-pressed", "true");
  await expect(rowHeart).toHaveAttribute("aria-pressed", "true");

  await rowHeart.click();
  await expect(page.locator("#tFav")).toHaveAttribute("aria-pressed", "false");
});

test("un-favouriting an unrendered row still rebuilds the list", async ({ page }) => {
  /* The fallback (no row element) must run the same toggleFav as the row path.
   * Reaching it needs favourites-only to hold MORE than the 60-row render
   * window with the playing track past the end of it — with a single
   * favourite, switching to favourites-only renders the row and the fallback
   * never executes, which is why the first version of this test passed against
   * a fallback that skipped the rebuild entirely. */
  const keys = await page.evaluate(() => {
    const ks = window.MASH_TRACKS.slice(300, 371).map((t) => t.k);
    localStorage.setItem("mash.favs.v1", JSON.stringify(ks));
    return ks;
  });
  await page.reload();
  const target = await page.evaluate((k) =>
    window.MASH_TRACKS.find((t) => t.k === k), keys[70]);

  await playFirstMatch(page, target.t.slice(0, 26));
  await page.fill("#search", "");
  await page.click("#bFavs");
  await expect.poll(() => page.locator("#statLoaded").textContent()).toContain("/ 71");

  // 60 rendered of 71, and the playing track is the 71st — no row exists
  expect(await page.evaluate((k) =>
    !document.querySelector(`.trow[data-key="${k}"]`), target.k)).toBe(true);
  await expect(page.locator("#tFav")).toHaveAttribute("aria-pressed", "true");

  await page.click("#tFav");
  await expect(page.locator("#tFav")).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate((k) =>
    JSON.parse(localStorage.getItem("mash.favs.v1")).includes(k), target.k)).toBe(false);
  // the view itself must shrink, not just the stored set
  await expect.poll(() => page.locator("#statLoaded").textContent()).toContain("/ 70");
});
