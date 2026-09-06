import { test, expect } from "@playwright/test";
import { blockExternal, setListMode, isHittable } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
});

test("the list-mode picker offers every mode, including the one in the pill", async ({ page }) => {
  await expect(page.locator("#listModeCurrent")).toHaveText("Shown");
  await expect(page.locator("#listModeMenu")).toBeHidden();

  await page.click("#listModeMore");
  await expect(page.locator("#listModeMenu")).toBeVisible();
  // toBeVisible() does not model ancestor clipping: this menu once sat inside
  // an overflow:hidden container and was invisible while passing that check
  expect(await isHittable(page, "#listModeMenu")).toMatchObject({ ok: true });
  expect(await isHittable(page, '.listmode-menu [data-listmode="hide"]')).toMatchObject({ ok: true });

  /* All three, with the active one marked. The menu used to list only the two
   * you were not in, so leaving "Shown" removed it from the interface: the
   * only way back was clicking the pill, an affordance advertised by nothing
   * but a title attribute. */
  await expect(page.locator(".listmode-menu button")).toHaveCount(3);
  await expect(page.locator('.listmode-menu [data-listmode="show"]')).toHaveAttribute("aria-current", "true");

  await page.click('.listmode-menu [data-listmode="hide"]');
  await expect(page.locator("#listModeCurrent")).toHaveText("Hidden");
  await expect(page.locator("#listModeMenu")).toBeHidden();
  expect(await page.locator(".trow .t-name").first().textContent()).toMatch(/^Track \d{4}$/);

  // and "Shown" is still there to go back to, marked as inactive
  await page.click("#listModeMore");
  await expect(page.locator('.listmode-menu [data-listmode="hide"]')).toHaveAttribute("aria-current", "true");
  await expect(page.locator('.listmode-menu [data-listmode="show"]')).toHaveAttribute("aria-current", "false");
  await page.click('.listmode-menu [data-listmode="show"]');
  await expect(page.locator("#listModeCurrent")).toHaveText("Shown");
});

test("either half of the control opens the picker", async ({ page }) => {
  for (const sel of ["#listModeCurrent", "#listModeMore"]) {
    await page.click(sel);
    await expect(page.locator("#listModeMenu")).toBeVisible();
    await expect(page.locator(sel)).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator("#listModeMenu")).toBeHidden();
  }
});

test("the picker closes on Escape and on an outside click", async ({ page }) => {
  await page.click("#listModeMore");
  await expect(page.locator("#listModeMenu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#listModeMenu")).toBeHidden();

  await page.click("#listModeMore");
  await expect(page.locator("#listModeMenu")).toBeVisible();
  await page.click(".brand");
  await expect(page.locator("#listModeMenu")).toBeHidden();
});

test("the chosen mode survives a reload", async ({ page }) => {
  await setListMode(page, "blur");
  await expect(page.locator("#listModeCurrent")).toHaveText("Obfuscated");
  await page.reload();
  await expect(page.locator("#listModeCurrent")).toHaveText("Obfuscated");
});

test("the palette badge carries three colours from the active theme", async ({ page }) => {
  const read = () =>
    page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const fill = (sel) => getComputedStyle(document.querySelector(sel)).fill;
      const asRgb = (hex) => {
        const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
        return m ? `rgb(${[0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).join(", ")})` : hex.trim();
      };
      return {
        drops: [fill(".pal-a"), fill(".pal-b"), fill(".pal-c")],
        tokens: ["--accent", "--tint", "--ok"].map((t) => asRgb(cs.getPropertyValue(t))),
        body: fill(".pal-body"),
        raised: asRgb(cs.getPropertyValue("--raised")),
      };
    });

  await page.click('button[data-skin="jukebox"]');
  const juke = await read();
  expect(juke.drops).toEqual(juke.tokens);
  expect(juke.body).toBe(juke.raised);

  await page.click('button[data-skin="night"]');
  const night = await read();
  expect(night.drops).toEqual(night.tokens);
  expect(night.drops).not.toEqual(juke.drops);      // it actually changed
});

