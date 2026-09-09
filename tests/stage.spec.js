import { test, expect } from "@playwright/test";
import { blockExternal, isHittable } from "./helpers.js";

/* QoL 10: the stage and the scrubber pin under the top bar, and the video
 * column closes once the list is scrolled. */

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
  /* Wait for the stage to have a real height before measuring anything.
   *
   * .stage-side is `height: 0; min-height: 100%`, so every row in it — the
   * now-playing text and the artwork/spectrum strip — is sized from the video
   * box's 16:9 height. Measure before that resolves and the strip is short,
   * which reads as a 165px gap to the scrubber rather than 33. That is a race
   * at load, not a defect, and it is why this file's assertions have to start
   * from a settled layout. */
  await page.waitForFunction(
    () => document.querySelector(".stage-media")?.getBoundingClientRect().height > 100,
    null, { timeout: 10_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
});

/* Two frames was enough before the block animated its sticky offset. Crossing
 * the trigger now starts a 300ms `top` transition, so every assertion about
 * where the block sits would otherwise resolve on how long a CDP round trip
 * happened to take — measured: the old helper read a top of about -100 on its
 * way to 59, and the "pinned under the bar" assertion passed anyway because two
 * evaluates took longer than the transition. Waits for the pinned offset and the
 * stage height to hold still for two consecutive frames instead. */
const settle = (page) => page.evaluate(() => new Promise((resolve) => {
  const pin = document.querySelector(".pinned");
  const st = document.querySelector(".stage");
  const read = () => getComputedStyle(pin).top + "|" +
    st.getBoundingClientRect().height.toFixed(2);
  let last = null, stable = 0, frames = 0;
  const step = () => {
    const now = read();
    stable = now === last ? stable + 1 : 0;
    last = now;
    if (stable >= 2 || ++frames > 60) return resolve();   // ~1s cap
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}));

/** How much of the expanded stage is allowed to leave before anything pins. */
const peelOf = (page) => page.evaluate(() =>
  parseFloat(getComputedStyle(document.querySelector(".pinned"))
    .getPropertyValue("--stage-peel")) || 0);

async function geo(page) {
  return page.evaluate(() => {
    const r = (s) => {
      const b = document.querySelector(s).getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, height: b.height, width: b.width };
    };
    const strip = r(".stage-strip");
    return {
      collapsed: document.querySelector(".stage").classList.contains("is-collapsed"),
      pinned: r(".pinned"),
      stage: r(".stage"),
      barBottom: r(".topbar").bottom,
      meta: r(".stage-meta"),
      strip,
      media: r(".stage-media"),
      gapToScrub: Math.round(r("#scrubber").top - strip.bottom),
      scrub: r("#scrubber"),
      vh: window.innerHeight,
    };
  });
}

test("the stage collapses when the list is scrolled and comes back at the top", async ({ page }) => {
  const before = await geo(page);
  expect(before.collapsed).toBe(false);
  expect(Math.round(before.media.width)).toBeGreaterThan(400);

  await page.evaluate(() => window.scrollTo(0, 900));
  await settle(page);
  const mid = await geo(page);
  expect(mid.collapsed).toBe(true);
  /* The class lands immediately but the column closes over 0.3s, so poll for
     the animation rather than assert one frame after the scroll. */
  await expect.poll(async () => Math.round((await geo(page)).media.width),
    { message: "the video column never finished closing" }).toBeLessThan(20);
  await expect.poll(async () => (await geo(page)).pinned.height)
    .toBeLessThan(before.pinned.height - 150);

  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  expect((await geo(page)).collapsed).toBe(false);
});

