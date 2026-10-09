const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

import type { Segment } from "./types.ts";

export class CaptionUnavailable extends Error {
  constructor(videoId: string, language: "ko" | "en" = "ko") {
    super(
      `${
        language === "ko" ? "한국어" : "영어"
      } 원본 자막을 찾을 수 없습니다: ${videoId}`,
    );
    this.name = "CaptionUnavailable";
  }
}

export class CaptionLanguageAmbiguous extends Error {
  constructor() {
    super("영상의 원본 언어를 확인할 수 없습니다. ko 또는 en을 명시해 주세요.");
    this.name = "CaptionLanguageAmbiguous";
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

export interface CaptionTrack {
  language: "ko" | "en";
  source: "manual" | "auto";
  format: "json3" | "vtt";
  tag: string;
}

export interface ToolPaths {
  deno: string;
  ytdlp: string;
}

type RequestedLanguage = "ko" | "en" | "auto";

function baseLanguage(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.toLowerCase().split(/[-_]/u)[0];
}

function bestFormat(value: unknown): CaptionTrack["format"] | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const ext of ["json3", "vtt"] as const) {
    if (value.some((entry) => isRecord(entry) && entry.ext === ext)) return ext;
  }
  return undefined;
}

export function selectCaptionTrack(
  info: unknown,
  requestedLanguage: RequestedLanguage,
): CaptionTrack {
  if (!isRecord(info)) {
    throw new CaptionFetchError("video metadata is malformed");
  }
  const native = [
    baseLanguage(info.original_language),
    baseLanguage(info.language),
  ]
    .filter((value): value is string => value !== undefined);
  if (new Set(native).size > 1) {
    throw new CaptionFetchError("native language metadata is contradictory");
  }
  if (!native.length && requestedLanguage === "auto") {
    throw new CaptionLanguageAmbiguous();
  }
  const language = requestedLanguage === "auto" ? native[0] : requestedLanguage;
  if (native.length && native[0] !== language) {
    throw new CaptionFetchError(
      `native language is ${native[0]}, not ${language}`,
    );
  }
  if (language !== "ko" && language !== "en") {
    throw new CaptionFetchError(`unsupported native language: ${language}`);
  }
  const captions = (source: "manual" | "auto") => {
    const value =
      info[source === "manual" ? "subtitles" : "automatic_captions"];
    return isRecord(value) ? value : {};
  };
  const nativeTag = typeof info.language === "string" &&
      baseLanguage(info.language) === language
    ? info.language
    : language;
  const find = (
    source: "manual" | "auto",
    tags: string[],
  ): CaptionTrack | undefined => {
    const available = captions(source);
    for (const tag of tags) {
      const format = bestFormat(available[tag]);
      if (format) return { language, source, format, tag };
    }
    return undefined;
  };
  if (language === "ko") {
    const track = find("auto", [nativeTag, "ko", "ko-orig"]);
    if (track) return track;
    throw new CaptionUnavailable(String(info.id ?? "unknown"), "ko");
  }
  const manualTags = [
    nativeTag,
    "en",
    ...Object.keys(captions("manual"))
      .filter((tag) => /^en-[A-Za-z]{2,3}$/u.test(tag)),
  ];
  const manual = find("manual", [...new Set(manualTags)]);
  if (manual) return manual;
  const auto = find("auto", ["en-orig", nativeTag, "en"]);
  if (auto) return auto;
  throw new CaptionUnavailable(String(info.id ?? "unknown"), "en");
}

export type CommandRunner = (
  executable: string,
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const runCommand: CommandRunner = async (executable, args, cwd) => {
  const result = await new Deno.Command(executable, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
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
  toolPaths: ToolPaths,
  runner: CommandRunner = runCommand,
  requestedLanguage: RequestedLanguage = "auto",
): Promise<{ captionPath: string; infoPath: string; track: CaptionTrack }> {
  if (!VIDEO_ID.test(videoId)) throw new CaptionFetchError("invalid video ID");
  await Deno.mkdir(workDir, { recursive: true });
  const infoPath = `${workDir}/${videoId}.info.json`;
  if (await existsNonempty(infoPath)) {
    throw new CaptionFetchError(
      "output files already exist; use a new work directory",
    );
  }
  const commonArgs = [
    "--ignore-config",
    "--no-playlist",
    "--skip-download",
    "--js-runtimes",
    `deno:${toolPaths.deno}`,
  ];
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await runner(toolPaths.ytdlp, [
      ...commonArgs,
      "--dump-single-json",
      url,
    ], workDir);
  } catch (error) {
    throw new CaptionFetchError(String(error));
  }
  if (result.code !== 0) {
    throw new CaptionFetchError(
      result.stderr.trim().slice(-500) || `yt-dlp exited with ${result.code}`,
    );
  }
  let info: unknown;
  try {
    info = JSON.parse(result.stdout);
  } catch {
    throw new CaptionFetchError("video metadata is malformed");
  }
  if (!isRecord(info) || info.id !== videoId) {
    throw new CaptionFetchError("video metadata ID does not match URL");
  }
  if (
    typeof info.duration !== "number" || info.duration <= 0 ||
    info.duration > 10800
  ) {
    throw new CaptionFetchError(
      "video duration must be between 1 second and 3 hours",
    );
  }
  const track = selectCaptionTrack(info, requestedLanguage);
  const captionPath = `${workDir}/${videoId}.${track.tag}.${track.format}`;
  if (await existsNonempty(captionPath)) {
    throw new CaptionFetchError(
      "output files already exist; use a new work directory",
    );
  }
  const args = [
    ...commonArgs,
    track.source === "manual" ? "--write-subs" : "--write-auto-subs",
    "--sub-langs",
    track.tag,
    "--sub-format",
    track.format,
    "--output",
    "%(id)s.%(ext)s",
    url,
  ];
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
  await Deno.writeTextFile(infoPath, JSON.stringify(info));
  return { captionPath, infoPath, track };
}
