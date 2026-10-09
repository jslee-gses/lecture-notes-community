import { CaptionDataError, parseJson3 } from "../scripts/captions.ts";
const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/captions.json3", import.meta.url),
  ),
);

Deno.test("test_empty_event", () => {
  const parsed = parseJson3(fixture);
  if (parsed.length !== 4 || parsed[0].text !== "안녕하세요 오늘은") {
    throw new Error(
      `Empty event or overlap was not removed: ${JSON.stringify(parsed)}`,
    );
  }
});

Deno.test("test_malformed_event", () => {
  const malformed = {
    events: [{
      tStartMs: "later",
      dDurationMs: 1000,
      segs: [{ utf8: "강의" }],
    }],
  };
  try {
    parseJson3(malformed);
    throw new Error("Malformed event was accepted");
  } catch (error) {
    if (
      !(error instanceof CaptionDataError) ||
      !error.message.includes("/events/0/tStartMs")
    ) {
      throw new Error(`Unexpected error: ${String(error)}`);
    }
  }
});

Deno.test("test_overlap", () => {
  const parsed = parseJson3(fixture);
  if (parsed[0].start_sec !== 0.5 || parsed[0].end_sec !== 2.4) {
    throw new Error(
      `Overlap time was not trimmed: ${JSON.stringify(parsed[0])}`,
    );
  }
  if (parsed.map((segment) => segment.idx).join(",") !== "1,2,3,4") {
    throw new Error("Indices are not contiguous and 1-based");
  }
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].start_sec < parsed[i - 1].end_sec) {
      throw new Error(`Non-monotonic segment time at ${i}`);
    }
  }
  if (parsed[2].text !== "네." || parsed[3].text !== "네.") {
    throw new Error("A real repeated utterance was removed");
  }
});

Deno.test("test_entire_transcript_empty", () => {
  try {
    parseJson3({
      events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "\n" }] }],
    });
    throw new Error("Empty transcript was accepted");
  } catch (error) {
    if (
      !(error instanceof CaptionDataError) || !error.message.includes("/events")
    ) throw error;
  }
});

Deno.test("test_overlapping_real_repetition", () => {
  const parsed = parseJson3({
    events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "네." }] },
      { tStartMs: 500, dDurationMs: 1000, segs: [{ utf8: "네." }] },
    ],
  });
  if (
    parsed.length !== 2 || parsed[0].end_sec !== 0.5 ||
    parsed[1].start_sec !== 0.5
  ) {
    throw new Error("An overlapping spoken repetition was removed");
  }
});
