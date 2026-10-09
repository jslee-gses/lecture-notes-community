import { assembleRun, fetchRun, prepareRun } from "../scripts/cli.ts";
import { chunkSegments } from "../scripts/chunk.ts";
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

Deno.test("test_prepare_clamps_small_caption_tail_only", async () => {
  for (const extraSeconds of [1.52, 20]) {
    const runDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        `${runDir}/source.json`,
        JSON.stringify({
          schema_version: "1.0",
          run_id: fixture.run_id,
          lecture: { ...fixture.lecture, duration_sec: 10 },
        }),
      );
      await Deno.writeTextFile(
        `${runDir}/${fixture.lecture.video_id}.ko.json3`,
        JSON.stringify({
          events: [
            {
              tStartMs: 9000,
              dDurationMs: 1000 + extraSeconds * 1000,
              segs: [{ utf8: "강의 마무리" }],
            },
          ],
        }),
      );
      if (extraSeconds < 5) {
        await prepareRun(runDir);
        const segments = JSON.parse(
          await Deno.readTextFile(`${runDir}/segments.json`),
        );
        if (
          segments.length !== 1 || segments[0].end_sec !== 10 ||
          segments[0].text !== "강의 마무리"
        ) {
          throw new Error(
            "Small caption tail was not capped without dropping speech",
          );
        }
      } else {
        try {
          await prepareRun(runDir);
          throw new Error("Large caption overrun was accepted");
        } catch (error) {
          if (
            !(error instanceof Error) || !error.message.includes("extends past")
          ) throw error;
        }
      }
    } finally {
      await Deno.remove(runDir, { recursive: true });
    }
  }
});

Deno.test("test_english_fetch_prepare_resume", async () => {
  const runDir = await Deno.makeTempDir();
  try {
    const videoId = "zizonToFXDs";
    const lecture = {
      video_id: videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: "Introduction to large language models",
      duration_sec: 946,
      caption_language: "en",
      caption_source: "manual",
      translation_language: "ko",
      created_at: "2026-10-10T00:00:00Z",
    };
    const source = {
      schema_version: "2.0",
      run_id: crypto.randomUUID(),
      lecture,
      caption_format: "vtt",
      caption_tag: "en-US",
      caption_file: `${videoId}.en-US.vtt`,
    };
    await Deno.writeTextFile(`${runDir}/source.json`, JSON.stringify(source));
    await Deno.writeTextFile(
      `${runDir}/${source.caption_file}`,
      "WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nHello world\n\n00:00:02.000 --> 00:00:03.000\nA language model\n",
    );
    await Deno.writeTextFile(
      `${runDir}/${videoId}.info.json`,
      JSON.stringify({
        id: videoId,
        title: lecture.title,
        duration: 946,
        language: "en-US",
      }),
    );
    const first = await fetchRun(
      lecture.url,
      runDir,
      `${runDir}/missing-tools`,
      "en",
    );
    const chunks = await prepareRun(runDir);
    const second = await fetchRun(
      lecture.url,
      runDir,
      `${runDir}/missing-tools`,
      "auto",
    );
    await prepareRun(runDir);
    const segments = JSON.parse(
      await Deno.readTextFile(`${runDir}/segments.json`),
    );
    if (
      JSON.stringify(first) !== JSON.stringify(second) ||
      first.schema_version !== "2.0"
    ) throw new Error("English resume changed saved source");
    if (
      chunks.length !== 1 || segments.length !== 2 || segments[0].idx !== 1 ||
      segments[1].start_sec !== 2
    ) throw new Error("English VTT was not prepared");
    const files = [...Deno.readDirSync(runDir)].map((entry) => entry.name);
    if (files.some((name) => /\.(mp4|webm|mkv)$/iu.test(name))) {
      throw new Error("Video was downloaded");
    }
  } finally {
    await Deno.remove(runDir, { recursive: true });
  }
});

Deno.test("test_mismatched_resume_source", async () => {
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
    await Deno.writeTextFile(`${runDir}/${videoId}.ko.json3`, "{}");
    await Deno.writeTextFile(
      `${runDir}/${videoId}.info.json`,
      JSON.stringify({
        id: videoId,
        title: fixture.lecture.title,
        duration: fixture.lecture.duration_sec,
      }),
    );
    for (
      const [url, requested] of [[fixture.lecture.url, "en"], [
        "https://www.youtube.com/watch?v=zizonToFXDs",
        "ko",
      ]] as const
    ) {
      try {
        await fetchRun(url, runDir, `${runDir}/missing-tools`, requested);
        throw new Error("Mismatched resume was accepted");
      } catch (error) {
        if (
          !(error instanceof Error) || !error.message.includes("run directory")
        ) throw error;
      }
    }
  } finally {
    await Deno.remove(runDir, { recursive: true });
  }
});