test("the gap from the artwork to the scrubber survives the collapse", async ({ page }) => {
  /* The spec's one hard number. Keeping the stage and the scrubber in a single
   * sticky wrapper is what makes it hold: the gap stays ordinary flow spacing
   * rather than something that has to be recomputed. */
  /* Poll rather than assert once. The whole side column is sized from the
     video box's 16:9 height, and until that resolves the strip is short — which
     reads as a 165px gap instead of 33. Waiting for .stage-media to have a
     height was not enough on its own; the settled gap is the thing this test
     is actually about. */
  await expect.poll(async () => (await geo(page)).gapToScrub,
    { message: "the expanded gap never settled" }).toBe(33);

  await page.evaluate(() => window.scrollTo(0, 900));
  await expect.poll(async () => (await geo(page)).collapsed).toBe(true);
  await expect.poll(async () => (await geo(page)).gapToScrub,
    { message: "the collapsed gap never settled" }).toBe(33);
});

test("the expanded stage scrolls away, and only the collapsed one pins", async ({ page }) => {
  /* The two modes differ in whether they pin at all. Expanded, the block is
     ordinary content and leaves with the list; collapsed, it holds under the bar
     for the rest of the scroll. This asserted only the second half, and every
     scroll position it used was already past the trigger — so it went on passing
     when the first half did not exist. */
  const peel = await peelOf(page);
  expect(peel, "no peel measured, so nothing below is being tested")
    .toBeGreaterThan(50);

  // short of the trigger: moved up by exactly the scroll amount, still expanded
  await page.evaluate(() => window.scrollTo(0, 100));
  await settle(page);
  const early = await geo(page);
  expect(early.collapsed).toBe(false);
  expect(early.pinned.top).toBeCloseTo(early.barBottom - 100, 0);

  // at it and past it: under the bar, and staying there
  for (const y of [Math.ceil(peel) + 1, 900, 4000, 12000]) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await settle(page);
    const g = await geo(page);
    expect(g.collapsed, `collapsed at scrollY ${y}`).toBe(true);
    expect(Math.abs(g.pinned.top - g.barBottom), `pinned at scrollY ${y}`).toBeLessThan(1.5);
  }
});

test("the trigger is half the expanded stage, and reverses at the same point", async ({ page }) => {
  const before = await geo(page);
  const peel = await peelOf(page);
  /* The peel IS half the expanded stage. That equivalence holds only because the
     stage sits directly under a bar of constant height, which is what makes the
     hidden amount equal to the scroll position. */
  expect(peel).toBeCloseTo(before.stage.height / 2, 0);

  await page.evaluate((v) => window.scrollTo(0, v), Math.floor(peel) - 8);
  await settle(page);
  expect((await geo(page)).collapsed, "8px short of the trigger").toBe(false);

  await page.evaluate((v) => window.scrollTo(0, v), Math.ceil(peel) + 8);
  await settle(page);
  expect((await geo(page)).collapsed, "8px past it").toBe(true);

  await page.evaluate((v) => window.scrollTo(0, v), Math.floor(peel) - 8);
  await settle(page);
  const back = await geo(page);
  expect(back.collapsed, "reverses at the same point").toBe(false);
  expect(back.stage.height, "and to the same height").toBeCloseTo(before.stage.height, 0);
});

test("the scrubber stays on screen and usable while collapsed", async ({ page }) => {
  await page.evaluate(() => window.scrollTo(0, 4000));
  await settle(page);
  const g = await geo(page);
  expect(g.collapsed).toBe(true);
  // it scrolled away entirely before the scrubber was pinned alongside the stage
  expect(g.scrub.top).toBeGreaterThanOrEqual(g.barBottom - 1);
  expect(g.scrub.bottom).toBeLessThanOrEqual(g.vh);
  expect(await isHittable(page, "#scrubber")).toMatchObject({ ok: true });
});

test("collapsing moves the now-playing text to the left of the spectrum", async ({ page }) => {
  const before = await geo(page);
  // expanded: text sits above the strip, sharing its left edge
  expect(Math.round(before.meta.left)).toBe(Math.round(before.strip.left));
  expect(before.meta.top).toBeLessThan(before.strip.top);

  await page.evaluate(() => window.scrollTo(0, 900));
  await settle(page);
  const after = await geo(page);
  expect(after.meta.left).toBeLessThan(after.strip.left);      // now beside it
  expect(Math.abs(after.meta.top - after.strip.top)).toBeLessThan(after.strip.height);
});

