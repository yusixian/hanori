import type { TaskSchedule } from "@cos-tool-bot/shared";

const MINUTE = 60_000;
function parts(at: Date, timezone: string) {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => Number(values.find((value) => value.type === type)!.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}
/** Ambiguous wall times use the earlier occurrence; nonexistent times advance to the first valid minute. */
function wallTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let later: { at: number; difference: number } | undefined;
  for (let at = target - 15 * 3_600_000; at <= target + 15 * 3_600_000; at += MINUTE) {
    const p = parts(new Date(at), timezone);
    const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (local === target) return new Date(at);
    if (local > target && (!later || local - target < later.difference))
      later = { at, difference: local - target };
  }
  if (!later) throw new Error("Invalid calendar date");
  return new Date(later.at);
}
export function validateTaskSchedule(schedule: TaskSchedule): void {
  new Intl.DateTimeFormat("en", { timeZone: schedule.timezone }).format();
  const start = new Date(schedule.kind === "once" ? schedule.at : schedule.startsAt);
  if (!Number.isFinite(start.getTime())) throw new Error("Invalid schedule date");
  if (
    schedule.kind === "interval" &&
    (!Number.isSafeInteger(schedule.everySeconds) ||
      schedule.everySeconds < 1 ||
      schedule.everySeconds * 1000 > Number.MAX_SAFE_INTEGER)
  )
    throw new Error("Invalid interval");
  if (schedule.kind === "calendar") {
    if (
      !Number.isInteger(schedule.hour) ||
      schedule.hour < 0 ||
      schedule.hour > 23 ||
      !Number.isInteger(schedule.minute) ||
      schedule.minute < 0 ||
      schedule.minute > 59
    )
      throw new Error("Invalid calendar time");
    if (
      schedule.period === "week" &&
      (!Number.isInteger(schedule.weekday) || schedule.weekday! < 0 || schedule.weekday! > 6)
    )
      throw new Error("Invalid weekday");
    if (
      schedule.period !== "week" &&
      (!Number.isInteger(schedule.dayOfMonth) ||
        schedule.dayOfMonth! < 1 ||
        schedule.dayOfMonth! > 31)
    )
      throw new Error("Invalid month day");
  }
}
function calendarOccurrence(
  schedule: Extract<TaskSchedule, { kind: "calendar" }>,
  index: number,
): Date {
  const anchor = parts(new Date(schedule.startsAt), schedule.timezone);
  if (schedule.period === "week") {
    const date = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day));
    date.setUTCDate(
      date.getUTCDate() + ((schedule.weekday! - date.getUTCDay() + 7) % 7) + index * 7,
    );
    return wallTime(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      schedule.hour,
      schedule.minute,
      schedule.timezone,
    );
  }
  const date = new Date(
    Date.UTC(anchor.year, anchor.month - 1 + index * (schedule.period === "quarter" ? 3 : 1), 1),
  );
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return wallTime(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    Math.min(schedule.dayOfMonth!, lastDay),
    schedule.hour,
    schedule.minute,
    schedule.timezone,
  );
}
/** Return the first occurrence at or after the boundary without iterating missed periods. */
export function nextTaskOccurrence(schedule: TaskSchedule, boundary: Date): Date | null {
  validateTaskSchedule(schedule);
  const start = new Date(schedule.kind === "once" ? schedule.at : schedule.startsAt);
  const after = Math.max(boundary.getTime(), start.getTime());
  if (schedule.kind === "once") return start.getTime() >= boundary.getTime() ? start : null;
  if (schedule.kind === "interval") {
    const result = new Date(
      start.getTime() +
        Math.max(0, Math.ceil((after - start.getTime()) / (schedule.everySeconds * 1000))) *
          schedule.everySeconds *
          1000,
    );
    if (!Number.isFinite(result.getTime()))
      throw new Error("Schedule exceeds supported date range");
    return result;
  }
  const anchor = parts(start, schedule.timezone),
    current = parts(new Date(after), schedule.timezone);
  let index =
    schedule.period === "week"
      ? Math.max(
          0,
          Math.floor(
            (Date.UTC(current.year, current.month - 1, current.day) -
              Date.UTC(anchor.year, anchor.month - 1, anchor.day)) /
              604_800_000,
          ) - 1,
        )
      : Math.max(
          0,
          Math.floor(
            ((current.year - anchor.year) * 12 + current.month - anchor.month) /
              (schedule.period === "quarter" ? 3 : 1),
          ) - 1,
        );
  for (;;) {
    const occurrence = calendarOccurrence(schedule, index++);
    if (occurrence.getTime() >= after) return occurrence;
  }
}

export function latestTaskOccurrence(schedule: TaskSchedule, at: Date): Date | null {
  const start = new Date(schedule.kind === "once" ? schedule.at : schedule.startsAt);
  if (start > at) return null;
  if (schedule.kind === "once") return start;
  if (schedule.kind === "interval")
    return new Date(
      start.getTime() +
        Math.floor((at.getTime() - start.getTime()) / (schedule.everySeconds * 1000)) *
          schedule.everySeconds *
          1000,
    );
  // At most fifteen weeks or four months are examined, regardless of downtime.
  let candidate = nextTaskOccurrence(
    schedule,
    new Date(Math.max(start.getTime(), at.getTime() - 100 * 86_400_000)),
  );
  let latest: Date | null = null;
  while (candidate && candidate <= at) {
    latest = candidate;
    candidate = nextTaskOccurrence(schedule, new Date(candidate.getTime() + 1));
  }
  return latest;
}
