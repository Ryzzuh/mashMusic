import { test, expect } from "@playwright/test";
import { blockExternal, isHittable } from "./helpers.js";

const openWheel = (page) => page.click("#bWheel");

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
});

test("the wheel opens, draws, and is actually on screen", async ({ page }) => {
  await openWheel(page);
  await expect(page.locator("#wheelModal")).toBeVisible();
  expect(await isHittable(page, "#wheelCanvas")).toMatchObject({ ok: true });

  const painted = await page.evaluate(() => {
    const c = document.getElementById("wheelCanvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
    return n / (d.length / 4);
  });
  expect(painted).toBeGreaterThan(0.5);        // a disc fills most of the square
});

test("the wheel only offers contributors that are in play", async ({ page }) => {
  await page.click("#btnContrib");
  await page.click("#contribAll");                        // none
  await page.locator(".contrib").first().click();         // Beau Garcia only
  await page.click("#contribClose");

  await openWheel(page);
  await expect(page.locator("#wheelSub")).toContainText("1 in play");

  await page.click("#wheelSpin");
  await expect(page.locator("#wheelSub")).toContainText("Beau Garcia");
});

test("the weighting toggle is announced and persists", async ({ page }) => {
  await openWheel(page);
  // the button is labelled with its action, matching #contribAll's convention
  await expect(page.locator("#wheelWeight")).toHaveText("Even odds");
  await expect(page.locator("#wheelSub")).toContainText("odds follow track count");

  await page.click("#wheelWeight");
  await expect(page.locator("#wheelWeight")).toHaveText("Weighted");
  await expect(page.locator("#wheelSub")).toContainText("equal odds");

  await page.reload();
  await openWheel(page);
  await expect(page.locator("#wheelWeight")).toHaveText("Weighted");
});

test.describe("selection distribution", () => {
  // test.use({ reducedMotion }) does not reach the page under channel:"chrome"
  // — matchMedia reported false. emulateMedia does, and it exercises the
  // reduced-motion branch in spinWheel(), which resolves synchronously.
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.evaluate(() =>
      window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  });

  const spin = async (page, n) => {
    const hits = [];
    for (let i = 0; i < n; i++) {
      await page.click("#wheelSpin");
      const line = await page.locator("#wheelSub").textContent();
      hits.push(line.split("—")[0].trim());
    }
    return hits;
  };

  test("weighted odds follow track count, even odds do not", async ({ page }) => {
    // Beau Garcia holds 330 of 1257 tracks (26%) but is 1 of 71 people (1.4%),
    // so the two modes should separate clearly.
    await openWheel(page);
    const weighted = await spin(page, 60);
    const weightedShare = weighted.filter((n) => n === "Beau Garcia").length / weighted.length;

    await page.click("#wheelWeight");                     // -> even odds
    const even = await spin(page, 60);
    const evenShare = even.filter((n) => n === "Beau Garcia").length / even.length;

    expect(weightedShare).toBeGreaterThan(0.10);          // expect ~0.26
    expect(evenShare).toBeLessThan(0.10);                 // expect ~0.014
    expect(weightedShare).toBeGreaterThan(evenShare);
    expect(new Set(even).size).toBeGreaterThan(new Set(weighted).size / 2);
  });

  test("a spin actually starts a track by the contributor it landed on", async ({ page }) => {
    await openWheel(page);
    await page.click("#wheelSpin");
    const who = (await page.locator("#wheelSub").textContent()).split("—")[0].trim();
    await page.click("#wheelClose");
    await expect(page.locator("#npSub")).toContainText(`via ${who}`);
  });
});

/* The half of the feature the first pass left untested: the rotation itself.
   Replacing the resting-angle maths with a random value passed every earlier
   assertion, because they all read text written straight from pickWinner(). */

