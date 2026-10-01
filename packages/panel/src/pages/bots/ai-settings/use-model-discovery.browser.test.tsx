import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useModelDiscovery } from "./use-model-discovery";

type Input = Parameters<typeof useModelDiscovery>[0];
const providers: Input["providers"] = ["one", "two"].map((id) => ({
  id,
  label: id,
  hasApiKey: true,
  baseURL: `https://${id}.example/v1`,
  providerFormat: "openai",
  defaultModel: "existing",
  models: [{ id: "existing" }],
}));

function Harness(props: Input) {
  const discovery = useModelDiscovery(props);
  return (
    <>
      <output aria-label="Pending">{discovery.fetching.size}</output>
      <output aria-label="Errors">{JSON.stringify(discovery.errors)}</output>
      <button onClick={() => void discovery.refresh("one")}>Refresh</button>
    </>
  );
}

async function setup(overrides: Partial<Input> = {}) {
  const props: Input = {
    botId: "bot",
    enabled: true,
    providers,
    apiKeys: {},
    onDiscover: vi.fn(),
    ...overrides,
  };
  return { props, view: await render(<Harness {...props} />) };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

test("refreshes all providers on each entry, with draft credentials and explicit provider IDs", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ ok: true, data: [{ id: "new", capabilities: [] }] }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { props, view } = await setup({ apiKeys: { one: "draft-key" } });
  await expect.poll(() => props.onDiscover).toHaveBeenCalledTimes(2);
  const calls = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(calls).toEqual([
    {
      providerId: "one",
      baseURL: "https://one.example/v1",
      apiKey: "draft-key",
      modelDiscoveryPath: "/models",
    },
    { providerId: "two", baseURL: "https://two.example/v1", modelDiscoveryPath: "/models" },
  ]);
  await view.rerender(<Harness {...props} providers={[...providers]} />);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await view.rerender(<Harness {...props} enabled={false} />);
  await view.rerender(<Harness {...props} />);
  await expect.poll(() => props.onDiscover).toHaveBeenCalledTimes(4);
});

test("keeps provider failures independent and formats structured API errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { providerId } = JSON.parse(String(init?.body));
      return providerId === "one"
        ? Response.json(
            {
              ok: false,
              error: { issues: [{ path: ["modelDiscoveryPath"], message: "Invalid path" }] },
            },
            { status: 400 },
          )
        : Response.json({ ok: true, data: [{ id: "new", capabilities: [] }] });
    }),
  );
  const { props } = await setup();
  await expect.element(page.getByLabelText("Pending")).toHaveTextContent("0");
  await expect
    .element(page.getByLabelText("Errors"))
    .toHaveTextContent("modelDiscoveryPath: Invalid path");
  expect(props.onDiscover).toHaveBeenCalledExactlyOnceWith("two", [
    { id: "new", capabilities: [] },
  ]);
});

test("skips providers without a discovery path or credentials", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await setup({
    providers: [
      { ...providers[0]!, modelDiscoveryPath: "" },
      { ...providers[1]!, hasApiKey: false },
    ],
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each(["bot", "connection", "disabled", "unmount"])(
  "ignores stale discovery after %s changes",
  async (change) => {
    const responses: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => responses.push(resolve))),
    );
    const { props, view } = await setup({ providers: [providers[0]!] });
    if (change === "unmount") await view.unmount();
    else
      await view.rerender(
        <Harness
          {...props}
          botId={change === "bot" ? "other-bot" : props.botId}
          enabled={change !== "disabled"}
          providers={
            change === "connection"
              ? [{ ...providers[0]!, baseURL: "https://changed.example/v1" }]
              : props.providers
          }
        />,
      );
    responses[0]!(Response.json({ ok: true, data: [{ id: "stale", capabilities: [] }] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(props.onDiscover).not.toHaveBeenCalled();
  },
);

test("manual refresh retries a failed provider", async () => {
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new Error("Temporary failure"))
    .mockResolvedValueOnce(Response.json({ ok: true, data: [{ id: "recovered" }] }));
  vi.stubGlobal("fetch", fetchMock);
  const { props } = await setup({ providers: [providers[0]!] });
  await expect.element(page.getByLabelText("Errors")).toHaveTextContent("Temporary failure");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => props.onDiscover).toHaveBeenCalledWith("one", [{ id: "recovered" }]);
  await expect.element(page.getByLabelText("Errors")).toHaveTextContent("{}");
});
