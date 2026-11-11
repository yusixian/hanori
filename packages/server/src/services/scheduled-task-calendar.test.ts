import { describe, it, expect } from "vitest";
import { nextTaskOccurrence, validateTaskSchedule } from "./scheduled-task-calendar.js";
import type { TaskSchedule } from "@cos-tool-bot/shared";
const monthly: TaskSchedule = {
  kind: "calendar",
  startsAt: "2026-01-01T00:00:00Z",
  timezone: "Asia/Shanghai",
  period: "month",
  dayOfMonth: 31,
  hour: 9,
  minute: 0,
};
describe("calendar task schedules", () => {
  it("keeps distant one-shot dates beyond the Node timer range", () => {
    expect(
      nextTaskOccurrence(
        { kind: "once", at: "2040-01-01T00:00:00Z", timezone: "UTC" },
        new Date("2026-01-01"),
      )?.toISOString(),
    ).toBe("2040-01-01T00:00:00.000Z");
  });
  it("clamps month ends without turning a month into thirty days", () => {
    expect(nextTaskOccurrence(monthly, new Date("2026-02-01"))?.toISOString()).toBe(
      "2026-02-28T01:00:00.000Z",
    );
    expect(nextTaskOccurrence(monthly, new Date("2026-03-01"))?.toISOString()).toBe(
      "2026-03-31T01:00:00.000Z",
    );
  });
  it("retains the quarter phase after missed years", () => {
    expect(
      nextTaskOccurrence({ ...monthly, period: "quarter" }, new Date("2030-02-01"))?.toISOString(),
    ).toBe("2030-04-30T01:00:00.000Z");
  });
  it("advances nonexistent DST wall time to the first valid minute", () => {
    expect(
      nextTaskOccurrence(
        {
          kind: "calendar",
          startsAt: "2026-03-01T00:00:00Z",
          timezone: "America/New_York",
          period: "week",
          weekday: 0,
          hour: 2,
          minute: 30,
        },
        new Date("2026-03-08T00:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-03-08T07:00:00.000Z");
  });
  it("chooses the earlier ambiguous DST occurrence", () => {
    expect(
      nextTaskOccurrence(
        {
          kind: "calendar",
          startsAt: "2026-11-01T00:00:00Z",
          timezone: "America/New_York",
          period: "week",
          weekday: 0,
          hour: 1,
          minute: 30,
        },
        new Date("2026-11-01T00:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-11-01T05:30:00.000Z");
  });
  it("skips missed intervals in constant time", () => {
    expect(
      nextTaskOccurrence(
        { kind: "interval", startsAt: "2020-01-01T00:00:00Z", everySeconds: 60, timezone: "UTC" },
        new Date("2040-01-01T00:00:01Z"),
      )?.toISOString(),
    ).toBe("2040-01-01T00:01:00.000Z");
  });
  it("rejects invalid dates, intervals and zones", () => {
    expect(() => validateTaskSchedule({ kind: "once", at: "no", timezone: "UTC" })).toThrow();
    expect(() =>
      validateTaskSchedule({ kind: "once", at: "2040-01-01", timezone: "no/such" }),
    ).toThrow();
    expect(() =>
      validateTaskSchedule({
        kind: "interval",
        startsAt: "2040-01-01",
        everySeconds: 0,
        timezone: "UTC",
      }),
    ).toThrow();
  });
});
