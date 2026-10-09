import { chunkSegments } from "../scripts/chunk.ts";
import type { Segment } from "../scripts/types.ts";

Deno.test("test_three_hour_chunks", () => {
  const segments: Segment[] = Array.from({ length: 3600 }, (_, i) => ({
    idx: i + 1,
    start_sec: i * 3,
    end_sec: (i + 1) * 3,
    text: `구간 ${i + 1}: ` + "자료 구조를 설명하는 자막입니다. ".repeat(3),
  }));
  const chunks = chunkSegments(segments, 12000, 3);
  if (chunks.length < 2) throw new Error("Three-hour transcript was not split");
  const indices = chunks.flatMap((chunk) =>
    chunk.editable.map((segment) => segment.idx)
  );
  if (
    indices.length !== segments.length ||
    indices.some((idx, i) => idx !== i + 1)
  ) {
    throw new Error("A segment was lost or appears in two editable ranges");
  }
  for (const chunk of chunks) {
    const chars = chunk.editable.reduce(
      (sum, segment) => sum + segment.text.length,
      0,
    );
    if (chars > 12000) {
      throw new Error(
        `Chunk ${chunk.chunk_idx} exceeds the editable character limit`,
      );
    }
    if (chunk.context_before.length > 3 || chunk.context_after.length > 3) {
      throw new Error("Too much context");
    }
    if (
      chunk.context_before.some((segment) => segment.idx >= chunk.start_idx)
    ) throw new Error("Before context overlaps editable range");
    if (chunk.context_after.some((segment) => segment.idx <= chunk.end_idx)) {
      throw new Error("After context overlaps editable range");
    }
  }
  if (chunks[0].end_idx + 1 !== chunks[1].start_idx) {
    throw new Error("Chunk boundary has a gap");
  }
  if (chunks[1].context_before.at(-1)?.idx !== chunks[0].end_idx) {
    throw new Error("Boundary context is missing");
  }
});

Deno.test("test_oversized_segment", () => {
  const long: Segment[] = [{
    idx: 1,
    start_sec: 0,
    end_sec: 1,
    text: "가".repeat(12001),
  }];
  try {
    chunkSegments(long, 12000, 3);
    throw new Error("Oversized segment was accepted");
  } catch (error) {
    if (
      !(error instanceof Error) || !error.message.includes("/segments/0/text")
    ) throw error;
  }
});