test("the trigger is re-measured after a resize that happens while collapsed", async ({ page }) => {
  /* The hazard the probe in measureStage() exists for. The expanded height is a
     function of the width, and it cannot be read while collapsed — that returns
     the collapsed height, which would put the trigger at about a quarter of
     where it belongs. Resizing while collapsed is the only way to reach that
     path, so it is the only way to test it. */
  const peelBefore = await peelOf(page);
  await page.evaluate((v) => window.scrollTo(0, v), Math.ceil(peelBefore) + 40);
  await settle(page);
  expect((await geo(page)).collapsed, "must be collapsed before the resize").toBe(true);

  await page.setViewportSize({ width: 1400, height: 820 });
  await settle(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);

  const after = await geo(page);
  const peelAfter = await peelOf(page);
  expect(after.collapsed).toBe(false);
  expect(peelAfter, "the peel must track the wider stage")
    .toBeGreaterThan(peelBefore);
  expect(peelAfter, "and still be half of it").toBeCloseTo(after.stage.height / 2, 0);
});

/* ------------------------------------------------------------------ the pin */

const pinColour = (page) => page.evaluate(() =>
  getComputedStyle(document.querySelector("#npPin")).color);

test("the pin holds the expanded stage under the bar", async ({ page }) => {
  const peel = await peelOf(page);
  expect(await isHittable(page, "#npPin")).toMatchObject({ ok: true });

  const off = await pinColour(page);
  await page.click("#npPin");
  await settle(page);
  expect(await page.getAttribute("#npPin", "aria-pressed")).toBe("true");
  /* The state has to be visible and not merely announced: this control locks
     the layout, which is a surprising thing to be in without being told. */
  const on = await pinColour(page);
  expect(on, "pressed must look different").not.toBe(off);
  expect(on, "and specifically like an active setting").toBe(
    await page.evaluate(() => {
      const el = document.createElement("span");
      el.style.color = getComputedStyle(document.documentElement)
        .getPropertyValue("--accent").trim();
      document.body.appendChild(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    }));

  await page.evaluate((v) => window.scrollTo(0, v), Math.ceil(peel) + 400);
  await settle(page);
  const g = await geo(page);
  expect(g.collapsed, "the scroll must not collapse a pinned stage").toBe(false);
  expect(Math.abs(g.pinned.top - g.barBottom), "and it holds under the bar")
    .toBeLessThan(1.5);
});

test("the pin is reachable and holds the collapsed stage too", async ({ page }) => {
  const peel = await peelOf(page);
  await page.evaluate((v) => window.scrollTo(0, v), Math.ceil(peel) + 400);
  await settle(page);
  expect((await geo(page)).collapsed).toBe(true);

  /* The control has to work in the mode where the stage is 117px tall and the
     video column is shut, which is the whole reason it lives on the source line
     rather than anywhere in .stage-media. */
  expect(await isHittable(page, "#npPin")).toMatchObject({ ok: true });
  await page.click("#npPin");
  await settle(page);

  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  expect((await geo(page)).collapsed, "the top must not expand a pinned stage").toBe(true);
});

test("unpinning catches up with the scroll position", async ({ page }) => {
  /* Without the explicit re-evaluation on release the stage stays expanded
     until the reader happens to scroll again, which reads as the button not
     having worked. */
  await page.click("#npPin");
  await settle(page);
  await page.evaluate(() => window.scrollTo(0, 900));
  await settle(page);
  expect((await geo(page)).collapsed).toBe(false);

  await page.click("#npPin");
  await settle(page);
  expect((await geo(page)).collapsed, "released, with no further scrolling").toBe(true);
});

test("the pin survives a reload", async ({ page }) => {
  await page.click("#npPin");
  await settle(page);
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector(".stage-media")?.getBoundingClientRect().height > 100);
  await settle(page);

  expect(await page.getAttribute("#npPin", "aria-pressed")).toBe("true");
  await page.evaluate(() => window.scrollTo(0, 900));
  await settle(page);
  expect((await geo(page)).collapsed, "and still holds after the reload").toBe(false);
});

