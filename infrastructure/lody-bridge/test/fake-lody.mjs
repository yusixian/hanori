// Stand-in for the `lody` binary in bridge tests; behavior is chosen by FAKE_LODY_MODE.
import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const mode = process.env.FAKE_LODY_MODE ?? "echo";
let stdin = "";
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", () => {
  if (args[0] === "daemon") {
    const file = process.env.FAKE_LODY_DAEMON_FILE;
    if (args[1] === "status") process.exit(file && existsSync(file) ? 0 : 1);
    if (mode === "fail") process.exit(1);
    if (file) writeFileSync(file, args.join(" "));
    process.exit(0);
  }
  if (args[0] === "--version") {
    process.stdout.write("0.100.0\n");
    return;
  }
  if (mode === "sleep") {
    setTimeout(() => {}, 60_000);
    return;
  }
  if (mode === "fail") {
    process.stdout.write('{"ok":false,"error":"machine offline"}\n');
    process.exit(3);
  }
  if (mode === "flood") {
    process.stdout.write("x".repeat(64 * 1024));
    return;
  }
  process.stdout.write(
    `[ws] attached\n${JSON.stringify({ ok: true, args, stdin, token: process.env.LODY_CLI_TOKEN ?? null })}\n`,
  );
});
