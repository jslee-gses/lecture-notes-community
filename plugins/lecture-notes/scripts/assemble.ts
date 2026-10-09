import {
  type EnglishLectureDocument,
  type KoreanLectureDocument,
  type Segment,
  validateLecture,
} from "./types.ts";

export interface Correction {
  segment_idx: number;
  from: string;
  to: string;
  evidence_segment_idxs: number[];
  reason: string;
}

interface SourceRange {
  title: string;
  summary: string;
  start_idx: number;
  end_idx: number;
}

export interface AssemblyInputs {
  schema_version: "1.0";
  run_id: string;
  lecture: KoreanLectureDocument["lecture"];
  segments: Segment[];
  corrections: Correction[];
  outline: {
    chapters: (SourceRange & { children: SourceRange[] })[];
  };
  summary_note: {
    overview: string;
    key_points: { text: string; segment_idxs: number[] }[];
  };
  glossary: {
    term: string;
    explanation: string;
    first_segment_idx: number;
  }[];
}

export interface EnglishAssemblyInputs
  extends Omit<AssemblyInputs, "schema_version" | "lecture"> {
  schema_version: "2.0";
  lecture: EnglishLectureDocument["lecture"];
  translations: { segment_idx: number; translation_ko: string }[];
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function segmentAt(segments: Segment[], idx: number, path: string): Segment {
  if (!Number.isInteger(idx) || idx < 1 || idx > segments.length) {
    fail(path, "segment index is out of range");
  }
  return segments[idx - 1];
}

export function assembleLecture(inputs: AssemblyInputs): KoreanLectureDocument {
  if (inputs.schema_version !== "1.0") {
    fail("/schema_version", "unsupported version");
  }
  if (!Array.isArray(inputs.segments) || inputs.segments.length === 0) {
    fail("/segments", "expected at least one segment");
  }
  if (!Array.isArray(inputs.corrections)) {
    fail("/corrections", "expected an array");
  }

  const segments = inputs.segments.map((segment) => ({ ...segment }));
  const edits = new Map<number, { start: number; end: number; to: string }[]>();
  for (const [i, correction] of inputs.corrections.entries()) {
    const path = `/corrections/${i}`;
    if (!correction || typeof correction !== "object") {
      fail(path, "expected a correction object");
    }
    const original = segmentAt(
      inputs.segments,
      correction.segment_idx,
      `${path}/segment_idx`,
    );
    if (
      typeof correction.from !== "string" || !correction.from ||
      typeof correction.to !== "string" || !correction.to ||
      correction.from === correction.to
    ) fail(`${path}/from`, "from and to must be distinct nonempty text");
    if (typeof correction.reason !== "string" || !correction.reason.trim()) {
      fail(`${path}/reason`, "a reason is required");
    }
    if (
      !Array.isArray(correction.evidence_segment_idxs) ||
      correction.evidence_segment_idxs.length === 0 ||
      correction.evidence_segment_idxs.some((idx) =>
        !Number.isInteger(idx) || idx < 1 || idx > segments.length
      ) ||
      new Set(correction.evidence_segment_idxs).size !==
        correction.evidence_segment_idxs.length
    ) {
      fail(
        `${path}/evidence_segment_idxs`,
        "valid, unique evidence indices required",
      );
    }

    const start = original.text.indexOf(correction.from);
    if (
      start < 0 || original.text.indexOf(correction.from, start + 1) >= 0
    ) fail(`${path}/from`, "source text must have exactly one match");
    const list = edits.get(correction.segment_idx) ?? [];
    const end = start + correction.from.length;
    if (list.some((other) => start < other.end && other.start < end)) {
      fail(`${path}/from`, "corrections overlap");
    }
    list.push({ start, end, to: correction.to });
    edits.set(correction.segment_idx, list);
  }
  for (const [idx, list] of edits) {
    let text = inputs.segments[idx - 1].text;
    for (const edit of list.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start) + edit.to + text.slice(edit.end);
    }
    segments[idx - 1].text = text;
  }

  function range(raw: SourceRange, path: string) {
    if (!raw || typeof raw !== "object") fail(path, "expected a range");
    if (
      !Number.isInteger(raw.start_idx) || !Number.isInteger(raw.end_idx) ||
      raw.start_idx > raw.end_idx
    ) fail(`${path}/start_idx`, "invalid range");
    return {
      title: raw.title,
      summary: raw.summary,
      start_idx: raw.start_idx,
      end_idx: raw.end_idx,
      start_sec:
        segmentAt(segments, raw.start_idx, `${path}/start_idx`).start_sec,
      end_sec: segmentAt(segments, raw.end_idx, `${path}/end_idx`).end_sec,
    };
  }
  if (!inputs.outline || !Array.isArray(inputs.outline.chapters)) {
    fail("/outline/chapters", "expected chapters");
  }
  const chapters = inputs.outline.chapters.map((chapter, i) => {
    const path = `/outline/chapters/${i}`;
    if (!Array.isArray(chapter.children)) {
      fail(`${path}/children`, "expected children");
    }
    return {
      ...range(chapter, path),
      children: chapter.children.map((child, j) =>
        range(child, `${path}/children/${j}`)
      ),
    };
  });
  if (
    !inputs.summary_note || !Array.isArray(inputs.summary_note.key_points)
  ) fail("/summary_note/key_points", "expected key points");
  const keyPoints = inputs.summary_note.key_points.map((point, i) => {
    const path = `/summary_note/key_points/${i}`;
    if (!Array.isArray(point.segment_idxs) || point.segment_idxs.length === 0) {
      fail(`${path}/segment_idxs`, "expected references");
    }
    return {
      text: point.text,
      segment_idxs: point.segment_idxs,
      start_sec: segmentAt(
        segments,
        point.segment_idxs[0],
        `${path}/segment_idxs/0`,
      ).start_sec,
    };
  });
  if (!Array.isArray(inputs.glossary)) fail("/glossary", "expected terms");
  const glossary = inputs.glossary.map((item, i) => ({
    term: item.term,
    explanation: item.explanation,
    first_segment_idx: item.first_segment_idx,
    start_sec: segmentAt(
      segments,
      item.first_segment_idx,
      `/glossary/${i}/first_segment_idx`,
    ).start_sec,
  }));

  return validateLecture({
    schema_version: inputs.schema_version,
    run_id: inputs.run_id,
    lecture: inputs.lecture,
    segments,
    outline: { chapters },
    summary_note: {
      overview: inputs.summary_note.overview,
      key_points: keyPoints,
    },
    glossary,
  }) as KoreanLectureDocument;
}

