import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testMatch: "*.spec.ts",
  timeout: 180000,
  use: { viewport: { width: 1440, height: 950 }, trace: "retain-on-failure" },
  reporter: "list",
});
