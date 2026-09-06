/* Shared test helpers.
 *
 * The suite deliberately never depends on YouTube or SoundCloud being
 * reachable. It doesn't need to: play() sets state.playing and calls
 * loadEnvelope() synchronously, and the envelope is served from localhost, so
 * the scrubber and spectrum both render whether or not a remote player ever
 * starts. Blocking the external hosts makes every run fast and identical. */

import zlib from "node:zlib";

export const EXTERNAL = /youtube\.com|youtube-nocookie|ytimg\.com|soundcloud\.com|sndcdn\.com|googleapis\.com|gstatic\.com/;

/** Abort every third-party request so tests are hermetic. */
export async function blockExternal(page) {
  await page.route(EXTERNAL, (route) => route.abort());
}

/** Serve a synthetic PNG of a given size for any image request matching `re`. */
export async function stubImage(page, re, width, height) {
  // A 1x1 PNG scaled by the browser still reports naturalWidth as 1, so the
  // real dimensions have to be encoded in the file itself.
  const png = pngOfSize(width, height);
  await page.route(re, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png })
  );
}

/** Minimal uncompressed-ish PNG encoder — enough for size assertions. */
function pngOfSize(w, h) {
  const chunks = [];
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;                       // 8-bit, truecolour
  const row = Buffer.alloc(1 + w * 3);            // filter byte + grey pixels
  row.fill(0x66, 1);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  chunks.push(chunk("IHDR", ihdr));
  chunks.push(chunk("IDAT", zlib.deflateSync(raw)));
  chunks.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

/** Filter the list to one term and click the first row. */
export async function playFirstMatch(page, term) {
  await page.fill("#search", term);
  await page.waitForFunction(
    (t) => {
      const row = document.querySelector(".trow .t-name");
      return row && document.querySelectorAll(".trow").length > 0 &&
             document.getElementById("search").value === t;
    },
    term
  );
  await page.waitForTimeout(250);            // debounce in app.js is 140ms
  const key = await page.getAttribute(".trow", "data-key");
  await page.click(".trow");
  return key;
}

/** Is the element actually painted and hittable where it claims to be?
 *
 * Playwright's toBeVisible() checks bounding box and computed styles, which
 * does NOT model clipping by an ancestor's overflow. A menu inside an
 * overflow:hidden container passes toBeVisible() while being invisible to the
 * user; elementFromPoint is what catches that. */
export function isHittable(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, why: "no element" };
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { ok: false, why: "zero size" };
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      ok: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
      why: hit ? hit.tagName + "." + (hit.className || "") : "nothing at that point",
    };
  }, selector);
}

/** Set the list-visibility mode through the picker UI. */
export async function setListMode(page, mode) {
  // every mode is in the menu now, including "show" — the pill used to be a
  // shortcut back to plain titles and is a menu toggle like the caret
  await page.click("#listModeMore");
  await page.click(`.listmode-menu [data-listmode="${mode}"]`);
}

/** Bounding rects for several selectors at once. */
export function rects(page, selectors) {
  return page.evaluate((sels) => {
    const out = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) { out[s] = null; continue; }
      const r = el.getBoundingClientRect();
      out[s] = { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    }
    return out;
  }, selectors);
}

/** Topmost row (in CSS px) containing any painted pixel on a canvas.
 *
 * `ignoreCssVar` names a theme colour to skip. The scrubber playhead is drawn
 * full-height, so without excluding it every measurement returns row 0 and the
 * assertion passes no matter where the waveform actually starts. */
export function canvasTopmostPaintedRow(page, selector, ignoreCssVar) {
  return page.evaluate(([sel, varName]) => {
    const c = document.querySelector(sel);
    const g = c.getContext("2d");
    const dpr = c.width / c.getBoundingClientRect().width;

    let ignore = null;
    if (varName) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      const m = /^#([0-9a-f]{6})$/i.exec(v);
      if (m) ignore = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    }

    const d = g.getImageData(0, 0, c.width, c.height).data;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i + 3] <= 40) continue;
        if (ignore &&
            Math.abs(d[i] - ignore[0]) < 12 &&
            Math.abs(d[i + 1] - ignore[1]) < 12 &&
            Math.abs(d[i + 2] - ignore[2]) < 12) continue;
        return y / dpr;
      }
    }
    return null;                                  // nothing painted at all
  }, [selector, ignoreCssVar || null]);
}

/** Wait until the given canvas has any painted pixel. */
export async function waitForCanvasPaint(page, selector) {
  await page.waitForFunction((sel) => {
    const c = document.querySelector(sel);
    if (!c || !c.width) return false;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) return true;
    return false;
  }, selector, { timeout: 10_000 });
}
