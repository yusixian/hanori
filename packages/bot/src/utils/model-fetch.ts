import { Agent, Dispatcher1Wrapper } from "undici";

let modelDispatcher: Dispatcher1Wrapper | undefined;

function getModelDispatcher(): Dispatcher1Wrapper {
  // Node's bundled fetch uses the legacy dispatcher contract and may supply its
  // own five-minute parser deadlines, overriding the Agent's defaults.
  return (modelDispatcher ??= new Dispatcher1Wrapper(
    new Agent().compose(
      (dispatch) => (options, handler) =>
        dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler),
    ),
  ));
}

/** Let the caller's model deadline govern requests, including quiet reasoning streams. */
export function createModelFetch(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init) => {
    // Requests without a caller-owned deadline retain the normal HTTP limits.
    if (!init?.signal) return fetchImpl(input, init);
    const request = {
      ...init,
      dispatcher: getModelDispatcher(),
    };
    // Dispatcher1Wrapper bridges Undici 8 to Node's older native fetch contract;
    // RequestInit may describe that older dispatcher or omit the Node extension.
    return fetchImpl(input, request as unknown as RequestInit);
  };
}
