import type { Segment } from "./types.ts";

export interface Chunk {
  chunk_idx: number;
  start_idx: number;
  end_idx: number;
  editable: Segment[];
  context_before: Segment[];
  context_after: Segment[];
}

export function chunkSegments(
  segments: Segment[],
  maxChars = 12000,
  contextSegments = 3,
): Chunk[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error("/maxChars: expected a positive integer");
  }
  if (!Number.isInteger(contextSegments) || contextSegments < 0) {
    throw new Error("/contextSegments: expected a nonnegative integer");
  }
  if (segments.length === 0) throw new Error("/segments: transcript is empty");
  let previousEnd = 0;
  for (const [i, segment] of segments.entries()) {
    if (segment.idx !== i + 1) {
      throw new Error(`/segments/${i}/idx: indices must be contiguous`);
    }
    if (
      segment.start_sec < previousEnd || segment.end_sec <= segment.start_sec
    ) {
      throw new Error(`/segments/${i}/start_sec: times must be monotonic`);
    }
    if (!segment.text.trim()) {
      throw new Error(`/segments/${i}/text: caption is empty`);
    }
    if (segment.text.length > maxChars) {
      throw new Error(
        `/segments/${i}/text: one segment exceeds the chunk character limit`,
      );
    }
    previousEnd = segment.end_sec;
  }

  const chunks: Chunk[] = [];
  for (let start = 0; start < segments.length;) {
    let end = start;
    let chars = 0;
    while (end < segments.length) {
      const extra = segments[end].text.length + (end > start ? 1 : 0);
      if (chars + extra > maxChars) break;
      chars += extra;
      end++;
    }
    const editable = segments.slice(start, end);
    chunks.push({
      chunk_idx: chunks.length + 1,
      start_idx: editable[0].idx,
      end_idx: editable.at(-1)!.idx,
      editable,
      context_before: segments.slice(
        Math.max(0, start - contextSegments),
        start,
      ),
      context_after: segments.slice(
        end,
        Math.min(segments.length, end + contextSegments),
      ),
    });
    start = end;
  }
  return chunks;
}
