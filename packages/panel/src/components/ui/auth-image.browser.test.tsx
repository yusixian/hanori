import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import { AuthImage } from "./auth-image";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("uses the error fallback when a successful response cannot be decoded", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    ),
  );
  const onError = vi.fn();
  const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");

  render(
    <AuthImage
      src="/broken-avatar.jpg"
      alt="Broken avatar"
      errorFallback={<div role="status">Avatar unavailable</div>}
      onError={onError}
    />,
  );

  await expect.element(page.getByRole("status")).toHaveTextContent("Avatar unavailable");
  expect(onError).toHaveBeenCalledOnce();
  expect(revokeObjectUrl).toHaveBeenCalledOnce();
});
