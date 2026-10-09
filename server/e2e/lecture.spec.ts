import { expect, test } from "@playwright/test";

test("chapter, note, and glossary seek to their source times", async ({ page }) => {
  await page.route("https://www.youtube.com/iframe_api", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `window.__seekCalls = [];
        window.YT = { Player: class {
          constructor(_id, options) { options.events.onReady({ target: this }); }
          seekTo(seconds) { window.__seekCalls.push(seconds); }
        }};
        window.onYouTubeIframeAPIReady();`,
    });
  });
  await page.goto("/fixture");
  await page.getByTestId("chapter-1").click();
  await page.getByTestId("key-point-2").click();
  await page.getByTestId("glossary-1").click();
  await expect.poll(() => page.evaluate(() => (window as any).__seekCalls)).toEqual([0, 30, 15]);
  await expect(page.getByTestId("youtube-fallback")).toHaveAttribute("href", /[?&]t=15s/);
});

test("search filters the transcript and mobile layout remains readable", async ({ page }) => {
  await page.route("https://www.youtube.com/iframe_api", (route) => route.abort());
  await page.goto("/fixture");
  await page.screenshot({ path: "../.lecture-notes/playwright-results/desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "../.lecture-notes/playwright-results/mobile.png", fullPage: true });
  const toggle = page.getByRole("button", { name: "세부 목차 펼치기" });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator(".toc-child").first()).toBeVisible();
  await page.getByTestId("transcript-search").fill("연결 리스트");
  await expect(page.locator("[data-transcript-row]:visible")).toHaveCount(1);
  await expect(page.getByTestId("search-count")).toContainText("1");
  await expect(page.getByRole("heading", { name: "자료 구조 입문" })).toBeVisible();
});
