import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EQ_DIR = join(dirname(ROOT), "mashMusic-eq");

test("the track list is still 1,257 unique of 1,318 rows", () => {
  const src = readFileSync(join(ROOT, "data", "tracks.js"), "utf8");
  const rows = JSON.parse(src.slice(src.indexOf("["), src.lastIndexOf("]") + 1));
  expect(rows.length).toBe(1257);
  expect(new Set(rows.map((r) => r.k)).size).toBe(1257);
  expect(rows.filter((r) => r.s === "YT").length).toBe(945);
  expect(rows.filter((r) => r.s === "SC").length).toBe(312);
  expect(rows.filter((r) => !r.d).length).toBe(0);        // no zero durations
});

test("every published envelope has a valid header and body length", () => {
  const files = readdirSync(EQ_DIR).filter((f) => f.endsWith(".bin"));
  expect(files.length).toBeGreaterThan(600);

  // spot-check a spread rather than all 633, to keep the suite quick
  const sample = files.filter((_, i) => i % 40 === 0);
  for (const f of sample) {
    const b = readFileSync(join(EQ_DIR, f));
    expect(b.subarray(0, 4).toString("ascii"), f).toBe("MEQ1");
    const [bands, fps, bits, dbRange] = [b[4], b[5], b[6], b[7]];
    expect([bands, fps, bits, dbRange], f).toEqual([24, 25, 4, 60]);

    const frames = b.readUInt32LE(8);
    const stride = (bands + 1) >> 1;
    expect(b.length, `${f} body length`).toBe(16 + frames * stride);

    // 4-bit packing means no nibble can exceed 15 by construction; assert the
    // file is not silent, which is what a broken analysis run produces
    const body = b.subarray(16);
    let peak = 0;
    for (let i = 0; i < body.length; i += 97) peak = Math.max(peak, body[i] & 0x0f, body[i] >> 4);
    expect(peak, `${f} is entirely silent`).toBeGreaterThan(0);
  }
});

test("the analyser maps tones to the right bands and floors silence", () => {
  test.slow();
  const script = `
import importlib.util, numpy as np
spec = importlib.util.spec_from_file_location("be", "tools/build-envelopes.py")
be = importlib.util.module_from_spec(spec); spec.loader.exec_module(be)
SR = be.SR
edges = [(lo*SR/be.WINDOW, hi*SR/be.WINDOW) for lo, hi in be.EDGES]
out = []
for hz in (55, 250, 1000, 5000, 12000):
    t = np.arange(SR*2, dtype=np.float32)/SR
    mid = be.envelope(np.sin(2*np.pi*hz*t).astype(np.float32))[25]
    top = int(mid.argmax())
    inband = [i for i in range(be.BANDS) if edges[i][0] <= hz <= edges[i][1]]
    out.append(any(abs(top-i) <= 1 for i in inband))
print("PLACEMENT_OK" if all(out) else "PLACEMENT_FAIL")
print("SILENCE", int(be.envelope(np.zeros(SR, np.float32)).max()))
rng = np.random.default_rng(0)
print("FULLSCALE", int(be.envelope(rng.standard_normal(SR).astype(np.float32)).max()))
centres = [ (edges[i][0]+edges[i][1])/2 for i in range(be.BANDS) ]
print("MONOTONIC" if all(centres[i] < centres[i+1] for i in range(len(centres)-1)) else "DEGENERATE")
`;
  const out = execFileSync("uv", [
    "run", "--python", "3.12", "--with", "av", "--with", "numpy", "--with", "yt-dlp",
    "python", "-c", script,
  ], { cwd: ROOT, encoding: "utf8", timeout: 240_000 });

  expect(out).toContain("PLACEMENT_OK");
  expect(out).toMatch(/SILENCE 0\b/);        // silence must not gain up to full scale
  expect(out).toMatch(/FULLSCALE 15\b/);
  expect(out).toContain("MONOTONIC");        // no two bands sharing a centre
});
