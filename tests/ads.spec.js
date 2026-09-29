import { test, expect } from "@playwright/test";
import { blockExternal } from "./helpers.js";

/* Muting an inferred ad.
 *
 * The player has no ad API — verified against the real one: 73 methods, none
 * about ads. The inference is that getVideoData() reports the id actually on
 * screen, which during an ad is not the id we asked for.
 *
 * Ads do not serve reliably to an automated browser, so the trigger itself is
 * driven here rather than reproduced. What these cover is the logic around it,
 * and in particular that every uncertain case fails towards doing nothing. */

async function fakePlayer(page) {
  await page.addInitScript(() => {
    window.__p = { muted: false, mutes: 0, unmutes: 0, showing: null, data: true };
    let events = {};
    window.YT = {
      PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, CUED: 5 },
      Player: function (host, opts) {
        events = (opts && opts.events) || {};
        this.getPlayerState = () => 1;
        this.getCurrentTime = () => 0;
        this.getDuration = () => 0;
        this.cueVideoById = () => {};
        this.loadVideoById = (id) => {
          /* The lag the debounce exists for. A real player keeps reporting the
             PREVIOUS video for a moment after this call, and a fake that swaps
             instantly has no track-change window at all — which is why the
             debounce's mutation went undetected until this was added.
             200ms, deliberately under the 250ms poll, so exactly one sample can
             ever fall inside it however the interval happens to be phased. */
          setTimeout(() => { window.__p.showing = id; }, 200);
          setTimeout(() => events.onStateChange && events.onStateChange({ data: 1 }), 5);
        };
        this.playVideo = () => {};
        this.pauseVideo = () => {};
        this.stopVideo = () => {};
        this.mute = () => { window.__p.muted = true; window.__p.mutes++; };
        this.unMute = () => { window.__p.muted = false; window.__p.unmutes++; };
        this.isMuted = () => window.__p.muted;
        Object.defineProperty(this, "getVideoData", {
          get: () => (window.__p.data
            ? () => ({ video_id: window.__p.showing })
            : undefined),
        });
        setTimeout(() => events.onReady && events.onReady({ target: this }), 0);
      },
    };
    /* What an ad looks like from out here: the player reports somebody else's
       video while we believe ours is playing. */
    window.__adStarts = () => { window.__p.showing = "AD_0000000"; };
    window.__adEnds = (id) => { window.__p.showing = id; };
  });
}

const p = (page) => page.evaluate(() => window.__p);
const chip = (page) => page.evaluate(() => !document.getElementById("npAd").hidden);

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await fakePlayer(page);
  await page.goto("/");
  await page.waitForSelector(".trow");
  await page.evaluate(() => window.onYouTubeIframeAPIReady());
});

/** Play the first YouTube track and return its id. */
async function playYT(page) {
  const row = page.locator('.trow[data-key^="YT:"]').first();
  const key = await row.getAttribute("data-key");
  await row.click();
  await page.waitForTimeout(300);
  return key.slice(3);
}

test("an ad is muted, and the mute is handed back when it ends", async ({ page }) => {
  const id = await playYT(page);
  expect((await p(page)).muted, "not muted to begin with").toBe(false);

  await page.evaluate(() => window.__adStarts());
  await expect.poll(() => chip(page), { message: "the mute should be visible" }).toBe(true);
  expect((await p(page)).muted).toBe(true);

  await page.evaluate((v) => window.__adEnds(v), id);
  await expect.poll(() => chip(page)).toBe(false);
  const st = await p(page);
  expect(st.muted).toBe(false);
  expect(st.unmutes).toBe(1);
});

test("a mute the reader made is left alone", async ({ page }) => {
  /* Taking a mute we did not make and handing it back later is a change nobody
     asked for, and the reader has no way to tell where it came from. */
  const id = await playYT(page);
  await page.evaluate(() => { window.__p.muted = true; });   // as if via the player

  await page.evaluate(() => window.__adStarts());
  await page.waitForTimeout(1200);
  expect((await p(page)).mutes, "nothing of ours").toBe(0);
  expect(await chip(page)).toBe(false);

  await page.evaluate((v) => window.__adEnds(v), id);
  await page.waitForTimeout(700);
  expect((await p(page)).unmutes, "and it must not be handed back").toBe(0);
  expect((await p(page)).muted).toBe(true);
});

test("changing track is not mistaken for an ad", async ({ page }) => {
  /* After loadVideoById the player reports the PREVIOUS track for a moment,
     which is a mismatch that means nothing. A single sample reads it as an ad. */
  await playYT(page);
  await page.waitForTimeout(400);
  await page.locator('.trow[data-key^="YT:"]').nth(1).click();
  await page.waitForTimeout(900);

  expect((await p(page)).mutes, "a track change must never mute").toBe(0);
  expect(await chip(page)).toBe(false);
});

test("a player without getVideoData infers nothing", async ({ page }) => {
  /* The field is undocumented. If it goes away the feature must go quiet, not
     start muting on a guess. */
  await page.evaluate(() => { window.__p.data = false; });
  await playYT(page);
  await page.evaluate(() => window.__adStarts());
  await page.waitForTimeout(1200);

  expect((await p(page)).mutes).toBe(0);
  expect(await chip(page)).toBe(false);
});

test("stopping during an ad hands the mute back", async ({ page }) => {
  await playYT(page);
  await page.evaluate(() => window.__adStarts());
  await expect.poll(() => chip(page)).toBe(true);

  await page.click("#bStop");
  await expect.poll(() => chip(page)).toBe(false);
  expect((await p(page)).muted, "left muted, nothing would ever unmute it").toBe(false);
});
