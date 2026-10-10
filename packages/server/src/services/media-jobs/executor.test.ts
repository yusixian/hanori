import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Server } from "node:http";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TranscriptDocument } from "@cos-tool-bot/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IsolatedAudioConverter } from "../media/isolated-converter.js";
import { inspectConvertedWav, inspectConvertedWavFile } from "../media/wav.js";
import { MediaAudioStore } from "../media/audio-store.js";
import type { MediaJobConfiguration, MediaJobRow } from "./contracts.js";
import { MediaJobExecutor } from "./executor.js";

const mocks = vi.hoisted(() => ({
  getVideo: vi.fn(),
  listSubtitles: vi.fn(),
  getAudio: vi.fn(),
  download: vi.fn(),
  transcribeBytes: vi.fn(),
  transcribeUrl: vi.fn(),
  resume: vi.fn(),
  bilibili: vi.fn(),
  asr: vi.fn(),
}));
vi.mock("../media/bilibili.js", () => ({ createBilibiliClient: mocks.bilibili }));
vi.mock("../media/http.js", async () => ({
  ...(await vi.importActual<typeof import("../media/http.js")>("../media/http.js")),
  downloadMediaFile: mocks.download,
}));
vi.mock("../media/asr.js", async () => ({
  ...(await vi.importActual<typeof import("../media/asr.js")>("../media/asr.js")),
  createAsrClient: mocks.asr,
}));
vi.mock("../media/asr-providers.js", () => ({
  createMediaAsrClient: (configuration: MediaJobConfiguration["asr"]) => {
    const client = mocks.asr(configuration);
    return {
      transcribeBytes: (bytes: Buffer, options?: { signal?: AbortSignal }) =>
        client.transcribeBytes(bytes, options?.signal),
      transcribeUrl: mocks.transcribeUrl,
      resume: mocks.resume,
    };
  },
}));

const exec = promisify(execFile);
const SECRET = "synthetic-worker-secret-with-32-characters";
const BVID = "BV1xx411c7mD";
const sourceUrl = `https://www.bilibili.com/video/${BVID}`;
const configuration: MediaJobConfiguration = {
  revision: 1,
  installationRevision: 2,
  cookie: "synthetic-bilibili-cookie",
  asr: { baseUrl: "https://asr.example/v1", apiKey: "synthetic-provider-key", model: "test-model" },
  limits: {
    maxDurationSeconds: 10,
    dailyJobs: 5,
    dailyMinutes: 10,
    costPerMinute: 0.01,
    maxDailyCost: 1,
  },
  allowExport: true,
};
const document: TranscriptDocument = {
  source: "asr",
  track: "original",
  language: "en",
  cues: [{ startMs: 0, endMs: 1000, text: "Synthetic audio" }],
};
type Worker = { server: Server; start(): Promise<void>; close(): Promise<void> };
type WorkerOptions = {
  socketPath: string;
  jobDirectory: string;
  secret: string;
  spawnProcess?: typeof spawn;
};

