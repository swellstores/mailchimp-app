import { env } from "cloudflare:test";

/**
 * The real Swell admin API, for integration tests only.
 *
 * Credentials arrive as Miniflare bindings resolved by `vitest.config.ts` — from
 * `SWELL_STORE_ID`/`SWELL_SESSION_ID` env vars, or from the local `swell login` session
 * in `~/.swell/config.json`. Nothing here reads the filesystem; the Workers isolate
 * cannot.
 *
 * Shape notes that cost debugging time once:
 *  - Admin data routes live under a `data/` prefix. It is added for you, so callers
 *    write `/orders` the way a function would.
 *  - Auth is `X-Session`, not a bearer token, and `Swell-Env` selects test vs live.
 *  - The API answers 200 with an `errors` payload for validation failures, so a bare
 *    `response.ok` check is not enough.
 *
 * ---------------------------------------------------------------------------------
 * A MISSING RECORD HAS THREE DIFFERENT ANSWERS. CALLERS MUST SURVIVE ALL THREE.
 *
 * STARTER AMENDMENT (Wave 2, Slack — measured, not read off a doc):
 *
 *   1. **Documented:** HTTP 400 with `code: "invalid_request"` and a "not found" message.
 *      Note 400, not 404, so a status check alone never fires.
 *   2. **`swell api get` on the CLI:** prints `Not found`.
 *   3. **This path — the admin API — answers 200 with an EMPTY BODY.** No error, no null
 *      envelope, no `{}`: zero bytes with a success status.
 *
 * `makeRequest` normalises the third into `null`, so callers see either a throw or a falsy
 * value. What it cannot do is collapse the first two, which is why every read of a record
 * that might not exist needs BOTH a try/catch AND a truthiness check:
 *
 *     let record: any = null;
 *     try { record = await swell.get(`/orders/${id}`); } catch { }
 *     if (!record?.id) return;   // covers the empty-200 and the plain-text body alike
 *
 * This is not defensive padding. A record created and deleted inside the event-delivery
 * window is a real race, and a handler that treats it as a hard failure will, repeated, get
 * its function auto-disabled by the platform after ~4 days of continuous failure.
 * ---------------------------------------------------------------------------------
 */

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

type BasicSwellClient = Pick<
  SwellAPI,
  "get" | "post" | "put" | "delete" | "settings"
>;

/**
 * Flattens a nested query object into the bracket notation the admin API expects:
 *   { where: { status: 'error' } }  → where[status]=error
 *   { expand: ['items.product'] }   → expand[]=items.product
 * Recursive, so `{ a: { b: { c: 1 } } }` becomes `a[b][c]=1`.
 */
function appendParam(
  params: URLSearchParams,
  prefix: string,
  value: unknown,
): void {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      appendParam(params, `${prefix}[]`, item);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as object)) {
      appendParam(params, `${prefix}[${key}]`, nested);
    }
    return;
  }

  params.append(prefix, String(value));
}

async function makeRequest(
  method: HttpMethod,
  url: string,
  data?: any,
): Promise<any> {
  const baseUrl = env.SWELL_API_BASE_URL || "https://api.swell.store";
  const sessionId = env.SWELL_SESSION_ID;
  const environment = env.SWELL_ENVIRONMENT || "test";

  if (!sessionId) {
    throw new Error(
      "Missing SWELL_SESSION_ID binding. Run `swell login` or set it explicitly for tests.",
    );
  }

  let endpointUrl = String(url).startsWith("/") ? url.substring(1) : String(url);
  if (!endpointUrl.startsWith("data/")) {
    endpointUrl = `data/${endpointUrl}`;
  }

  let fullUrl = `${baseUrl}/${endpointUrl}`;
  const headers: HeadersInit = {
    "Content-Type": "application/json;charset=UTF-8",
    "User-Agent": "swell-app-tests/1.0",
    "X-Session": sessionId,
    "Swell-Env": environment,
  };

  const options: RequestInit = {
    method,
    headers,
  };

  if (data) {
    if (method === "GET") {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(data)) {
        appendParam(params, key, value);
      }
      const query = params.toString();
      if (query) {
        fullUrl += `?${query}`;
      }
    } else {
      options.body = JSON.stringify(data);
    }
  }

  const response = await fetch(fullUrl, options);
  const text = await response.text();

  let result: any;
  try {
    // An empty (or whitespace-only) 200 is how this path reports a missing record — see the
    // three-answers note in the header. Normalised to `null` so a caller's truthiness check
    // is enough; `JSON.parse("")` would otherwise throw and be misreported as a text body.
    result = text.trim() ? JSON.parse(text) : null;
  } catch {
    // A non-JSON 200 body, which is the CLI's `Not found` shape. Returned verbatim rather
    // than nulled: it is truthy, so callers checking `record?.id` still treat it as missing,
    // and anything genuinely unexpected stays visible in the failure message.
    result = text;
  }

  if (!response.ok) {
    throw new (globalThis as any).SwellError(result || text || "Request failed", {
      status: response.status,
    });
  }

  // Validation failures come back 200 with an `errors` map, so this check is not
  // redundant with the one above.
  if (result?.errors) {
    throw new (globalThis as any).SwellError(result.errors, {
      status: 400,
    });
  }

  return result;
}

export function createSwellClient(): BasicSwellClient {
  return {
    get(url: string, query?: any) {
      return makeRequest("GET", url, query);
    },
    post(url: string, data?: any) {
      return makeRequest("POST", url, data);
    },
    put(url: string, data?: any) {
      return makeRequest("PUT", url, data);
    },
    delete(url: string, data?: any) {
      return makeRequest("DELETE", url, data);
    },
    settings(id?: string) {
      const appId = id || env.SWELL_APP_ID;
      if (!appId) {
        throw new Error(
          "Missing app id. Pass an id to settings() or set SWELL_APP_ID binding.",
        );
      }
      return makeRequest("GET", `/settings/${appId}`);
    },
  } as BasicSwellClient;
}
