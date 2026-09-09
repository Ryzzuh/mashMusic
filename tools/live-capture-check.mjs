/* The live spectrum against a REAL capture. Run by hand; never in the suite.
 *
 *   node tools/live-capture-check.mjs [url]
 *
 * Everything in tests/liveeq.spec.js stubs getDisplayMedia and builds its own
 * MediaStream from an oscillator. That exercises the AudioContext, the
 * bin-to-band mapping and the draw loop, and it cannot touch two things:
 * whether a browser will grant the capture at all, and what Chrome's audio
 * pipeline does to the signal on the way through. The second of those was
 * hiding a real defect — see the constraints comment in app.js.
 *
 * Two facts make this runnable without a human at the picker, and they are the
 * whole reason this file exists rather than a paragraph of instructions:
 *
 *   --auto-accept-this-tab-capture   grants the request with no dialog, so the
 *                                    app's own "go live" click goes through.
 *   headless has NO AUDIO DEVICE     the capture is granted and the track is
 *                                    live, but it carries silence and every bar
 *                                    reads zero. That looks exactly like a
 *                                    broken feature and is not. Headed only.
 *
 * Checks, in order: a real tone lands in the band it belongs in, the strip is a
 * peak rather than a wall, and Chrome's voice processing is off on the track we
 * actually receive.
 */
import { chromium } from "playwright";

const URL_ = process.argv[2] || "https://ryzzuh.github.io/mashMusic/";
const BANDS = 24, LO = 40, HI = 16000;
const bandOf = (hz) => Math.round(BANDS * Math.log(hz / LO) / Math.log(HI / LO));

/** Bar heights in CSS px, read off the canvas. Mirrors tests/liveeq.spec.js. */
const readBars = () => {
  const c = document.getElementById("eqScope");
  const ctx = c.getContext("2d");
  const { width: w, height: h } = c;
  const scale = w / c.clientWidth;
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
    out.push(Math.round((floorY - top) / scale));
  }
  return out;
};

/** Poll until the bars stop rising, the same reason the suite does. */
async function settle(page) {
  let prev = null;
  for (let i = 0; i < 60; i++) {
    const now = await page.evaluate(readBars);
    const peak = Math.max(...now);
    if (prev !== null && peak > 3 && Math.abs(peak - Math.max(...prev)) <= 1) return now;
    prev = now;
    await page.waitForTimeout(200);
  }
  return prev || [];
}

let failures = 0;
const check = (ok, what, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${detail ? "   " + detail : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  headless: false,                    // see the header: headless has no audio
  channel: "chrome",
  args: ["--auto-accept-this-tab-capture", "--autoplay-policy=no-user-gesture-required"],
});

try {
  for (const hz of [1000, 120]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(URL_, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#eqLive");

    // real audio out of the tab, not a stubbed stream
    await page.evaluate((f) => {
      const ac = new AudioContext();
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = f;
      g.gain.value = 0.25;
      o.connect(g).connect(ac.destination);
      o.start();
    }, hz);
    await page.waitForTimeout(400);

    await page.click("#eqLive");                  // the app's own control
    await page.waitForTimeout(600);

    const state = await page.evaluate(() => ({
      tag: document.getElementById("eqTag").textContent,
      pressed: document.getElementById("eqLive").getAttribute("aria-pressed"),
    }));

    console.log(`\n${hz} Hz tone`);
    check(state.pressed === "true", "the capture was granted", state.tag);
    check(/tab audio/i.test(state.tag), "and reports tab audio", state.tag);

    const bars = await settle(page);
    const peak = bars.indexOf(Math.max(...bars));
    const want = bandOf(hz);
    check(Math.max(...bars) > 4, "something is drawn", `max ${Math.max(...bars)}`);
    check(Math.abs(peak - want) <= 1, "the peak is in the right band",
          `band ${peak}, expected ~${want}`);
    /* The wall this catches: with Chrome's voice processing left on, a single
       low tone lit all 24 bands because the pipeline injected 70-80 dB of noise
       into empty frequencies. */
    check(Math.min(...bars) < Math.max(...bars) / 3, "a peak, not a wall",
          `min ${Math.min(...bars)} vs max ${Math.max(...bars)}`);

    await page.close();
  }

  // and the track we actually receive, rather than the one we asked for
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(URL_, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#eqLive");
  const got = await page.evaluate(async () => {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { suppressLocalAudioPlayback: false, echoCancellation: false,
               noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: true, selfBrowserSurface: "include",
    });
    const t = s.getAudioTracks()[0].getSettings();
    s.getTracks().forEach((x) => x.stop());
    return t;
  });
  console.log("\ngranted track settings");
  check(got.echoCancellation === false, "echo cancellation off", String(got.echoCancellation));
  check(got.noiseSuppression === false, "noise suppression off", String(got.noiseSuppression));
  check(got.autoGainControl === false, "gain control off", String(got.autoGainControl));
  await page.close();
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} failed` : "\nall ok");
process.exit(failures ? 1 : 0);