test("the palette switches between the two profiles", async ({ page }) => {
  /* It straddles the divider between the two theme buttons and carries the
     active theme's colours, so it reads as the thing that sits between them.
     It used to be pointer-events:none decoration. */
  const skin = () => page.evaluate(() => document.documentElement.dataset.skin);
  expect(await skin()).toBe("jukebox");

  await page.click("#skinBadge");
  await expect.poll(skin).toBe("night");
  await expect(page.locator('button[data-skin="night"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('button[data-skin="jukebox"]')).toHaveAttribute("aria-pressed", "false");

  await page.click("#skinBadge");                       // and back again
  await expect.poll(skin).toBe("jukebox");
  await expect(page.locator('button[data-skin="jukebox"]')).toHaveAttribute("aria-pressed", "true");
});

test("the palette is a real target, not decoration", async ({ page }) => {
  /* isHittable() is not strict enough for this one. It accepts a hit on an
   * ancestor (`hit.contains(el)`), and an unclickable control is exactly the
   * case where elementFromPoint returns the ancestor behind it — so restoring
   * pointer-events:none left that assertion green. The topmost element at the
   * palette's centre has to BE the palette. */
  const hit = await page.evaluate(() => {
    const el = document.getElementById("skinBadge");
    const r = el.querySelector("svg").getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      insideBadge: !!top && el.contains(top),
      landedOn: top ? (top.id || `${top.tagName}.${top.getAttribute("class") || ""}`) : "nothing",
    };
  });
  expect(hit.insideBadge, `a click there lands on ${hit.landedOn}`).toBe(true);

  const box = await page.locator("#skinBadge").boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);

  // a focusable control must not be hidden from assistive tech
  const a11y = await page.evaluate(() => {
    const el = document.getElementById("skinBadge");
    return { tag: el.tagName, ariaHidden: el.getAttribute("aria-hidden"),
             label: el.getAttribute("aria-label") };
  });
  expect(a11y.tag).toBe("BUTTON");
  expect(a11y.ariaHidden).toBeNull();
  expect(a11y.label).toBeTruthy();
});

test("the palette choice persists like the buttons do", async ({ page }) => {
  await page.click("#skinBadge");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.skin)).toBe("night");
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.skin)).toBe("night");
});

test("the badge sits on the divider between the two theme buttons", async ({ page }) => {
  const geo = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const juke = r('button[data-skin="jukebox"]'), badge = r(".skin-badge svg"), night = r('button[data-skin="night"]');
    return {
      badgeCentre: badge.left + badge.width / 2,
      divider: (juke.right + night.left) / 2,
    };
  });
  expect(Math.abs(geo.badgeCentre - geo.divider)).toBeLessThanOrEqual(1.5);
});

test("starting the next track does not move the view", async ({ page }) => {
  await page.evaluate(() => window.scrollTo(0, 400));
  /* Let the layout settle first. This scroll collapses the stage (QoL 10),
   * which shortens the document by ~258px over 300ms and can clamp the
   * position — measuring straight away recorded 400, then read 142 after the
   * click and blamed the next track for a move the test itself caused. */
  await expect.poll(async () => {
    const a = await page.evaluate(() => Math.round(window.scrollY));
    await page.waitForTimeout(150);
    return a === (await page.evaluate(() => Math.round(window.scrollY)));
  }).toBe(true);
  const before = await page.evaluate(() => window.scrollY);
  await page.click("#bNext");
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test("the theme divider does not escape the control", async ({ page }) => {
  // the badge span stretches to full control height, so a -17px inset made this
  // 68px tall and it only looked right because an ancestor clipped it
  const g = await page.evaluate(() => {
    const sw = document.querySelector(".skin-switch").getBoundingClientRect();
    const el = document.querySelector(".skin-badge");
    const d = getComputedStyle(el, "::before");
    const r = el.getBoundingClientRect();
    return { switchTop: sw.top, switchBottom: sw.bottom, badgeTop: r.top, badgeBottom: r.bottom,
             insetTop: d.top, insetBottom: d.bottom };
  });
  expect(g.badgeTop).toBeGreaterThanOrEqual(g.switchTop - 1);
  expect(g.badgeBottom).toBeLessThanOrEqual(g.switchBottom + 1);
  expect(g.insetTop).toBe("0px");
  expect(g.insetBottom).toBe("0px");
});

test("an open picker owns the keyboard", async ({ page }) => {
  await page.click("#bNext");
  await page.waitForTimeout(300);
  const playing = await page.locator("#npTitle").textContent();

  await page.click("#listModeMore");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  expect(await page.locator("#npTitle").textContent()).toBe(playing);   // no skip
  await expect(page.locator("#listModeMenu")).toBeVisible();
});

test("Space activates the focused control instead of the transport", async ({ page }) => {
  await page.focus("#listModeMore");
  await page.keyboard.press(" ");
  await expect(page.locator("#listModeMenu")).toBeVisible();
});

test("closing the picker returns focus to it", async ({ page }) => {
  await page.click("#listModeMore");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.activeElement.id)).toBe("listModeMore");
});

