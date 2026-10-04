import { beforeEach, describe, expect, it, vi } from "vitest";
import type { boundedTranscriptPage, MediaJobView, TranscriptDocument } from "@cos-tool-bot/shared";
import type { MediaJobConfiguration } from "../services/media-jobs/contracts.js";
import { MediaJobError } from "../services/media-jobs/service.js";
import { pluginMediaJobRoutes } from "./plugin-media-jobs.js";

const botId = "00000000-0000-4000-8000-000000000001";
const jobId = "00000000-0000-4000-8000-000000000002";
const base = `/hanori.bilibili/bots/${botId}/jobs`;
const document: TranscriptDocument = {
  source: "asr",
  language: "en",
  track: "original",
  cues: [{ startMs: 0, endMs: 1000, text: "Synthetic <caption>", uncertain: true }],
};
const job: MediaJobView = {
  id: jobId,
  sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
  title: "Synthetic",
  part: 1,
  durationSeconds: 1,
  status: "completed",
  progress: 100,
  error: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  expiresAt: new Date(86400000).toISOString(),
  language: "en",
  source: "asr",
  notification: "sent",
};
const config: MediaJobConfiguration = {
  revision: 1,
  installationRevision: 1,
  asr: { baseUrl: "https://asr.example.test/v1", apiKey: "private-test-key", model: "test" },
  limits: {
    maxDurationSeconds: 300,
    dailyJobs: 3,
    dailyMinutes: 10,
    costPerMinute: 0.01,
    maxDailyCost: 1,
  },
  allowExport: true,
};
const jobs = {
  listForBot: vi.fn(async () => [job]),
  getForOwner: vi.fn(async () => job),
  cancelForOwner: vi.fn(async () => job),
  readForOwner: vi.fn(async (): Promise<TranscriptDocument> => document),
};
const configuration = vi.fn(async (): Promise<MediaJobConfiguration | null> => config);
const app = () => pluginMediaJobRoutes({ jobs, configuration });
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
beforeEach(() => {
  vi.clearAllMocks();
  configuration.mockResolvedValue(config);
  jobs.readForOwner.mockResolvedValue(document);
});

