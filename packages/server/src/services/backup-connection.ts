import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Preserve libpq's authority (including multiple hosts) and query encoding verbatim.
export async function withBackupConnection(
  databaseUrl: string,
  dump: (url: string, env: NodeJS.ProcessEnv) => Promise<void>,
): Promise<void> {
  const parts = /^(postgres(?:ql)?:\/\/)([^/?#]*)([^?#]*)(?:\?([^#]*))?$/i.exec(databaseUrl);
  if (!parts) throw new Error("Backup requires a PostgreSQL connection URI");
  const [, scheme, authority, path, query] = parts;
  let password = process.env.PGPASSWORD;
  const host = authority!.replace(/^([^:@]*):([^@]*)@/, (_, user: string, encoded: string) => {
    password = decodeURIComponent(encoded);
    return user + "@";
  });
  const options = (query || "").split("&").filter((option) => {
    const [key, ...value] = option.split("=");
    if (decodeURIComponent(key!) !== "password") return !!option;
    password = decodeURIComponent(value.join("="));
    return false;
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        (key.startsWith("PG") && key !== "PGPASSWORD") ||
        ["PATH", "HOME", "LANG", "LC_ALL", "LC_MESSAGES", "TZ", "SystemRoot"].includes(key),
    ),
  );
  const uri = (options: string[]) =>
    scheme + host + path + (options.length ? "?" + options.join("&") : "");
  if (!password) return dump(uri(options), env);
  if (/[\r\n]/.test(password) || password.includes("\0"))
    throw new Error(
      "Backup password contains a character unsupported by PostgreSQL password files",
    );
  const directory = await mkdtemp(join(tmpdir(), "pgdump-"));
  try {
    const passfile = join(directory, "pgpass");
    await writeFile(passfile, "*:*:*:*:" + password.replace(/[:\\]/g, "\\$&") + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    // An explicit password takes precedence over an existing passfile URI option.
    const safeOptions = options.filter(
      (option) => decodeURIComponent(option.split("=")[0]!) !== "passfile",
    );
    await dump(uri(safeOptions), { ...env, PGPASSFILE: passfile });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