test.describe("the wheel actually lands where it says", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  // two contributors -> segment 0 is --wheel-1, segment 1 is --wheel-2
  const twoContributors = async (page) => {
    await page.click("#btnContrib");
    await page.click("#contribAll");
    await page.locator(".contrib").nth(0).click();
    await page.locator(".contrib").nth(1).click();
    const names = await page.$$eval('.contrib[aria-pressed="true"] .contrib-name',
      (els) => els.map((e) => e.textContent));
    await page.click("#contribClose");
    return names;
  };

  test("the segment under the pointer is the announced winner", async ({ page }) => {
    const names = await twoContributors(page);
    await openWheel(page);

    for (let i = 0; i < 8; i++) {
      await page.click("#wheelSpin");
      const result = await page.evaluate((names) => {
        const c = document.getElementById("wheelCanvas");
        const g = c.getContext("2d");
        // just inside the rim at twelve o'clock, where the pointer aims
        const d = g.getImageData(Math.round(c.width / 2), Math.round(c.height * 0.10), 1, 1).data;
        const cs = getComputedStyle(document.documentElement);
        const rgb = (n) => {
          const m = /^#([0-9a-f]{6})$/i.exec(cs.getPropertyValue(n).trim());
          return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
        };
        const near = (a, b) => Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) + Math.abs(a[2]-b[2]) < 30;
        const px = [d[0], d[1], d[2]];
        const underPointer = near(px, rgb("--wheel-1")) ? names[0]
                           : near(px, rgb("--wheel-2")) ? names[1] : "unknown";
        const announced = document.getElementById("wheelSub").textContent.split("\u2014")[0].trim();
        return { underPointer, announced };
      }, names);
      expect(result.underPointer, `spin ${i + 1}`).toBe(result.announced);
    }
  });

  test("every segment is labelled even at 71 slices", async ({ page }) => {
    await openWheel(page);
    await page.click("#wheelWeight");          // even odds: all 71 are 0.089 rad
    const ink = await page.evaluate(() => {
      const c = document.getElementById("wheelCanvas");
      const g = c.getContext("2d");
      const cs = getComputedStyle(document.documentElement);
      const m = /^#([0-9a-f]{6})$/i.exec(cs.getPropertyValue("--check-ink").trim());
      const lab = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i]-lab[0]) + Math.abs(d[i+1]-lab[1]) + Math.abs(d[i+2]-lab[2]) < 40 && d[i+3] > 200) n++;
      }
      return n;
    });
    // tangential labels drew nothing at all in this mode
    expect(ink).toBeGreaterThan(800);
  });
});

test("closing mid-spin does not disable Spin forever", async ({ page }) => {
  await openWheel(page);
  await page.click("#wheelSpin");             // full 3.2s animation
  await page.waitForTimeout(400);
  await page.click("#wheelClose");            // dismiss mid-flight
  await page.waitForTimeout(300);

  await openWheel(page);
  await expect(page.locator("#wheelSpin")).toBeEnabled();
  await page.click("#wheelSpin");
  await expect(page.locator("#wheelSub")).toContainText("\u2014", { timeout: 8000 });
});

test("the Spin button stays reachable on a short viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 480 });
  await openWheel(page);
  // .modal has overflow:hidden, so without a scrollable region the footer was
  // clipped away entirely with no way to reach it
  expect(await isHittable(page, "#wheelSpin")).toMatchObject({ ok: true });
});

test("no contributors selected disables Spin", async ({ page }) => {
  await page.click("#btnContrib");
  await page.click("#contribAll");            // none
  await page.click("#contribClose");
  await openWheel(page);
  await expect(page.locator("#wheelSub")).toHaveText("No contributors selected");
  await expect(page.locator("#wheelSpin")).toBeDisabled();
});

test("the wheel repaints when the theme changes under it", async ({ page }) => {
  await openWheel(page);
  const sample = () => page.evaluate(() => {
    const c = document.getElementById("wheelCanvas");
    const d = c.getContext("2d").getImageData(Math.round(c.width / 2), Math.round(c.height * 0.10), 1, 1).data;
    return [d[0], d[1], d[2]].join(",");
  });
  const before = await sample();
  await page.evaluate(() => {
    document.documentElement.dataset.skin =
      document.documentElement.dataset.skin === "night" ? "jukebox" : "night";
  });
  await page.waitForTimeout(200);
  expect(await sample()).not.toBe(before);
});

test("the wheel canvas carries a text alternative", async ({ page }) => {
  await openWheel(page);
  await expect(page.locator("#wheelCanvas")).toHaveAttribute("aria-label", /Wheel of \d+ contributors/);
});