test("the pill is highlighted only when a non-default mode is active", async ({ page }) => {
  const active = () => page.evaluate(() => document.getElementById("listModeCurrent").classList.contains("is-active"));
  expect(await active()).toBe(false);
  await setListMode(page, "hide");
  expect(await active()).toBe(true);
  await setListMode(page, "show");
  expect(await active()).toBe(false);
});

/* ------------------------------------------------- QoL 2: one bar height */

/* Settle to a painted frame. A ResizeObserver callback runs before paint, so a
 * sub-frame sleep measures the previous layout: at a 9ms wait every collapse
 * boundary below reports 1px high. Two rAFs is the reliable wait. */
const settle = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function barMetrics(page, w) {
  await page.setViewportSize({ width: w, height: 820 });
  await settle(page);
  return page.evaluate(() => {
    const bar = document.querySelector(".topbar");
    const doc = document.documentElement;
    const brand = bar.querySelector(".brand").getBoundingClientRect();
    const tools = bar.querySelector(".tools").getBoundingClientRect();
    return {
      h: Math.round(bar.getBoundingClientRect().height),
      barOverflow: bar.scrollWidth - bar.clientWidth,
      docOverflow: doc.scrollWidth - doc.clientWidth,
      // .topbar has a FIXED height, so it can never report a taller box —
      // wrapped children spill out of it instead. Height alone is blind to
      // the exact regression this milestone exists to prevent.
      spill: bar.scrollHeight - bar.clientHeight,
      wrapped: tools.top >= brand.bottom,
      collapsed: document.getElementById("toolsPanel").children.length,
    };
  });
}

const isBad = (m) =>
  m.h !== 59 || m.barOverflow > 0 || m.docOverflow > 0 || m.spill > 0 || m.wrapped;

test("the top bar holds one height and never wraps, 320px to 1600px", async ({ page }) => {
  test.setTimeout(120_000);
  // it used to wrap to 103px at 800 and 149px at 560
  const bad = [];
  for (let w = 1600; w >= 320; w -= 20) {
    const m = await barMetrics(page, w);
    if (isBad(m)) bad.push({ w, ...m });
  }
  expect(bad).toEqual([]);
});

test("no overflow within a pixel of either collapse boundary", async ({ page }) => {
  test.setTimeout(120_000);
  /* A uniform sweep is the wrong instrument. The window where a rounding
   * tolerance leaks a pixel of horizontal scroll is exactly ONE pixel wide,
   * so a 2px sweep finds it with probability 1/2 — it depends on the parity
   * of the boundary, which is not a designed property. There are two
   * boundaries (one per collapsible control), and loading the real fonts
   * shifts each by 1px, flipping that parity.
   *
   * So: binary-search each boundary, then check every integer width around
   * it. ~40 resizes instead of 600, and it cannot miss on parity. */
  const countAt = async (w) => (await barMetrics(page, w)).collapsed;

  const boundaries = [];
  for (const target of [1, 2]) {
    let lo = 320, hi = 1600;                 // count is monotonic as width falls
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await countAt(mid) >= target) lo = mid; else hi = mid;
    }
    boundaries.push(lo);
  }
  expect(boundaries.length).toBe(2);
  expect(boundaries[0]).toBeGreaterThan(boundaries[1]);

  const bad = [];
  for (const b of boundaries) {
    for (let w = Math.min(1600, b + 4); w >= Math.max(320, b - 4); w -= 1) {
      const m = await barMetrics(page, w);
      if (isBad(m)) bad.push({ w, boundary: b, ...m });
    }
  }
  expect(bad).toEqual([]);
});