export function assembleEnglishLecture(
  inputs: EnglishAssemblyInputs,
): EnglishLectureDocument {
  if (inputs.schema_version !== "2.0") {
    fail("/schema_version", "unsupported version");
  }
  if (!Array.isArray(inputs.translations)) {
    fail("/translations", "expected an array");
  }
  const translations = new Map<number, string>();
  for (const [i, entry] of inputs.translations.entries()) {
    if (
      !entry || !Number.isInteger(entry.segment_idx) ||
      entry.segment_idx < 1 || entry.segment_idx > inputs.segments.length
    ) fail(`/translations/${i}/segment_idx`, "out of range");
    if (translations.has(entry.segment_idx)) {
      fail(`/translations/${i}/segment_idx`, "duplicate translation");
    }
    if (
      typeof entry.translation_ko !== "string" ||
      !entry.translation_ko.trim()
    ) {
      fail(
        `/translations/${i}/translation_ko`,
        "nonempty translation required",
      );
    }
    translations.set(entry.segment_idx, entry.translation_ko.trim());
  }
  if (translations.size !== inputs.segments.length) {
    fail(
      "/translations",
      "exactly one translation per source segment required",
    );
  }
  const { translation_language: _translationLanguage, ...commonLecture } =
    inputs.lecture;
  const base = assembleLecture({
    ...inputs,
    schema_version: "1.0",
    lecture: {
      ...commonLecture,
      caption_language: "ko",
      caption_source: "auto",
    },
  });
  return validateLecture({
    ...base,
    schema_version: "2.0",
    lecture: inputs.lecture,
    segments: base.segments.map((segment) => ({
      ...segment,
      translation_ko: translations.get(segment.idx),
    })),
  }) as EnglishLectureDocument;
}