test("the pin is not offered, or obeyed, where nothing pins", async ({ page }) => {
  /* Below 860px `.pinned` is static. A pin there could not hold anything on
     screen, and a lock carried over from a wider window would freeze the mode
     with no visible control to undo it. */
  await page.click("#npPin");
  await settle(page);

  await page.setViewportSize({ width: 700, height: 820 });
  await settle(page);
  expect(await page.isVisible("#npPin"), "hidden where it would be a lie").toBe(false);

  await page.evaluate(() => window.scrollTo(0, 300));
  await settle(page);
  expect((await geo(page)).collapsed, "narrow ignores the lock entirely").toBe(true);
});

test("a list with too little scroll room never collapses", async ({ page }) => {
  /* Collapsing shortens the document by the stage's own shrink — 259px at this
   * file's 1100px viewport, and it scales with the width, which is why app.js
   * measures it rather than carrying a number. A list that can only just be
   * scrolled past the trigger would be pulled back above it and the two states
   * would alternate on every scroll event.
   *
   * The first version of this test filtered to three rows, which cannot
   * scroll at all — scrollY stayed 0, so the guard was never reached and
   * deleting it left the test green. Six favourites is the zone that matters:
   * scrollable, but by less than the collapse costs. */
  await page.evaluate(() => {
    const ks = window.MASH_TRACKS.slice(0, 6).map((t) => t.k);
    localStorage.setItem("mash.favs.v1", JSON.stringify(ks));
  });
  await page.reload();
  await page.click("#bFavs");
  await expect.poll(() => page.locator(".trow").count()).toBe(6);

  const room = await page.evaluate(() =>
    document.documentElement.scrollHeight - window.innerHeight);
  /* The window is narrow and both bounds matter. Below the trigger the collapse
     is never attempted and the guard is never reached — which is the same way
     the three-row version of this test managed to pass while doing nothing. */
  const peel = await peelOf(page);
  expect(room, "must be scrollable past the trigger, or the guard is never reached")
    .toBeGreaterThan(peel);
  expect(room, "but by less than the collapse would remove").toBeLessThan(260);

  /* The end state alone proves nothing: without the guard the flap resolves
   * back to expanded on its own — collapse shortens the document, scrollY is
   * clamped to 0, and the next event expands it again. What the guard
   * prevents is that churn, so count the actual class changes. */
  await page.evaluate(() => {
    window.__stageToggles = 0;
    new MutationObserver(() => { window.__stageToggles++; })
      .observe(document.querySelector(".stage"), { attributes: true, attributeFilter: ["class"] });
  });

  /* Wait out the 300ms collapse transition and the bounce that follows it.
   * Two rAFs is far too early: unguarded, this reads collapsed=true at +30ms
   * and only flips back to false at ~+400ms, once the shortened document has
   * clamped the scroll position to 0. */
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(600);
    expect((await geo(page)).collapsed, `after scroll ${i + 1}`).toBe(false);
  }

  expect(await page.evaluate(() => window.__stageToggles),
    "the stage must not flicker between states").toBe(0);
  expect((await geo(page)).gapToScrub).toBe(33);
});

