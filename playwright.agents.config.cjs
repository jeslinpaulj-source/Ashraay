const { defineConfig } = require("@playwright/test");
const base = require("./playwright.base.cjs");

// Used only by tests/agents/run-agents-e2e.js, which owns the stack and the VS Code extension host.
module.exports = defineConfig({
  testDir: "./tests/agents",
  testMatch: "*.spec.cjs",
  fullyParallel: base.fullyParallel,
  workers: base.workers,
  timeout: 180000,
  expect: { timeout: 25000 },
  retries: base.retries,
  outputDir: "test-results-agents",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-agents" }]],
  use: base.use,
  projects: [base.desktopProject]
});
