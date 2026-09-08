import { test, expect } from "@playwright/test";
import { blockExternal, isHittable } from "./helpers.js";

/* The live spectrum: getDisplayMedia hands over a tab's audio, Web Audio
 * analyses it, and the bars show what is actually coming out.
 *
 * getDisplayMedia cannot be granted in a test, but it does not need to be.
 * The app only ever sees a MediaStream — so these tests build a real one in
 * the page from an oscillator and hand it over. Everything after that point
 * (AudioContext, AnalyserNode, the bin-to-band mapping, the draw loop) is the
 * production path running on real audio, and a known tone frequency means the
 * bars can be checked against the band it belongs in. */

/** Replace getDisplayMedia with one returning a tone at `hz`. */
async function stubCapture(page, hz, opts = {}) {
  await page.evaluate(({ hz, noAudio, gain: g }) => {
    const tones = Array.isArray(hz) ? hz : [hz];
    window.__cap = { stopped: 0 };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const ctx = new AudioContext();
      window.__cap.ctx = ctx;
      const dest = ctx.createMediaStreamDestination();
      if (!noAudio) {
        for (const f of tones) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.frequency.value = f;
          gain.gain.value = g;                    // equal amplitude per tone
          osc.connect(gain).connect(dest);
          osc.start();
        }
      }
      const stream = noAudio ? new MediaStream() : dest.stream;
      // a video track, as a real screen capture would carry
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 8;
      const vid = canvas.captureStream(1).getVideoTracks()[0];
      stream.addTrack(vid);
      window.__cap.video = vid;
      stream.getTracks().forEach((t) => {
        const stop = t.stop.bind(t);
        t.stop = () => { window.__cap.stopped++; stop(); };
      });
      window.__cap.stream = stream;
      return stream;
    };
  }, { hz, noAudio: !!opts.noAudio, gain: opts.gain ?? 0.5 / (Array.isArray(hz) ? hz.length : 1) });
}

/** Bar height per band, read off the canvas the app actually draws.
 *
 * Scans only ABOVE the baseline. The app draws a 1px grid line along the floor
 * on every frame whether or not anything is playing, and the first version of
 * this helper measured that — so "a bar was drawn" was true even with the live
 * source disconnected, and a mutation check went MISSED. */
const bars = (page) => page.evaluate(() => {
  const c = document.getElementById("eqScope");
  const ctx = c.getContext("2d");
  const { width: w, height: h } = c;
  const scale = w / c.clientWidth;                 // canvas is dpr-scaled
  const floorY = Math.round((c.clientHeight - 8) * scale);
  const img = ctx.getImageData(0, 0, w, h).data;
  const n = 24, padX = 12 * scale, gap = 3 * scale;
  const bw = (w - padX * 2 - gap * (n - 1)) / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = Math.round(padX + i * (bw + gap) + bw / 2);
    let top = floorY;
    for (let y = 0; y < floorY - 1; y++) {
      if (img[(y * w + x) * 4 + 3] > 8) { top = y; break; }
    }
    out.push(Math.round((floorY - top) / scale));   // back to CSS px
  }
  return out;
});

/** Bars once they have risen and stopped moving.
 *
 * NOT a fixed wait. eqFrame smooths towards its target over successive
 * animation frames, so how long that takes depends on how fast frames are
 * arriving — under load a 700ms sleep measured a rising edge and three of
 * these tests failed on a busy machine while passing on an idle one. Poll for
 * the settled value, which is the rule this suite already has. */
async function settleBars(page) {
  let prev = null;
  await expect.poll(async () => {
    const now = await bars(page);
    const peak = Math.max(...now);
    const steady = prev !== null && Math.abs(peak - Math.max(...prev)) <= 1;
    prev = now;
    return peak > 3 && steady;
  }, { timeout: 20_000, intervals: [150] }).toBe(true);
  return prev;
}

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
});

test("the control is present, off, and clickable", async ({ page }) => {
  const btn = page.locator("#eqLive");
  await expect(btn).toHaveText("go live");
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  expect(await isHittable(page, "#eqLive")).toMatchObject({ ok: true });
});

test("capture is never started without a click", async ({ page }) => {
  /* A page that asks to capture your screen unprompted is not one to trust,
     so this asserts the app has not called getDisplayMedia on its own. */
  let called = 0;
  await page.exposeFunction("__note", () => { called++; });
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => { window.__note(); throw new Error("no"); };
  });
  await page.waitForTimeout(1200);
  await page.locator(".trow").first().waitFor();   // not a bare click: under
  await page.click(".trow");                       // load the list may be late
  await page.waitForTimeout(1200);
  expect(called).toBe(0);
});

