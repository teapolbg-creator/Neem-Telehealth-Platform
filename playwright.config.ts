import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests (spec §80).
 *
 * These drive the real web app against the real API and a real MySQL database.
 * Nothing is stubbed — an E2E test that mocks the API would prove only that
 * the mock behaves.
 *
 * Isolation strategy: the suite runs against the ordinary development stack
 * and gives every run its own uniquely-suffixed fixtures (emails, MDC numbers,
 * Pharmacy Council numbers) rather than truncating the database. That keeps a
 * run non-destructive — the seeded demo data survives, so a demo is never
 * wiped by a test run — at the cost of not starting from a pristine database.
 * The Vitest integration suite already covers the pristine-state cases against
 * `neem_test`, so the two layers complement rather than duplicate each other.
 */

const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:8080";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",

  // Fixtures are unique per run, but several specs sign in as the single
  // seeded admin, so files run one at a time to avoid fighting over it.
  fullyParallel: false,
  workers: 1,

  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },

  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"]],

  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // The patient portal is phone-first (spec §69); the staff portals are
    // desktop-first. Specs that need a phone viewport set it themselves.
    viewport: { width: 1280, height: 900 },
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        /**
         * The consultation screens use the real `getUserMedia`, so the browser
         * needs a camera and a granted permission. Chromium's fake device
         * provides both without hardware, and the permission is granted up
         * front because a modal prompt would hang the run.
         *
         * A build agent has no webcam; this is what makes the media path
         * genuinely exercised rather than skipped.
         */
        permissions: ["camera", "microphone"],
        launchOptions: {
          args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
        },
      },
    },
  ],

  /**
   * Waits for the API, which `webServer` below does not.
   *
   * `npm run dev` starts two processes under `concurrently`, and the block
   * below waits only for the web app on 8080 — while every test here talks to
   * the API on 4000. They usually come up close enough together that it never
   * showed, which is the least useful kind of correct.
   */
  globalSetup: "./e2e/support/global-setup.ts",

  /**
   * Reuses an already-running `npm run dev` where there is one, and starts the
   * stack otherwise. The web dev server is pinned to 8080 by the Lovable vite
   * config, so the URL is not configurable here without changing that.
   *
   * This waits for the **web** app only — see `globalSetup` above for the API.
   *
   * `reuseExistingServer` is deliberately unconditional, where Playwright's
   * usual shape is `!process.env.CI`. **CI starts the stack itself**, on
   * purpose: it waits for both 4000 and 8080 before the run begins, and it
   * redirects `npm run dev` to `dev.log`, which the workflow uploads when a
   * test fails. That log is usually where the cause is, and it does not exist
   * if Playwright owns the process — `stdout` here is discarded.
   *
   * With the usual `!process.env.CI`, those two arrangements collide: the
   * workflow has 8080 up, Playwright refuses to reuse it, and the run dies
   * with "http://localhost:8080 is already used" before a single test runs.
   * Reusing is the correct answer precisely because the server it finds is the
   * one the workflow deliberately started.
   */
  webServer: {
    command: "npm run dev",
    url: WEB_URL,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