describe("plugin media job web routes", () => {
  it("lists only public job projections and configuration flags with no caching", async () => {
    const response = await app().request(base);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      data: [job],
      available: true,
      allowExport: true,
    });
    expect(jobs.listForBot).toHaveBeenCalledWith(botId);
  });
  it("reports an unavailable deployment without constructing jobs", async () => {
    const response = await pluginMediaJobRoutes().request(base);
    expect(await response.json()).toEqual({
      ok: true,
      data: [],
      available: false,
      allowExport: false,
    });
  });
  it("keeps existing tasks manageable when provider configuration is invalid", async () => {
    configuration.mockRejectedValue(new Error("invalid-provider-private-key"));
    const response = await app().request(base);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: [job],
      available: false,
      allowExport: false,
    });
    expect((await app().request(`${base}/${jobId}/cancel`, { method: "POST" })).status).toBe(200);
    expect(jobs.cancelForOwner).toHaveBeenCalledWith(botId, jobId);
  });
  it("binds web management to the requested Bot and validated job identifier", async () => {
    expect((await app().request(`${base}/${jobId}`)).status).toBe(200);
    expect((await app().request(`${base}/${jobId}/cancel`, { method: "POST" })).status).toBe(200);
    expect(jobs.getForOwner).toHaveBeenCalledWith(botId, jobId);
    expect(jobs.cancelForOwner).toHaveBeenCalledWith(botId, jobId);
    expect((await app().request(`${base}/invalid/cancel`, { method: "POST" })).status).toBe(400);
    expect(jobs.cancelForOwner).toHaveBeenCalledTimes(1);
  });
  it("bounds excerpts, searches literal text and preserves provenance and uncertainty", async () => {
    jobs.readForOwner.mockResolvedValue({
      ...document,
      cues: [
        { startMs: 0, endMs: 1000, text: "Other" },
        { startMs: 1000, endMs: 2000, text: "needle " + "x".repeat(4993), uncertain: true },
        { startMs: 2000, endMs: 3000, text: "needle next" },
      ],
    });
    const response = await app().request(`${base}/${jobId}/transcript?query=needle&limit=40`);
    const body = (await response.json()) as { data: ReturnType<typeof boundedTranscriptPage> };
    expect(body.data).toMatchObject({
      source: "asr",
      nextOffset: 1,
      total: 2,
      textTruncated: true,
      cues: [{ cueIndex: 1, uncertain: true, textTruncated: true }],
    });
    expect(body.data.cues[0]?.text).toHaveLength(4000);
    expect((await app().request(`${base}/${jobId}/transcript?limit=41`)).status).toBe(400);
    expect((await app().request(`${base}/${jobId}/transcript?offset=-1`)).status).toBe(400);
  });
  it("reads a bounded page beyond cue 10,000 while retaining owner scope checks", async () => {
    jobs.readForOwner.mockResolvedValue({
      ...document,
      cues: Array.from({ length: 10_050 }, (_, index) => ({
        startMs: index * 1000,
        endMs: (index + 1) * 1000,
        text: `Synthetic long cue ${index}`,
      })),
    });
    const response = await app().request(`${base}/${jobId}/transcript?offset=10001&limit=40`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: ReturnType<typeof boundedTranscriptPage> };
    expect(body.data).toMatchObject({ source: "asr", total: 10_050, nextOffset: 10_041 });
    expect(body.data.cues).toHaveLength(40);
    expect(body.data.cues[0]).toMatchObject({
      cueIndex: 10_001,
      text: "Synthetic long cue 10001",
    });
    expect(body.data.cues.at(-1)?.cueIndex).toBe(10_040);
    expect(body.data.cues.reduce((sum, cue) => sum + cue.text.length, 0)).toBeLessThanOrEqual(4000);
    expect(jobs.readForOwner).toHaveBeenCalledWith(botId, jobId);
    jobs.readForOwner.mockClear();
    expect((await app().request(`${base}/${jobId}/transcript?offset=50001`)).status).toBe(400);
    expect(jobs.readForOwner).not.toHaveBeenCalled();
    jobs.readForOwner.mockRejectedValueOnce(new MediaJobError("forbidden"));
    expect((await app().request(`${base}/${jobId}/transcript?offset=10001`)).status).toBe(403);
    expect(jobs.readForOwner).toHaveBeenCalledWith(botId, jobId);
  });
  it.each([
    {},
    { format: "srt" },
    { format: "srt", rightsConfirmed: false },
    { format: "txt", rightsConfirmed: true },
  ])("requires an explicit per-export rights confirmation: %j", async (body) => {
    expect((await app().request(`${base}/${jobId}/export`, post(body))).status).toBe(400);
    expect(jobs.readForOwner).not.toHaveBeenCalled();
  });
  it("requires export to be enabled server-side even with a forged UI confirmation", async () => {
    configuration.mockResolvedValue({ ...config, allowExport: false });
    const response = await app().request(
      `${base}/${jobId}/export`,
      post({ format: "srt", rightsConfirmed: true }),
    );
    expect(response.status).toBe(403);
    expect(jobs.readForOwner).not.toHaveBeenCalled();
  });
  it.each(["srt", "vtt"])(
    "exports authorized %s with a safe filename and escaped content",
    async (format) => {
      const response = await app().request(
        `${base}/${jobId}/export`,
        post({ format, rightsConfirmed: true }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="${jobId}.${format}"`,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toContain(format === "vtt" ? "&lt;caption&gt;" : "‹caption›");
      expect(jobs.readForOwner).toHaveBeenCalledWith(botId, jobId);
    },
  );
  it("honors revoked/expired content and never echoes exception secrets", async () => {
    jobs.readForOwner.mockRejectedValueOnce(new MediaJobError("expired"));
    expect(await (await app().request(`${base}/${jobId}/transcript`)).json()).toEqual({
      ok: false,
      error: "expired",
    });
    jobs.readForOwner.mockRejectedValueOnce(new Error("private-test-key"));
    expect(
      await (
        await app().request(
          `${base}/${jobId}/export`,
          post({ format: "vtt", rightsConfirmed: true }),
        )
      ).json(),
    ).toEqual({ ok: false, error: "job_failed" });
  });
});
