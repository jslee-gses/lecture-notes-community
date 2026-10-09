const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);

export function parseVideoId(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Invalid YouTube URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Invalid YouTube URL");
  }
  let id: string | undefined;
  if (WATCH_HOSTS.has(url.hostname) && url.pathname === "/watch") {
    const values = url.searchParams.getAll("v");
    if (values.length === 1) id = values[0];
  } else if (url.hostname === "youtu.be") {
    const match = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
    id = match?.[1];
  }
  if (!id || !VIDEO_ID.test(id)) throw new Error("Invalid YouTube URL");
  return id;
}