test("changing the list mode near a boundary does not overflow", async ({ page }) => {
  /* The pill's label is the only live-width element in the bar: "Shown" ->
   * "Obfuscated" moves the first collapse boundary by ~37px. The
   * ResizeObserver watches .topbar, whose size never changes, so nothing
   * noticed until the next window resize — this left 34px of permanent
   * horizontal document scroll. */
  const boundary = await (async () => {
    let lo = 320, hi = 1600;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await barMetrics(page, mid)).collapsed >= 1) lo = mid; else hi = mid;
    }
    return lo;
  })();

  for (const w of [boundary + 4, boundary + 20, boundary + 40]) {
    const before = await barMetrics(page, w);
    expect(isBad(before), `clean before at ${w}`).toBe(false);

    await page.click("#listModeMore");
    await page.click('#listModeMenu button[data-listmode="blur"]');
    await settle(page);
    const after = await barMetrics(page, w);
    expect({ w, ...after }, "widening the pill must not overflow").toMatchObject({
      docOverflow: 0, barOverflow: 0, h: 59,
    });

    await page.click("#listModeMore");        // back to Shown
    await page.click('#listModeMenu button[data-listmode="show"]');
    await settle(page);
  }
});

test("controls collapse into the panel and come back when there is room", async ({ page }) => {
  const inPanel = () => page.$$eval("#toolsPanel > *", (e) => e.map((x) => x.className.split(" ")[0]));

  expect(await inPanel()).toEqual([]);              // 1100px: everything on the bar
  await expect(page.locator("#toolsMore")).toBeHidden();

  await page.setViewportSize({ width: 640, height: 820 });
  await expect.poll(inPanel).toEqual(["switch"]);   // theme goes first
  await expect(page.locator("#toolsMore")).toBeVisible();

  await page.setViewportSize({ width: 400, height: 820 });
  await expect.poll(inPanel).toEqual(["switch", "listmode"]);

  // and widening restores them rather than stranding them in the panel
  await page.setViewportSize({ width: 1100, height: 820 });
  await expect.poll(inPanel).toEqual([]);
  await expect(page.locator("#toolsMore")).toBeHidden();
  await expect(page.locator(".tools > .skin-switch")).toBeVisible();
  await expect(page.locator(".tools > .listmode")).toBeVisible();
});

test("the search is never collapsed and stays usable at 360px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.waitForTimeout(200);
  expect(await isHittable(page, "#search")).toMatchObject({ ok: true });

  const box = await page.locator(".search").boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(124);

  await page.fill("#search", "Ben Pearce");
  await expect.poll(() => page.locator(".trow").count()).toBeGreaterThan(0);
  await expect.poll(() => page.locator(".trow").count()).toBeLessThan(20);
});

test("the collapsed theme and list-mode controls still work", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 820 });
  await expect.poll(() => page.locator("#toolsPanel > *").count()).toBe(2);

  await page.click("#toolsMore");
  await expect(page.locator("#toolsPanel")).toBeVisible();
  /* The panel is absolutely positioned so it cannot add to the bar. Asserting
   * the bar is still 59px tall proves nothing — `height` is fixed in CSS, so
   * that holds however the panel is laid out. And scrollHeight is no good
   * either: an out-of-flow panel hanging below the bar legitimately extends
   * it. What distinguishes the two is where the panel lands — out of flow it
   * drops below the bar; as a flex item it stays inside .tools and pushes its
   * contents off screen (the night button lands at y:-11). */
  const geo = await page.evaluate(() => {
    const bar = document.querySelector(".topbar").getBoundingClientRect();
    const panel = document.getElementById("toolsPanel").getBoundingClientRect();
    const tools = document.querySelector(".tools").getBoundingClientRect();
    return { barBottom: bar.bottom, panelTop: panel.top, toolsH: tools.height };
  });
  expect(geo.panelTop).toBeGreaterThanOrEqual(geo.barBottom);
  expect(geo.toolsH).toBeLessThanOrEqual(40);
  expect(await isHittable(page, '#toolsPanel button[data-skin="night"]')).toMatchObject({ ok: true });

  await page.click('#toolsPanel button[data-skin="night"]');
  await expect(page.locator("html")).toHaveAttribute("data-skin", "night");

  await page.click("#listModeMore");
  await page.click('#listModeMenu button[data-listmode="blur"]');
  await expect(page.locator("#listModeCurrent")).toHaveText("Obfuscated");
  await expect(page.locator(".tracklist")).toHaveClass(/mode-blur/);
  // the class is on the list, so assert the effect actually reaches a title.
  // Obfuscation is the SVG #pixelate filter; the CSS blur is only the
  // reduced-motion fallback, so accept either but never "none".
  expect(await page.evaluate(() =>
    getComputedStyle(document.querySelector(".trow .t-name")).filter))
    .toMatch(/pixelate|blur/);
});

