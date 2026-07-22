import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("coding worker Compose isolation", () => {
  it("mounts only hard-bounded staging/control volumes on an internal network", async () => {
    const compose = await readFile(path.resolve(process.cwd(), "docker-compose.yml"), "utf8");
    const app = compose.slice(compose.indexOf("  app:"), compose.indexOf("  coding-egress-proxy:"));
    const worker = compose.slice(
      compose.indexOf("  coding-worker:"),
      compose.indexOf("  nsfw-api:"),
    );
    const volumesStart = compose.lastIndexOf("\nvolumes:\n");
    const networksStart = compose.lastIndexOf("\nnetworks:\n");
    const volumes = compose.slice(volumesStart, networksStart);
    const networks = compose.slice(networksStart);

    expect(worker).not.toContain("codeworkspaces");
    expect(worker).not.toContain("codegit");
    expect(worker).toContain("codingjob:/job");
    expect(worker).toContain("codingcontrol:/coding-control");
    expect(worker).toContain("CODING_WORKER_SOCKET=/coding-control/worker.sock");
    expect(worker).toContain("CODING_REQUIRE_PROXY=1");
    expect(worker).toContain("HTTP_PROXY=http://coding-egress-proxy:3128");
    expect(worker).toContain("- coding-sandbox");
    expect(worker).not.toContain("- coding-egress");
    expect(worker).toContain("restart: always");
    expect(worker).toContain("pids_limit: 128");
    expect(worker).toContain("cap_drop:\n      - ALL");
    expect(worker).toContain(
      "cap_add:\n      - CHOWN\n      - DAC_OVERRIDE\n      - SETGID\n      - SETUID",
    );
    expect(worker).not.toContain("init: true");
    expect(app).not.toContain("chown -R 1000:1000 /coding-job /coding-control");
    expect(volumes).toContain('o: "size=1073741824,uid=0,gid=0,mode=0711"');
    expect(volumes).toContain('o: "size=1048576,uid=0,gid=1000,mode=0770"');
    expect(networks).toContain("coding-sandbox:");
    expect(networks).toContain("internal: true");
  });

  it("scrubs the worker secret before the image-owned init starts", async () => {
    const [dockerfile, entrypoint] = await Promise.all([
      readFile(path.resolve(process.cwd(), "Dockerfile"), "utf8"),
      readFile(path.resolve(process.cwd(), "infrastructure/coding-worker/entrypoint.sh"), "utf8"),
    ]);
    const workerImage = dockerfile.slice(
      dockerfile.indexOf("FROM base AS coding-worker"),
      dockerfile.indexOf("FROM runner AS app"),
    );

    expect(workerImage).toContain("apk add --no-cache bash git ripgrep su-exec tini");
    expect(workerImage).toContain(
      "COPY --chmod=755 infrastructure/coding-worker/entrypoint.sh /usr/local/bin/coding-worker-entrypoint",
    );
    expect(workerImage).toContain('ENTRYPOINT ["/usr/local/bin/coding-worker-entrypoint"]');
    expect(workerImage).not.toContain("USER node");

    const writeSecret = entrypoint.indexOf(`printf "%s" "$CODING_WORKER_SECRET"`);
    const scrubAndExec = entrypoint.indexOf(
      'exec env -u CODING_WORKER_SECRET su-exec node:node tini -g -- "$@"',
    );
    expect(writeSecret).toBeGreaterThan(-1);
    expect(scrubAndExec).toBeGreaterThan(writeSecret);
    expect(entrypoint).toContain('chown root:root "$job_root"');
    expect(entrypoint).toContain('chmod 0711 "$job_root"');
    expect(entrypoint).toContain(
      'find "$control_root" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
    );
    expect(entrypoint).toContain('chown root:node "$control_root"');
    expect(entrypoint).toContain('chmod 0770 "$control_root"');
  });

  it("routes the internal worker network through a public-only HTTP proxy", async () => {
    const compose = await readFile(path.resolve(process.cwd(), "docker-compose.yml"), "utf8");
    const proxy = compose.slice(
      compose.indexOf("  coding-egress-proxy:"),
      compose.indexOf("  coding-worker:"),
    );
    expect(proxy).toContain("target: coding-egress-proxy");
    expect(proxy).toContain("- coding-sandbox");
    expect(proxy).toContain("- coding-egress");

    const squid = await readFile(
      path.resolve(process.cwd(), "infrastructure/coding-egress-proxy/squid.conf"),
      "utf8",
    );
    for (const denied of [
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "224.0.0.0/4",
      "fc00::/7",
      "fe80::/10",
      "ff00::/8",
    ]) {
      expect(squid).toContain(`acl blocked_destination dst ${denied}`);
    }
    expect(squid).toContain("http_access deny blocked_destination");
    expect(squid).toContain("http_access deny !Allowed_protocols !CONNECT");
    expect(squid).toContain("http_access deny !Safe_ports");
    expect(squid).toContain("http_access deny CONNECT !SSL_ports");
  });
});
