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
