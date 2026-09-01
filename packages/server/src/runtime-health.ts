import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export type RuntimeStatus = "starting" | "ready" | "stopping";

export interface RuntimeHealthSnapshot {
  status: RuntimeStatus;
  version: string;
}

export interface RuntimeHealthReader {
  snapshot(): RuntimeHealthSnapshot;
}

interface DeploymentVersionOptions {
  environmentValue?: string;
  versionFile?: string;
  readFile?: (path: string) => string;
}

export function resolveDeploymentVersion(options: DeploymentVersionOptions = {}): string {
  const environmentValue = options.environmentValue?.trim();
  if (environmentValue) return normalizeDeploymentVersion(environmentValue);

  const versionFile = options.versionFile ?? resolve(process.cwd(), "deployment-version");
  try {
    const value = (options.readFile ?? ((path) => readFileSync(path, "utf8")))(versionFile).trim();
    return normalizeDeploymentVersion(value);
  } catch {
    return "unknown";
  }
}

function normalizeDeploymentVersion(value: string): string {
  return COMMIT_SHA_PATTERN.test(value) ? value.toLowerCase() : "unknown";
}

export class RuntimeHealth implements RuntimeHealthReader {
  private status: RuntimeStatus = "starting";

  constructor(private readonly version: string) {}

  markReady(): void {
    if (this.status === "starting") this.status = "ready";
  }

  markStopping(): void {
    this.status = "stopping";
  }

  snapshot(): RuntimeHealthSnapshot {
    return { status: this.status, version: this.version };
  }
}
