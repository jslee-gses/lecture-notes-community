import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:8765",
    browserName: "chromium",
  },
  webServer: {
    command: "python -m uvicorn server.e2e.fixture_server:app --host 127.0.0.1 --port 8765",
    cwd: "..",
    url: "http://127.0.0.1:8765/fixture",
    reuseExistingServer: false,
    timeout: 30000,
  },
  outputDir: "../.lecture-notes/playwright-results",
});
