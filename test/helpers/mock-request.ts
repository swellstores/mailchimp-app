import { env } from "cloudflare:test";
import { createSwellClient } from "./swell-client";

/**
 * A stand-in for the `SwellRequest` the platform hands a function.
 *
 * Two behaviours here are load-bearing and deliberately not "convenient":
 *
 *  1. Un-stubbed `swell.*` methods THROW a self-documenting error instead of returning
 *     `undefined`. A silently-undefined `swell.get()` produces a test that passes for
 *     the wrong reason, or a failure ten frames away from its cause.
 *
 *  2. `appValues()` reproduces the real implementation's validation, including its
 *     plain-object check. That is what makes the single-writer regression test
 *     (see `test/unit/single-writer.test.ts`) meaningful rather than decorative.
 */
export interface MockRequestOptions {
  data?: SwellData;
  query?: { [key: string]: string };
  session?: { [key: string]: any };
  headers?: Record<string, string>;
  method?: string;
  url?: string;
  /** Partial stub. Any method you leave out throws rather than returning undefined. */
  swell?: Partial<SwellAPI>;
  store?: Partial<SwellStore>;
  appId?: string;
  /** Swap the stub for the real admin-API client. Integration tests only. */
  useRealSwell?: boolean;
  /**
   * Raw bytes for BOTH `req.rawBody` and `req.originalRequest`, independent of the parsed
   * `data`. The two are filled from the same expression, so a test can never end up
   * verifying a signature over one body while the handler reads the other.
   *
   * Needed by any handler that reads the unparsed body — Mailchimp posts webhooks as
   * `application/x-www-form-urlencoded`, and its signature is computed over the exact
   * bytes, so re-encoding a parsed object cannot reproduce it. Without this option the
   * mock can only ever present JSON, and a form-body parser is untestable.
   *
   * Set `data` as well when the handler also reads `req.data`; the two are deliberately
   * independent so a test can pin what happens when they disagree.
   */
  rawBody?: string;
}

/**
 * Every method fails loudly and tells you exactly how to fix the call site. Without
 * this, a forgotten stub returns `undefined` and the failure surfaces somewhere else
 * entirely — usually as `Cannot read properties of undefined`.
 */
function createDefaultSwellMock(): Partial<SwellAPI> {
  const notMocked = (method: string) => () => {
    throw new Error(
      `swell.${method}() not mocked. Pass { swell: { ${method}: vi.fn() } } to createMockRequest().`,
    );
  };
  return {
    get: notMocked("get"),
    post: notMocked("post"),
    put: notMocked("put"),
    delete: notMocked("delete"),
    settings: notMocked("settings"),
  };
}

export function createMockRequest(
  options: MockRequestOptions = {},
): SwellRequest {
  const {
    data = {},
    query = {},
    session = {},
    headers = {},
    method = "POST",
    url = "https://example.com/test",
    swell,
    store,
    appId,
    useRealSwell = false,
    rawBody,
  } = options;

  const requestHeaders = new Headers(headers);
  const originalRequest = new Request(url, {
    method,
    headers: requestHeaders,
    body:
      method === "GET"
        ? undefined
        : rawBody !== undefined
          ? rawBody
          : JSON.stringify(data),
  });

  const storeId = store?.id || env.SWELL_STORE_ID || "test-store";

  const resolvedStore = {
    id: storeId,
    url: store?.url || "",
    admin_url: store?.admin_url || "",
  };

  const context = {
    // Real `waitUntil` is fire-and-forget; awaiting it here keeps tests deterministic.
    waitUntil: async (promise: Promise<unknown>) => {
      await promise;
    },
  };

  const swellClient =
    swell || (useRealSwell ? createSwellClient() : createDefaultSwellMock());

  const resolvedAppId = appId || env.SWELL_APP_ID || "mailchimp";

  const req: Partial<SwellRequest> & { appId: string; storeId: string } = {
    originalRequest,
    context,
    url,
    method,
    headers: requestHeaders,
    referrer: originalRequest.referrer,
    credentials: "include",
    appId: resolvedAppId,
    storeId,
    accessToken: null,
    publicKey: null,
    store: resolvedStore,
    session,
    apiHost: env.SWELL_API_BASE_URL || "",
    logParams: undefined,
    swell: swellClient as SwellAPI,
    body: data,
    data,
    query,

    /**
     * `req.rawBody` — the untouched body text.
     *
     * STARTER AMENDMENT (Wave 2, Slack). The mock exposed `originalRequest` but not
     * `rawBody`, even though `@swell/app-types` declares `rawBody: string` on
     * `SwellRequest`. `mailchimp-webhook.ts` used to hand-roll
     * `await req.originalRequest?.clone?.().text?.()` to get at the same bytes, which needed
     * three optional-chains to typecheck and re-read an already-consumed stream. It now
     * reads the typed field, so the mock has to present it.
     *
     * Mirrors the same `rawBody ?? JSON.stringify(data)` precedence the `originalRequest`
     * body above uses, so the two can never disagree about what arrived.
     */
    rawBody: rawBody !== undefined ? rawBody : JSON.stringify(data),
    initialize: async () => {},
    parseJson: (input: string) => JSON.parse(input),

    /**
     * Mirrors `SwellRejection`'s status clamping: only 4xx survives, everything else
     * becomes 422. Returns the error rather than throwing it, matching the platform.
     */
    reject: (
      code: string,
      message: string,
      options: { status?: number } = {},
    ) => {
      const status =
        typeof options.status === "number" &&
        options.status >= 400 &&
        options.status < 500
          ? options.status
          : 422;
      const error = new Error(
        message || "Request rejected by function",
      ) as Error & {
        body: { $reject: { code: string; message: string; status: number } };
        code: string;
        status: number;
      };
      error.name = "SwellRejection";
      error.code = code;
      error.status = status;
      error.body = {
        $reject: {
          code,
          message: error.message,
          status,
        },
      };
      return error;
    },

    /**
     * Wraps a patch so it can only land under `$app.<app_id>.*`. This is the mechanism
     * behind the single-writer invariant (INTEGRATION-PLAN §2.5): confining every write
     * to the app's own namespace is what stops the app's writes from re-triggering its
     * own `*.updated` handler.
     *
     * Both call shapes the platform accepts are supported:
     *   appValues(values)           → uses req.appId
     *   appValues(appId, values)    → explicit app id
     *
     * The validation is not defensive padding — it is copied from the real behaviour:
     * an array, a class instance, `null` or a primitive would produce a malformed patch
     * that the API rejects far from the call site, so it is caught here instead.
     */
    appValues: (idOrValues: string | SwellData, values?: SwellData) => {
      const targetAppId =
        typeof idOrValues === "string" ? idOrValues : resolvedAppId;
      const appValues = typeof idOrValues === "string" ? values : idOrValues;
      if (!targetAppId) {
        throw new Error("appValues: missing app id (req.appId is empty)");
      }
      if (
        typeof appValues !== "object" ||
        appValues === null ||
        Object.getPrototypeOf(appValues) !== Object.prototype
      ) {
        throw new Error(
          "appValues: values must be a plain object (arrays, class instances, null, and primitives are not allowed)",
        );
      }
      return {
        $app: {
          [targetAppId]: appValues,
        },
      };
    },
  };

  return req as SwellRequest;
}
