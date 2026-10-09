const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export class CaptionUnavailable extends Error {
  constructor(videoId: string) {
    super(`한국어 자동 자막을 찾을 수 없습니다: ${videoId}`);
    this.name = "CaptionUnavailable";
  }
}

export class CaptionFetchError extends Error {
  constructor(detail: string) {
    super(`자막 수집 실패: ${detail}`);
    this.name = "CaptionFetchError";
  }
}

export type CommandRunner = (
  executable: string,
  args: string[],
  cwd: string,
) => Promise<{ code: number; stderr: string }>;

const runCommand: CommandRunner = async (executable, args, cwd) => {
  const result = await new Deno.Command(executable, {
    args,
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  return { code: result.code, stderr: new TextDecoder().decode(result.stderr) };
};

async function existsNonempty(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile && stat.size > 0;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function fetchCaption(
  videoId: string,
  workDir: string,
  toolPaths: { deno: string; ytdlp: string },
  runner: CommandRunner = runCommand,
): Promise<{ captionPath: string; infoPath: string }> {
  if (!VIDEO_ID.test(videoId)) throw new CaptionFetchError("invalid video ID");
  await Deno.mkdir(workDir, { recursive: true });
  const captionPath = `${workDir}/${videoId}.ko.json3`;
  const infoPath = `${workDir}/${videoId}.info.json`;
  if (await existsNonempty(captionPath) || await existsNonempty(infoPath)) {
    throw new CaptionFetchError(
      "output files already exist; use a new work directory",
    );
  }
  const args = [
    "--ignore-config",
    "--no-playlist",
    "--skip-download",
    "--write-auto-subs",
    "--sub-langs",
    "ko",
    "--sub-format",
    "json3",
    "--write-info-json",
    "--js-runtimes",
    `deno:${toolPaths.deno}`,
    "--output",
    "%(id)s.%(ext)s",
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  let result: { code: number; stderr: string };
  try {
    result = await runner(toolPaths.ytdlp, args, workDir);
  } catch (error) {
    throw new CaptionFetchError(String(error));
  }
  if (result.code !== 0) {
    throw new CaptionFetchError(
      result.stderr.trim().slice(-500) || `yt-dlp exited with ${result.code}`,
    );
  }
  if (!await existsNonempty(captionPath)) throw new CaptionUnavailable(videoId);
  if (!await existsNonempty(infoPath)) {
    throw new CaptionFetchError("video metadata is missing");
  }
  let info: unknown;
  try {
    info = JSON.parse(await Deno.readTextFile(infoPath));
  } catch {
    throw new CaptionFetchError("video metadata is malformed");
  }
  if (
    typeof info !== "object" || info === null || !("id" in info) ||
    info.id !== videoId
  ) {
    throw new CaptionFetchError("video metadata ID does not match URL");
  }
  if (
    !("duration" in info) || typeof info.duration !== "number" ||
    info.duration <= 0 || info.duration > 10800
  ) {
    throw new CaptionFetchError(
      "video duration must be between 1 second and 3 hours",
    );
  }
  return { captionPath, infoPath };
}
