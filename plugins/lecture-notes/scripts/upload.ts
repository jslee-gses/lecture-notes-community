import { validateLecture } from "./types.ts";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

export interface UploadResult {
  share_url: string;
  expires_at: string;
  listing_url?: string;
}

export interface UploadOptions {
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

function endpointFor(baseUrl: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("server URL must be an HTTPS origin");
  }
  const local = base.protocol === "http:" &&
    (base.hostname === "localhost" || base.hostname === "127.0.0.1");
  if (
    !(base.protocol === "https:" || local) || base.username || base.password ||
    base.search || base.hash || base.pathname !== "/"
  ) throw new Error("server URL must be an HTTPS origin");
  return new URL("/api/lectures", base);
}

async function responseDetail(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (body && typeof body.detail === "string") {
      return body.detail.slice(0, 300);
    }
  } catch {
    // A plain-text or empty error response is still reported by status.
  }
  return response.statusText || "server rejected the upload";
}

export async function uploadLecture(
  file: string,
  baseUrl: string,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const endpoint = endpointFor(baseUrl);
  const body = await Deno.readTextFile(file);
  if (new TextEncoder().encode(body).byteLength > MAX_BYTES) {
    throw new Error(`${file}: JSON exceeds the 10 MiB upload limit`);
  }
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    throw new Error(`${file}: invalid JSON`);
  }
  validateLecture(document);
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Lecture-Listing": "public" },
        body,
      });
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(
          `network upload failed after ${attempt} attempts: ${String(error)}`,
        );
      }
      await sleep(attempt * 500);
      continue;
    }
    if (response.status >= 500 && response.status <= 599) {
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(
          `HTTP ${response.status}: server unavailable after ${attempt} attempts`,
        );
      }
      await sleep(attempt * 500);
      continue;
    }
    if (response.status === 429) {
      const retry = response.headers.get("Retry-After");
      throw new Error(
        `HTTP 429: upload limit reached${
          retry ? `; Retry-After: ${retry}` : ""
        }`,
      );
    }
    if (response.status === 409) {
      throw new Error(
        "HTTP 409: run_id already belongs to different content; keep this JSON and start a new run",
      );
    }
    if (response.status === 413) {
      throw new Error("HTTP 413: JSON exceeds the server upload size limit");
    }
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${await responseDetail(response)}`,
      );
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error("server returned an invalid upload response");
    }
    if (
      !result || typeof result !== "object" ||
      typeof (result as UploadResult).share_url !== "string" ||
      typeof (result as UploadResult).expires_at !== "string"
    ) throw new Error("server returned an incomplete upload response");
    const value = result as UploadResult;
    let share: URL;
    try {
      share = new URL(value.share_url);
    } catch {
      throw new Error("server returned an invalid share URL");
    }
    if (
      share.origin !== endpoint.origin ||
      (endpoint.protocol === "https:" && share.protocol !== "https:") ||
      !Number.isFinite(Date.parse(value.expires_at))
    ) throw new Error("server returned an invalid share URL or expiry");
    if (value.listing_url !== undefined) {
      if (typeof value.listing_url !== "string") throw new Error("server returned an invalid listing URL");
      let listing: URL;
      try {
        listing = new URL(value.listing_url);
      } catch {
        throw new Error("server returned an invalid listing URL");
      }
      if (
        listing.origin !== endpoint.origin || listing.pathname !== "/" ||
        listing.search || listing.hash || listing.username || listing.password ||
        (endpoint.protocol === "https:" && listing.protocol !== "https:")
      ) throw new Error("server returned an invalid listing URL");
    }
    return value;
  }
  throw new Error("upload retry limit reached");
}
