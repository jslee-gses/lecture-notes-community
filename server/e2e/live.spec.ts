import { expect, test } from "@playwright/test";

const liveUrl = process.env.LIVE_LECTURE_URL;
test.skip(!liveUrl, "LIVE_LECTURE_URL is required for the live Railway smoke test");

test("live lecture page seeks, searches, and remains usable on mobile", async ({ page }) => {
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
  await page.goto(liveUrl!);
  await expect(page.getByRole("heading", { name: /UI는 정답이 있는 문제/ })).toBeVisible();
  const chapter = page.getByTestId("chapter-2");
  const seconds = Number(await chapter.getAttribute("data-seek"));
  await chapter.click();
  await expect.poll(() => page.evaluate(() => (window as any).__seekCalls)).toEqual([seconds]);
  await expect(page.getByTestId("youtube-fallback")).toHaveAttribute("href", new RegExp(`t=${Math.floor(seconds)}s`));
  await page.getByTestId("transcript-search").fill("하드코딩");
  await expect(page.locator("[data-transcript-row]:visible")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "세부 목차 펼치기" }).first()).toBeVisible();
});
