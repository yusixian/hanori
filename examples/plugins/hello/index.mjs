const catalogue = [
  {
    id: "synthetic",
    title: "Synthetic catalogue",
    summary: "This example searches fixed demonstration text without external requests.",
    content:
      "Synthetic catalogue. All entries are demonstration text packaged with the plugin. No account, API key or network request is needed.",
  },
  {
    id: "sessions",
    title: "Turn-local sessions",
    summary: "Each createSession call owns its state and cancellation signal.",
    content:
      "Turn-local sessions. Keep references and caches inside createSession. Honor both the session signal and each operation signal, and release resources in dispose.",
  },
  {
    id: "read_only",
    title: "Read-only tools",
    summary: "Arguments still need validation when a tool has a JSON Schema.",
    content:
      "Read-only tools. The greeting tool returns text without changing data. Its execute function validates the name and rejects unknown fields. Search also performs no writes.",
  },
];

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export default {
  apiVersion: 1,
  createSession(context) {
    const greeting = context.configuration.greeting ?? "Hello";
    if (typeof greeting !== "string" || !greeting.trim() || greeting.length > 120)
      throw new Error("invalid_configuration");
    const stop = new AbortController();
    const sessionSignal = AbortSignal.any([context.signal, stop.signal]);
    const check = (signal) => {
      if (sessionSignal.aborted || signal.aborted) throw new Error("plugin_stopped");
    };
    check(sessionSignal);
    return {
      tools: [
        {
          name: "greet",
          description:
            "Return a short synthetic greeting. This tool makes no external request and changes no data.",
          effect: "read_only",
          access: "all",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string", minLength: 1, maxLength: 80 } },
            required: ["name"],
            additionalProperties: false,
          },
          async execute(input, signal) {
            check(signal);
            if (
              !record(input) ||
              Object.keys(input).some((key) => key !== "name") ||
              typeof input.name !== "string" ||
              !input.name.trim() ||
              input.name.length > 80
            )
              return { status: "invalid_request", error: "invalid_arguments" };
            return { status: "ok", text: `${greeting.trim()}, ${input.name.trim()}!` };
          },
        },
      ],
      searchProviders: [
        {
          id: "catalogue",
          scope: "hello",
          description:
            "Search the example's fixed synthetic catalogue. No account or external search service is used.",
          pagination: "single_page",
          maxQueryLength: 200,
          allowEmptyQuery: false,
          async search(request, signal) {
            check(signal);
            if (
              !record(request) ||
              request.scope !== "hello" ||
              typeof request.query !== "string" ||
              !request.query.trim() ||
              request.query.length > 200 ||
              request.page !== 1 ||
              !Number.isSafeInteger(request.limit) ||
              request.limit < 1 ||
              request.limit > 20 ||
              (request.filters !== undefined &&
                (!record(request.filters) || Object.keys(request.filters).length > 0))
            )
              return { status: "invalid_request", items: [], hasMore: false };
            const needle = request.query.trim().normalize("NFC").toLowerCase();
            const matches = catalogue.filter((item) =>
              `${item.title} ${item.content}`.normalize("NFC").toLowerCase().includes(needle),
            );
            return {
              status: matches.length ? "ok" : "empty",
              items: matches
                .slice(0, request.limit)
                .map((item) => ({ ...item, source: "example.hello" })),
              hasMore: false,
              truncated: matches.length > request.limit,
            };
          },
        },
      ],
      dispose() {
        stop.abort();
      },
    };
  },
};
