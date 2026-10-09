import { CaptionUnavailable, fetchCaption } from "../scripts/captions.ts";

const ID = "AbCdEfGhIjK";

Deno.test("test_fetch_text_only", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "lecture-fetch-test-" });
  try {
    const calls: { command: string; args: string[]; cwd: string }[] = [];
    const result = await fetchCaption(ID, workDir, {
      deno: "C:/tools/deno.exe",
      ytdlp: "C:/tools/yt-dlp.exe",
    }, async (command, args, cwd) => {
      calls.push({ command, args, cwd });
      await Deno.writeTextFile(
        `${workDir}/${ID}.ko.json3`,
        JSON.stringify({
          events: [{ tStartMs: 0, segs: [{ utf8: "안녕하세요" }] }],
        }),
      );
      await Deno.writeTextFile(
        `${workDir}/${ID}.info.json`,
        JSON.stringify({ id: ID, title: "강의", duration: 60 }),
      );
      return { code: 0, stderr: "" };
    });
    if (calls.length !== 1 || calls[0].command !== "C:/tools/yt-dlp.exe") {
      throw new Error("yt-dlp was not called exactly once");
    }
    const args = calls[0].args;
    for (
      const flag of [
        "--ignore-config",
        "--no-playlist",
        "--skip-download",
        "--write-auto-subs",
        "--write-info-json",
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
      !result.infoPath.endsWith(`${ID}.info.json`)
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
          await Deno.writeTextFile(
            `${workDir}/${ID}.info.json`,
            JSON.stringify({ id: ID, title: "강의", duration: 60 }),
          );
          return { code: 0, stderr: "No subtitles" };
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
