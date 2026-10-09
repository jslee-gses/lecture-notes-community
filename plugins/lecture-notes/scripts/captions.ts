const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

import type { Segment } from "./types.ts";

export class CaptionUnavailable extends Error {
  constructor(videoId: string) {
    super(`한국어 자동 자막을 찾을 수 없습니다: ${videoId}`);
    this.name = "CaptionUnavailable";
  }
}

export class CaptionFetchError extends Error {
  constructor(detail: string) {
    super(`자막 수집 실패: ${detail}`);
    this.name = "CaptionFetchError";
  }
}

export class CaptionDataError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "CaptionDataError";
  }
}

interface Candidate {
  startMs: number;
  endMs: number;
  text: string;
  order: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson3(raw: unknown): Segment[] {
  if (!isRecord(raw) || !Array.isArray(raw.events)) {
    throw new CaptionDataError("/events", "expected a JSON3 events array");
  }
  const candidates: Candidate[] = [];
  for (const [i, event] of raw.events.entries()) {
    const path = `/events/${i}`;
    if (!isRecord(event)) {
      throw new CaptionDataError(path, "event must be an object");
    }
    if (event.segs === undefined || event.segs === null) continue;
    if (!Array.isArray(event.segs)) {
      throw new CaptionDataError(`${path}/segs`, "expected an array");
    }
    if (event.segs.length === 0) continue;
    const pieces: string[] = [];
    for (const [j, piece] of event.segs.entries()) {
      if (!isRecord(piece) || typeof piece.utf8 !== "string") {
        throw new CaptionDataError(`${path}/segs/${j}/utf8`, "expected text");
      }
      pieces.push(piece.utf8);
    }
    const text = pieces.join("").replace(/\s+/gu, " ").trim();
    if (!text) continue;
    if (
      typeof event.tStartMs !== "number" || !Number.isFinite(event.tStartMs) ||
      event.tStartMs < 0
    ) {
      throw new CaptionDataError(
        `${path}/tStartMs`,
        "expected a nonnegative time",
      );
    }
    if (
      event.dDurationMs !== undefined &&
      (typeof event.dDurationMs !== "number" ||
        !Number.isFinite(event.dDurationMs) || event.dDurationMs < 0)
    ) {
      throw new CaptionDataError(
        `${path}/dDurationMs`,
        "expected a nonnegative duration",
      );
    }
    const durationMs =
      typeof event.dDurationMs === "number" && event.dDurationMs > 0
        ? event.dDurationMs
        : 200;
    candidates.push({
      startMs: event.tStartMs,
      endMs: event.tStartMs + durationMs,
      text,
      order: i,
    });
  }
  if (candidates.length === 0) {
    throw new CaptionDataError("/events", "no spoken caption text");
  }
  candidates.sort((a, b) => a.startMs - b.startMs || a.order - b.order);
  const normalized: Candidate[] = [];
  for (const candidate of candidates) {
    const previous = normalized.at(-1);
    if (!previous) {
      normalized.push({ ...candidate });
      continue;
    }
    if (
      candidate.text === previous.text && candidate.startMs === previous.startMs
    ) {
      previous.endMs = Math.max(previous.endMs, candidate.endMs);
      continue;
    }
    if (candidate.startMs === previous.startMs) {
      previous.text = `${previous.text} ${candidate.text}`;
      previous.endMs = Math.max(previous.endMs, candidate.endMs);
      continue;
    }
    if (candidate.startMs < previous.endMs) {
      previous.endMs = candidate.startMs;
    }
    normalized.push({ ...candidate });
  }
  return normalized.map((candidate, i) => ({
    idx: i + 1,
    start_sec: candidate.startMs / 1000,
    end_sec: candidate.endMs / 1000,
    text: candidate.text,
  }));
}

export type CommandRunner = (
  executable: string,
  args: string[],
  cwd: string,
) => Promise<{ code: number; stderr: string }>;

const runCommand: CommandRunner = async (executable, args, cwd) => {
  const result = await new Deno.Command(executable, {
    args,
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  return { code: result.code, stderr: new TextDecoder().decode(result.stderr) };
};

async function existsNonempty(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile && stat.size > 0;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function fetchCaption(
  videoId: string,
  workDir: string,
  toolPaths: { deno: string; ytdlp: string },
  runner: CommandRunner = runCommand,
): Promise<{ captionPath: string; infoPath: string }> {
  if (!VIDEO_ID.test(videoId)) throw new CaptionFetchError("invalid video ID");
  await Deno.mkdir(workDir, { recursive: true });
  const captionPath = `${workDir}/${videoId}.ko.json3`;
  const infoPath = `${workDir}/${videoId}.info.json`;
  if (await existsNonempty(captionPath) || await existsNonempty(infoPath)) {
    throw new CaptionFetchError(
      "output files already exist; use a new work directory",
    );
  }
  const args = [
    "--ignore-config",
    "--no-playlist",
    "--skip-download",
    "--write-auto-subs",
    "--sub-langs",
    "ko",
    "--sub-format",
    "json3",
    "--write-info-json",
    "--js-runtimes",
    `deno:${toolPaths.deno}`,
    "--output",
    "%(id)s.%(ext)s",
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  let result: { code: number; stderr: string };
  try {
    result = await runner(toolPaths.ytdlp, args, workDir);
  } catch (error) {
    throw new CaptionFetchError(String(error));
  }
  if (result.code !== 0) {
    throw new CaptionFetchError(
      result.stderr.trim().slice(-500) || `yt-dlp exited with ${result.code}`,
    );
  }
  if (!await existsNonempty(captionPath)) throw new CaptionUnavailable(videoId);
  if (!await existsNonempty(infoPath)) {
    throw new CaptionFetchError("video metadata is missing");
  }
  let info: unknown;
  try {
    info = JSON.parse(await Deno.readTextFile(infoPath));
  } catch {
    throw new CaptionFetchError("video metadata is malformed");
  }
  if (
    typeof info !== "object" || info === null || !("id" in info) ||
    info.id !== videoId
  ) {
    throw new CaptionFetchError("video metadata ID does not match URL");
  }
  if (
    !("duration" in info) || typeof info.duration !== "number" ||
    info.duration <= 0 || info.duration > 10800
  ) {
    throw new CaptionFetchError(
      "video duration must be between 1 second and 3 hours",
    );
  }
  return { captionPath, infoPath };
}
