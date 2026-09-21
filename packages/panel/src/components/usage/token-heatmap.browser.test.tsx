import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGrid, TokenHeatmap } from "./token-heatmap";

afterEach(() => {
  vi.useRealTimers();
});

describe("token heatmap calendar grid", () => {
  it.each([
    {
      label: "Sunday",
      today: new Date(2026, 2, 8, 12),
      todayDate: "2026-03-08",
      todayDay: 0,
      lastDate: "2026-03-14",
      futureDates: [
        "2026-03-09",
        "2026-03-10",
        "2026-03-11",
        "2026-03-12",
        "2026-03-13",
        "2026-03-14",
      ],
    },
    {
      label: "Wednesday",
      today: new Date(2026, 2, 11, 12),
      todayDate: "2026-03-11",
      todayDay: 3,
      lastDate: "2026-03-14",
      futureDates: ["2026-03-12", "2026-03-13", "2026-03-14"],
    },
    {
      label: "Saturday",
      today: new Date(2026, 2, 14, 12),
      todayDate: "2026-03-14",
      todayDay: 6,
      lastDate: "2026-03-14",
      futureDates: [],
    },
    {
      label: "year boundary",
      today: new Date(2025, 11, 31, 12),
      todayDate: "2025-12-31",
      todayDay: 3,
      lastDate: "2026-01-03",
      futureDates: ["2026-01-01", "2026-01-02", "2026-01-03"],
    },
  ])(
    "keeps the current week visible on $label",
    ({ today, todayDate, todayDay, lastDate, futureDates }) => {
      vi.useFakeTimers();
      vi.setSystemTime(today);

      const cells = buildGrid([]);

      expect(cells).toHaveLength(53 * 7);
      expect(cells[0]?.day).toBe(0);
      expect(cells.at(-1)).toMatchObject({ date: lastDate, week: 52, day: 6 });
      expect(cells.find((cell) => cell.date === todayDate)).toMatchObject({
        week: 52,
        day: todayDay,
        future: false,
      });
      expect(cells.filter((cell) => cell.future).map((cell) => cell.date)).toEqual(futureDates);
    },
  );

  it("groups values by the supplied local calendar date prefix", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 11, 12));

    const cells = buildGrid([
      { date: "2026-03-11T00:05:00+08:00", totalTokens: 4 },
      { date: "2026-03-11T23:55:00+08:00", totalTokens: 6 },
    ]);

    expect(cells.find((cell) => cell.date === "2026-03-11")).toMatchObject({
      value: 10,
      future: false,
    });
  });

  it("renders usage when the only non-zero value is today", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 11, 12));
    await i18n.changeLanguage("en");

    render(<TokenHeatmap data={[{ date: "2026-03-11T12:00:00+08:00", totalTokens: 42 }]} />);

    await expect.element(page.getByText("Less", { exact: true })).toBeVisible();
    await expect.element(page.getByText("No usage data", { exact: true })).not.toBeInTheDocument();
    expect(document.querySelectorAll("svg rect")).toHaveLength(53 * 7);
  });
});
