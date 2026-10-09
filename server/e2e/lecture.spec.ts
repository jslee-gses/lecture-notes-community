import { expect, test } from "@playwright/test";

test("public catalog opens a lecture", async ({ page }) => {
  await page.route("https://www.youtube.com/iframe_api", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "강의 목록" })).toBeVisible();
  await page.getByRole("link", { name: /자료 구조 입문/ }).click();
  await expect(page.getByRole("heading", { name: "자료 구조 입문" })).toBeVisible();
  await page.getByRole("link", { name: "강의 목록" }).click();
  await expect(page.getByRole("heading", { name: "강의 목록" })).toBeVisible();
});

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
  await page.getByRole("tab", { name: "강의 요약" }).click();
  await page.getByTestId("key-point-2").click();
  await page.getByRole("tab", { name: "용어집" }).click();
  await page.getByTestId("glossary-1").click();
  await expect.poll(() => page.evaluate(() => (window as any).__seekCalls)).toEqual([0, 30, 15]);
  await expect(page.getByTestId("youtube-fallback")).toHaveAttribute("href", /[?&]t=15s/);
});

test("tabs_switch_without_resetting_player", async ({ page }) => {
  await page.route("https://www.youtube.com/iframe_api", (route) => route.abort());
  await page.goto("/fixture");
  const player = page.locator("#player");
  const playerHandle = await player.elementHandle();
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(3);
  await expect(page.getByRole("tabpanel", { name: "목차" })).toBeVisible();
  await page.getByRole("tab", { name: "강의 요약" }).click();
  await expect(page.getByRole("tabpanel", { name: "강의 요약" })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "목차" })).toBeHidden();
  await page.getByRole("tab", { name: "강의 요약" }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: "용어집" })).toBeFocused();
  await page.getByRole("tab", { name: "용어집" }).press("Home");
  await expect(page.getByRole("tab", { name: "목차" })).toBeFocused();
  await page.getByRole("tab", { name: "목차" }).press("End");
  await expect(page.getByRole("tab", { name: "용어집" })).toBeFocused();
  expect(await player.evaluate((node, original) => node === original, playerHandle)).toBe(true);
});

test("search_highlight_is_safe_and_player_stays_visible", async ({ page }) => {
  await page.route("https://www.youtube.com/iframe_api", (route) => route.abort());
  await page.goto("/fixture-long");
  const player = page.locator(".player-frame");
  const list = page.locator(".transcript-list");
  const before = await player.boundingBox();
  await list.evaluate((node) => { node.scrollTop = 600; });
  expect(await list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  const after = await player.boundingBox();
  expect(after?.y).toBeCloseTo(before!.y, 0);
  await page.getByTestId("transcript-search").fill("C++ [배열] <script>");
  await expect(page.locator("[data-transcript-row]:visible")).toHaveCount(1);
  await expect(page.locator("[data-transcript-row] mark")).toHaveText("C++ [배열] <script>");
  await expect(page.getByTestId("search-count")).toContainText("1개 구간");
  expect(await page.evaluate(() => (window as any).__injected)).toBeUndefined();
  await page.getByTestId("transcript-search").fill("존재하지않는표현");
  await expect(page.locator("#search-empty")).toBeVisible();
  await page.getByTestId("transcript-search").fill("");
  await expect(page.locator("[data-transcript-row]:visible")).toHaveCount(120);
  await expect(page.locator("[data-transcript-row] mark")).toHaveCount(0);
});

test("long_tab_panel_scrolls_without_moving_player", async ({ page }) => {
  await page.route("https://www.youtube.com/iframe_api", (route) => route.abort());
  await page.goto("/fixture-long");
  await page.getByRole("tab", { name: "강의 요약" }).click();
  const player = page.locator(".player-frame");
  const panel = page.getByRole("tabpanel", { name: "강의 요약" });
  const before = await player.boundingBox();
  await panel.evaluate((node) => { node.scrollTop = 600; });
  expect(await panel.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  const after = await player.boundingBox();
  expect(after?.y).toBeCloseTo(before!.y, 0);
});

test("mobile_order_and_white_background", async ({ page }) => {
  await page.route("https://www.youtube.com/iframe_api", (route) => route.abort());
  await page.goto("/fixture");
  await page.screenshot({ path: "../.lecture-notes/playwright-results/desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "../.lecture-notes/playwright-results/mobile.png", fullPage: true });
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(255, 255, 255)");
  const video = await page.locator(".video-section").boundingBox();
  const transcript = await page.locator(".transcript-section").boundingBox();
  const panels = await page.locator(".detail-tabs").boundingBox();
  expect(video!.y).toBeLessThan(transcript!.y);
  expect(transcript!.y).toBeLessThan(panels!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByTestId("transcript-search").fill("연결 리스트");
  await expect(page.locator("[data-transcript-row]:visible")).toHaveCount(1);
  await expect(page.getByTestId("search-count")).toContainText("1");
  await expect(page.getByRole("heading", { name: "자료 구조 입문" })).toBeVisible();
});

test("bilingual_search_highlights_both_languages", async ({ page }) => {
  await page.route("https://www.youtube.com/iframe_api", (route) => route.abort());
  await page.goto("/fixture-en");
  const rows = page.locator("[data-transcript-row]");
  await expect(rows).toHaveCount(4);
  await expect(rows.first().locator("p")).toHaveCount(2);
  await expect(rows.first()).toContainText("An array stores data");
  await expect(rows.first()).toContainText("배열은 연속된 데이터를 저장합니다.");
  const search = page.getByTestId("transcript-search");
  await search.fill("ARRAY");
  await expect(page.locator("[data-transcript-row]:visible")).toHaveCount(2);
  await expect(rows.first().locator("p").first().locator("mark")).toHaveText("array");
  await search.fill("배열은");
  await expect(page.locator("[data-transcript-row]:visible")).toHaveCount(1);
  await expect(rows.first().locator("p").last().locator("mark")).toHaveText("배열은");
  await search.fill("<SCRIPT>");
  await expect(page.locator("[data-transcript-row]:visible")).toHaveCount(1);
  await expect(rows.first().locator("p").first().locator("mark")).toHaveText("<script>");
  expect(await page.evaluate(() => (window as any).__injected)).toBeUndefined();
  await search.fill("");
  await expect(rows.locator("mark")).toHaveCount(0);
});

test("legacy_korean_viewer_survives", async ({ page }) => {
  await page.route("https://www.youtube.com/iframe_api", (route) => route.abort());
  await page.goto("/fixture");
  await expect(page.locator("[data-transcript-row]")).toHaveCount(4);
  await expect(page.locator("[data-transcript-row]").first().locator("p")).toHaveCount(1);
  await expect(page.locator("[data-transcript-row]").first()).toContainText("배열은 연속된 데이터를 저장합니다.");
  await expect(page.locator("[data-transcript-row]").first().locator("button[data-seek]")).toHaveCount(1);
});
