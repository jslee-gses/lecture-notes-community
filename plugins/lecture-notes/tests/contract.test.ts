import { validateLecture } from "../scripts/types.ts";
import fixture from "./fixtures/valid-lecture.json" with { type: "json" };

function copyFixture(): Record<string, unknown> {
  return structuredClone(fixture) as Record<string, unknown>;
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

Deno.test("missing_note", () => {
  const doc = copyFixture();
  delete doc.summary_note;
  rejectsAt(doc, "/summary_note");
});

Deno.test("unsupported_version", () => {
  const doc = copyFixture();
  doc.schema_version = "2.0";
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
