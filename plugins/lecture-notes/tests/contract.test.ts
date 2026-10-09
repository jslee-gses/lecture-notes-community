import { validateLecture } from "../scripts/types.ts";
import fixture from "./fixtures/valid-lecture.json" with { type: "json" };
import englishFixture from "./fixtures/valid-english-lecture.json" with {
  type: "json",
};

function copyFixture(): Record<string, unknown> {
  return structuredClone(fixture) as Record<string, unknown>;
}

function copyEnglishFixture(): Record<string, unknown> {
  return structuredClone(englishFixture) as Record<string, unknown>;
}

function rejectsAt(doc: unknown, path: string): void {
  try {
    validateLecture(doc);
    throw new Error(`Expected validation to reject ${path}`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(path)) {
      throw new Error(`Expected error at ${path}, got: ${String(error)}`);
    }
  }
}

Deno.test("valid_lecture", () => {
  if (validateLecture(copyFixture()).schema_version !== "1.0") {
    throw new Error("Valid fixture was not returned");
  }
});

Deno.test("valid_english_lecture", () => {
  const doc = copyEnglishFixture();
  const returned = validateLecture(doc);
  if (String(returned.schema_version) !== "2.0") {
    throw new Error("English 2.0 lecture was not accepted");
  }
});

Deno.test("test_legacy_korean_contract", () => {
  const doc = copyFixture();
  const original = structuredClone(doc);
  validateLecture(doc);
  if (JSON.stringify(doc) !== JSON.stringify(original)) {
    throw new Error("Validation changed the legacy Korean document");
  }
});

Deno.test("missing_translation", () => {
  const doc = copyEnglishFixture();
  delete (doc.segments as Record<string, unknown>[])[0].translation_ko;
  rejectsAt(doc, "/segments/0/translation_ko");
});

Deno.test("bad_caption_source", () => {
  const doc = copyEnglishFixture();
  (doc.lecture as Record<string, unknown>).caption_source = "translated";
  rejectsAt(doc, "/lecture/caption_source");
});

Deno.test("wrong_translation_language", () => {
  const doc = copyEnglishFixture();
  (doc.lecture as Record<string, unknown>).translation_language = "en";
  rejectsAt(doc, "/lecture/translation_language");
});

Deno.test("missing_note", () => {
  const doc = copyFixture();
  delete doc.summary_note;
  rejectsAt(doc, "/summary_note");
});

Deno.test("unsupported_version", () => {
  const doc = copyFixture();
  doc.schema_version = "3.0";
  rejectsAt(doc, "/schema_version");
});

Deno.test("chapter_gap", () => {
  const doc = copyFixture();
  const chapters = (doc.outline as typeof fixture.outline).chapters;
  chapters[0].children[1].start_idx = 4;
  rejectsAt(doc, "/outline/chapters/0/children/1/start_idx");
});

Deno.test("glossary_out_of_range", () => {
  const doc = copyFixture();
  (doc.glossary as typeof fixture.glossary)[0].first_segment_idx = 9;
  rejectsAt(doc, "/glossary/0/first_segment_idx");
});
