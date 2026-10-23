import { test, expect } from "@playwright/test";
import { blockExternal } from "./helpers.js";

/* Muting a preroll ad.
 *
 * The embed says nothing about an ad: measured against three real ones, it
 * reports the content's id and the content's duration throughout. What it does
 * is let the clock run for ~15s while never reporting PLAYING, then report
 * PLAYING with the clock reset for the real track.
 *
 * So the signal is "time is passing but the player has not started", and these
 * tests drive exactly that. Ads cannot be made to serve to an automated browser
 * on demand, so the shape is reproduced rather than the ad. */

async function fakePlayer(page) {
  await page.addInitScript(() => {
    window.__p = { muted: false, mutes: 0, unmutes: 0, clock: 0 };
    let events = {};
    window.YT = {
      PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, CUED: 5 },
      Player: function (host, opts) {
        events = (opts && opts.events) || {};
        this.getPlayerState = () => 1;
        this.getCurrentTime = () => window.__p.clock;
        this.getDuration = () => 292;
        this.cueVideoById = () => {};
        /* Two things a real player does here, both load-bearing.
           It does NOT report PLAYING — a real one does not either while a
           preroll runs, which is the whole signal, so the test says when.
           And it keeps reporting the PREVIOUS clock for a moment: resetting
           instantly gave the grace window nothing to guard against, and its
           mutation went undetected until this lagged. */
        this.loadVideoById = () => {
          /* One pending reset at a time. Without the clear, an earlier load's
             timer fires later and zeroes a clock the test has since set, which
             quietly removed the stale read this is here to model. */
          clearTimeout(window.__p.resetAt);
          window.__p.resetAt = setTimeout(() => { window.__p.clock = 0; }, 500);
        };
        this.playVideo = () => {};
        this.pauseVideo = () => {};
        this.stopVideo = () => {};
        this.mute = () => { window.__p.muted = true; window.__p.mutes++; };
        this.unMute = () => { window.__p.muted = false; window.__p.unmutes++; };
        this.isMuted = () => window.__p.muted;
        setTimeout(() => events.onReady && events.onReady({ target: this }), 0);
      },
    };
    /* An ad: the clock advances while the player stays silent about starting.
       Cancels any pending reset from a load. Three separate tests have now been
       broken by that timer firing later and zeroing a clock the test had set —
       a clock set explicitly is the test taking control, and it must win. */
    window.__adRuns = (secs) => {
      clearTimeout(window.__p.resetAt);
      window.__p.clock = secs;
    };
    /* The track itself beginning, clock back to zero. */
    window.__trackStarts = () => {
      window.__p.clock = 0;
      events.onStateChange && events.onStateChange({ data: 1 });
    };
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

async function playYT(page) {
  await page.locator('.trow[data-key^="YT:"]').first().click();
  await page.waitForTimeout(150);
}

test("a clock running before the track starts is muted", async ({ page }) => {
  await playYT(page);
  expect((await p(page)).muted).toBe(false);

  await page.waitForTimeout(700);                 // past the grace window
  await page.evaluate(() => window.__adRuns(3));  // the ad is playing
  await expect.poll(() => chip(page)).toBe(true);
  expect((await p(page)).muted).toBe(true);
});

test("the mute is handed back when the track itself starts", async ({ page }) => {
  await playYT(page);
  await page.waitForTimeout(700);
  await page.evaluate(() => window.__adRuns(5));
  await expect.poll(() => chip(page)).toBe(true);

  await page.evaluate(() => window.__trackStarts());
  await expect.poll(() => chip(page)).toBe(false);
  const st = await p(page);
  expect(st.muted).toBe(false);
  expect(st.unmutes).toBe(1);
});

test("a normal start is never muted", async ({ page }) => {
  /* PLAYING arrives promptly with the clock at zero, which is what an ad-free
     start looks like and what must not be touched. */
  await playYT(page);
  await page.evaluate(() => window.__trackStarts());
  await page.evaluate(() => window.__adRuns(4));   // now genuinely playing
  await page.waitForTimeout(1200);

  expect((await p(page)).mutes).toBe(0);
  expect(await chip(page)).toBe(false);
});

test("a load that never starts is not mistaken for an ad", async ({ page }) => {
  /* A dead or slow embed leaves the clock at zero. Time passing on its own is
     not the signal; time passing ON THE CLOCK is. */
  await playYT(page);
  await page.waitForTimeout(1500);                 // clock stays 0

  expect((await p(page)).mutes).toBe(0);
  expect(await chip(page)).toBe(false);
});

test("a stale clock just after a track change does not mute", async ({ page }) => {
  /* The failure that killed the previous signal: for a moment after the load the
     player can still be reporting the track that was playing a second ago. */
  await playYT(page);
  await page.evaluate(() => window.__trackStarts());
  /* Past the first load's own reset before setting the clock, or that timer
     lands later and zeroes it — which is how this test first passed against a
     version with no grace window at all. */
  await page.waitForTimeout(700);
  await page.evaluate(() => window.__adRuns(120));  // deep into track one
  await page.waitForTimeout(200);

  await page.locator('.trow[data-key^="YT:"]').nth(1).click();
  /* The clock keeps reading 120 for 500ms, which is two polls' worth of
     "the clock is running and nothing has started" — an ad, as far as the
     signal can tell. Only the grace window separates them. */
  await page.waitForTimeout(560);
  expect((await p(page)).mutes, "the grace window must cover the stale clock").toBe(0);
});

test("a mute the reader made is left alone", async ({ page }) => {
  await playYT(page);
  await page.evaluate(() => { window.__p.muted = true; });
  await page.waitForTimeout(700);
  await page.evaluate(() => window.__adRuns(4));
  await page.waitForTimeout(1200);

  expect((await p(page)).mutes).toBe(0);
  expect(await chip(page)).toBe(false);

  await page.evaluate(() => window.__trackStarts());
  await page.waitForTimeout(400);
  expect((await p(page)).unmutes, "and never handed back").toBe(0);
  expect((await p(page)).muted).toBe(true);
});

test("stopping during an ad hands the mute back", async ({ page }) => {
  await playYT(page);
  await page.waitForTimeout(700);
  await page.evaluate(() => window.__adRuns(6));
  await expect.poll(() => chip(page)).toBe(true);

  await page.click("#bStop");
  await expect.poll(() => chip(page)).toBe(false);
  expect((await p(page)).muted).toBe(false);
});

/* --------------------------------------------- giving up on a long ad
 *
 * The tolerance is a number of seconds the reader sets in the top bar. An ad
 * that runs past it costs the track it is in front of: the player moves on.
 * Nothing about the ad itself is skipped, blocked or hurried.
 *
 * 5s is the floor of the scale, and these tests step down to it rather than
 * seeding a pref, so the control and the behaviour are exercised by the same
 * run — a tolerance nothing can reach from the interface is not a feature. */

const curKey = (page) =>
  page.evaluate(() => {
    const row = document.querySelector('.trow[aria-current="true"]');
    return row ? row.dataset.key : null;
  });

/** Step the control down to its floor, however many steps that is. */
async function tolFloor(page) {
  for (let i = 0; i < 30; i++) {
    if (!(await page.locator("#adSkipDown").isEnabled())) break;
    await page.click("#adSkipDown");
  }
  await expect(page.locator("#adSkipVal")).toHaveText("ad 5s");
}

test("an ad past the tolerance costs the track, not the reader", async ({ page }) => {
  await tolFloor(page);
  await playYT(page);
  const first = await curKey(page);
  expect(first).toBeTruthy();

  await page.waitForTimeout(700);
  await page.evaluate(() => window.__adRuns(3));
  await expect.poll(() => chip(page)).toBe(true);

  await expect.poll(async () => (await curKey(page)) !== first, { timeout: 15_000 })
    .toBe(true);

  /* The mute belongs to the ad we walked away from, so it goes back on the way
     out; the new track must not inherit it. */
  expect((await p(page)).muted).toBe(false);
  await expect.poll(() => chip(page)).toBe(false);
  /* And the track was never heard, so it is not decayed. Pressing Next does
     not mark a track played, and neither does this. Read from the store and
     not from the status bar: nothing here re-renders the bar, so a track
     quietly added to the played set leaves it reading zero. */
  expect(await page.evaluate(() =>
    JSON.parse(localStorage.getItem("mash.played.v1") || "[]"))).toEqual([]);
});

test("an ad inside the tolerance is left to finish", async ({ page }) => {
  /* The default is 35s, so three seconds of ad is nothing to act on. Without a
     threshold at all, any ad would take the track with it. */
  await expect(page.locator("#adSkipVal")).toHaveText("ad 35s");
  await playYT(page);
  const first = await curKey(page);

  await page.waitForTimeout(700);
  await page.evaluate(() => window.__adRuns(3));
  await expect.poll(() => chip(page)).toBe(true);
  await page.waitForTimeout(3000);

  expect(await curKey(page)).toBe(first);
  expect(await chip(page), "still muted, still waiting").toBe(true);
});

test("the tolerance measures the ad and never the track", async ({ page }) => {
  /* The worst bug this feature could have: a stopwatch that keeps running once
     the music starts would throw a track away every five seconds. */
  await tolFloor(page);
  await playYT(page);
  const first = await curKey(page);

  await page.evaluate(() => window.__trackStarts());
  await page.evaluate(() => window.__adRuns(30));   // the track itself, playing
  await page.waitForTimeout(6500);

  expect(await curKey(page)).toBe(first);
  expect((await p(page)).mutes).toBe(0);
});

test("with nowhere to go the ad is not traded for another", async ({ page }) => {
  /* One playable track means the next one IS this one, and reloading it rolls
     the dice on another ad — forever, at one throw per tolerance. */
  await tolFloor(page);
  await page.fill("#search", "Hot Natured (Jamie Jones");
  await expect.poll(() => page.locator(".trow").count()).toBe(1);

  await page.locator(".trow").first().click();
  await page.waitForTimeout(700);
  const first = await curKey(page);
  await page.evaluate(() => window.__adRuns(3));
  await expect.poll(() => chip(page)).toBe(true);
  await page.waitForTimeout(6500);

  expect(await curKey(page)).toBe(first);
  expect(await chip(page), "the ad is still on, and still muted").toBe(true);
});

test("the tolerance steps by five, stops at both ends, and is remembered", async ({ page }) => {
  const val = page.locator("#adSkipVal");
  await expect(val).toHaveText("ad 35s");

  await page.click("#adSkipDown");
  await expect(val).toHaveText("ad 30s");
  await page.click("#adSkipUp");
  await page.click("#adSkipUp");
  await expect(val).toHaveText("ad 40s");

  await tolFloor(page);
  await expect(page.locator("#adSkipDown")).toBeDisabled();
  await expect(page.locator("#adSkipUp")).toBeEnabled();

  for (let i = 0; i < 40; i++) {
    if (!(await page.locator("#adSkipUp").isEnabled())) break;
    await page.click("#adSkipUp");
  }
  await expect(val).toHaveText("ad 120s");
  await expect(page.locator("#adSkipUp")).toBeDisabled();

  await page.click("#adSkipDown");
  await page.reload();
  await expect(page.locator("#adSkipVal")).toHaveText("ad 115s");
});

test("a stored tolerance off the scale is brought back onto it", async ({ page }) => {
  await page.evaluate(() =>
    localStorage.setItem("mash.prefs.v1", JSON.stringify({ adSkip: 9999 })));
  await page.reload();
  await expect(page.locator("#adSkipVal")).toHaveText("ad 120s");

  await page.evaluate(() =>
    localStorage.setItem("mash.prefs.v1", JSON.stringify({ adSkip: "whenever" })));
  await page.reload();
  await expect(page.locator("#adSkipVal")).toHaveText("ad 35s");
});
