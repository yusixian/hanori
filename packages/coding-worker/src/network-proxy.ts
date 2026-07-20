import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

export function configureWorkerProxy(
  environment: NodeJS.ProcessEnv = process.env,
): EnvHttpProxyAgent | undefined {
  const httpProxy = environment["HTTP_PROXY"] ?? environment["http_proxy"];
  const httpsProxy = environment["HTTPS_PROXY"] ?? environment["https_proxy"];
  const required = environment["CODING_REQUIRE_PROXY"] === "1";
  if (!httpProxy && !httpsProxy) {
    if (required) throw new Error("Coding worker proxy is required but not configured");
    return undefined;
  }
  if (!httpProxy || !httpsProxy) {
    throw new Error("Both HTTP_PROXY and HTTPS_PROXY are required for the coding worker");
  }
  const agent = new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: "" });
  setGlobalDispatcher(agent);
  return agent;
}
