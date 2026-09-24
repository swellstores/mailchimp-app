import { vi, type Mock } from "vitest";

/**
 * Typed `fetch` stubbing for the network-level vendor-API pattern.
 *
 * ---------------------------------------------------------------------------------
 * WHY THIS EXISTS — STARTER AMENDMENT (Wave 2).
 *
 * The obvious spelling does not typecheck:
 *
 *     const fetchMock = vi.fn(async () => jsonResponse(200, {}));
 *     vi.stubGlobal("fetch", fetchMock);
 *     const [url, init] = fetchMock.mock.calls[0];   // ERROR
 *
 * `vi.fn` infers the mock's parameter list from the implementation, and an implementation
 * that ignores its arguments has NO parameters — so `mock.calls` is typed `[][]`, an array
 * of empty tuples. Destructuring it, indexing `calls[0][1]`, reading `init.headers`: all
 * type errors, none of which show up when running vitest, and all of which fail
 * `tsc --build test`. This cost multiple agents a full typecheck round each, and the usual
 * "fix" is a cast that then hides real shape errors:
 *
 *     const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
 *
 * The fix is to declare the signature rather than infer it. `stubFetch` does that once, and
 * `fetchCall` gives back the parsed request so no assertion needs a cast at all.
 *
 * The same trap applies to object-level Swell stubs — `vi.fn(async () => ({}))` produces the
 * same empty-tuple `mock.calls`. Two ways out, both fine: annotate the implementation's
 * parameters (`vi.fn(async (_url: string, _body: Record<string, any>) => ({}))`), which is
 * what `test/unit/single-writer.test.ts` does, or use `mockFn<T>()` at the bottom of this
 * file when there is no implementation to annotate.
 * ---------------------------------------------------------------------------------
 */

/** The signature the Workers runtime's `fetch` actually has. */
export type FetchSignature = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type FetchStub = Mock<FetchSignature>;

/** What a test hands `stubFetch`: a responder, a fixed response, or a queue of them. */
export type FetchResponder =
  | ((input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>)
  | Response
  | Response[];

/**
 * Installs a typed `fetch` stub on the shared Workers global and returns it.
 *
 *     const fetchMock = stubFetch(jsonResponse(200, { id: "remote_1" }));
 *     await client.push(record);
 *     expect(fetchCall(fetchMock).url).toContain("/records/remote_1");
 *
 * Three input shapes, because all three come up constantly:
 *
 *   - a `Response`  — every call answers with it. Note a `Response` body can only be read
 *     once, so it is cloned per call rather than handed out repeatedly.
 *   - a `Response[]` — answered in order, one per call. This is the retry/rate-limit case:
 *     `stubFetch([jsonResponse(429, {}, { "Retry-After": "1" }), jsonResponse(200, {})])`.
 *     Running past the end throws rather than replaying the last one, so an extra call is
 *     a loud failure instead of a silently passing test.
 *   - a function — for anything conditional on URL or body.
 *
 * REMEMBER THE CLEANUP. `vitest.config.ts` sets `singleWorker: true`, so every test file
 * shares one runtime and a stub left installed leaks into `test/integration/*`, where it
 * would answer the real admin API. Every file that calls this needs:
 *
 *     afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
 */
export function stubFetch(responder: FetchResponder = jsonOk()): FetchStub {
  let index = 0;

  const implementation: FetchSignature = async (input, init) => {
    if (Array.isArray(responder)) {
      const response = responder[index];
      if (!response) {
        throw new Error(
          `stubFetch: call ${index + 1} has no queued response (${responder.length} queued). ` +
            "Queue another, or assert on the call count that surprised you.",
        );
      }
      index += 1;
      return response;
    }
    if (typeof responder === "function") {
      return responder(input, init);
    }
    // Cloned so a fixed Response can answer more than one call: a body is single-use.
    return responder.clone();
  };

  const stub = vi.fn<FetchSignature>(implementation);
  vi.stubGlobal("fetch", stub);
  return stub;
}

/** A plain 200 with an empty JSON object, the default when a test does not care. */
export function jsonOk(): Response {
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** One outbound request, parsed. Nothing here needs a cast at the call site. */
export interface FetchCall {
  /** The request URL as a string, whatever shape it was passed in. */
  url: string;
  /** Upper-case, defaulting to GET the way `fetch` itself does. */
  method: string;
  /** Header names lower-cased, so a test never has to guess the casing the client used. */
  headers: Record<string, string>;
  /** The request body as text, or `""` when there was none. */
  body: string;
  /** The raw init, for the rare assertion these accessors do not cover. */
  init: RequestInit;
  /** The body parsed as JSON. Throws with the offending text when it is not JSON. */
  json<T = any>(): T;
}

/**
 * The nth outbound request (default: the first), parsed.
 *
 * Fails with the call count rather than `undefined is not an object` when the call was never
 * made, which is the difference between a one-line fix and ten minutes of bisecting.
 */
export function fetchCall(stub: FetchStub, index = 0): FetchCall {
  const call = stub.mock.calls[index];
  if (!call) {
    throw new Error(
      `fetchCall: no call at index ${index}; fetch was called ${stub.mock.calls.length} time(s).`,
    );
  }

  const [input, init = {}] = call;
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  const headers: Record<string, string> = {};
  new Headers(init.headers as HeadersInit | undefined).forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const body = typeof init.body === "string" ? init.body : init.body ? String(init.body) : "";

  return {
    url,
    method: (init.method ?? "GET").toUpperCase(),
    headers,
    body,
    init,
    json<T = any>(): T {
      try {
        return JSON.parse(body) as T;
      } catch {
        throw new Error(`fetchCall(${index}).json(): body is not JSON: ${body.slice(0, 200)}`);
      }
    },
  };
}

/** Every outbound request, parsed. Handy for asserting a batch went out in order. */
export function fetchCalls(stub: FetchStub): FetchCall[] {
  return stub.mock.calls.map((_, index) => fetchCall(stub, index));
}

/**
 * A typed `vi.fn()` for object-level stubs, where there is no implementation whose
 * parameters could be annotated:
 *
 *     const put = mockFn<(url: string, body: Record<string, any>) => Promise<any>>();
 *     const req = createMockRequest({ swell: { put } });
 *     ...
 *     expect(put.mock.calls[0][1]).toEqual({ $app: { ... } });   // typechecks
 *
 * Without the explicit type argument, `vi.fn()` types `mock.calls` as `[][]` and every
 * argument assertion is a compile error.
 */
export function mockFn<T extends (...args: any[]) => any>(implementation?: T): Mock<T> {
  return implementation ? vi.fn<T>(implementation) : vi.fn<T>();
}
