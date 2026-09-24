import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MailchimpClient,
  MailchimpError,
  isAlreadyExists,
  isNotFound,
} from "../../functions/lib/mailchimp-client";
import {
  WEBHOOK_FUNCTION_DESCRIPTION,
  configurationError,
  datacenterFromKey,
  getSettings,
  hasCredentials,
  redact,
  resolveApiBase,
  storeId,
  storefrontOrigin,
  webhookCallbackUrl,
  type MailchimpSettings,
} from "../../functions/lib/settings";
import { createMockRequest } from "../helpers/mock-request";
import { jsonResponse, mailchimpError } from "../helpers/fixtures";

/**
 * ===========================================================================
 * Two house patterns, and they are never mixed.
 *
 *   1. THE MAILCHIMP API IS STUBBED AT THE NETWORK LEVEL (`vi.stubGlobal('fetch', …)`).
 *      The transport — auth header, base URL, status classification, the single inline
 *      429 retry — is the part most worth testing, and stubbing the client's *methods*
 *      would skip all of it. It also lets a test assert on the exact URL and body sent,
 *      which is the only place an idempotency-key bug is visible.
 *
 *   2. SWELL IS STUBBED AT THE OBJECT LEVEL (`createMockRequest({ swell: { … } })`).
 *      `req.swell` is an injected object, not a fetch call, so there is nothing to
 *      intercept — and object stubs give you `swell.put.mock.calls`.
 * ===========================================================================
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function settings(overrides: Partial<MailchimpSettings> = {}): MailchimpSettings {
  return {
    enabled: true,
    api_key: "0123456789abcdef0123456789abcde-us14",
    list_id: "a6b5da1054",
    api_base: "",
    store_id: "test-store",
    store_name: "Test Store",
    store_currency: "USD",
    store_domain: "shop.example.com",
    push_trigger: "automatic",
    sync_accounts: true,
    sync_products: true,
    sync_carts: true,
    cart_scope: "all",
    sync_orders: true,
    event_created: true,
    event_updated: true,
    event_deleted: false,
    push_optout: true,
    archive_on_delete: true,
    webhook_secret: "a-long-enough-secret",
    webhook_signing_secret: "",
    webhook_writeback: true,
    callback_url: "",
    app_object_id: "",
    allow_test_payload: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Datacenter derivation — the whole reason `api_base` exists as a settings field
// ---------------------------------------------------------------------------

describe("datacenter derivation", () => {
  it("derives the API host from the key's suffix", () => {
    expect(datacenterFromKey("0123456789abcdef0123456789abcde-us14")).toBe("us14");
    expect(resolveApiBase({ api_key: "abc-us6" })).toBe("https://us6.api.mailchimp.com/3.0");
    expect(resolveApiBase({ api_key: "abc-us1" })).toBe("https://us1.api.mailchimp.com/3.0");
  });

  it("refuses to interpolate anything that is not a datacenter", () => {
    // The suffix goes straight into a URL. A permissive match here is an SSRF hole, not a
    // convenience — these are the shapes that must never produce a host.
    for (const key of [
      "no-suffix-here",
      "abc-us14/evil",
      "abc-evil.example.com",
      "abc-US14",
      "abc-",
      "plainkeywithnodash",
      "abc-1234567",
    ]) {
      expect(datacenterFromKey(key), `${key} must not yield a datacenter`).toBe("");
      expect(resolveApiBase({ api_key: key })).toBeNull();
    }
  });

  it("lets the explicit override win over the derived host", () => {
    expect(resolveApiBase({ api_key: "abc-us14", api_base: "https://mock.test/3.0/" })).toBe(
      "https://mock.test/3.0",
    );
  });

  it("reports an unusable key as configuration rather than failing at request time", () => {
    // A key sent to the wrong datacenter comes back 401, which reads as "bad credential"
    // and sends the merchant hunting the wrong problem. So this is caught before the call.
    expect(configurationError(settings({ api_key: "nosuffix" }))).toMatch(/datacenter/i);
    expect(configurationError(settings({ api_key: "" }))).toMatch(/API key/i);
    expect(configurationError(settings({ list_id: "" }))).toMatch(/audience/i);
    expect(configurationError(settings())).toBeNull();
    expect(hasCredentials(settings())).toBe(true);
  });

  it("throws rather than guessing a datacenter when the client is constructed", () => {
    expect(() => new MailchimpClient({ api_key: "nosuffix" })).toThrow(/datacenter/i);
  });
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

describe("MailchimpClient transport", () => {
  it("sends HTTP Basic auth against the derived datacenter host", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "store_1" }));
    vi.stubGlobal("fetch", fetchMock);

    await new MailchimpClient(settings()).getStore("store_1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://us14.api.mailchimp.com/3.0/ecommerce/stores/store_1");
    // Mailchimp documents Basic with any username: `--user 'anystring:APIKEY'`.
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth.startsWith("Basic ")).toBe(true);
    expect(atob(auth.slice(6))).toBe("swell:0123456789abcdef0123456789abcde-us14");
  });

  it("classifies 5xx and 429 as retryable and other 4xx as permanent", async () => {
    // `retryable` is what eventually becomes `SwellError({ retry })`, so getting it
    // backwards means either an infinite redelivery loop on a bad payload, or a dropped
    // event on a transient outage. Both are silent. Pin it.
    const cases: Array<[number, boolean]> = [
      [500, true],
      [503, true],
      [429, true],
      [400, false],
      [401, false],
      [404, false],
      [422, false],
    ];
    for (const [status, retryable] of cases) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(status, mailchimpError(status, "nope"))),
      );
      await expect(
        new MailchimpClient(settings()).getStore("store_1"),
      ).rejects.toMatchObject({ status, retryable });
    }
  });

  it("surfaces Mailchimp's field-level errors, not just the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          400,
          mailchimpError(400, "Your merge fields were invalid.", [
            { field: "lines.0.product_id", message: "is required" },
          ]),
        ),
      ),
    );

    // A merchant reading `last_error` needs the reason and the support instance id.
    await expect(new MailchimpClient(settings()).getStore("s")).rejects.toThrow(
      /lines\.0\.product_id: is required/,
    );
    await expect(new MailchimpClient(settings()).getStore("s")).rejects.toThrow(/instance /);
  });

  it("survives a 429 with no body at all", async () => {
    // Mailchimp documents this explicitly: "At exceptionally high volumes, you may receive
    // an HTTP 429 or 403 without a JSON body."
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    await expect(new MailchimpClient(settings()).getStore("s")).rejects.toMatchObject({
      status: 429,
      retryable: true,
    });
  });

  it("waits once and retries when a short Retry-After is supplied", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}, { "Retry-After": "1" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "store_1" }));
    vi.stubGlobal("fetch", fetchMock);

    await new MailchimpClient(settings()).getStore("store_1");

    // Exactly two: one inline retry, never a loop. The 10s budget cannot absorb more.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up on a long pause so the platform can redeliver instead", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(429, {}, { "Retry-After": "120" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new MailchimpClient(settings()).getStore("s")).rejects.toMatchObject({
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a network failure as a retryable MailchimpError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );

    // Never let a raw TypeError escape: the orchestration layer classifies on `retryable`,
    // and an unclassified throw defaults to "retry forever".
    await expect(new MailchimpClient(settings()).getStore("s")).rejects.toBeInstanceOf(
      MailchimpError,
    );
    await expect(new MailchimpClient(settings()).getStore("s")).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("treats an empty 204 body as success", async () => {
    // DELETE answers 204 with no body; parsing that as JSON would throw.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 204 })));
    await expect(
      new MailchimpClient(settings()).deleteCart("store_1", "cart_1"),
    ).resolves.toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The upsert asymmetry — the single most important vendor fact in this app
// ---------------------------------------------------------------------------

describe("idempotent upserts", () => {
  it("uses PUT-by-Swell-id for customers, products and orders", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "rec_1" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new MailchimpClient(settings());

    await client.upsertCustomer("store_1", "acct_1", { id: "acct_1" });
    await client.upsertProduct("store_1", "prod_1", { id: "prod_1" });
    await client.upsertOrder("store_1", "ord_1", { id: "ord_1" });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([, init]) => init.method)).toEqual(["PUT", "PUT", "PUT"]);
    // The Swell record id is the path segment. That is the whole idempotency story.
    expect(calls[0][0]).toContain("/customers/acct_1");
    expect(calls[1][0]).toContain("/products/prod_1");
    expect(calls[2][0]).toContain("/orders/ord_1");
  });

  it("creates a cart with POST when it has never been pushed", async () => {
    // Carts are the one ecommerce resource with NO add-or-update PUT — verified against
    // Mailchimp's OpenAPI spec. `remote_key` is what decides POST vs PATCH.
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "cart_1" }));
    vi.stubGlobal("fetch", fetchMock);

    await new MailchimpClient(settings()).upsertCart(
      "store_1",
      "cart_1",
      { id: "cart_1", order_total: 5 },
      false,
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(url).toMatch(/\/carts$/);
    expect(JSON.parse(init.body as string).id).toBe("cart_1");
  });

  it("updates a known cart with PATCH, and strips the id Mailchimp will not accept", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "cart_1" }));
    vi.stubGlobal("fetch", fetchMock);

    await new MailchimpClient(settings()).upsertCart(
      "store_1",
      "cart_1",
      { id: "cart_1", order_total: 5 },
      true,
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("PATCH");
    expect(url).toMatch(/\/carts\/cart_1$/);
    // `id` is not a property of Mailchimp's cart PATCH body.
    expect(JSON.parse(init.body as string)).toEqual({ order_total: 5 });
  });

  it("falls back to PATCH when a create says the cart already exists", async () => {
    // The `remote_key` flag can be stale in both directions. Each miss costs one extra
    // call, once — never a failed sync.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, mailchimpError(400, "cart already exists")))
      .mockResolvedValueOnce(jsonResponse(200, { id: "cart_1" }));
    vi.stubGlobal("fetch", fetchMock);

    await new MailchimpClient(settings()).upsertCart("store_1", "cart_1", { id: "cart_1" }, false);

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([, init]) => init.method)).toEqual(["POST", "PATCH"]);
  });

  it("falls back to POST when an update finds no cart", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, mailchimpError(404, "not found")))
      .mockResolvedValueOnce(jsonResponse(200, { id: "cart_1" }));
    vi.stubGlobal("fetch", fetchMock);

    await new MailchimpClient(settings()).upsertCart("store_1", "cart_1", { id: "cart_1" }, true);

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([, init]) => init.method)).toEqual(["PATCH", "POST"]);
  });

  it("recovers when the fallback POST loses the create race to a concurrent push", async () => {
    // Two invocations can both see the PATCH 404 and both take the POST branch — only one
    // create can win, and the loser gets Mailchimp's "already exists" 400, which
    // classifies as permanent. Without the same isAlreadyExists → PATCH recovery the
    // create direction has, a push that SUCCEEDED (the other invocation created the cart)
    // would be recorded as a non-retryable error.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, mailchimpError(404, "not found")))
      .mockResolvedValueOnce(jsonResponse(400, mailchimpError(400, "cart already exists")))
      .mockResolvedValueOnce(jsonResponse(200, { id: "cart_1" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new MailchimpClient(settings()).upsertCart(
      "store_1",
      "cart_1",
      { id: "cart_1", order_total: 5 },
      true,
    );

    expect(result.id).toBe("cart_1");
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([, init]) => init.method)).toEqual(["PATCH", "POST", "PATCH"]);
  });

  it("addresses an audience member by email rather than by an MD5 hash", async () => {
    // Mailchimp documents the subscriber hash as MD5(lowercase(email)) but also accepts
    // the raw address — which matters because a Workers isolate has no MD5 at all
    // (`crypto.subtle` offers SHA only).
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "hash", status: "subscribed" }));
    vi.stubGlobal("fetch", fetchMock);

    await new MailchimpClient(settings()).upsertMember("list_1", "  Ada+Test@Example.COM ", {
      email_address: "ada@example.com",
      status_if_new: "subscribed",
    });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/lists/list_1/members/");
    expect(url).toContain(encodeURIComponent("ada+test@example.com"));
  });

  it("sends batch operation bodies as JSON strings", async () => {
    // Mailchimp's contract: `body` is a string. An object here produces a batch whose
    // every operation fails, hours later, with nothing readable to show for it.
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "batch_1", status: "pending" }));
    vi.stubGlobal("fetch", fetchMock);

    await new MailchimpClient(settings()).submitBatch([
      { method: "PUT", path: "/x", body: JSON.stringify({ a: 1 }), operation_id: "op" },
    ]);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(typeof sent.operations[0].body).toBe("string");
  });
});

describe("error predicates", () => {
  it("recognises the two failures the upsert paths branch on", () => {
    expect(isNotFound(new MailchimpError("x", { status: 404 }))).toBe(true);
    expect(isNotFound(new MailchimpError("x", { status: 400 }))).toBe(false);
    // Mailchimp answers 400, not 409, for a duplicate — so the message is the only signal.
    expect(isAlreadyExists(new MailchimpError("cart already exists", { status: 400 }))).toBe(
      true,
    );
    expect(isAlreadyExists(new MailchimpError("bad request", { status: 400 }))).toBe(false);
    expect(isAlreadyExists(new Error("already exists"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Settings — object-level stubs, no network anywhere in this block
// ---------------------------------------------------------------------------

describe("getSettings", () => {
  it("returns defaults rather than undefined when nothing is configured", async () => {
    const swell = { settings: vi.fn(async () => ({})) };
    const result = await getSettings(createMockRequest({ swell }));

    for (const [key, value] of Object.entries(result)) {
      expect(value, `settings.${key} has no default`).toBeDefined();
    }
    // The master toggle defaults false fleet-wide, so installing the app never starts
    // syncing before a merchant has entered credentials.
    expect(result.enabled).toBe(false);
    expect(result.store_currency).toBe("USD");
    expect(result.cart_scope).toBe("all");
    expect(hasCredentials(result)).toBe(false);
  });

  it("reads from the settings filename namespace, not the app id", async () => {
    const swell = {
      settings: vi.fn(async () => ({ mailchimp: { enabled: true, api_key: "k-us2" } })),
    };
    const result = await getSettings(
      createMockRequest({ swell, appId: "some-other-app-id" }),
    );

    expect(result.enabled).toBe(true);
    expect(result.api_key).toBe("k-us2");
  });

  it("coerces values the settings UI should never have produced", async () => {
    const swell = {
      settings: vi.fn(async () => ({
        mailchimp: {
          enabled: "yes",
          api_key: 42,
          push_trigger: "whenever",
          cart_scope: "sometimes",
          store_currency: "gbp",
          store_domain: "https://shop.example.com/",
        },
      })),
    };

    const result = await getSettings(createMockRequest({ swell }));

    expect(result.enabled).toBe(false);
    expect(result.api_key).toBe("");
    expect(result.push_trigger).toBe("automatic");
    expect(result.cart_scope).toBe("all");
    // Normalised so a mapper never has to.
    expect(result.store_currency).toBe("GBP");
    expect(result.store_domain).toBe("shop.example.com");
  });
});

describe("derived values", () => {
  it("defaults the Mailchimp store id to the Swell store id", () => {
    const req = createMockRequest({ swell: {}, store: { id: "example-store" } });
    expect(storeId(req, settings({ store_id: "" }))).toBe("example-store");
    expect(storeId(req, settings({ store_id: "custom" }))).toBe("custom");
  });

  it("prefers the configured storefront domain over the store URL", () => {
    const req = createMockRequest({ swell: {}, store: { url: "https://fallback.test/" } });
    expect(storefrontOrigin(req, settings())).toBe("https://shop.example.com");
    expect(storefrontOrigin(req, settings({ store_domain: "" }))).toBe("https://fallback.test");
  });

});

// ---------------------------------------------------------------------------
// The public callback URL — the live bug this app shipped with
// ---------------------------------------------------------------------------

/**
 * ===========================================================================
 * REGRESSION SUITE FOR THE 404 CALLBACK URL.
 *
 * This app went live building `https://<store>.swell.store/functions/mailchimp/
 * mailchimp-webhook` from `req.appId`. That form **404s**: a public route resolves by the
 * app's 24-character hex ObjectId. Measured on the live store — the ObjectId form answers
 * 200, the slug form answers 404.
 *
 * The failure was silent at both ends. Mailchimp accepted the URL, reported the
 * subscription as created, and dropped every delivery. So the tests below pin two things
 * that a review would not catch: that the ObjectId is what reaches the URL, and that a
 * failure to determine it produces `null` rather than the slug form.
 *
 * House rule, as everywhere in this scaffold: ASCII-only in `describe()` and `it()` titles.
 * ===========================================================================
 */

