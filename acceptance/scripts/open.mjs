import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const latest = path.join(root, ".acceptance", "latest");

let runDir;
const stat = fs.lstatSync(latest);
if (stat.isSymbolicLink()) {
  runDir = path.resolve(path.dirname(latest), fs.readlinkSync(latest));
} else {
  runDir = path.join(root, ".acceptance", "runs", fs.readFileSync(latest, "utf8").trim());
}

const report = path.join(runDir, "report.html");
if (!fs.existsSync(report)) {
  console.error(`report not found: ${report} — run pnpm acceptance:report first`);
  process.exit(1);
}

if (process.platform === "darwin") {
  spawnSync("open", [report], { stdio: "inherit" });
} else {
  console.log(report);
}
