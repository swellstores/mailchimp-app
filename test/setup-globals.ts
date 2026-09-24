/**
 * Swell's function runtime injects three globals that do not exist in the Workers test
 * isolate. Vitest loads this file via `setupFiles` so functions under test can use them.
 *
 * ---------------------------------------------------------------------------------
 * READ THIS BEFORE DELETING ANYTHING HERE — especially `SwellResponse`.
 *
 * `swell create tests` scaffolds a setup file that defines `SwellError` and
 * `SwellRejection` but *omits* `SwellResponse`. That omission is silent until a route
 * function returns one, at which point the test dies with:
 *
 *     ReferenceError: SwellResponse is not defined
 *
 * ...pointing at your function rather than at the missing global, which sends you
 * hunting through the wrong file. Every app with a public route function
 * (webhooks, adapters, storefront endpoints) hits this. Defining `SwellResponse`
 * below is the single most important thing this file does.
 * ---------------------------------------------------------------------------------
 *
 * Semantics below mirror the platform's observed behaviour, not a published contract.
 * If the runtime changes, this file is where the fleet gets corrected.
 */

/**
 * Thrown by handlers to signal a failure. `status` drives the HTTP response for route
 * functions; `retry` drives redelivery of model events.
 *
 * An object message is stringified into `.message` for readable assertions *and* kept
 * verbatim on `.body`, so a test can match either the text or the structure.
 *
 * ---------------------------------------------------------------------------------
 * STARTER AMENDMENT (Wave 2): `retry` IS MODELLED. It used to be dropped on the floor here
 * with a comment saying the platform reads it — which made the single most consequential
 * decision in the whole error model untestable through the global.
 *
 * The retry decision is the entire reason §2.6 layer 3 (`throwIfFailed`) exists. Getting it
 * backwards is silent in both directions: `retry: true` on a permanently bad payload loops
 * until the platform auto-disables the function after ~4 days of continuous failure, and
 * `retry: false` on a transient Mailchimp outage drops the event for good. Neither shows up
 * as an error anywhere. So `throwIfFailed` needs to be assertable:
 *
 *     expect(() => throwIfFailed(result)).toThrow();
 *     try { throwIfFailed(result); } catch (err) {
 *       expect(err).toMatchObject({ status: 502, retry: false });
 *     }
 *
 * The value is kept EXACTLY as passed, including `undefined`. No default is invented: what
 * the platform does with an omitted `retry` has not been measured on this store, and a
 * fabricated default here would have every app's tests agreeing with a guess.
 * ---------------------------------------------------------------------------------
 */
class SwellErrorImpl extends Error {
  status: number;
  /** Verbatim, including `undefined` when the caller omitted it. See the header. */
  retry?: boolean;
  body?: unknown;

  constructor(
    message: string | object,
    options: { status?: number; retry?: boolean } = {},
  ) {
    const text =
      typeof message === "string" ? message : JSON.stringify(message, null, 2);

    super(text);
    this.name = "SwellError";
    // The platform defaults an unclassified failure to 500.
    this.status = options.status ?? 500;
    this.retry = options.retry;
    this.body = typeof message === "string" ? undefined : message;
  }
}

/**
 * Thrown to reject an inbound request with a client error. The platform only honours
 * 4xx here — anything else (including 5xx and 2xx) is clamped to 422, so a handler
 * cannot accidentally turn a rejection into a server error the platform would retry.
 *
 * `.body.$reject` is the wire shape the caller actually receives; assert against it
 * rather than against `.message` when testing a route's contract.
 */
class SwellRejectionImpl extends Error {
  status: number;
  code: string;
  body: {
    $reject: {
      code: string;
      message: string;
      status: number;
    };
  };

  constructor(code: string, message: string, options: { status?: number } = {}) {
    const status =
      typeof options.status === "number" &&
      options.status >= 400 &&
      options.status < 500
        ? options.status
        : 422;

    super(message || "Request rejected by function");
    this.name = "SwellRejection";
    this.status = status;
    this.code = code;
    this.body = {
      $reject: {
        code,
        message: this.message,
        status,
      },
    };
  }
}

/**
 * The return value of a public route function. It is a real `Response`, so tests can
 * `await res.json()` / `res.status` / `res.headers.get(...)` exactly as the caller would.
 *
 * Convenience the platform provides and the base `Response` does not: an object body is
 * JSON-stringified and given `content-type: application/json` unless the caller set one.
 */
class SwellResponseImpl extends Response {
  constructor(data: string | object | undefined, options: ResponseInit = {}) {
    const isObject = typeof data === "object" && data !== null;
    const headers = new Headers(options.headers);
    if (isObject && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const body =
      data === undefined ? null : isObject ? JSON.stringify(data) : String(data);

    super(body, { ...options, headers });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).SwellError = SwellErrorImpl;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).SwellRejection = SwellRejectionImpl;
// The one the CLI scaffold forgets. See the header comment.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).SwellResponse = SwellResponseImpl;

export {};
