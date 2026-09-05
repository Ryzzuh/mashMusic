import { defineConfig, devices } from "@playwright/test";

/* Headless Chromium against the project's own dev server.
 *
 * Deliberately not the editor's browser pane: that suspends
 * requestAnimationFrame whenever it is hidden, mis-maps synthetic click
 * coordinates, and serves stale assets — all of which produce failures that
 * have nothing to do with the code.
 *
 * tools/serve.py is used rather than `python3 -m http.server` because it maps
 * /mashMusic-eq/ to the sibling envelope checkout and sends no-store.
 *
 * channel: "chrome" drives the system Google Chrome. Playwright's own Chromium
 * build is not available for macOS 13, which this machine runs. */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,        // one dev server, and several tests drive playback
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: "http://localhost:8412",
    viewport: { width: 1100, height: 820 },   // the width every measured invariant assumes
    deviceScaleFactor: 2,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chrome",
      // spread first: devices["Desktop Chrome"] carries its own viewport and
      // deviceScaleFactor, and would otherwise silently override the ones the
      // geometry assertions depend on.
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        viewport: { width: 1100, height: 820 },
        deviceScaleFactor: 2,
      },
    },
  ],

  webServer: {
    command: "python3 tools/serve.py 8412",
    url: "http://localhost:8412/index.html",
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