test("a 1 kHz tone lights the band it belongs in, not the whole strip", async ({ page }) => {
  await stubCapture(page, 1000);
  await page.click("#eqLive");
  await expect(page.locator("#eqLive")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#eqTag")).toHaveText(/live/i);

  const h = await settleBars(page);
  /* Bands are 24 log steps from 40 Hz to 16 kHz, so 1 kHz sits at
     round(24 * ln(1000/40) / ln(16000/40)) = band 13. */
  const peak = h.indexOf(Math.max(...h));
  expect(Math.max(...h)).toBeGreaterThan(4);          // something is drawn
  expect(Math.abs(peak - 13)).toBeLessThanOrEqual(1); // in the right place
  // and it is a peak, not a wall: the bottom octave stays quiet
  expect(h[0]).toBeLessThan(Math.max(...h) / 2);
});

test("a different tone moves the peak", async ({ page }) => {
  await stubCapture(page, 120);
  await page.click("#eqLive");
  const h = await settleBars(page);
  const peak = h.indexOf(Math.max(...h));
  // 120 Hz => round(24 * ln(120/40) / ln(400)) = band 4
  expect(Math.abs(peak - 4)).toBeLessThanOrEqual(1);
  expect(peak).toBeLessThan(10);
});

test("live analysis works for a track that has no envelope", async ({ page }) => {
  /* The whole reason this exists. Envelopes cover only the 874 tracks the
     offline pipeline processed; an imported playlist has none at all. */
  await page.evaluate(() => {
    const t = window.MASH_TRACKS.find((x) => x.s === "YT");
    localStorage.setItem("mash.liveness.v1", JSON.stringify({}));
    window.__k = t.k;
  });
  await page.route("**/mashMusic-eq/index.json", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ids: [] }) }));
  await page.reload();
  await page.click(".trow");
  await expect(page.locator("#eqTag")).toHaveText(/no envelope/i);

  await stubCapture(page, 1000);
  await page.click("#eqLive");
  const h = await settleBars(page);
  expect(Math.max(...h)).toBeGreaterThan(4);
});

test("stopping releases the capture and hands the tag back", async ({ page }) => {
  await stubCapture(page, 1000);
  await page.click("#eqLive");
  await expect(page.locator("#eqLive")).toHaveAttribute("aria-pressed", "true");

  await page.click("#eqLive");
  await expect(page.locator("#eqLive")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#eqLive")).toHaveText("go live");
  await expect(page.locator("#eqTag")).not.toHaveText(/live/i);

  // every track stopped, including the video one, so no capture is left running
  const stopped = await page.evaluate(() => window.__cap.stopped);
  expect(stopped).toBeGreaterThanOrEqual(2);
});

test("the video track is dropped immediately; only audio is kept", async ({ page }) => {
  await stubCapture(page, 1000);
  await page.click("#eqLive");
  await expect.poll(() => page.evaluate(() => window.__cap.video.readyState))
    .toBe("ended");
});

test("a share with no audio is reported rather than silently doing nothing", async ({ page }) => {
  /* On macOS Chrome only delivers audio for a TAB share. Choosing a window or
     the whole screen yields a stream with no audio track at all. */
  await stubCapture(page, 1000, { noAudio: true });
  await page.click("#eqLive");
  await expect(page.locator("#eqTag")).toHaveText(/no audio/i);
  await expect(page.locator("#eqLive")).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__cap.stopped)).toBeGreaterThan(0);
});

test("a cancelled picker leaves the app alone", async ({ page }) => {
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const e = new Error("denied"); e.name = "NotAllowedError"; throw e;
    };
  });
  await page.click("#eqLive");
  await expect(page.locator("#eqTag")).toHaveText(/cancelled/i);
  await expect(page.locator("#eqLive")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#eqLive")).toBeEnabled();
});

test("Chrome's own Stop sharing ends live mode", async ({ page }) => {
  await stubCapture(page, 1000);
  await page.click("#eqLive");
  await expect(page.locator("#eqLive")).toHaveAttribute("aria-pressed", "true");

  // the browser ends the track without telling the page anything else
  await page.evaluate(() => {
    const a = window.__cap.stream.getAudioTracks()[0];
    a.dispatchEvent(new Event("ended"));
  });
  await expect(page.locator("#eqLive")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#eqTag")).not.toHaveText(/live/i);
});


test("the spectrum is tilted, so highs are not buried under lows", async ({ page }) => {
  /* EQ_TILT lifts everything above 200 Hz by 2.6 dB per octave, the same tilt
     the offline envelopes are drawn with — without it the two paths would look
     like different instruments. A single tone cannot show this: the tilt
     changes how tall a band is, not which band a tone lands in. Two tones of
     equal amplitude, six octaves apart, can. */
  await stubCapture(page, [100, 6400], { gain: 0.01 });   // well under the ceiling
  await page.click("#eqLive");
  const h = await settleBars(page);

  const low = Math.max(...h.slice(0, 8));     // ~100 Hz
  const high = Math.max(...h.slice(16));      // ~6.4 kHz
  expect(low).toBeGreaterThan(2);             // both tones are present
  expect(high).toBeGreaterThan(2);
  /* 100 Hz is tilted down 2.6 dB and 6.4 kHz up ~13 dB, ~16 dB apart over a
     67 dB window. Both tones have identical amplitude, so any difference in
     bar height is the tilt and nothing else. */
  expect(high).toBeGreaterThan(low * 1.3);
});
