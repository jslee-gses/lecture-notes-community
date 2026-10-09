import { CaptionDataError } from "./captions.ts";
import type { Segment } from "./types.ts";

function cueTime(value: string): number {
  const parts = value.replace(",", ".").split(":");
  if (parts.length !== 2 && parts.length !== 3) return NaN;
  if (!parts.every((part) => /^\d+(?:\.\d{3})?$/u.test(part))) return NaN;
  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (minutes >= 60 || seconds >= 60) return NaN;
  return hours * 3600 + minutes * 60 + seconds;
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text.replace(
    /&(#(?:x[\da-f]+|\d+)|[a-z]+);/giu,
    (match, entity: string) => {
      if (entity.startsWith("#")) {
        const hex = entity[1]?.toLowerCase() === "x";
        const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(value) && value > 0 && value <= 0x10ffff &&
            !(value >= 0xd800 && value <= 0xdfff)
          ? String.fromCodePoint(value)
          : match;
      }
      return named[entity.toLowerCase()] ?? match;
    },
  );
}

export function parseVtt(raw: string): Segment[] {
  const text = raw.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  if (!/^WEBVTT(?:[ \t][^\n]*)?\n/u.test(text)) {
    throw new CaptionDataError("/vtt", "missing WEBVTT header");
  }
  const blocks = text.split(/\n\s*\n/u).slice(1);
  const segments: Segment[] = [];
  for (const [blockIndex, block] of blocks.entries()) {
    const lines = block.trim().split("\n");
    if (!lines[0] || /^(NOTE|STYLE|REGION)(?:\s|$)/u.test(lines[0])) continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0 || timingIndex > 1) {
      throw new CaptionDataError(`/vtt/${blockIndex}`, "missing cue timing");
    }
    const match = lines[timingIndex].match(
      /^\s*(\d{2}:\d{2}(?::\d{2})?[.,]\d{3})\s+-->\s+(\d{2}:\d{2}(?::\d{2})?[.,]\d{3})(?:\s+.*)?$/u,
    );
    if (!match) {
      throw new CaptionDataError(`/vtt/${blockIndex}`, "malformed cue timing");
    }
    const start = cueTime(match[1]);
    const end = cueTime(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new CaptionDataError(
        `/vtt/${blockIndex}`,
        "invalid cue time range",
      );
    }
    const spoken = decodeEntities(lines.slice(timingIndex + 1).join(" "))
      .replace(/\s+/gu, " ").trim();
    if (!spoken) {
      throw new CaptionDataError(`/vtt/${blockIndex}`, "empty cue text");
    }
    const previous = segments.at(-1);
    if (previous && start < previous.start_sec) {
      throw new CaptionDataError(`/vtt/${blockIndex}`, "cues out of order");
    }
    if (previous && start === previous.start_sec) {
      previous.text = `${previous.text} ${spoken}`;
      previous.end_sec = Math.max(previous.end_sec, end);
      continue;
    }
    if (previous && start < previous.end_sec) previous.end_sec = start;
    segments.push({
      idx: segments.length + 1,
      start_sec: start,
      end_sec: end,
      text: spoken,
    });
  }
  if (!segments.length) {
    throw new CaptionDataError("/vtt", "no spoken caption text");
  }
  return segments;
}