function job(overrides: Partial<MediaJobRow> = {}): MediaJobRow {
  return {
    id: randomUUID(),
    botId: randomUUID(),
    chatId: 1,
    userId: 2,
    threadId: null,
    confirmation: null,
    confirmedAt: new Date(),
    providerTaskId: null,
    providerSubmittedAt: null,
    providerAccount: "legacy",
    providerRevision: 1,
    forceAsr: false,
    pluginId: "hanori.bilibili",
    configRevision: 1,
    installationRevision: 2,
    sourceUrl,
    bvid: BVID,
    part: 1,
    title: "Synthetic clip",
    durationSeconds: 1,
    providerModel: "test-model",
    estimatedCost: 0.01,
    status: "downloading",
    progress: 0,
    error: null,
    result: null,
    cancelRequested: false,
    cleanupPending: false,
    leaseId: null,
    leaseExpiresAt: null,
    attempt: 1,
    notification: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}
function video() {
  return {
    bvid: BVID,
    selectedPart: 1,
    url: sourceUrl,
    title: "Synthetic clip",
    reference: "synthetic-ref",
    parts: [{ part: 1, durationSeconds: 1 }],
  };
}
function pcm(seconds = 1): Buffer {
  const bytes = Buffer.alloc(44 + seconds * 32_000);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
function metadata(bytes: Buffer, durationSeconds = 1) {
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    durationSeconds,
  };
}

describe("media executor isolated conversion pipeline", () => {
  let fixtureRoot: string;
  let fixture: string;
  let hasFfmpeg: boolean;
  let root: string;
  let jobs: string;
  let socket: string;
  let worker: Worker | undefined;
  let createWorker: (options: WorkerOptions) => Worker;
  let converter: IsolatedAudioConverter;
  let executor: MediaJobExecutor;
  let stages: string[];
  const signal = () => new AbortController().signal;
  const onStage = async (stage: string) => {
    stages.push(stage);
  };

  beforeAll(async () => {
    const workerModule = new URL(
      "../../../../../infrastructure/media-worker/server.mjs",
      import.meta.url,
    ).href;
    ({ createWorker } = await import(workerModule));
    fixtureRoot = await mkdtemp(join(tmpdir(), "executor-fixture-"));
    fixture = join(fixtureRoot, "synthetic.m4a");
    hasFfmpeg = true;
    try {
      await exec("ffprobe", ["-version"]);
      await exec("ffmpeg", ["-version"]);
    } catch {
      hasFfmpeg = false;
      const header = Buffer.alloc(16);
      header.writeUInt32BE(16, 0);
      header.write("ftyp", 4);
      await writeFile(fixture, header);
      return;
    }
    await exec("ffmpeg", [
      "-hide_banner",
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:a",
      "aac",
      "-f",
      "mp4",
      fixture,
    ]);
  }, 15_000);
  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.resetAllMocks();
    // Keep both the public socket and the worker's private binding below AF_UNIX path limits.
    root = await mkdtemp(join(await realpath("/tmp"), "executor-test-"));
    jobs = join(root, "jobs");
    socket = join(root, "worker.sock");
    stages = [];
    await mkdir(jobs, { mode: 0o755 });
    converter = new IsolatedAudioConverter(socket, SECRET);
    executor = new MediaJobExecutor(jobs, converter, process.getgid!());
    mocks.bilibili.mockReturnValue({
      getVideo: mocks.getVideo,
      listSubtitles: mocks.listSubtitles,
      getAudio: mocks.getAudio,
    });
    mocks.asr.mockReturnValue({ transcribeBytes: mocks.transcribeBytes });
    mocks.getVideo.mockResolvedValue(video());
    mocks.listSubtitles.mockResolvedValue({ status: "available" });
    mocks.getAudio.mockResolvedValue({
      url: "https://fixture.bilivideo.com/signed.m4a",
      allowedHosts: ["fixture.bilivideo.com"],
    });
    mocks.transcribeBytes.mockResolvedValue(document);
    mocks.download.mockImplementation(async (_url, _policy, destination: string) => {
      await copyFile(fixture, destination, constants.COPYFILE_EXCL);
      const bytes = await readFile(destination);
      return metadata(bytes);
    });
  });
  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function fakeConverter(
    write: (output: string, id: string) => Promise<ReturnType<typeof metadata>>,
  ) {
    vi.spyOn(converter, "health").mockResolvedValue();
    vi.spyOn(converter, "cancel").mockResolvedValue();
    vi.spyOn(converter, "convert").mockImplementation(async (id) =>
      write(join(jobs, id, "output.wav"), id),
    );
  }
  async function startWorker(spawnProcess?: typeof spawn) {
    worker = createWorker({ socketPath: socket, jobDirectory: jobs, secret: SECRET, spawnProcess });
    await worker.start();
  }

  it("converts synthetic AAC through the real worker and sends the verified WAV after persisting the stage", async (context) => {
    if (!hasFfmpeg) {
      context.skip("FFmpeg/ffprobe unavailable");
      return;
    }
    await startWorker();
    const requests: Array<{ path: string; headers: string; body: string }> = [];
    worker!.server.on("request", (request) => {
      const observed = { path: request.url!, headers: JSON.stringify(request.headers), body: "" };
      requests.push(observed);
      request.on("data", (chunk: Buffer) => {
        observed.body += chunk.toString("utf8");
      });
    });
    const convert = vi.spyOn(converter, "convert");
    const inputJob = job();
    mocks.transcribeBytes.mockImplementation(async (bytes: Buffer) => {
      expect(stages).toEqual(["downloading", "converting", "transcribing"]);
      expect(inspectConvertedWav(bytes, 10).durationSeconds).toBeGreaterThan(0.9);
      return document;
    });
    expect(await executor.execute(inputJob, configuration, { signal: signal(), onStage })).toEqual(
      document,
    );
    const [id] = await readdir(jobs);
    const output = await readFile(join(jobs, id!, "output.wav"));
    expect(mocks.transcribeBytes.mock.calls[0]![0]).toEqual(output);
    expect(output.length).toBeLessThanOrEqual(20 * 1024 * 1024);
    expect(convert.mock.calls[0]![1]).toBe(metadata(await readFile(fixture)).sha256);
    const conversionRequest = requests.find(({ path }) => path.endsWith("/convert"))!;
    expect(JSON.parse(conversionRequest.body)).toEqual({
      sha256: convert.mock.calls[0]![1],
      maxDurationSeconds: 10,
    });
    expect(JSON.stringify(requests)).not.toContain(configuration.cookie);
    expect(JSON.stringify(requests)).not.toContain(configuration.asr.apiKey);
    expect(JSON.stringify(requests)).not.toContain(configuration.asr.baseUrl);
    expect((await lstat(join(jobs, id!, "input.m4a"))).mode & 0o777).toBe(0o440);
    expect(await readdir(join(jobs, id!))).toEqual(["input.m4a", "output.wav"]);
    expect(mocks.bilibili).toHaveBeenCalledWith({ cookie: configuration.cookie });
    expect(mocks.download.mock.calls[0]![1]).toMatchObject({
      referer: "https://www.bilibili.com/",
      maxRedirects: 0,
    });
    expect(JSON.stringify(mocks.download.mock.calls[0]![1])).not.toContain(configuration.cookie);
    await executor.cleanup(inputJob.id, 1);
    expect(await readdir(jobs)).toEqual([]);
  }, 15_000);

  it("converts more than ten minutes when allowed by the saved duration limit", async (context) => {
    if (!hasFfmpeg) {
      context.skip("FFmpeg/ffprobe unavailable");
      return;
    }
    const longFixture = join(root, "long.m4a");
    await exec("ffmpeg", [
      "-hide_banner",
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=16000:cl=mono",
      "-t",
      "601",
      "-c:a",
      "aac",
      "-f",
      "mp4",
      longFixture,
    ]);
    mocks.getVideo.mockResolvedValue({
      ...video(),
      parts: [{ part: 1, durationSeconds: 601 }],
    });
    mocks.download.mockImplementation(async (_url, _policy, destination: string) => {
      await copyFile(longFixture, destination, constants.COPYFILE_EXCL);
      return metadata(await readFile(destination), 601);
    });
    await startWorker();
    const options = {
      ...configuration,
      limits: { ...configuration.limits, maxDurationSeconds: 900 },
    };
    expect(
      await executor.execute(job({ durationSeconds: 601, estimatedCost: 0.12 }), options, {
        signal: signal(),
        onStage,
      }),
    ).toEqual(document);
    expect(mocks.getAudio).toHaveBeenCalledWith("synthetic-ref", expect.any(AbortSignal), 900);
    const bytes = mocks.transcribeBytes.mock.calls[0]![0] as Buffer;
    expect(inspectConvertedWav(bytes, 900).durationSeconds).toBeGreaterThanOrEqual(601);
    expect(bytes.length).toBeLessThanOrEqual(20 * 1024 * 1024);
    expect(stages).toEqual(["downloading", "converting", "transcribing"]);
  }, 15_000);

  it.each([5 * 1024 * 1024 - 2, 5 * 1024 * 1024])(
    "submits a %i-byte Tencent WAV without a public audio store",
    async (size) => {
      const seconds = (size - 44) / 32_000;
      const output = pcm(seconds);
      expect(output.length).toBe(size);
      mocks.getVideo.mockResolvedValue({
        ...video(),
        parts: [{ part: 1, durationSeconds: seconds }],
      });
      fakeConverter(async (path) => {
        await writeFile(path, output);
        return metadata(output, seconds);
      });
      const config = {
        ...configuration,
        asr: { ...configuration.asr, provider: "tencent" as const },
        limits: { ...configuration.limits, maxDurationSeconds: 200 },
      };
      expect(
        await executor.execute(job({ durationSeconds: seconds, estimatedCost: 1 }), config, {
          signal: signal(),
          onStage,
        }),
      ).toEqual(document);
      expect(mocks.transcribeUrl).not.toHaveBeenCalled();
      expect(mocks.transcribeBytes).toHaveBeenCalledOnce();
      expect((mocks.transcribeBytes.mock.calls[0]![0] as Buffer).equals(output)).toBe(true);
      expect(stages).toEqual(["downloading", "converting", "transcribing"]);
    },
  );

  it("passes a one-hour verified file URL to Tencent without reading the full WAV into a Buffer", async () => {
    const seconds = 3600;
    const audioStore = new MediaAudioStore(root, "https://audio.example.com", SECRET);
    const stage = vi.spyOn(audioStore, "stageFile");
    const remove = vi.spyOn(audioStore, "remove");
    const executor = new MediaJobExecutor(jobs, converter, process.getgid!(), socket, audioStore);
    mocks.getVideo.mockResolvedValue({
      ...video(),
      parts: [{ part: 1, durationSeconds: seconds }],
    });
    fakeConverter(async (output) => {
      const header = pcm().subarray(0, 44);
      const size = 44 + seconds * 32_000;
      header.writeUInt32LE(size - 8, 4);
      header.writeUInt32LE(size - 44, 40);
      const file = await open(output, "wx");
      try {
        await file.write(header);
        await file.truncate(size);
      } finally {
        await file.close();
      }
      return inspectConvertedWavFile(output, seconds);
    });
    mocks.transcribeUrl.mockResolvedValue(document);
    const inputJob = job({ durationSeconds: seconds, estimatedCost: 1 });
    const config = {
      ...configuration,
      asr: { ...configuration.asr, provider: "tencent" as const },
      limits: { ...configuration.limits, maxDurationSeconds: seconds },
    };
    const onProviderTask = vi.fn(async () => {});
    expect(
      await executor.execute(inputJob, config, { signal: signal(), onStage, onProviderTask }),
    ).toEqual(document);
    expect(stage).toHaveBeenCalledWith(
      inputJob.id,
      expect.stringContaining("output.wav"),
      expect.objectContaining({ expectedBytes: 115_200_044, maxDurationSeconds: seconds }),
      expect.any(AbortSignal),
    );
    expect(mocks.transcribeBytes).not.toHaveBeenCalled();
    expect(mocks.transcribeUrl).toHaveBeenCalledWith(
      expect.stringContaining("https://audio.example.com/api/asr-audio/"),
      seconds,
      expect.objectContaining({ onProviderTask, signal: expect.any(AbortSignal) }),
    );
    expect(mocks.download.mock.calls[0]![1]).toMatchObject({
      maxBytes: 512 * 1024 * 1024,
      timeoutMs: 30 * 60_000,
    });
    const url = new URL(mocks.transcribeUrl.mock.calls[0]![0]);
    expect(remove).not.toHaveBeenCalled();
    expect(
      (
        await lstat(
          join(root, "asr-audio", `${inputJob.id}.${url.searchParams.get("expires")}.wav`),
        )
      ).size,
    ).toBe(115_200_044);
    await audioStore.remove(inputJob.id);
    expect(
      await audioStore.openStream(
        inputJob.id,
        url.searchParams.get("expires")!,
        url.searchParams.get("signature")!,
      ),
    ).toBeNull();
  });

  it("returns a resumed provider result without deleting audio before persistence", async () => {
    const audioStore = new MediaAudioStore(root, "https://audio.example.com", SECRET);
    const remove = vi.spyOn(audioStore, "remove").mockRejectedValue(new Error("cleanup denied"));
    const executor = new MediaJobExecutor(jobs, converter, process.getgid!(), socket, audioStore);
    mocks.resume.mockResolvedValue(document);
    expect(
      await executor.resume(
        job({ providerTaskId: "synthetic-provider-task", providerSubmittedAt: new Date() }),
        configuration,
        signal(),
      ),
    ).toEqual(document);
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns the subtitle flag without fetching or downloading audio during inspection", async () => {
    fakeConverter(async () => metadata(pcm()));
    expect(await executor.inspect(sourceUrl, configuration, signal())).toMatchObject({
      hasSubtitles: true,
      bvid: BVID,
      part: 1,
    });
    expect(mocks.getAudio).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.transcribeBytes).not.toHaveBeenCalled();
  });

  it.each(["login_required", "authentication_unconfirmed"])(
    "fails inspection closed when subtitles report %s",
    async (status) => {
      fakeConverter(async () => metadata(pcm()));
      mocks.listSubtitles.mockResolvedValue({ status });
      await expect(executor.inspect(sourceUrl, configuration, signal())).rejects.toMatchObject({
        code: "authentication_required",
      });
      expect(mocks.getAudio).not.toHaveBeenCalled();
    },
  );

  it.each([
    { bvid: "BVdifferent" },
    { selectedPart: 2 },
    { parts: [{ part: 1, durationSeconds: 2 }] },
  ])("rejects changed video identity, part or duration before download: %j", async (change) => {
    fakeConverter(async () => metadata(pcm()));
    mocks.getVideo.mockResolvedValue({ ...video(), ...change });
    const inputJob = job();
    await expect(
      executor.execute(inputJob, configuration, { signal: signal(), onStage }),
    ).rejects.toMatchObject({ code: "source_changed" });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.transcribeBytes).not.toHaveBeenCalled();
    await executor.cleanup(inputJob.id, 1);
    expect(await readdir(jobs)).toEqual([]);
  });

  it("fails before creating raw files or invoking providers when the worker is absent", async () => {
    await expect(
      executor.execute(job(), configuration, { signal: signal(), onStage }),
    ).rejects.toThrow();
    expect(await readdir(jobs)).toEqual([]);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.asr).not.toHaveBeenCalled();
  });

  async function abandonedAttempts() {
    fakeConverter(async (output) => {
      const bytes = pcm();
      await writeFile(output, bytes);
      return metadata(bytes);
    });
    const inputJob = job();
    await executor.execute(inputJob, configuration, { signal: signal(), onStage });
    await executor.execute({ ...inputJob, attempt: 2 }, configuration, {
      signal: signal(),
      onStage,
    });
    const calls = vi.mocked(converter.convert).mock.calls;
    return { inputJob, firstId: calls[0]![0], secondId: calls[1]![0] };
  }

  it.each(["", "worker.sock"])(
    "preserves abandoned artifacts when a disabled deployment lacks a fixed absolute socket: %j",
    async (workerSocket) => {
      const { inputJob, firstId, secondId } = await abandonedAttempts();
      const disabled = new MediaJobExecutor(jobs, undefined, process.getgid!(), workerSocket);
      await expect(disabled.cleanup(inputJob.id, 1)).rejects.toMatchObject({
        code: "worker_unavailable",
      });
      expect((await readdir(jobs)).sort()).toEqual([firstId, secondId].sort());
      expect(await readFile(join(jobs, firstId, "output.wav"))).toEqual(pcm());
    },
  );

  it("cleans only the old attempt once the fixed absolute worker socket is absent", async () => {
    const { inputJob, firstId, secondId } = await abandonedAttempts();
    const disabled = new MediaJobExecutor(jobs, undefined, process.getgid!(), socket);
    await expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" });
    await disabled.cleanup(inputJob.id, 1);
    expect(await readdir(jobs)).toEqual([secondId]);
    await expect(lstat(join(jobs, firstId))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(jobs, secondId, "output.wav"))).toEqual(pcm());
    await disabled.cleanup(inputJob.id, 1);
    expect(await readdir(jobs)).toEqual([secondId]);
  });

  it("preserves files while a real worker Unix socket is still accepting connections", async () => {
    const { inputJob, firstId, secondId } = await abandonedAttempts();
    await startWorker();
    const disabled = new MediaJobExecutor(jobs, undefined, process.getgid!(), socket);
    await expect(disabled.cleanup(inputJob.id, 1)).rejects.toMatchObject({
      code: "worker_unavailable",
    });
    expect((await readdir(jobs)).sort()).toEqual([firstId, secondId].sort());
    expect(await readFile(join(jobs, firstId, "input.m4a"))).toEqual(await readFile(fixture));
    expect(await readFile(join(jobs, firstId, "output.wav"))).toEqual(pcm());
  });

  it("cleans abandoned artifacts after a stopped worker leaves a stale refused Unix socket", async () => {
    const { inputJob, secondId } = await abandonedAttempts();
    await startWorker();
    const staleSocket = join(root, "stale.sock");
    await link(socket, staleSocket);
    await worker!.close();
    expect((await lstat(staleSocket)).isSocket()).toBe(true);
    const disabled = new MediaJobExecutor(jobs, undefined, process.getgid!(), staleSocket);
    await disabled.cleanup(inputJob.id, 1);
    expect(await readdir(jobs)).toEqual([secondId]);
    expect(await readFile(join(jobs, secondId, "output.wav"))).toEqual(pcm());
  });

  it("refuses inspection and execution immediately when the converter is disabled", async () => {
    const disabled = new MediaJobExecutor(jobs, undefined, process.getgid!(), socket);
    await expect(disabled.inspect(sourceUrl, configuration, signal())).rejects.toMatchObject({
      code: "worker_unavailable",
    });
    await expect(
      disabled.execute(job(), configuration, { signal: signal(), onStage }),
    ).rejects.toMatchObject({ code: "worker_unavailable" });
    expect(mocks.bilibili).not.toHaveBeenCalled();
    expect(mocks.getVideo).not.toHaveBeenCalled();
    expect(mocks.getAudio).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.asr).not.toHaveBeenCalled();
    expect(stages).toEqual([]);
    expect(await readdir(jobs)).toEqual([]);
  });

  it.each([0o775, 0o757])("rejects a group/other writable parent directory %o", async (mode) => {
    fakeConverter(async () => metadata(pcm()));
    await chmod(jobs, mode);
    await expect(
      executor.execute(job(), configuration, { signal: signal(), onStage }),
    ).rejects.toMatchObject({ code: "invalid_audio" });
    expect(await readdir(jobs)).toEqual([]);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("rejects a worker-created symlink before reading it or invoking ASR", async () => {
    const outside = join(root, "private.wav");
    await writeFile(outside, pcm());
    fakeConverter(async (output) => {
      await symlink(outside, output);
      return metadata(pcm());
    });
    await expect(
      executor.execute(job(), configuration, { signal: signal(), onStage }),
    ).rejects.toMatchObject({ code: "invalid_audio" });
    expect(mocks.asr).not.toHaveBeenCalled();
    expect(await readFile(outside)).toEqual(pcm());
  });

  it("rejects actual audio longer than a worker's forged duration before ASR", async () => {
    fakeConverter(async (output) => {
      const bytes = pcm(4);
      await writeFile(output, bytes);
      return metadata(bytes, 1);
    });
    await expect(
      executor.execute(job(), configuration, { signal: signal(), onStage }),
    ).rejects.toMatchObject({ code: "invalid_audio" });
    expect(mocks.asr).not.toHaveBeenCalled();
    expect(stages).toEqual(["downloading", "converting"]);
  });

  it("refuses billable audio that exceeds the confirmed cost reservation within the metadata duration tolerance", async () => {
    fakeConverter(async (output) => {
      const bytes = pcm(2);
      await writeFile(output, bytes);
      return metadata(bytes, 2);
    });
    await expect(
      executor.execute(job({ estimatedCost: 0.0002 }), configuration, {
        signal: signal(),
        onStage,
      }),
    ).rejects.toMatchObject({ code: "invalid_audio" });
    expect(mocks.asr).not.toHaveBeenCalled();
    expect(stages).toEqual(["downloading", "converting"]);
  });

  it("rejects a forged worker duration even when the PCM matches the selected source duration", async () => {
    fakeConverter(async (output) => {
      const bytes = pcm();
      await writeFile(output, bytes);
      return metadata(bytes, 0.5);
    });
    await expect(
      executor.execute(job(), configuration, { signal: signal(), onStage }),
    ).rejects.toMatchObject({ code: "invalid_audio" });
    expect(mocks.asr).not.toHaveBeenCalled();
  });

  it("uses the verified buffer even if the output path changes while persisting the ASR stage", async () => {
    let outputPath = "";
    fakeConverter(async (output) => {
      outputPath = output;
      const bytes = pcm();
      await writeFile(output, bytes);
      return metadata(bytes);
    });
    await executor.execute(job(), configuration, {
      signal: signal(),
      onStage: async (stage) => {
        if (stage === "transcribing") await writeFile(outputPath, pcm(2));
      },
    });
    expect(mocks.transcribeBytes.mock.calls[0]![0]).toEqual(pcm());
    expect(await readFile(outputPath)).toEqual(pcm(2));
  });

  it("keeps attempts in distinct directories so an old cleanup leaves the new attempt intact", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    let writes = 0;
    fakeConverter(async (output) => {
      if (++writes === 2) {
        started = true;
        await gate;
      }
      const bytes = pcm();
      await writeFile(output, bytes);
      return metadata(bytes);
    });
    const first = job();
    await executor.execute(first, configuration, { signal: signal(), onStage });
    const [firstDirectory] = await readdir(jobs);
    const second = executor.execute({ ...first, attempt: 2 }, configuration, {
      signal: signal(),
      onStage,
    });
    await vi.waitFor(() => expect(started).toBe(true));
    const directories = await readdir(jobs);
    expect(directories).toHaveLength(2);
    const secondDirectory = directories.find((id) => id !== firstDirectory)!;
    await executor.cleanup(first.id, 1);
    expect(await readdir(jobs)).toEqual([secondDirectory]);
    expect(converter.cancel).toHaveBeenLastCalledWith(firstDirectory);
    release();
    await second;
    expect(await readFile(join(jobs, secondDirectory, "output.wav"))).toEqual(pcm());
  });

  it("cancels a real worker conversion, waits for child termination, then removes the raw artifacts", async (context) => {
    if (!hasFfmpeg) {
      context.skip("FFmpeg/ffprobe unavailable");
      return;
    }
    let child: ReturnType<typeof spawn> | undefined;
    let childClosed = false;
    const controlledSpawn: typeof spawn = ((
      binary: string,
      args: string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      if (binary !== "ffmpeg") return spawn(binary, args, options!);
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options!);
      child.once("close", () => {
        childClosed = true;
      });
      return child;
    }) as typeof spawn;
    await startWorker(controlledSpawn);
    const inputJob = job();
    const controller = new AbortController();
    const pending = executor.execute(inputJob, configuration, {
      signal: controller.signal,
      onStage,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: "conversion_cancelled" });
    await vi.waitFor(() => expect(child).toBeDefined());
    controller.abort();
    await rejected;
    await executor.cleanup(inputJob.id, 1);
    expect(childClosed).toBe(true);
    expect(await readdir(jobs)).toEqual([]);
    expect(mocks.asr).not.toHaveBeenCalled();
    await converter.health();
  }, 15_000);

  it("persists the transcribing stage successfully before issuing a billable request", async () => {
    fakeConverter(async (output) => {
      const bytes = pcm();
      await writeFile(output, bytes);
      return metadata(bytes);
    });
    await expect(
      executor.execute(job(), configuration, {
        signal: signal(),
        onStage: async (stage) => {
          if (stage === "transcribing") throw new Error("synthetic persistence failure");
        },
      }),
    ).rejects.toThrow("synthetic persistence failure");
    expect(mocks.asr).not.toHaveBeenCalled();
  });
});
