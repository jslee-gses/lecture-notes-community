import { CaptionUnavailable, fetchCaption } from "../scripts/captions.ts";
import * as captions from "../scripts/captions.ts";

const ID = "AbCdEfGhIjK";

function select(info: unknown, requested: "ko" | "en" | "auto") {
  const candidate =
    (captions as unknown as Record<string, unknown>).selectCaptionTrack;
  if (typeof candidate !== "function") {
    throw new Error("caption track selector is missing");
  }
  return candidate(info, requested) as {
    language: string;
    source: string;
    format: string;
    tag: string;
  };
}

const englishInfo = () => ({
  id: ID,
  duration: 60,
  language: "en-US",
  subtitles: { "en-US": [{ ext: "vtt" }, { ext: "json3" }] },
  automatic_captions: { "en-orig": [{ ext: "json3" }], en: [{ ext: "json3" }] },
});

Deno.test("test_manual_english_precedes_auto", () => {
  const track = select(englishInfo(), "auto");
  if (
    track.language !== "en" || track.source !== "manual" ||
    track.format !== "json3" || track.tag !== "en-US"
  ) {
    throw new Error(`Wrong English track: ${JSON.stringify(track)}`);
  }
});

Deno.test("test_auto_english_fallback", () => {
  const info = englishInfo();
  info.subtitles = {} as typeof info.subtitles;
  const track = select(info, "auto");
  if (track.source !== "auto" || track.tag !== "en-orig") {
    throw new Error("Original English auto track was not selected");
  }
});

Deno.test("test_reject_translated_english_track", () => {
  const info = {
    ...englishInfo(),
    language: "ja",
    subtitles: {},
    automatic_captions: { en: [{ ext: "json3" }] },
  };
  try {
    select(info, "en");
    throw new Error("Translated English track was accepted");
  } catch (error) {
    if (
      !(error instanceof Error) || !error.message.includes("native language")
    ) throw error;
  }
});

Deno.test("test_ambiguous_native_language", () => {
  const info = { ...englishInfo(), language: undefined };
  try {
    select(info, "auto");
    throw new Error("Ambiguous native language was accepted");
  } catch (error) {
    if (
      !(error instanceof Error) || error.name !== "CaptionLanguageAmbiguous"
    ) throw error;
  }
  if (select(info, "en").source !== "manual") {
    throw new Error("Explicit English choice was rejected");
  }
});

Deno.test("test_no_english_caption", () => {
  const info = { ...englishInfo(), subtitles: {}, automatic_captions: {} };
  try {
    select(info, "en");
    throw new Error("Missing English captions were accepted");
  } catch (error) {
    if (!(error instanceof CaptionUnavailable)) throw error;
  }
});

Deno.test("test_manual_vtt_fallback", () => {
  const info = englishInfo();
  info.subtitles["en-US"] = [{ ext: "vtt" }];
  const track = select(info, "auto");
  if (track.source !== "manual" || track.format !== "vtt") {
    throw new Error("Manual VTT was not selected");
  }
});

Deno.test("test_fetch_text_only", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "lecture-fetch-test-" });
  try {
    const calls: { command: string; args: string[]; cwd: string }[] = [];
    const result = await fetchCaption(ID, workDir, {
      deno: "C:/tools/deno.exe",
      ytdlp: "C:/tools/yt-dlp.exe",
    }, async (command, args, cwd) => {
      calls.push({ command, args, cwd });
      if (args.includes("--dump-single-json")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            id: ID,
            title: "강의",
            duration: 60,
            language: "ko",
            automatic_captions: { ko: [{ ext: "json3" }] },
          }),
          stderr: "",
        };
      }
      await Deno.writeTextFile(
        `${workDir}/${ID}.ko.json3`,
        JSON.stringify({
          events: [{ tStartMs: 0, segs: [{ utf8: "안녕하세요" }] }],
        }),
      );
      return { code: 0, stdout: "", stderr: "" };
    });
    if (
      calls.length !== 2 ||
      calls.some((call) => call.command !== "C:/tools/yt-dlp.exe")
    ) {
      throw new Error("yt-dlp metadata and subtitle calls were not made");
    }
    const args = calls[1].args;
    for (
      const flag of [
        "--ignore-config",
        "--no-playlist",
        "--skip-download",
        "--write-auto-subs",
      ]
    ) {
      if (!args.includes(flag)) throw new Error(`Missing ${flag}`);
    }
    if (args[args.indexOf("--sub-langs") + 1] !== "ko") {
      throw new Error("Korean captions were not selected");
    }
    if (args[args.indexOf("--sub-format") + 1] !== "json3") {
      throw new Error("JSON3 captions were not selected");
    }
    if (args[args.indexOf("--js-runtimes") + 1] !== "deno:C:/tools/deno.exe") {
      throw new Error("Deno was not passed to yt-dlp");
    }
    if (args.at(-1) !== `https://www.youtube.com/watch?v=${ID}`) {
      throw new Error("Unexpected video URL");
    }
    const files = [];
    for await (const entry of Deno.readDir(workDir)) files.push(entry.name);
    files.sort();
    if (
      JSON.stringify(files) !==
        JSON.stringify([`${ID}.info.json`, `${ID}.ko.json3`])
    ) throw new Error(`Unexpected output files: ${files}`);
    if (
      !result.captionPath.endsWith(`${ID}.ko.json3`) ||
      !result.infoPath.endsWith(`${ID}.info.json`) ||
      result.track.language !== "ko"
    ) throw new Error("Wrong output paths");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("test_no_korean_auto_caption", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "lecture-fetch-test-" });
  try {
    try {
      await fetchCaption(
        ID,
        workDir,
        { deno: "deno", ytdlp: "yt-dlp" },
        async () => {
          return {
            code: 0,
            stdout: JSON.stringify({
              id: ID,
              title: "강의",
              duration: 60,
              language: "ko",
              automatic_captions: {},
            }),
            stderr: "No subtitles",
          };
        },
      );
      throw new Error("Expected CaptionUnavailable");
    } catch (error) {
      if (!(error instanceof CaptionUnavailable)) throw error;
    }
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
