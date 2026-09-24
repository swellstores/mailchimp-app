import { afterEach, describe, expect, it, vi } from "vitest";
import accountsSync from "../../functions/accounts-sync";
import cartsSync from "../../functions/carts-sync";
import ordersSync from "../../functions/orders-sync";
import { deleteRecord, pushRecord } from "../../functions/lib/push";
import { hasRelevantChange } from "../../functions/lib/events";
import { getSettings } from "../../functions/lib/settings";
import { createMockRequest } from "../helpers/mock-request";
import {
  ACCOUNT_ID,
  CART_ID,
  RECORD_ID,
  account,
  cart,
  jsonResponse,
  mailchimpError,
  mailchimpMember,
  order,
  withSyncState,
} from "../helpers/fixtures";

/**
 * Handler-level tests: the gates that decide whether anything is pushed at all.
 *
 * These are the cheapest place to catch the two failures that would be most expensive in
 * production — the write-back loop, and pushing every customer on every order — because
 * both are invisible in a mapper test and only show up as vendor traffic.
 *
 * Mailchimp is stubbed at the network level, Swell at the object level. Never mixed.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SETTINGS = {
  mailchimp: {
    enabled: true,
    api_key: "0123456789abcdef-us14",
    list_id: "a6b5da1054",
    store_id: "test-store",
    store_currency: "USD",
    webhook_secret: "a-long-enough-secret",
  },
};

function harness(options: {
  data: Record<string, any>;
  record?: Record<string, any>;
  settings?: Record<string, any>;
  fetchImpl?: () => Promise<Response>;
}) {
  const fetchMock = vi.fn(
    options.fetchImpl ?? (async () => jsonResponse(200, mailchimpMember())),
  );
  vi.stubGlobal("fetch", fetchMock);

  const swell = {
    settings: vi.fn(async () => options.settings ?? SETTINGS),
    get: vi.fn(async () => options.record ?? null),
    put: vi.fn(async (_url: string, _body: Record<string, any>) => ({})),
  };

  const req = createMockRequest({
    swell,
    appId: "mailchimp",
    data: options.data as any,
  });

  return { req, swell, fetchMock };
}

// ---------------------------------------------------------------------------
// The loop breaker
// ---------------------------------------------------------------------------

describe("accounts-sync", () => {
  it("ignores its own write-back from an inbound webhook", async () => {
    // THE LOOP BREAKER. `lib/account-writeback.ts` stamps `last_webhook_at` in the same
    // PUT as the `email_optin` it clears. Without this guard, every unsubscribe Mailchimp
    // sends is pushed straight back to Mailchimp, which is a loop that only stops when the
    // platform disables the function after four days.
    const { req, fetchMock } = harness({
      data: {
        id: ACCOUNT_ID,
        $event: {
          type: "account.updated",
          data: {
            email_optin: false,
            $app: { mailchimp: { last_webhook_at: "2026-08-07T09:00:00.000Z" } },
          },
        },
      },
      record: account(),
    });

    await accountsSync(req);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores the account.updated Swell fires for order_count on every purchase", async () => {
    // Measured on the live store: an order updates the account's `order_count` and
    // `date_last_order`. Without a relevance filter this app would re-push every customer
    // on every order, forever.
    expect(hasRelevantChange("accounts", { order_count: 46, date_last_order: "x" })).toBe(
      false,
    );

    const { req, fetchMock } = harness({
      data: {
        id: ACCOUNT_ID,
        $event: { type: "account.updated", data: { order_count: 46, date_last_order: "x" } },
      },
      record: account(),
    });

    await accountsSync(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pushes when a field Mailchimp cares about actually changed", async () => {
    const { req, fetchMock, swell } = harness({
      data: {
        id: ACCOUNT_ID,
        $event: { type: "account.updated", data: { email_optin: true } },
      },
      record: withSyncState(account(), { remote_key: ACCOUNT_ID }),
    });

    await accountsSync(req);

    // Two calls: the ecommerce customer, then the audience member.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = (fetchMock.mock.calls as unknown as Array<[string]>).map(([u]) => u);
    expect(urls[0]).toContain(`/ecommerce/stores/test-store/customers/${ACCOUNT_ID}`);
    expect(urls[1]).toContain("/lists/a6b5da1054/members/");
    expect(swell.put).toHaveBeenCalled();
  });

  it("does not create a customer Mailchimp has never seen from an incidental edit", async () => {
    // `remote_key` doubles as the "has this ever been pushed?" flag.
    const { req, fetchMock } = harness({
      data: { id: ACCOUNT_ID, $event: { type: "account.updated", data: { first_name: "Ada" } } },
      record: account(),
    });

    await accountsSync(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours the master switch and the per-collection toggle", async () => {
    for (const overrides of [{ enabled: false }, { sync_accounts: false }]) {
      const { req, fetchMock, swell } = harness({
        data: { id: ACCOUNT_ID, $event: { type: "account.created", data: {} } },
        record: account(),
        settings: { mailchimp: { ...SETTINGS.mailchimp, ...overrides } },
      });

      await accountsSync(req);

      // Not even a read: the gate is the first thing the handler evaluates. This is the
      // gate that CANNOT live in `config.model.conditions` — a `$settings` reference there
      // stops the platform dispatching the event at all.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(swell.get).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// Carts
// ---------------------------------------------------------------------------

describe("carts-sync", () => {
  it("deletes the cart from Mailchimp on conversion, whatever the deletion setting says", async () => {
    // Mailchimp's abandoned-cart automation runs off carts present in the store. Leaving a
    // converted cart there emails "you left something behind" to a customer who has paid.
    // That is why this ignores `event_deleted`, which is about propagating a merchant's
    // destructive action rather than about not sending a wrong email.
    const { req, fetchMock } = harness({
      data: { id: "cart_1", $event: { type: "cart.converted", data: {} } },
      settings: { mailchimp: { ...SETTINGS.mailchimp, event_deleted: false } },
      fetchImpl: async () => new Response(null, { status: 204 }),
    });

    await cartsSync(req);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(url).toContain("/ecommerce/stores/test-store/carts/cart_1");
  });

  it("pushes an abandoned cart even if it was never pushed before", async () => {
    // `cart.abandoned` is the event the whole feature exists for; `requireExisting` would
    // skip exactly the carts Mailchimp most needs.
    const { req, fetchMock } = harness({
      data: { id: "cart_1", $event: { type: "cart.abandoned", data: {} } },
      record: cart(),
      fetchImpl: async () => jsonResponse(200, { id: "cart_1" }),
    });

    await cartsSync(req);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // No remote_key on the record, so this is a create.
    expect(init.method).toBe("POST");
  });

  it("skips live cart traffic when the scope is abandoned-only", async () => {
    const { req, fetchMock } = harness({
      data: { id: "cart_1", $event: { type: "cart.updated", data: { items: [] } } },
      record: cart(),
      settings: { mailchimp: { ...SETTINGS.mailchimp, cart_scope: "abandoned" } },
    });

    await cartsSync(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

describe("orders-sync", () => {
  it("pushes on order.submitted and ignores the draft-level order.created", async () => {
    const submitted = harness({
      data: { id: RECORD_ID, $event: { type: "order.submitted", data: {} } },
      record: order(),
      fetchImpl: async () => jsonResponse(200, { id: RECORD_ID }),
    });
    await ordersSync(submitted.req);
    expect(submitted.fetchMock).toHaveBeenCalledTimes(1);
    expect((submitted.fetchMock.mock.calls[0] as any)[1].method).toBe("PUT");

    const created = harness({
      data: { id: RECORD_ID, $event: { type: "order.created", data: {} } },
      record: order(),
    });
    await ordersSync(created.req);
    // Same payload as `submitted`; acting on both would double every order push.
    expect(created.fetchMock).not.toHaveBeenCalled();
  });

  it("pushes lifecycle events that move the status Mailchimp automations key on", async () => {
    for (const type of ["order.paid", "order.canceled", "order.delivered"]) {
      const { req, fetchMock } = harness({
        data: { id: RECORD_ID, $event: { type, data: {} } },
        record: withSyncState(order(), { remote_key: RECORD_ID }),
        fetchImpl: async () => jsonResponse(200, { id: RECORD_ID }),
      });
      await ordersSync(req);
      expect(fetchMock, `${type} should push`).toHaveBeenCalledTimes(1);
    }
  });
});

// ---------------------------------------------------------------------------
// push.ts outcomes
// ---------------------------------------------------------------------------

describe("pushRecord outcomes", () => {
  async function settingsFor(overrides: Record<string, any> = {}) {
    return getSettings(
      createMockRequest({
        swell: {
          settings: vi.fn(async () => ({
            mailchimp: { ...SETTINGS.mailchimp, ...overrides },
          })),
        },
      }),
    );
  }

  it("reports a guest cart as skipped and non-retryable", async () => {
    // Redelivering will never produce an account, so retrying would loop the platform on a
    // payload that cannot improve — and after ~4 days it disables the function.
    const swell = {
      settings: vi.fn(async () => SETTINGS),
      get: vi.fn(async () => cart({ account: null, account_id: null })),
      put: vi.fn(async (_url: string, _body: Record<string, any>) => ({})),
    };
    const req = createMockRequest({ swell, appId: "mailchimp" });

    const result = await pushRecord(req, await settingsFor(), "carts", "cart_1");

    expect(result).toMatchObject({ ok: true, action: "skipped_guest" });
    expect(swell.put.mock.calls[0][1].$app.mailchimp.sync_status).toBe("skipped");
  });

  it("reports a missing credential without stamping every record in the store", async () => {
    const swell = {
      settings: vi.fn(async () => ({ mailchimp: { enabled: true } })),
      get: vi.fn(async () => order()),
      put: vi.fn(async (_url: string, _body: Record<string, any>) => ({})),
    };
    const req = createMockRequest({ swell, appId: "mailchimp" });

    const result = await pushRecord(req, await settingsFor({ api_key: "" }), "orders", RECORD_ID);

    expect(result).toMatchObject({
      ok: false,
      action: "skipped_not_configured",
      retryable: false,
    });
    // Nothing has been attempted, so nothing is written. Stamping every record with an
    // error the moment the app is installed is noise, not observability.
    expect(swell.put).not.toHaveBeenCalled();
  });

  it("provisions the Mailchimp store when a push 404s because it does not exist", async () => {
    // The lazy safety net from lib/store.ts: a merchant who never ran `setup` would
    // otherwise get 24 hours of failures before the daily cron caught it.
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ method: init.method as string, url });
        if (init.method === "PUT") {
          return jsonResponse(404, mailchimpError(404, "The requested resource could not be found."));
        }
        if (init.method === "GET") {
          return jsonResponse(404, mailchimpError(404, "not found"));
        }
        return jsonResponse(200, { id: "test-store" });
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const swell = {
      settings: vi.fn(async () => SETTINGS),
      get: vi.fn(async () => order()),
      put: vi.fn(async (_url: string, _body: Record<string, any>) => ({})),
    };
    const req = createMockRequest({ swell, appId: "mailchimp" });

    const result = await pushRecord(req, await settingsFor(), "orders", RECORD_ID);

    expect(result.ok).toBe(false);
    // Retryable, so the platform redelivers into a store that now exists.
    expect(result.retryable).toBe(true);
    expect(result.message).toMatch(/did not exist, so it was created/);
    expect(calls.map((c) => c.method)).toEqual(["PUT", "GET", "GET", "POST"]);
  });

  it("explains a 404 that is about a missing product rather than a missing store", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === "PUT") {
          return jsonResponse(404, mailchimpError(404, "not found"));
        }
        // The store probe succeeds, so the 404 was about something else.
        return jsonResponse(200, { id: "test-store", list_id: "a6b5da1054" });
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const swell = {
      settings: vi.fn(async () => SETTINGS),
      get: vi.fn(async () => order()),
      put: vi.fn(async (_url: string, _body: Record<string, any>) => ({})),
    };
    const req = createMockRequest({ swell, appId: "mailchimp" });

    const result = await pushRecord(req, await settingsFor(), "orders", RECORD_ID);

    expect(result.message).toMatch(/references a product that has never been pushed/);
    expect(swell.put.mock.calls[0][1].$app.mailchimp.sync_status).toBe("error");
  });

  it("records the outcome under $app and nowhere else on a successful push", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { id: RECORD_ID })));

    const swell = {
      settings: vi.fn(async () => SETTINGS),
      get: vi.fn(async () => order()),
      put: vi.fn(async (_url: string, _body: Record<string, any>) => ({})),
    };
    const req = createMockRequest({ swell, appId: "mailchimp" });

    const result = await pushRecord(req, await settingsFor(), "orders", RECORD_ID);

    expect(result).toMatchObject({ ok: true, action: "pushed" });
    const [url, body] = swell.put.mock.calls[0];
    expect(url).toBe(`/orders/${RECORD_ID}`);
    expect(Object.keys(body)).toEqual(["$app"]);
    // `remote_key` is always the Swell record id. That is the whole idempotency story.
    expect(body.$app.mailchimp.remote_key).toBe(RECORD_ID);
    expect(body.$app.mailchimp.sync_status).toBe("synced");
  });
});

// ---------------------------------------------------------------------------
// deleteRecord outcomes
// ---------------------------------------------------------------------------

describe("deleteRecord outcomes", () => {
  async function settingsFor() {
    return getSettings(
      createMockRequest({
        swell: { settings: vi.fn(async () => SETTINGS) },
      }),
    );
  }

  it("stamps 'canceled' when Mailchimp reports the record already absent", async () => {
    // The 404 branch used to return success WITHOUT recording state, so a cart deleted
    // in Mailchimp's UI — or expired there before cart.converted arrived — kept reading
    // 'synced' in the admin forever, on the one surface this fleet exists to keep honest.
    // Already-absent must record the same state as a successful delete.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, mailchimpError(404, "not found"))),
    );

    const swell = {
      settings: vi.fn(async () => SETTINGS),
      put: vi.fn(async (_url: string, _body: Record<string, any>) => ({})),
    };
    const req = createMockRequest({ swell, appId: "mailchimp" });

    const result = await deleteRecord(req, await settingsFor(), "carts", CART_ID);

    expect(result).toMatchObject({ ok: true, action: "deleted" });
    expect(swell.put).toHaveBeenCalledTimes(1);
    const [url, body] = swell.put.mock.calls[0];
    expect(url).toBe(`/carts/${CART_ID}`);
    expect(Object.keys(body)).toEqual(["$app"]);
    expect(body.$app.mailchimp).toMatchObject({
      sync_status: "canceled",
      last_error: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Opt-in, opt-out and deletion (native parity)
// ---------------------------------------------------------------------------

describe("accounts-sync audience membership", () => {
  type Call = { url: string; method: string; body: any };

  /** Mailchimp stub that records every call and answers member writes with `member`. */
  function mailchimp(respond?: (call: Call) => Response | undefined) {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call: Call = {
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        };
        calls.push(call);
        return respond?.(call) ?? jsonResponse(200, mailchimpMember());
      }),
    );
    return calls;
  }

  function request(data: Record<string, any>, record: Record<string, any> | null, settings = {}) {
    return createMockRequest({
      swell: {
        settings: vi.fn(async () => ({ mailchimp: { ...SETTINGS.mailchimp, ...settings } })),
        get: vi.fn(async () => record),
        put: vi.fn(async () => ({})),
      },
      appId: "mailchimp",
      data: data as any,
    });
  }

  const memberWrites = (calls: Call[]) => calls.filter((c) => c.url.includes("/members/"));

  it("creates the member when an account that was never sent opts in", async () => {
    const calls = mailchimp();

    await accountsSync(
      request(
        { id: ACCOUNT_ID, $event: { type: "account.updated", data: { email_optin: true } }, email_optin: true },
        account({ email_optin: true }),
      ),
    );

    const [member] = memberWrites(calls);
    expect(member.method).toBe("PUT");
    // Explicit consent in this event, so an existing unsubscribed/transactional member is
    // subscribed too, not just a brand-new one.
    expect(member.body.status).toBe("subscribed");
  });

  it("asks Mailchimp to confirm by email when the member unsubscribed through Mailchimp", async () => {
    let firstMemberWrite = true;
    const calls = mailchimp((call) => {
      if (call.url.includes("/members/") && firstMemberWrite) {
        firstMemberWrite = false;
        return jsonResponse(400, {
          ...mailchimpError(400, "ada@example.com is in a compliance state due to unsubscribe, bounce, or compliance review and cannot be subscribed."),
          title: "Member In Compliance State",
        });
      }
      return undefined;
    });

    await accountsSync(
      request(
        { id: ACCOUNT_ID, $event: { type: "account.updated", data: { email_optin: true } }, email_optin: true },
        withSyncState(account({ email_optin: true }), { remote_key: ACCOUNT_ID }),
      ),
    );

    const writes = memberWrites(calls);
    expect(writes.map((w) => w.body.status)).toEqual(["subscribed", "pending"]);
  });

  it("never unsubscribes a member just because email_optin is unset in Swell", async () => {
    const calls = mailchimp();

    await accountsSync(
      request(
        { id: ACCOUNT_ID, $event: { type: "account.updated", data: { first_name: "Ada" } } },
        withSyncState(account({ email_optin: undefined }), { remote_key: ACCOUNT_ID }),
      ),
    );

    expect(memberWrites(calls).some((w) => w.body?.status === "unsubscribed")).toBe(false);
  });

  it("unsubscribes on an explicit opt-out even if the member joined through Mailchimp", async () => {
    // The app never recorded them as subscribed (list_status is empty), which used to
    // skip the opt-out entirely.
    const calls = mailchimp();

    await accountsSync(
      request(
        { id: ACCOUNT_ID, $event: { type: "account.updated", data: { email_optin: false } }, email_optin: false },
        withSyncState(account({ email_optin: false }), { remote_key: ACCOUNT_ID }),
      ),
    );

    const [member] = memberWrites(calls);
    expect(member).toMatchObject({ method: "PATCH", body: { status: "unsubscribed" } });
  });

  it("archives the audience member when the account is deleted", async () => {
    const calls = mailchimp(() => new Response(null, { status: 204 }));
    const deleted = account();

    // A deleted record cannot be re-read, so the handler works from $event.data alone.
    await accountsSync(request({ $event: { type: "account.deleted", data: deleted } }, null));

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain("/lists/a6b5da1054/members/ada%40example.com");
  });

  it("treats a member Mailchimp no longer has as already archived", async () => {
    mailchimp(() => jsonResponse(404, mailchimpError(404, "Resource Not Found")));

    await expect(
      accountsSync(request({ $event: { type: "account.deleted", data: account() } }, null)),
    ).resolves.toBeUndefined();
  });

  it("leaves Mailchimp alone on delete when archiving is switched off", async () => {
    const calls = mailchimp();

    await accountsSync(
      request({ $event: { type: "account.deleted", data: account() } }, null, { archive_on_delete: false }),
    );

    expect(calls).toHaveLength(0);
  });
});