const OBJECT_ID = "0123456789abcdef01234567";

/** One `/:functions` row, as the platform's own registry returns it. */
function functionRow(overrides: Record<string, any> = {}) {
  return {
    name: "mailchimp-webhook",
    description: "Receive Mailchimp audience webhooks",
    app_id: OBJECT_ID,
    enabled: true,
    ...overrides,
  };
}

function callbackRequest(rows: Array<Record<string, any>> | Error) {
  return createMockRequest({
    swell: {
      get: vi.fn(async () => {
        if (rows instanceof Error) throw rows;
        return { results: rows, count: rows.length };
      }),
    },
    store: { id: "example-store" },
    appId: "mailchimp",
  });
}

describe("webhookCallbackUrl", () => {
  it("builds the URL from the app ObjectId, never from the string app id", async () => {
    const req = callbackRequest([functionRow()]);

    const callback = await webhookCallbackUrl(req, settings());

    // THE BUG. `/functions/mailchimp/...` is what shipped and what 404s.
    expect(callback?.url).toBe(
      `https://example-store.swell.store/functions/${OBJECT_ID}/mailchimp-webhook?secret=a-long-enough-secret`,
    );
    expect(callback?.url).not.toContain("/functions/mailchimp/");
    expect(callback).toMatchObject({ derived: true, appObjectId: OBJECT_ID });
  });

  it("redacts the secret for anything a merchant or a log will see", async () => {
    const callback = await webhookCallbackUrl(callbackRequest([functionRow()]), settings());

    expect(callback?.redacted).toContain("secret=***");
    expect(callback?.redacted).not.toContain("a-long-enough-secret");
    expect(redact("https://x.test/y?a=1&secret=shh")).toBe("https://x.test/y?a=1&secret=***");
  });

  it("returns null rather than falling back to the slug form", async () => {
    // A 404 URL is worse than no URL: Mailchimp accepts it, reports success, and drops every
    // delivery. `setup` turns this null into an instruction the installer can act on.
    for (const rows of [[], [functionRow(), functionRow({ app_id: "b".repeat(24) })]]) {
      expect(await webhookCallbackUrl(callbackRequest(rows), settings())).toBeNull();
    }
    // ...and a registry read that throws is advisory, not fatal.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await webhookCallbackUrl(callbackRequest(new Error("registry down")), settings()),
    ).toBeNull();
  });

  it("ignores a row belonging to another app with the same function name", async () => {
    // `/:functions` cannot be filtered by app, so the name alone is ambiguous. The
    // description is this app's own string and is matched too.
    const rows = [functionRow({ description: "Some other app's webhook" })];
    expect(await webhookCallbackUrl(callbackRequest(rows), settings())).toBeNull();
  });

  it("refuses a malformed app_id rather than interpolating it", async () => {
    const rows = [functionRow({ app_id: "mailchimp" })];
    expect(await webhookCallbackUrl(callbackRequest(rows), settings())).toBeNull();
  });

  it("prefers the app_object_id override, without reading the registry at all", async () => {
    const req = callbackRequest([]);

    const callback = await webhookCallbackUrl(
      req,
      settings({ app_object_id: OBJECT_ID }),
    );

    expect(callback?.url).toContain(`/functions/${OBJECT_ID}/mailchimp-webhook`);
    expect(req.swell.get).not.toHaveBeenCalled();
  });

  it("falls back to discovery when the override is not a well-formed ObjectId", async () => {
    const callback = await webhookCallbackUrl(
      callbackRequest([functionRow()]),
      settings({ app_object_id: "not-an-objectid" }),
    );
    expect(callback?.appObjectId).toBe(OBJECT_ID);
  });

  it("lets the callback_url override win, and still carries the secret", async () => {
    const req = callbackRequest([functionRow()]);

    const callback = await webhookCallbackUrl(
      req,
      settings({ callback_url: "https://tunnel.test/hook?x=1" }),
    );

    expect(callback?.url).toBe("https://tunnel.test/hook?x=1&secret=a-long-enough-secret");
    expect(callback?.derived).toBe(false);
    // A tunnel is an explicit instruction; there is nothing to discover.
    expect(req.swell.get).not.toHaveBeenCalled();
  });

  it("queries the registry by function name", async () => {
    const req = callbackRequest([functionRow()]);
    await webhookCallbackUrl(req, settings());

    expect(req.swell.get).toHaveBeenCalledWith("/:functions", {
      where: { name: "mailchimp-webhook" },
      limit: 20,
    });
  });
});

describe("the webhook route's declared description", () => {
  it("matches WEBHOOK_FUNCTION_DESCRIPTION verbatim", async () => {
    // ObjectId discovery matches on name AND description. `config.description` is a literal
    // rather than the imported constant on purpose (see that file), so nothing but this
    // test keeps the two in step - and a drift silently breaks discovery for every install.
    const route: any = await import("../../functions/mailchimp-webhook");
    expect(route.config.description).toBe(WEBHOOK_FUNCTION_DESCRIPTION);
    expect(route.config.route.public).toBe(true);
    // Mailchimp fetches the URL before creating the subscription.
    expect(route.config.route.methods).toContain("get");
  });
});
