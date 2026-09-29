import { test, expect } from "@playwright/test";
import { blockExternal } from "./helpers.js";

/* Resume on return.
 *
 * The YouTube embed pauses itself when the page is hidden. That is the embed's
 * own code and it does not happen on a desktop browser, which plays straight
 * through — so the pause cannot be reproduced here and is simulated instead.
 * What is under test is what the app does about it, which is all the app has
 * any say over.
 *
 * The main player is normally built by the real IFrame API calling
 * onYouTubeIframeAPIReady, and the suite blocks that API. These tests call the
 * same entry point themselves rather than adding a test-only seam. */

/** A main player the test can drive. Installed before the app runs. */
async function fakePlayer(page) {
  await page.addInitScript(() => {
    window.__p = { played: 0, paused: 0, loaded: [], state: -1 };
    let events = {};
    window.YT = {
      PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, CUED: 5 },
      Player: function (host, opts) {
        events = (opts && opts.events) || {};
        this.mute = () => {};
        this.getPlayerState = () => window.__p.state;
        this.getCurrentTime = () => 0;
        this.getDuration = () => 0;
        this.cueVideoById = () => {};
        this.loadVideoById = (id) => {
          window.__p.loaded.push(id);
          window.__p.state = 1;
          setTimeout(() => events.onStateChange && events.onStateChange({ data: 1 }), 5);
        };
        this.playVideo = () => {
          window.__p.played++;
          window.__p.state = 1;
          setTimeout(() => events.onStateChange && events.onStateChange({ data: 1 }), 5);
        };
        this.pauseVideo = () => { window.__p.paused++; window.__p.state = 2; };
        this.stopVideo = () => { window.__p.state = 0; };
        setTimeout(() => events.onReady && events.onReady({ target: this }), 0);
      },
    };
    /* What the embed does on a phone: pause itself, and tell the page. */
    window.__embedPauses = () => {
      window.__p.state = 2;
      events.onStateChange && events.onStateChange({ data: 2 });
    };
  });
}

/** A screen wake lock the test can count. Real Chrome has a real one, so this
 *  has to shadow it rather than fill a gap. */
async function fakeWakeLock(page) {
  await page.addInitScript(() => {
    window.__wake = { requests: 0, releases: 0, listeners: [] };
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async (type) => {
          window.__wake.requests++;
          const mine = [];
          window.__wake.listeners.push(mine);
          return {
            type, released: false,
            addEventListener: (n, f) => { if (n === "release") mine.push(f); },
            release: async () => { window.__wake.releases++; },
          };
        },
      },
    });
    /* What a platform does of its own accord — switching apps, a system policy.
       Not the same as the page releasing it, and the app has to survive both. */
    window.__wakeTakenBack = () => {
      window.__wake.listeners.forEach((fns) => fns.forEach((f) => f()));
      window.__wake.listeners = [];
    };
  });
}

const setHidden = (page, hidden) => page.evaluate((h) => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
  Object.defineProperty(document, "visibilityState",
    { configurable: true, get: () => (h ? "hidden" : "visible") });
  document.dispatchEvent(new Event("visibilitychange"));
}, hidden);

const played = (page) => page.evaluate(() => window.__p.played);

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await fakePlayer(page);
  await fakeWakeLock(page);
  await page.goto("/");
  await page.waitForSelector(".trow");
  // the real API is blocked, so stand in for it at the app's own entry point
  await page.evaluate(() => window.onYouTubeIframeAPIReady());
  await expect.poll(() => page.evaluate(() => window.__p.state)).not.toBe(undefined);
});

/** Start the first YouTube track and wait for the player to have it. */
async function playFirstYT(page) {
  const row = page.locator('.trow[data-key^="YT:"]').first();
  await row.click();
  await expect.poll(() => page.evaluate(() => window.__p.loaded.length)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__p.state)).toBe(1);
}

test("a track the embed paused while hidden is resumed on return", async ({ page }) => {
  await playFirstYT(page);
  const before = await played(page);

  await setHidden(page, true);
  await page.evaluate(() => window.__embedPauses());   // what a phone does
  await page.waitForTimeout(100);
  await setHidden(page, false);

  await expect.poll(() => played(page),
    { message: "the app should have asked the player to resume" })
    .toBe(before + 1);
});