Deno.test("test_resume_english_after_caption_before_manifest", async () => {
  const runDir = await Deno.makeTempDir();
  try {
    const videoId = "zizonToFXDs";
    await Deno.writeTextFile(
      `${runDir}/${videoId}.info.json`,
      JSON.stringify({
        id: videoId,
        title: "Introduction to large language models",
        duration: 946,
        language: "en-US",
        subtitles: { "en-US": [{ ext: "json3" }] },
        automatic_captions: { "en-orig": [{ ext: "json3" }] },
      }),
    );
    await Deno.writeTextFile(
      `${runDir}/${videoId}.en-US.json3`,
      JSON.stringify({
        events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Hello" }] }],
      }),
    );
    const source = await fetchRun(
      `https://www.youtube.com/watch?v=${videoId}`,
      runDir,
      `${runDir}/missing-tools`,
      "en",
    );
    if (
      source.schema_version !== "2.0" ||
      source.caption_file !== `${videoId}.en-US.json3` ||
      source.lecture.caption_source !== "manual"
    ) {
      throw new Error("English caption was not recovered from saved metadata");
    }
    await prepareRun(runDir);
    const repeat = await fetchRun(
      `https://www.youtube.com/watch?v=${videoId}`,
      runDir,
      `${runDir}/missing-tools`,
      "auto",
    );
    if (JSON.stringify(source) !== JSON.stringify(repeat)) {
      throw new Error("Recovered source changed");
    }
  } finally {
    await Deno.remove(runDir, { recursive: true });
  }
});

Deno.test("test_resume_legacy_korean_before_manifest", async () => {
  const runDir = await Deno.makeTempDir();
  try {
    const videoId = fixture.lecture.video_id;
    await Deno.writeTextFile(
      `${runDir}/${videoId}.info.json`,
      JSON.stringify({
        id: videoId,
        title: fixture.lecture.title,
        duration: fixture.lecture.duration_sec,
      }),
    );
    await Deno.writeTextFile(
      `${runDir}/${videoId}.ko.json3`,
      JSON.stringify({
        events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "강의" }] }],
      }),
    );
    const source = await fetchRun(
      fixture.lecture.url,
      runDir,
      `${runDir}/missing-tools`,
    );
    if (
      source.schema_version !== "1.0" ||
      source.lecture.caption_language !== "ko"
    ) {
      throw new Error("Interrupted legacy Korean run was not recovered");
    }
    await prepareRun(runDir);
  } finally {
    await Deno.remove(runDir, { recursive: true });
  }
});

Deno.test("test_legacy_resume_does_not_override_english_native_language", async () => {
  const runDir = await Deno.makeTempDir();
  try {
    const videoId = fixture.lecture.video_id;
    await Deno.writeTextFile(
      `${runDir}/${videoId}.info.json`,
      JSON.stringify({
        id: videoId,
        title: fixture.lecture.title,
        duration: fixture.lecture.duration_sec,
        language: "en-US",
      }),
    );
    await Deno.writeTextFile(`${runDir}/${videoId}.ko.json3`, "{}");
    try {
      await fetchRun(fixture.lecture.url, runDir, `${runDir}/missing-tools`);
      throw new Error(
        "Translated Korean track was accepted as a legacy original",
      );
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "CaptionUnavailable") {
        throw error;
      }
    }
    if (await Deno.stat(`${runDir}/source.json`).catch(() => null)) {
      throw new Error("Rejected source was saved");
    }
  } finally {
    await Deno.remove(runDir, { recursive: true });
  }
});

const englishFixture = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/valid-english-lecture.json", import.meta.url),
  ),
);

async function stageEnglishAssembly(runDir: string) {
  const segments = englishFixture.segments.map((
    { idx, start_sec, end_sec, text }: {
      idx: number;
      start_sec: number;
      end_sec: number;
      text: string;
    },
  ) => ({ idx, start_sec, end_sec, text }));
  const chunks = chunkSegments(segments);
  await Deno.writeTextFile(
    `${runDir}/source.json`,
    JSON.stringify({
      schema_version: "2.0",
      run_id: englishFixture.run_id,
      lecture: englishFixture.lecture,
      caption_format: "json3",
      caption_tag: "en-US",
      caption_file: `${englishFixture.lecture.video_id}.en-US.json3`,
    }),
  );
  await Deno.writeTextFile(`${runDir}/segments.json`, JSON.stringify(segments));
  await Deno.mkdir(`${runDir}/chunks`);
  for (const chunk of chunks) {
    await Deno.writeTextFile(
      `${runDir}/chunks/${chunk.chunk_idx}.json`,
      JSON.stringify(chunk),
    );
  }
  const stripRange = (range: Record<string, unknown>) => ({
    title: range.title,
    summary: range.summary,
    start_idx: range.start_idx,
    end_idx: range.end_idx,
  });
  await Deno.writeTextFile(
    `${runDir}/outline.json`,
    JSON.stringify({
      chapters: englishFixture.outline.chapters.map((
        chapter: Record<string, unknown>,
      ) => ({
        ...stripRange(chapter),
        children: (chapter.children as Record<string, unknown>[]).map(
          stripRange,
        ),
      })),
    }),
  );
  await Deno.writeTextFile(
    `${runDir}/summary_note.json`,
    JSON.stringify({
      overview: englishFixture.summary_note.overview,
      key_points: englishFixture.summary_note.key_points.map((
        point: Record<string, unknown>,
      ) => ({ text: point.text, segment_idxs: point.segment_idxs })),
    }),
  );
  await Deno.writeTextFile(
    `${runDir}/glossary.json`,
    JSON.stringify(
      englishFixture.glossary.map((term: Record<string, unknown>) => ({
        term: term.term,
        explanation: term.explanation,
        first_segment_idx: term.first_segment_idx,
      })),
    ),
  );
  return chunks;
}

