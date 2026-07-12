import { formatTokens } from "@/lib/format";
import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";

interface HeatmapDay {
  date: string;
  totalTokens: number;
}

interface TokenHeatmapProps {
  data: HeatmapDay[];
  loading?: boolean;
}

const CELL_SIZE = 11;
const CELL_GAP = 2;
const STEP = CELL_SIZE + CELL_GAP;
const WEEKS = 53;
const DAYS = 7;
const LABEL_WIDTH = 28;
const HEADER_HEIGHT = 16;

const COLORS = ["#161b22", "#0e4429", "#1d4ed8", "#3b82f6", "#60a5fa"];

function toLocalISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getLevel(value: number, thresholds: [number, number, number]): number {
  if (value === 0) return 0;
  if (value <= thresholds[0]) return 1;
  if (value <= thresholds[1]) return 2;
  if (value <= thresholds[2]) return 3;
  return 4;
}

function computeThresholds(values: number[]): [number, number, number] {
  const nonZero = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return [1, 2, 3];
  const q = (p: number) => nonZero[Math.max(0, Math.floor(p * nonZero.length) - 1)] ?? 1;
  return [q(0.25), q(0.5), q(0.75)];
}

interface GridCell {
  date: string;
  week: number;
  day: number;
  value: number;
  future: boolean;
}

function buildGrid(data: HeatmapDay[]): GridCell[] {
  const lookup = new Map<string, number>();
  for (const d of data) {
    const key = d.date.slice(0, 10);
    lookup.set(key, (lookup.get(key) ?? 0) + d.totalTokens);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = toLocalISO(today);

  // Walk back to fill 53 full weeks ending on today's weekday row
  const totalDays = WEEKS * DAYS;
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - totalDays + 1);
  // Align to Sunday (start of week column)
  const startDay = startDate.getDay();
  if (startDay !== 0) {
    startDate.setDate(startDate.getDate() - startDay);
  }

  const cells: GridCell[] = [];
  const cursor = new Date(startDate);
  for (let week = 0; week < WEEKS; week++) {
    for (let day = 0; day < DAYS; day++) {
      const iso = toLocalISO(cursor);
      cells.push({
        date: iso,
        week,
        day,
        value: lookup.get(iso) ?? 0,
        future: iso > todayISO,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return cells;
}

function getMonthLabels(cells: GridCell[], locale: string | undefined) {
  const labels: { label: string; week: number }[] = [];
  const formatter = new Intl.DateTimeFormat(locale, { month: "short" });
  let lastMonth = -1;
  for (const cell of cells) {
    if (cell.day !== 0) continue;
    const date = new Date(`${cell.date}T00:00:00`);
    const month = date.getMonth();
    if (month !== lastMonth) {
      labels.push({ label: formatter.format(date), week: cell.week });
      lastMonth = month;
    }
  }
  return labels;
}

export function TokenHeatmap({ data, loading }: TokenHeatmapProps) {
  const { t, i18n } = useTranslation("admin");
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    cell: GridCell;
  } | null>(null);

  const cells = useMemo(() => buildGrid(data), [data]);
  const thresholds = useMemo(() => computeThresholds(cells.map((c) => c.value)), [cells]);
  const monthLabels = useMemo(
    () => getMonthLabels(cells, i18n.resolvedLanguage),
    [cells, i18n.resolvedLanguage],
  );
  const hasData = useMemo(() => cells.some((c) => c.value > 0), [cells]);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: "medium" }),
    [i18n.resolvedLanguage],
  );
  const dayLabels: [number, string][] = [
    [1, t("usage.heatmap.monday")],
    [3, t("usage.heatmap.wednesday")],
    [5, t("usage.heatmap.friday")],
  ];
  const tooltipText = tooltip
    ? (() => {
        const date = dateFormatter.format(new Date(`${tooltip.cell.date}T00:00:00`));
        if (tooltip.cell.future) return date;
        if (tooltip.cell.value > 0) {
          return t("usage.heatmap.tokens", {
            tokens: formatTokens(tooltip.cell.value),
            date,
          });
        }
        return t("usage.heatmap.noUsage", { date });
      })()
    : null;

  const svgWidth = LABEL_WIDTH + WEEKS * STEP;
  const svgHeight = HEADER_HEIGHT + DAYS * STEP;

  return (
    <div className="relative">
      <div className="overflow-x-auto">
        {loading ? (
          <div
            className="animate-pulse rounded"
            style={{ width: svgWidth, height: svgHeight, backgroundColor: "#161b22" }}
          />
        ) : !hasData ? (
          <div
            className="text-muted-foreground flex items-center justify-center text-sm"
            style={{ width: svgWidth, height: svgHeight }}
          >
            {t("usage.heatmap.noData")}
          </div>
        ) : (
          <svg
            width={svgWidth}
            height={svgHeight}
            className="block"
            onMouseLeave={() => setTooltip(null)}
          >
            {/* Month labels */}
            {monthLabels.map((m) => (
              <text
                key={`${m.label}-${m.week}`}
                x={LABEL_WIDTH + m.week * STEP}
                y={HEADER_HEIGHT - 4}
                className="fill-muted-foreground"
                fontSize={10}
              >
                {m.label}
              </text>
            ))}
            {/* Day labels */}
            {dayLabels.map(([row, label]) => (
              <text
                key={label}
                x={0}
                y={HEADER_HEIGHT + row * STEP + CELL_SIZE}
                className="fill-muted-foreground"
                fontSize={10}
              >
                {label}
              </text>
            ))}
            {/* Cells */}
            {cells.map((cell) => {
              const level = getLevel(cell.value, thresholds);
              const x = LABEL_WIDTH + cell.week * STEP;
              const y = HEADER_HEIGHT + cell.day * STEP;
              return (
                <rect
                  key={cell.date}
                  x={x}
                  y={y}
                  width={CELL_SIZE}
                  height={CELL_SIZE}
                  rx={2}
                  fill={COLORS[level]}
                  onMouseEnter={(e) => {
                    const rect = (e.target as SVGRectElement).getBoundingClientRect();
                    const container = (e.target as SVGRectElement).closest(".relative");
                    if (!container) return;
                    const containerRect = container.getBoundingClientRect();
                    setTooltip({
                      x: rect.left - containerRect.left + rect.width / 2,
                      y: rect.top - containerRect.top - 8,
                      cell,
                    });
                  }}
                  onMouseLeave={() => setTooltip(null)}
                  className="cursor-pointer"
                />
              );
            })}
          </svg>
        )}
      </div>

      {/* Legend */}
      {!loading && hasData && (
        <div className="mt-2 flex items-center justify-end gap-1 text-xs">
          <span className="text-muted-foreground mr-1">{t("usage.heatmap.less")}</span>
          {COLORS.map((color, i) => (
            <span
              key={i}
              className="inline-block rounded-sm"
              style={{ width: CELL_SIZE, height: CELL_SIZE, backgroundColor: color }}
            />
          ))}
          <span className="text-muted-foreground ml-1">{t("usage.heatmap.more")}</span>
        </div>
      )}

      {/* Tooltip */}
      {tooltip && (
        <div
          className="bg-popover text-popover-foreground pointer-events-none absolute z-50 rounded-md border px-2 py-1 text-xs shadow-md"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: "translate(-50%, -100%)",
          }}
        >
          {tooltipText}
        </div>
      )}
    </div>
  );
}