test("a track the reader paused before leaving stays paused", async ({ page }) => {
  /* The reason the intent is snapshotted as the tab hides rather than read on
     the way back: by then the flag is false either way, and resuming a track
     someone deliberately stopped is worse than not resuming at all. */
  await playFirstYT(page);
  await page.click("#bPause");
  const before = await played(page);

  await setHidden(page, true);
  await page.waitForTimeout(100);
  await setHidden(page, false);

  await page.waitForTimeout(300);
  expect(await played(page)).toBe(before);
});

test("a track that never stopped is not restarted", async ({ page }) => {
  /* SoundCloud plays straight through a backgrounded tab, and so does YouTube
     on a desktop browser. Asking the player its state, rather than trusting the
     mirrored flag, is what keeps this from firing a pointless resume. */
  await playFirstYT(page);
  const before = await played(page);

  await setHidden(page, true);
  await page.waitForTimeout(100);
  await setHidden(page, false);          // still PLAYING: nothing was interrupted

  await page.waitForTimeout(300);
  expect(await played(page)).toBe(before);
});


/* ------------------------------------------------------- the screen wake lock
 *
 * A jukebox gets put down, and a phone that locks itself hides the page, which
 * is the same pause by another route. Held only while something plays. */

const wake = (page) => page.evaluate(() => window.__wake);

test("nothing is held while nothing is playing", async ({ page }) => {
  /* A visibility round trip, not just a wait. syncWakeLock() only runs when
     something asks it to, so an idle page never evaluates its condition at all
     and "no lock was taken" is true for the wrong reason — which is exactly how
     this test first passed against a version that held the screen on forever. */
  await setHidden(page, true);
  await setHidden(page, false);
  await page.waitForTimeout(300);
  expect((await wake(page)).requests).toBe(0);
});

test("the screen is held while a track plays, and let go when it stops", async ({ page }) => {
  await playFirstYT(page);
  await expect.poll(async () => (await wake(page)).requests).toBe(1);
  expect((await wake(page)).releases).toBe(0);

  await page.click("#bPause");
  await expect.poll(async () => (await wake(page)).releases,
    { message: "a paused track should not hold the screen on" }).toBe(1);
});

test("the hold is taken again on return, because the platform does not give it back", async ({ page }) => {
  /* The failure this exists for: request once, assume it still holds. The lock
     is released the moment the page hides, silently, and a version that does
     not re-acquire looks correct for exactly as long as nobody leaves. */
  await playFirstYT(page);
  await expect.poll(async () => (await wake(page)).requests).toBe(1);

  await setHidden(page, true);
  await expect.poll(async () => (await wake(page)).releases).toBe(1);

  await setHidden(page, false);
  await expect.poll(async () => (await wake(page)).requests,
    { message: "coming back should take a fresh lock" }).toBe(2);
});

test("a lock the platform takes back is not believed to be held", async ({ page }) => {
  /* If the handle is kept after the platform revokes it, the next sync sees
     "already held" and never asks again, so the screen quietly stops staying on
     with nothing to show for it. */
  await playFirstYT(page);
  await expect.poll(async () => (await wake(page)).requests).toBe(1);

  await page.evaluate(() => window.__wakeTakenBack());
  await page.waitForTimeout(100);

  await setHidden(page, true);
  await setHidden(page, false);
  await expect.poll(async () => (await wake(page)).requests).toBe(2);
  /* The tell is the release count, not the request count. Holding a revoked
     handle, the app releases it on the way out and re-requests on the way back,
     reaching two requests by a route that only looks the same. Nothing was held
     to release, so nothing should have been released. */
  expect((await wake(page)).releases,
    "a revoked lock should not be released as though it were held").toBe(0);
});

/* --------------------------------------------- the background-playback tip
 *
 * The embed's pause is user agent gated: with the browser's desktop-site
 * setting on, switching apps leaves playback running. A page cannot request
 * that mode, so naming the setting is all there is. */

