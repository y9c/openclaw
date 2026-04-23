import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 120_000, // 2 min per test (LLM calls can be slow)
  retries: 0,
  use: {
    browserName: "webkit", // Safari!
    baseURL: "http://127.0.0.1:19005",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
});
