const HOST_ENVIRONMENT_KEYS = ["HOME", "LANG", "LC_ALL", "PATH", "TEMP", "TMP", "TMPDIR", "TZ"];

export const ACCEPTANCE_ENCRYPTION_KEY = "acceptance-only-encryption-key-not-used-in-production";

export function createAcceptanceServerEnvironment(hostEnvironment, overrides) {
  const environment = {};
  for (const key of HOST_ENVIRONMENT_KEYS) {
    if (hostEnvironment[key] !== undefined) environment[key] = hostEnvironment[key];
  }
  return { ...environment, ...overrides };
}
