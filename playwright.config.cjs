const { defineConfig, devices } = require("@playwright/test");
const path = require("node:path");
const base = require("./playwright.base.cjs");
process.env.ASHRAAY_AGENT_CLIENT_SECRET ||= require("node:crypto").randomBytes(32).toString("hex");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: base.fullyParallel,
  workers: base.workers,
  timeout: 60000,
  expect: { timeout: 12000 },
  retries: base.retries,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    ...base.use,
    baseURL: "http://127.0.0.1:5173"
  },
  projects: [
    base.desktopProject,
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } }
  ],
  webServer: {
    command: `"${process.env.ASHRAAY_TEST_PYTHON || path.join(__dirname, ".venv", "Scripts", "python.exe")}" tests\\support\\local_stack.py`,
    url: "http://127.0.0.1:8000/health",
    reuseExistingServer: false,
    timeout: 60000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 }
  }
});