const tipShown = (page) => page.evaluate(() =>
  !document.getElementById("bgTip").hidden);

test("the tip is not shown on a desktop-width viewport", async ({ page }) => {
  /* Also the self-retiring property: a phone that has taken the advice reports
     a desktop-width viewport from then on, so nothing has to detect that. */
  await playFirstYT(page);
  await page.waitForTimeout(200);
  expect(await tipShown(page)).toBe(false);
});

test("the tip appears on a phone once a YouTube track is playing", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 820 });
  expect(await tipShown(page), "nothing playing yet").toBe(false);

  await playFirstYT(page);
  await expect.poll(() => tipShown(page)).toBe(true);
});

test("the tip stays away for a SoundCloud track, which never stops", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 820 });
  await page.locator('.trow[data-key^="SC:"]').first().click();
  await page.waitForTimeout(400);
  expect(await tipShown(page)).toBe(false);
});

test("dismissing the tip is permanent", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 820 });
  await playFirstYT(page);
  await expect.poll(() => tipShown(page)).toBe(true);

  await page.click("#bgTipX");
  expect(await tipShown(page)).toBe(false);

  await page.reload();
  await page.waitForSelector(".trow");
  await page.evaluate(() => window.onYouTubeIframeAPIReady());
  await playFirstYT(page);
  await page.waitForTimeout(400);
  expect(await tipShown(page), "a tip that comes back is a nag").toBe(false);
});

test("switching from SoundCloud to YouTube brings the tip up", async ({ page }) => {
  /* The case the extra paint in play() exists for: this changes the answer
     without changing whether anything is playing, so the state.playing setter
     never fires and the setter alone would leave the tip hidden. */
  await page.setViewportSize({ width: 700, height: 820 });
  await page.locator('.trow[data-key^="SC:"]').first().click();
  await page.waitForTimeout(300);
  expect(await tipShown(page), "SoundCloud does not need the tip").toBe(false);

  await page.locator('.trow[data-key^="YT:"]').first().click();
  await expect.poll(() => tipShown(page)).toBe(true);
});

test("the tip does not cover the last track in the list", async ({ page }) => {
  /* A guard, and honest about being only that: NO code added for the tip is
     keeping this true. The listing's existing bottom padding, plus whatever sits
     below it, already clears the tip by 37px at 360px wide and 44px at 700px —
     measured, after a padding rule added here "to make room" turned out to
     change nothing and was deleted. What this catches is the tip growing: a
     longer string, a bigger font, another line. There is no mutation for it,
     because there is no longer any code to break.

     A short favourites list, not the full library. The list extends in chunks of
     60 as you scroll, so scrolling the whole library to its "bottom" only
     lazy-loads more rows and never arrives — and #tBottom, which would render
     them all, is one of the transport flanks that hide at this width. Forty
     rows is one chunk, taller than the viewport, and genuinely finite. */
  await page.setViewportSize({ width: 700, height: 820 });
  await page.evaluate(() => {
    const ks = window.MASH_TRACKS.filter((t) => t.s === "YT").slice(0, 40).map((t) => t.k);
    localStorage.setItem("mash.favs.v1", JSON.stringify(ks));
  });
  await page.reload();
  await page.waitForSelector(".trow");
  await page.evaluate(() => window.onYouTubeIframeAPIReady());
  await page.click("#bFavs");
  await expect.poll(() => page.locator(".trow").count()).toBe(40);

  await playFirstYT(page);
  await expect.poll(() => tipShown(page)).toBe(true);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(400);

  const clear = await page.evaluate(() => {
    const rows = document.querySelectorAll(".trow");
    const last = rows[rows.length - 1].getBoundingClientRect();
    const tip = document.getElementById("bgTip").getBoundingClientRect();
    return { rows: rows.length, lastBottom: last.bottom, tipTop: tip.top };
  });
  expect(clear.rows, "the whole list must be rendered").toBe(40);
  expect(clear.lastBottom,
    "the last row must end above the tip").toBeLessThanOrEqual(clear.tipTop + 1);
});
