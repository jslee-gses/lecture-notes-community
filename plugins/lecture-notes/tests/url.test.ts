import { parseVideoId } from "../scripts/url.ts";

const ID = "AbCdEfGhIjK";

Deno.test("test_url_forms", () => {
  const links = [
    `https://www.youtube.com/watch?v=${ID}&t=42s`,
    `https://youtube.com/watch?list=example&v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}?si=shared`,
  ];
  for (const link of links) {
    if (parseVideoId(link) !== ID) throw new Error(`Wrong ID for ${link}`);
  }
});

Deno.test("test_lookalike_host", () => {
  const badLinks = [
    `https://youtube.com.evil.test/watch?v=${ID}`,
    `https://notyoutu.be/${ID}`,
    `https://youtube.com@evil.test/watch?v=${ID}`,
    `http://youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=short`,
    `https://youtube.com/watch?v=${ID}&v=ZyXwVuTsRqP`,
  ];
  for (const link of badLinks) {
    try {
      parseVideoId(link);
      throw new Error(`Expected rejection: ${link}`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("YouTube URL")) {
        throw new Error(`Unexpected error for ${link}: ${String(error)}`);
      }
    }
  }
});
