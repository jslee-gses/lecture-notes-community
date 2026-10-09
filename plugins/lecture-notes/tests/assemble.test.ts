import { assembleLecture, type AssemblyInputs } from "../scripts/assemble.ts";
import type { LectureDocument } from "../scripts/types.ts";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/valid-lecture.json", import.meta.url),
  ),
) as LectureDocument;

function inputs(): AssemblyInputs {
  return {
    schema_version: "1.0",
    run_id: fixture.run_id,
    lecture: structuredClone(fixture.lecture),
    segments: structuredClone(fixture.segments),
    corrections: [],
    outline: {
      chapters: fixture.outline.chapters.map((chapter) => ({
        title: chapter.title,
        summary: chapter.summary,
        start_idx: chapter.start_idx,
        end_idx: chapter.end_idx,
        children: chapter.children.map((child) => ({
          title: child.title,
          summary: child.summary,
          start_idx: child.start_idx,
          end_idx: child.end_idx,
        })),
      })),
    },
    summary_note: {
      overview: fixture.summary_note.overview,
      key_points: fixture.summary_note.key_points.map((point) => ({
        text: point.text,
        segment_idxs: point.segment_idxs,
      })),
    },
    glossary: fixture.glossary.map((item) => ({
      term: item.term,
      explanation: item.explanation,
      first_segment_idx: item.first_segment_idx,
    })),
  };
}

Deno.test("test_exact_correction", () => {
  const input = inputs();
  input.corrections.push({
    segment_idx: 2,
    from: "인덱스로",
    to: "색인으로",
    evidence_segment_idxs: [1, 2],
    reason: "The lecture uses 색인 for this concept.",
  });
  const document = assembleLecture(input);
  if (document.segments[1].text !== "색인으로 배열의 값에 접근합니다.") {
    throw new Error("Exact correction was not applied");
  }
  for (const [i, segment] of input.segments.entries()) {
    if (
      i !== 1 &&
      JSON.stringify(document.segments[i]) !== JSON.stringify(segment)
    ) {
      throw new Error(`Untargeted segment ${i + 1} changed`);
    }
  }
  if (input.segments[1].text !== fixture.segments[1].text) {
    throw new Error("Source segments were mutated");
  }
});

Deno.test("test_ambiguous_correction", () => {
  const input = inputs();
  input.segments[0].text = "배열과 배열을 비교합니다.";
  input.corrections.push({
    segment_idx: 1,
    from: "배열",
    to: "연결 리스트",
    evidence_segment_idxs: [1],
    reason: "One occurrence appears mistranscribed.",
  });
  try {
    assembleLecture(input);
    throw new Error("Ambiguous correction was accepted");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("/corrections/0/from")
    ) throw error;
  }
});

Deno.test("test_correction_evidence_refs", () => {
  for (const refs of [[], [5], [1, 1]]) {
    const input = inputs();
    input.corrections.push({
      segment_idx: 2,
      from: "인덱스",
      to: "색인",
      evidence_segment_idxs: refs,
      reason: "Supported by repeated terminology.",
    });
    try {
      assembleLecture(input);
      throw new Error("Invalid correction evidence was accepted");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("/corrections/0/evidence_segment_idxs")
      ) throw error;
    }
  }
});

Deno.test("test_outline_coverage", () => {
  const input = inputs();
  input.outline.chapters[0].children[1].start_idx = 4;
  try {
    assembleLecture(input);
    throw new Error("Outline gap was accepted");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("/outline/chapters/0/children/1/start_idx")
    ) throw error;
  }
});

Deno.test("test_derived_times", () => {
  const document = assembleLecture(inputs());
  if (
    document.outline.chapters[0].end_sec !== document.segments[3].end_sec ||
    document.outline.chapters[0].children[1].start_sec !==
      document.segments[2].start_sec ||
    document.summary_note.key_points[1].start_sec !==
      document.segments[2].start_sec ||
    document.glossary[0].start_sec !== document.segments[1].start_sec
  ) throw new Error("Reference times were not derived from segments");
});

Deno.test("test_unsupported_assembly_version", () => {
  const input = inputs();
  (input as unknown as { schema_version: string }).schema_version = "2.0";
  try {
    assembleLecture(input);
    throw new Error("Unsupported version was accepted");
  } catch (error) {
    if (
      !(error instanceof Error) || !error.message.includes("/schema_version")
    ) throw error;
  }
});
