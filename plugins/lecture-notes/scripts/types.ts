import { Ajv2020 } from "@ajv/2020";
import schemaV1 from "../schema/lecture.schema.json" with { type: "json" };
import schemaV2 from "../schema/lecture-v2.schema.json" with { type: "json" };

export interface Segment {
  idx: number;
  start_sec: number;
  end_sec: number;
  text: string;
}

export interface TranslatedSegment extends Segment {
  translation_ko: string;
}

export interface OutlineRange {
  title: string;
  summary: string;
  start_idx: number;
  end_idx: number;
  start_sec: number;
  end_sec: number;
}

export interface Chapter extends OutlineRange {
  children: OutlineRange[];
}

export interface KoreanLectureDocument {
  schema_version: "1.0";
  run_id: string;
  lecture: {
    video_id: string;
    url: string;
    title: string;
    duration_sec: number;
    caption_language: "ko";
    caption_source: "auto";
    created_at: string;
  };
  segments: Segment[];
  outline: { chapters: Chapter[] };
  summary_note: {
    overview: string;
    key_points: { text: string; segment_idxs: number[]; start_sec: number }[];
  };
  glossary: {
    term: string;
    explanation: string;
    first_segment_idx: number;
    start_sec: number;
  }[];
}

export interface EnglishLectureDocument
  extends
    Omit<KoreanLectureDocument, "schema_version" | "lecture" | "segments"> {
  schema_version: "2.0";
  lecture:
    & Omit<
      KoreanLectureDocument["lecture"],
      "caption_language" | "caption_source"
    >
    & {
      caption_language: "en";
      caption_source: "manual" | "auto";
      translation_language: "ko";
    };
  segments: TranslatedSegment[];
}

export type LectureDocument = KoreanLectureDocument | EnglishLectureDocument;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchemaV1 = ajv.compile<KoreanLectureDocument>(schemaV1);
const validateSchemaV2 = ajv.compile<EnglishLectureDocument>(schemaV2);

function fail(path: string, detail: string): never {
  throw new Error(`${path}: ${detail}`);
}

function checkRange(
  range: OutlineRange,
  path: string,
  segments: Segment[],
): void {
  if (range.start_idx > range.end_idx || range.end_idx > segments.length) {
    fail(`${path}/end_idx`, "invalid segment range");
  }
  if (range.start_sec !== segments[range.start_idx - 1].start_sec) {
    fail(`${path}/start_sec`, "must match first segment start");
  }
  if (range.end_sec !== segments[range.end_idx - 1].end_sec) {
    fail(`${path}/end_sec`, "must match last segment end");
  }
}

export function validateLecture(doc: unknown): LectureDocument {
  const version = doc && typeof doc === "object" && !Array.isArray(doc)
    ? (doc as { schema_version?: unknown }).schema_version
    : undefined;
  if (version !== "1.0" && version !== "2.0") {
    fail("/schema_version", "unsupported version");
  }
  const validateSchema = version === "1.0"
    ? validateSchemaV1
    : validateSchemaV2;
  if (!validateSchema(doc)) {
    const error = validateSchema.errors?.[0];
    const suffix = error?.keyword === "required" &&
        typeof error.params.missingProperty === "string"
      ? `/${error.params.missingProperty}`
      : "";
    fail(
      `${error?.instancePath ?? ""}${suffix}` || "/",
      error?.message ?? "invalid document",
    );
  }
  const lecture = doc as LectureDocument;
  const segments = lecture.segments;
  if (
    lecture.lecture.url !==
      `https://www.youtube.com/watch?v=${lecture.lecture.video_id}`
  ) {
    fail("/lecture/url", "video ID does not match canonical URL");
  }
  let previousEnd = 0;
  for (const [i, segment] of segments.entries()) {
    const path = `/segments/${i}`;
    if (segment.idx !== i + 1) {
      fail(`${path}/idx`, "indices must be contiguous and 1-based");
    }
    if (segment.start_sec < previousEnd) {
      fail(`${path}/start_sec`, "times must be monotonic");
    }
    if (
      segment.end_sec <= segment.start_sec ||
      segment.end_sec > lecture.lecture.duration_sec
    ) {
      fail(`${path}/end_sec`, "end must follow start and fit video duration");
    }
    previousEnd = segment.end_sec;
  }

  let nextChapterIdx = 1;
  for (const [chapterNumber, chapter] of lecture.outline.chapters.entries()) {
    const path = `/outline/chapters/${chapterNumber}`;
    if (chapter.start_idx !== nextChapterIdx) {
      fail(`${path}/start_idx`, "chapter gap or overlap");
    }
    checkRange(chapter, path, segments);
    let nextChildIdx = chapter.start_idx;
    for (const [childNumber, child] of chapter.children.entries()) {
      const childPath = `${path}/children/${childNumber}`;
      if (child.start_idx !== nextChildIdx) {
        fail(`${childPath}/start_idx`, "child gap or overlap");
      }
      if (child.end_idx > chapter.end_idx) {
        fail(`${childPath}/end_idx`, "child exceeds chapter");
      }
      checkRange(child, childPath, segments);
      nextChildIdx = child.end_idx + 1;
    }
    if (nextChildIdx !== chapter.end_idx + 1) {
      fail(`${path}/children`, "children do not cover chapter");
    }
    nextChapterIdx = chapter.end_idx + 1;
  }
  if (nextChapterIdx !== segments.length + 1) {
    fail("/outline/chapters", "chapters do not cover all segments");
  }

  for (
    const [pointNumber, point] of lecture.summary_note.key_points.entries()
  ) {
    const path = `/summary_note/key_points/${pointNumber}`;
    let previousIdx = 0;
    for (const [refNumber, idx] of point.segment_idxs.entries()) {
      if (idx <= previousIdx || idx > segments.length) {
        fail(
          `${path}/segment_idxs/${refNumber}`,
          "invalid or unordered reference",
        );
      }
      previousIdx = idx;
    }
    if (point.start_sec !== segments[point.segment_idxs[0] - 1].start_sec) {
      fail(`${path}/start_sec`, "must match first referenced segment");
    }
  }
  for (const [termNumber, term] of lecture.glossary.entries()) {
    const path = `/glossary/${termNumber}`;
    if (term.first_segment_idx > segments.length) {
      fail(`${path}/first_segment_idx`, "missing segment");
    }
    if (term.start_sec !== segments[term.first_segment_idx - 1].start_sec) {
      fail(`${path}/start_sec`, "must match referenced segment");
    }
  }
  return lecture;
}
