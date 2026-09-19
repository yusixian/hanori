import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, expect, test, vi } from "vitest";
import { useCanManageBot } from "./use-can-manage-bot";

function Harness() {
  const canManage = useCanManageBot();
  return <p>{canManage ? "allowed" : "blocked"}</p>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test.each(["owner", "admin"])("allows the %s role after membership loads", async (role) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: { member: { role } } })),
  );
  render(<Harness />);
  await expect.element(page.getByText("allowed")).toBeVisible();
});

test.each(["editor", "viewer"])("keeps the %s role blocked", async (role) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: { member: { role } } })),
  );
  render(<Harness />);
  await expect.element(page.getByText("blocked")).toBeVisible();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await expect.element(page.getByText("blocked")).toBeVisible();
});

test("fails closed while membership is unresolved or unavailable", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        await new Promise<Response>((_resolve, reject) => {
          window.setTimeout(() => reject(new Error("offline")), 20);
        }),
    ),
  );
  render(<Harness />);
  await expect.element(page.getByText("blocked")).toBeVisible();
  await new Promise((resolve) => window.setTimeout(resolve, 30));
  await expect.element(page.getByText("blocked")).toBeVisible();
});