test("jump-to-top clears the pinned stage, not just the top bar", async ({ page }) => {
  test.setTimeout(60_000);
  await page.evaluate(() => window.scrollTo(0, 6000));
  await settle(page);
  await page.click("#tTop");

  /* Poll the claim itself until it rests. Two fixed waits were wrong here for
   * two different reasons: 1000ms sampled the smooth scroll mid-flight at
   * y=18, and waiting only for the scroll position to stop still caught the
   * 300ms expand that fires once it reaches 0. The claim is about where the
   * list comes to rest, so wait for exactly that. */
  /* Two separate waits, so a failure says which half broke. Under a loaded
   * full-suite run this timed out at 8s while passing alone, and "the row
   * never cleared" did not distinguish a stalled smooth scroll from a wrong
   * resting geometry. */
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)),
    { timeout: 20_000, message: "the smooth scroll never reached the document top" })
    .toBe(0);

  await expect.poll(async () => {
    const g = await page.evaluate(() => {
      const first = document.querySelector(".trow").getBoundingClientRect();
      const pinned = document.querySelector(".pinned").getBoundingClientRect();
      return { firstRowTop: Math.round(first.top), pinnedBottom: Math.round(pinned.bottom) };
    });
    return g.firstRowTop >= g.pinnedBottom - 2;
  }, { timeout: 10_000, message: "the stage expanded but the first row stayed behind it" })
    .toBe(true);
});

test("the stage does not pin on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 820 });
  await settle(page);
  expect(await page.evaluate(() =>
    getComputedStyle(document.querySelector(".pinned")).position)).toBe("static");

  // and it still must not overflow or lose the gap
  await page.evaluate(() => window.scrollTo(0, 900));
  await settle(page);
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);

  /* The peel is a wide-viewport behaviour and must not follow the class here.
     A scroll of 100 is short of the wide trigger; narrow keeps the old plain
     threshold, so it is collapsed well before that, with no peel set. */
  await page.evaluate(() => window.scrollTo(0, 100));
  await settle(page);
  expect(await page.evaluate(() =>
    document.querySelector(".stage").classList.contains("is-collapsed"))).toBe(true);
  expect(await peelOf(page)).toBe(0);
});

test("reduced motion drops the collapse transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() =>
    matchMedia("(prefers-reduced-motion: reduce)").matches), "emulation took effect").toBe(true);
  // the project's convention is a global * rule capping every duration at
  // .01ms !important, which computes to "1e-05s" — not "0s"
  const secs = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".stage"))
      .transitionDuration.split(",").map((v) => parseFloat(v)));
  expect(secs.length).toBeGreaterThan(0);
  for (const v of secs) expect(v).toBeLessThanOrEqual(0.001);

  // and the transition is real when motion is allowed, or this proves nothing
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const normal = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".stage"))
      .transitionDuration.split(",").map((v) => parseFloat(v)));
  expect(Math.max(...normal)).toBeGreaterThan(0.1);
});


test("scroll anchoring does not drag the jump-to-top back", async ({ page }) => {
  /* The stage grows by ~258px as the scroll nears the top, and scroll
   * anchoring exists to compensate for exactly that — content above the
   * viewport changing size. Left on, it settles the page 73px short with the
   * first rows behind the pinned block. Measured: 73 with anchoring, 0 without.
   *
   * The full list has to be rendered and fully scrolled first; a short scroll
   * does not give anchoring enough to work with. */
  test.setTimeout(90_000);

  /* Assert the declaration as well as the behaviour. The behavioural half
   * below is an unreliable gate: with `overflow-anchor` restored it only
   * reproduces about one run in three, because whether the compensation fires
   * depends on scroll timing. Measured over three mutation runs: 1 failed, 2
   * passed. The declaration is what a regression would actually delete, and
   * checking it fails every time. */
  expect(await page.evaluate(() =>
    getComputedStyle(document.documentElement).overflowAnchor)).toBe("none");

  await page.click("#tBottom");
  await page.waitForFunction(() => document.querySelectorAll(".trow").length === 1257,
    null, { timeout: 30_000 });
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);

  await page.click("#tTop");
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)),
    { timeout: 20_000, message: "the page never came to rest at the document top" })
    .toBe(0);

  // and having landed, it must stay there rather than being nudged back
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(0);
});