test("the panel closes on outside click and on Escape", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 820 });
  await expect.poll(() => page.locator("#toolsPanel > *").count()).toBe(2);

  await page.click("#toolsMore");
  await expect(page.locator("#toolsPanel")).toBeVisible();
  await page.click("main", { position: { x: 30, y: 300 } });
  await expect(page.locator("#toolsPanel")).toBeHidden();

  await page.click("#toolsMore");
  await expect(page.locator("#toolsPanel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#toolsPanel")).toBeHidden();
  await expect(page.locator("#toolsMore")).toBeFocused();
});

test("Escape closes one layer at a time", async ({ page }) => {
  /* Two separate document keydown listeners could not do this: the picker's
   * own ran first and set listModeMenu.hidden synchronously, so the panel's
   * guard on that flag always read true and a single press collapsed both. */
  await page.setViewportSize({ width: 400, height: 820 });
  await expect.poll(() => page.locator("#toolsPanel > *").count()).toBe(2);

  await page.click("#toolsMore");
  await page.click("#listModeMore");
  await expect(page.locator("#listModeMenu")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#listModeMenu")).toBeHidden();
  await expect(page.locator("#toolsPanel")).toBeVisible();      // panel survives
  await expect(page.locator("#listModeMore")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator("#toolsPanel")).toBeHidden();
  await expect(page.locator("#toolsMore")).toBeFocused();
});

test("closing the panel does not strand the picker open behind it", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 820 });
  await expect.poll(() => page.locator("#toolsPanel > *").count()).toBe(2);

  await page.click("#toolsMore");
  await page.click("#listModeMore");
  await expect(page.locator("#listModeMore")).toHaveAttribute("aria-expanded", "true");

  await page.click("#toolsMore");                    // close the panel around it
  await expect(page.locator("#toolsPanel")).toBeHidden();
  await expect(page.locator("#listModeMenu")).toBeHidden();
  await expect(page.locator("#listModeMore")).toHaveAttribute("aria-expanded", "false");

  // and re-opening must not reveal an already-expanded picker
  await page.click("#toolsMore");
  await expect(page.locator("#listModeMenu")).toBeHidden();
});

test("widening with the picker open leaves nothing floating", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 820 });
  await expect.poll(() => page.locator("#toolsPanel > *").count()).toBe(2);
  await page.click("#toolsMore");
  await page.click("#listModeMore");
  await expect(page.locator("#listModeMenu")).toBeVisible();

  await page.setViewportSize({ width: 1100, height: 820 });
  await expect.poll(() => page.locator("#toolsPanel > *").count()).toBe(0);
  await expect(page.locator("#listModeMenu")).toBeHidden();
  await expect(page.locator("#toolsPanel")).toBeHidden();
  await expect(page.locator("#listModeMore")).toHaveAttribute("aria-expanded", "false");
});

test("a reflow does not throw keyboard focus away", async ({ page }) => {
  /* Moving a focused node between containers blurs it, and so does hiding one:
   * toolsMore.hidden = true runs on every pass, and reading scrollWidth right
   * after forces the flush that drops focus to <body>. A 2px resize that
   * changes nothing at all was destroying focus — which on a phone fires from
   * URL-bar collapse, the on-screen keyboard, and rotation. */
  await page.setViewportSize({ width: 400, height: 820 });
  await expect.poll(() => page.locator("#toolsPanel > *").count()).toBe(2);

  await page.focus("#toolsMore");
  await page.setViewportSize({ width: 398, height: 820 });
  await settle(page);
  await expect(page.locator("#toolsMore")).toBeFocused();

  // and focus follows a control that gets re-parented back onto the bar
  await page.click("#toolsMore");
  await page.focus('#toolsPanel button[data-skin="night"]');
  await page.setViewportSize({ width: 1100, height: 820 });
  await settle(page);
  await expect(page.locator('.tools > .skin-switch button[data-skin="night"]')).toBeFocused();
});
