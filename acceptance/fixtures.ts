import fs from "node:fs";
import path from "node:path";
import { test as base, expect, type Page } from "@playwright/test";

export interface CaseMeta {
  id: string;
  feature: string;
  severity: "P0" | "P1" | "P2";
  steps: string[];
  expected: string[];
  /** Defaults to true. Set false only for pure API/diagnostic cases. */
  visualRequired?: boolean;
  /** HTTP statuses this case triggers on purpose (e.g. 401 from a wrong-password step). */
  allowHttpStatuses?: number[];
}

interface HttpErrorRecord {
  status: number;
  url: string;
}

interface CheckpointRecord {
  name: string;
  path: string;
  overflow: boolean;
}

interface CaseEvidence {
  meta: CaseMeta | null;
  project: string;
  testTitle: string;
  status: "passed" | "failed" | "timedOut" | "interrupted" | "skipped";
  durationMs: number;
  startedAt: string;
  checkpoints: CheckpointRecord[];
  finalScreenshot: string | null;
  diagnostics: {
    consoleErrors: string[];
    pageErrors: string[];
    failedRequests: string[];
    httpErrors: HttpErrorRecord[];
    horizontalOverflow: boolean;
  };
}

export interface Acceptance {
  meta(meta: CaseMeta): void;
  checkpoint(name: string): Promise<void>;
}

const runDir =
  process.env.ACCEPTANCE_RUN_DIR ?? path.resolve(import.meta.dirname, "../.acceptance/runs/ad-hoc");

/** Project-specific: storage state written by global-setup.ts for authenticated specs. */
export const AUTH_STATE_PATH = path.join(runDir, "auth-state.json");

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function measureHorizontalOverflow(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth > root.clientWidth + 1;
    })
    .catch(() => false);
}

/**
 * Per-case acceptance helper. Checkpoint naming convention:
 * - plain names (e.g. "modal-open") render as lightbox thumbnails;
 * - "before:<label>" and "after:<label>" pair into an <img-compare> slider.
 */
export const test = base.extend<{ acceptance: Acceptance }>({
  acceptance: [
    async ({ page }, use, testInfo) => {
      const evidence: CaseEvidence = {
        meta: null,
        project: testInfo.project.name,
        testTitle: testInfo.title,
        status: "passed",
        durationMs: 0,
        startedAt: new Date().toISOString(),
        checkpoints: [],
        finalScreenshot: null,
        diagnostics: {
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
          httpErrors: [],
          horizontalOverflow: false,
        },
      };

      page.on("console", (message) => {
        if (message.type() === "error") {
          // Browser-generated resource errors for statuses in allowHttpStatuses are exempted too
          const statusMatch = /status of (\d+)/.exec(message.text());
          if (statusMatch && evidence.meta?.allowHttpStatuses?.includes(Number(statusMatch[1]))) {
            return;
          }
          evidence.diagnostics.consoleErrors.push(message.text());
        }
      });
      page.on("pageerror", (error) => {
        evidence.diagnostics.pageErrors.push(String(error));
      });
      page.on("requestfailed", (request) => {
        // Intentional: the app aborts in-flight requests on route change/unmount; not a network defect.
        if (request.failure()?.errorText === "net::ERR_ABORTED") return;
        evidence.diagnostics.failedRequests.push(
          `${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`,
        );
      });
      page.on("response", (response) => {
        if (response.status() >= 400) {
          if (evidence.meta?.allowHttpStatuses?.includes(response.status())) return;
          evidence.diagnostics.httpErrors.push({
            status: response.status(),
            url: response.url(),
          });
        }
      });

      let checkpointIndex = 0;
      const screenshotDir = (): string => {
        const caseSlug = evidence.meta ? evidence.meta.id : slugify(testInfo.title);
        const directory = path.join(runDir, "screenshots", evidence.project, caseSlug);
        fs.mkdirSync(directory, { recursive: true });
        return directory;
      };

      const acceptance: Acceptance = {
        meta(meta) {
          evidence.meta = meta;
          testInfo.annotations.push(
            { type: "acceptance-id", description: meta.id },
            { type: "acceptance-severity", description: meta.severity },
          );
        },
        async checkpoint(name) {
          checkpointIndex += 1;
          const fileName = `${String(checkpointIndex).padStart(2, "0")}-${slugify(name)}.png`;
          const filePath = path.join(screenshotDir(), fileName);
          await page.screenshot({ path: filePath, fullPage: false });
          const overflow = await measureHorizontalOverflow(page);
          if (overflow) evidence.diagnostics.horizontalOverflow = true;
          evidence.checkpoints.push({
            name,
            path: path.relative(runDir, filePath),
            overflow,
          });
        },
      };

      const startedAt = Date.now();
      await use(acceptance);

      // Final state capture: always recorded, never a substitute for checkpoints.
      evidence.durationMs = Date.now() - startedAt;
      evidence.status = testInfo.status;
      const finalOverflow = await measureHorizontalOverflow(page);
      if (finalOverflow) evidence.diagnostics.horizontalOverflow = true;
      const finalPath = path.join(screenshotDir(), "99-final.png");
      await page.screenshot({ path: finalPath, fullPage: false }).catch(() => undefined);
      if (fs.existsSync(finalPath)) {
        evidence.finalScreenshot = path.relative(runDir, finalPath);
      }

      const casesDir = path.join(runDir, "cases");
      fs.mkdirSync(casesDir, { recursive: true });
      const caseSlug = evidence.meta ? evidence.meta.id : slugify(testInfo.title);
      fs.writeFileSync(
        path.join(casesDir, `${evidence.project}--${caseSlug}.json`),
        JSON.stringify(evidence, null, 2),
      );
    },
    { auto: true },
  ],
});

export { expect };