Deno.test("test_english_assembly_requires_context_then_translations", async () => {
  const runDir = await Deno.makeTempDir();
  try {
    const chunks = await stageEnglishAssembly(runDir);
    try {
      await assembleRun(runDir);
      throw new Error("English assembly skipped context");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("context")) {
        throw error;
      }
    }
    await Deno.mkdir(`${runDir}/context/parts`, { recursive: true });
    await Deno.mkdir(`${runDir}/corrections`);
    for (const chunk of chunks) {
      await Deno.writeTextFile(
        `${runDir}/context/parts/${chunk.chunk_idx}.json`,
        JSON.stringify({
          chunk_idx: chunk.chunk_idx,
          start_idx: chunk.start_idx,
          end_idx: chunk.end_idx,
          flow: "Arrays and linked lists",
          terms: [],
          possible_misrecognitions: [],
        }),
      );
      await Deno.writeTextFile(
        `${runDir}/corrections/${chunk.chunk_idx}.json`,
        "[]",
      );
    }
    await Deno.writeTextFile(
      `${runDir}/context/lecture.json`,
      JSON.stringify({
        covered_chunk_idxs: chunks.map((chunk) => chunk.chunk_idx),
        lecture_flow: "Compare data structures",
        recurring_terms: [],
        possible_misrecognitions: [],
      }),
    );
    try {
      await assembleRun(runDir);
      throw new Error("English assembly skipped translations");
    } catch (error) {
      if (
        !(error instanceof Error) || !error.message.includes("translations")
      ) throw error;
    }
    await Deno.mkdir(`${runDir}/translations`);
    await Deno.writeTextFile(
      `${runDir}/translations/1.json`,
      JSON.stringify(
        englishFixture.segments.map((
          segment: { idx: number; translation_ko: string },
        ) => ({
          segment_idx: segment.idx,
          translation_ko: segment.translation_ko,
        })),
      ),
    );
    const document = await assembleRun(runDir);
    await assembleRun(runDir);
    if (
      document.schema_version !== "2.0" || document.segments.length !== 4 ||
      !("translation_ko" in document.segments[0])
    ) throw new Error("English lecture was not assembled");
    if (
      JSON.stringify(
        await JSON.parse(await Deno.readTextFile(`${runDir}/lecture.json`)),
      ) !== JSON.stringify(document)
    ) throw new Error("English lecture changed on resume");
  } finally {
    await Deno.remove(runDir, { recursive: true });
  }
});

Deno.test("test_translation_outside_editable_chunk", async () => {
  const runDir = await Deno.makeTempDir();
  try {
    const chunks = await stageEnglishAssembly(runDir);
    await Deno.mkdir(`${runDir}/context/parts`, { recursive: true });
    await Deno.mkdir(`${runDir}/corrections`);
    await Deno.mkdir(`${runDir}/translations`);
    for (const chunk of chunks) {
      await Deno.writeTextFile(
        `${runDir}/context/parts/${chunk.chunk_idx}.json`,
        JSON.stringify({
          chunk_idx: chunk.chunk_idx,
          start_idx: chunk.start_idx,
          end_idx: chunk.end_idx,
          flow: "Arrays",
          terms: [],
          possible_misrecognitions: [],
        }),
      );
      await Deno.writeTextFile(
        `${runDir}/corrections/${chunk.chunk_idx}.json`,
        "[]",
      );
    }
    await Deno.writeTextFile(
      `${runDir}/context/lecture.json`,
      JSON.stringify({
        covered_chunk_idxs: [1],
        lecture_flow: "Data structures",
        recurring_terms: [],
        possible_misrecognitions: [],
      }),
    );
    await Deno.writeTextFile(
      `${runDir}/translations/1.json`,
      JSON.stringify([{ segment_idx: 99, translation_ko: "오류" }]),
    );
    try {
      await assembleRun(runDir);
      throw new Error("Out-of-chunk translation was accepted");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("translations/1.json")
      ) throw error;
    }
  } finally {
    await Deno.remove(runDir, { recursive: true });
  }
});
