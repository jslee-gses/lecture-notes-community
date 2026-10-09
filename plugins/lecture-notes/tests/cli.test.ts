import { assembleRun, fetchRun, prepareRun } from "../scripts/cli.ts";
import type { LectureDocument } from "../scripts/types.ts";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/valid-lecture.json", import.meta.url),
  ),
) as LectureDocument;

Deno.test("test_restartable_prepare_and_assemble", async () => {
  const runDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${runDir}/source.json`,
      JSON.stringify({
        schema_version: "1.0",
        run_id: fixture.run_id,
        lecture: fixture.lecture,
      }),
    );
    await Deno.writeTextFile(
      `${runDir}/${fixture.lecture.video_id}.ko.json3`,
      JSON.stringify({
        events: fixture.segments.map((segment) => ({
          tStartMs: segment.start_sec * 1000,
          dDurationMs: (segment.end_sec - segment.start_sec) * 1000,
          segs: [{ utf8: segment.text }],
        })),
      }),
    );
    await prepareRun(runDir);
    await prepareRun(runDir);
    const chunks = JSON.parse(
      await Deno.readTextFile(`${runDir}/chunks/1.json`),
    );
    if (chunks.editable.length !== 4) throw new Error("Prepared chunk missing");

    await Deno.mkdir(`${runDir}/context/parts`, { recursive: true });
    await Deno.mkdir(`${runDir}/corrections`, { recursive: true });
    await Deno.writeTextFile(
      `${runDir}/context/parts/1.json`,
      JSON.stringify({
        chunk_idx: 1,
        start_idx: 1,
        end_idx: 4,
        flow: "배열과 연결 리스트를 비교한다.",
        terms: [{
          term: "배열",
          spellings: ["배열"],
          evidence_segment_idxs: [1],
        }],
        possible_misrecognitions: [],
      }),
    );
    await Deno.writeTextFile(
      `${runDir}/context/lecture.json`,
      JSON.stringify({
        covered_chunk_idxs: [1],
        lecture_flow: "배열의 저장 방식, 연결 리스트, 접근 비용을 설명한다.",
        recurring_terms: [],
        possible_misrecognitions: [],
      }),
    );
    await Deno.writeTextFile(`${runDir}/corrections/1.json`, "[]");
    const { chapters } = fixture.outline;
    const withoutTime = (
      range: {
        title: string;
        summary: string;
        start_idx: number;
        end_idx: number;
      },
    ) => ({
      title: range.title,
      summary: range.summary,
      start_idx: range.start_idx,
      end_idx: range.end_idx,
    });
    await Deno.writeTextFile(
      `${runDir}/outline.json`,
      JSON.stringify({
        chapters: chapters.map((chapter) => ({
          ...withoutTime(chapter),
          children: chapter.children.map(withoutTime),
        })),
      }),
    );
    await Deno.writeTextFile(
      `${runDir}/summary_note.json`,
      JSON.stringify({
        overview: fixture.summary_note.overview,
        key_points: fixture.summary_note.key_points.map((point) => ({
          text: point.text,
          segment_idxs: point.segment_idxs,
        })),
      }),
    );
    await Deno.writeTextFile(
      `${runDir}/glossary.json`,
      JSON.stringify(
        fixture.glossary.map((item) => ({
          term: item.term,
          explanation: item.explanation,
          first_segment_idx: item.first_segment_idx,
        })),
      ),
    );
    await assembleRun(runDir);
    await assembleRun(runDir);
    const result = JSON.parse(
      await Deno.readTextFile(`${runDir}/lecture.json`),
    );
    if (JSON.stringify(result) !== JSON.stringify(fixture)) {
      throw new Error("Assembled lecture differs from the valid fixture");
    }
    const files = [...Deno.readDirSync(runDir)].map((entry) => entry.name);
    if (files.some((name) => /\.(mp4|webm|mkv)$/i.test(name))) {
      throw new Error("Video file was created");
    }
  } finally {
    await Deno.remove(runDir, { recursive: true });
  }
});

Deno.test("test_assemble_requires_whole_context", async () => {
  const runDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${runDir}/source.json`,
      JSON.stringify({
        schema_version: "1.0",
        run_id: fixture.run_id,
        lecture: fixture.lecture,
      }),
    );
    await Deno.writeTextFile(
      `${runDir}/segments.json`,
      JSON.stringify(fixture.segments),
    );
    await Deno.mkdir(`${runDir}/chunks`);
    await Deno.writeTextFile(
      `${runDir}/chunks/1.json`,
      JSON.stringify({
        chunk_idx: 1,
        start_idx: 1,
        end_idx: 4,
        editable: fixture.segments,
        context_before: [],
        context_after: [],
      }),
    );
    try {
      await assembleRun(runDir);
      throw new Error("Assembly skipped the whole-context pass");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("context")) {
        throw error;
      }
    }
  } finally {
    await Deno.remove(runDir, { recursive: true });
  }
});

Deno.test("test_fetch_resume_uses_existing_files", async () => {
  const runDir = await Deno.makeTempDir();
  try {
    const videoId = fixture.lecture.video_id;
    await Deno.writeTextFile(
      `${runDir}/source.json`,
      JSON.stringify({
        schema_version: "1.0",
        run_id: fixture.run_id,
        lecture: fixture.lecture,
      }),
    );
    await Deno.writeTextFile(
      `${runDir}/${videoId}.ko.json3`,
      JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "강의" }] },
        ],
      }),
    );
    await Deno.writeTextFile(
      `${runDir}/${videoId}.info.json`,
      JSON.stringify({
        id: videoId,
        title: fixture.lecture.title,
        duration: fixture.lecture.duration_sec,
      }),
    );
    const source = await fetchRun(
      fixture.lecture.url,
      runDir,
      `${runDir}/no-tools`,
    );
    if (source.run_id !== fixture.run_id) {
      throw new Error("Fetch retry changed run ID");
    }
  } finally {
    await Deno.remove(runDir, { recursive: true });
  }
});
