import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import "@/style.css";
import { BotGenerationLibraryPage } from "./generation-library";

const character = {
  id: 1,
  botId: "test-id",
  source: "original",
  canonicalTag: null,
  postCount: null,
  wikiSummary: null,
  sourceUrl: null,
  sourceFetchedAt: null,
  queryCount: 2,
  firstQueriedAt: null,
  lastQueriedAt: null,
  name: "Mira",
  aliases: ["mira oc"],
  appearance: "silver hair, amber eyes",
  defaultOutfit: "blue coat",
  notes: "fixture",
  copyright: null,
  ownerTelegramId: 42,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  bindingCount: 1,
};

const asset = {
  id: 2,
  botId: "test-id",
  name: "Soft light",
  type: "style",
  content: "soft cinematic lighting",
  notes: "fixture",
  safety: "safe",
  pinned: true,
  useCount: 3,
  lastUsedAt: "2026-09-20T00:00:00.000Z",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
};

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/bots/test-id/generation-library"]}>
      <Routes>
        <Route path="/bots/:botId/generation-library" element={<BotGenerationLibraryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("shows characters and prompt assets with owner controls for an administrator", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/authz/me")) {
      return new Response(JSON.stringify({ data: { member: { role: "owner" } } }), { status: 200 });
    }
    if (url.includes("/generation-library/settings")) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            charactersEnabled: true,
            assetsEnabled: true,
            injectionEnabled: false,
            nsfwEnabled: false,
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/generation-library/characters")) {
      return new Response(JSON.stringify({ ok: true, data: [character], total: 1 }), {
        status: 200,
      });
    }
    if (url.includes("/generation-library/assets")) {
      return new Response(JSON.stringify({ ok: true, data: [asset], total: 1 }), { status: 200 });
    }
    if (url.includes("/profiles")) {
      return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);

  renderPage();

  await expect.element(page.getByRole("heading", { name: "Generation library" })).toBeVisible();
  await expect.element(page.getByText("Mira", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Add original character" })).toBeVisible();

  await page.getByRole("tab", { name: "Prompt assets" }).click();
  await expect.element(page.getByText("Soft light", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Pinned", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Add prompt asset" })).toBeVisible();
});

test("keeps the library read-only for viewers", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/authz/me")) {
      return new Response(JSON.stringify({ data: { member: { role: "viewer" } } }), {
        status: 200,
      });
    }
    if (url.includes("/generation-library/settings")) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            charactersEnabled: true,
            assetsEnabled: true,
            injectionEnabled: false,
            nsfwEnabled: false,
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/generation-library/characters")) {
      return new Response(JSON.stringify({ ok: true, data: [], total: 0 }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);

  renderPage();

  await expect
    .element(page.getByText("Your workspace role can view this library but cannot change it."))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Add original character" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("switch", { name: "Automatic injection" }))
    .toHaveAttribute("disabled");
});

test("locks form-switching controls while a character save is pending", async () => {
  let resolveSave!: (response: Response) => void;
  const saveResponse = new Promise<Response>((resolve) => {
    resolveSave = resolve;
  });
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/api/authz/me")) {
        return new Response(JSON.stringify({ data: { member: { role: "owner" } } }), {
          status: 200,
        });
      }
      if (url.includes("/generation-library/settings")) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              charactersEnabled: true,
              assetsEnabled: true,
              injectionEnabled: false,
              nsfwEnabled: false,
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/generation-library/characters") && init?.method === "POST") {
        return saveResponse;
      }
      if (url.includes("/generation-library/characters")) {
        return new Response(JSON.stringify({ ok: true, data: [character], total: 1 }), {
          status: 200,
        });
      }
      if (url.includes("/generation-library/assets")) {
        return new Response(JSON.stringify({ ok: true, data: [asset], total: 1 }), { status: 200 });
      }
      if (url.includes("/profiles")) {
        return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  renderPage();
  await expect.element(page.getByText("Mira", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add original character" }).click();
  await page.getByLabelText("Name *", { exact: true }).fill("Pending character");
  await page.getByLabelText("Appearance *", { exact: true }).fill("pending appearance");
  await page
    .getByLabelText("Characters", { exact: true })
    .getByRole("button", { name: "Save", exact: true })
    .click();

  await vi.waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([input, requestInit]) =>
          String(input).endsWith("/generation-library/characters") &&
          requestInit?.method === "POST",
      ),
    ).toBe(true),
  );
  await expect
    .element(page.getByRole("button", { name: "Add original character" }))
    .toHaveAttribute("disabled");
  await expect
    .element(page.getByRole("button", { name: "Edit original character" }))
    .toHaveAttribute("disabled");
  await expect
    .element(page.getByRole("button", { name: "Cancel", exact: true }))
    .toHaveAttribute("disabled");

  await page.getByRole("tab", { name: "Prompt assets" }).click();
  await expect.element(page.getByText("Soft light", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Add prompt asset" }))
    .toHaveAttribute("disabled");
  await expect
    .element(page.getByRole("button", { name: "Edit prompt asset" }))
    .toHaveAttribute("disabled");

  resolveSave(new Response(JSON.stringify({ ok: true, data: character }), { status: 200 }));
  await expect
    .element(page.getByRole("button", { name: "Add prompt asset" }))
    .not.toHaveAttribute("disabled");
});
