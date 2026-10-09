import { afterEach, describe, expect, it, vi } from "vitest";
import { post as backfill } from "../../functions/backfill";
import { createMockRequest } from "../helpers/mock-request";
import {
  ACCOUNT_ID,
  PRODUCT_ID,
  account,
  jsonResponse,
  mailchimpError,
  listResponse,
  product,
  withSyncState,
} from "../helpers/fixtures";
import { mockFn } from "../helpers/stub-fetch";

/**
 * Backfill route tests — the selection and settlement rules.
 *
 * These pin the three behaviours whose failure modes are *silent*:
 *
 *  1. The never-pushed selection excludes terminally-skipped records and always reads
 *     from the front. Get either wrong and records are skipped forever without anyone
 *     seeing it — nothing retries a record that was never pushed.
 *  2. Polling a batch settles ONLY the records that batch queued. Unscoped, batch A's
 *     poll flips batch B's in-flight records to 'synced' and B's failures are never
 *     recorded anywhere.
 *  3. A null list response is an error, not an empty page. The platform silently drops
 *     response bodies over 75 KB, and an empty page here reads as "backfill complete".
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
  },
};

type GetFn = (url: string, params?: Record<string, any>) => Promise<any>;
type PutFn = (url: string, body: Record<string, any>) => Promise<any>;

function harness(options: {
  body: Record<string, any>;
  get?: GetFn;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}) {
  const fetchMock = vi.fn(
    options.fetchImpl ?? (async () => jsonResponse(200, { id: "batch_A", status: "pending" })),
  );
  vi.stubGlobal("fetch", fetchMock);

  const get = mockFn<GetFn>(options.get ?? (async () => listResponse([])));
  const put = mockFn<PutFn>(async () => ({}));
  const swell = {
    settings: vi.fn(async () => SETTINGS),
    get,
    put,
  };

  const req = createMockRequest({
    swell,
    appId: "mailchimp",
    data: options.body as any,
  });

  return { req, get, put, fetchMock };
}

// ---------------------------------------------------------------------------
// 1. The never-pushed selection
// ---------------------------------------------------------------------------

describe("backfill selection", () => {
  it("excludes terminally-skipped records from the never-pushed selection", async () => {
    // The skip paths record `sync_status: 'skipped'` WITHOUT a remote_key — nothing was
    // pushed, so there is no key to record. A bare `{remote_key: null}` selection
    // therefore returns every guest cart and email-less account at the front of page 1,
    // forever. The `$nin` is what lets the selection drain past them; records with no
    // sync state at all still match, because a missing field is not in the $nin list.
    const { req, get } = harness({ body: { collection: "products", mode: "batch" } });

    const response: Record<string, any> = await backfill(req);

    expect(get).toHaveBeenCalledTimes(1);
    const params = get.mock.calls[0][1] as Record<string, any>;
    expect(params["$app.mailchimp.remote_key"]).toBeNull();
    expect(params["$app.mailchimp.sync_status"]).toEqual({
      $nin: ["skipped", "canceled", "error"],
    });
    expect(response.has_more).toBe(false);
  });

  it("never selects a cart that has become an order", async () => {
    // A converted cart sent to Mailchimp is one its abandoned-cart automation can email
    // about, for a purchase that was already made.
    for (const body of [
      { collection: "carts" },
      { collection: "carts", mode: "batch" },
      { collection: "carts", sync_status: "error" },
    ]) {
      const { req, get } = harness({ body });

      await backfill(req);

      const params = get.mock.calls[0][1] as Record<string, any>;
      expect(params, JSON.stringify(body)).toHaveProperty("order_id", null);
    }
  });

  it("always selects from the front and ignores any page parameter", async () => {
    // Processed records leave the selection between calls (pushed → remote_key set,
    // skipped → terminal status), so "page 2" has moved to the front by the time a
    // second call arrives. Advancing a page number over a draining selection silently
    // skips one page-worth of records per call — the caller must repeat the SAME call.
    const { req, get } = harness({
      body: { collection: "products", mode: "batch", page: 7 },
    });

    const response: Record<string, any> = await backfill(req);

    const params = get.mock.calls[0][1] as Record<string, any>;
    expect(params.page).toBe(1);
    // And the page size honours the plan's ~10-25 guidance: 25 expanded records, not
    // 100 — a bigger read courts the silent 75 KB response drop.
    expect(params.limit).toBe(25);
    expect(response.message).toContain("Nothing left to backfill");
  });

  it("treats a null list response as an error, never as an empty page", async () => {
    // The platform silently drops response bodies over 75 KB. A dropped body used to
    // come back as `has_more: false` with zero records — "backfill complete" for a
    // backfill that never ran, which is the worst possible failure mode.
    const { req } = harness({
      body: { collection: "products" },
      get: async () => null,
    });

    await expect(backfill(req)).rejects.toThrow(/75 KB/);
  });
});

// ---------------------------------------------------------------------------
// 2. Batch submission stamps the batch id
// ---------------------------------------------------------------------------

describe("batch submission", () => {
  it("stamps each queued record 'pending' with the submitted batch's id", async () => {
    // The stamp is the ONLY tie between a record and the submission that queued it.
    // pollBatch settles by batch id, so a record marked pending without one could be
    // settled by any batch's poll — which is exactly finding #25's bug.
    const { req, put, fetchMock } = harness({
      body: { collection: "products", mode: "batch" },
      get: async () => listResponse([product()]),
      fetchImpl: async () => jsonResponse(200, { id: "batch_A", status: "pending" }),
    });

    const response: Record<string, any> = await backfill(req);

    expect(response.batch_id).toBe("batch_A");
    // Two calls: the store is marked syncing first, then the batch is submitted.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toBe(`/products/${PRODUCT_ID}`);
    expect(put.mock.calls[0][1].$app.mailchimp).toMatchObject({
      sync_status: "pending",
      remote_key: PRODUCT_ID,
      batch_id: "batch_A",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Poll settlement is scoped to the polled batch
// ---------------------------------------------------------------------------

describe("batch polling", () => {
  /**
   * Two records pending in the same collection, queued by two different batches. The
   * Swell stub honours the where clause the way the real API would: it only returns
   * records whose stamped batch_id matches the one the route asked for. If the route
   * ever drops the batch_id from its selection, the stub returns both records and the
   * cross-batch assertion below fails.
   */
  function pendingFixtures() {
    const recordA = withSyncState(product({ id: "prod_a" }), {
      sync_status: "pending",
      remote_key: "prod_a",
      batch_id: "batch_A",
    });
    const recordB = withSyncState(product({ id: "prod_b" }), {
      sync_status: "pending",
      remote_key: "prod_b",
      batch_id: "batch_B",
    });

    const get: GetFn = async (_url, params = {}) => {
      const requested = params["$app.mailchimp.batch_id"];
      return listResponse(
        [recordA, recordB].filter(
          (record) => record.$app.mailchimp.batch_id === requested,
        ),
      );
    };
    return { get };
  }

  it("settles only the records the polled batch queued, never another batch's", async () => {
    // THE CROSS-BATCH GUARD. Batch A finishing cleanly must not flip batch B's
    // still-in-flight records to 'synced': if it did, B's later failures would never be
    // recorded anywhere — the records read 'synced' forever, and the daily reconciler
    // retries only error/pending.
    const { get } = pendingFixtures();
    const { req, put } = harness({
      body: { batch_id: "batch_A", collection: "products" },
      get,
      fetchImpl: async () =>
        jsonResponse(200, {
          id: "batch_A",
          status: "finished",
          total_operations: 1,
          finished_operations: 1,
          errored_operations: 0,
        }),
    });

    const response: Record<string, any> = await backfill(req);

    expect(response.settled).toBe(1);

    // ...and only batch A's record was written. Batch B's record was never touched.
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toBe("/products/prod_a");
    expect(put.mock.calls[0][1].$app.mailchimp).toMatchObject({
      sync_status: "synced",
    });
    const touchedUrls = put.mock.calls.map((call) => call[0]);
    expect(touchedUrls).not.toContain("/products/prod_b");
  });

  it("marks only its own batch's records 'error' when the batch reports failures", async () => {
    // The error direction of the same scope: batch B failing must not stain batch A's
    // records, and the error message must name the failing batch for the operator.
    const { get } = pendingFixtures();
    const { req, put } = harness({
      body: { batch_id: "batch_B", collection: "products" },
      get,
      fetchImpl: async () =>
        jsonResponse(200, {
          id: "batch_B",
          status: "finished",
          total_operations: 1,
          finished_operations: 1,
          errored_operations: 1,
        }),
    });

    const response: Record<string, any> = await backfill(req);

    expect(response.ok).toBe(false);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toBe("/products/prod_b");
    expect(put.mock.calls[0][1].$app.mailchimp).toMatchObject({
      sync_status: "error",
    });
    expect(put.mock.calls[0][1].$app.mailchimp.last_error).toContain("batch_B");
  });
});

// ---------------------------------------------------------------------------
// 4. Automations stay quiet during a backfill
// ---------------------------------------------------------------------------

describe("store syncing flag", () => {
  function storeCalls(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls
      .map(([url, init]: any[]) => ({ url: String(url), init: init as RequestInit | undefined }))
      .filter(({ url, init }) => init?.method === "PATCH" && /\/ecommerce\/stores\/[^/]+$/.test(url));
  }

  it("marks the store as syncing before a bulk run, so Mailchimp does not email about old orders", async () => {
    const { req, fetchMock } = harness({ body: { collection: "products", mode: "batch" } });

    const response: Record<string, any> = await backfill(req);

    const [patch] = storeCalls(fetchMock);
    expect(JSON.parse(String(patch.init?.body))).toEqual({ is_syncing: true });
    expect(response.store_syncing).toBe(true);
  });

  it("leaves the flag alone for a single-record re-sync", async () => {
    const { req, fetchMock } = harness({
      body: { collection: "products", record_id: PRODUCT_ID },
      get: async () => product(),
      fetchImpl: async () => jsonResponse(200, { id: PRODUCT_ID }),
    });

    await backfill(req);

    expect(storeCalls(fetchMock)).toHaveLength(0);
  });

  it("turns syncing off again on the finish action", async () => {
    const { req, fetchMock } = harness({ body: { action: "finish" } });

    const response: Record<string, any> = await backfill(req);

    expect(response).toMatchObject({ ok: true, store_syncing: false });
    const [patch] = storeCalls(fetchMock);
    expect(JSON.parse(String(patch.init?.body))).toEqual({ is_syncing: false });
  });
});

// ---------------------------------------------------------------------------
// 5. Direct mode drains past records that keep failing
// ---------------------------------------------------------------------------

/**
 * A tiny in-memory collection that honours the where clauses the route sends, and applies
 * the route's `$app` writes, so a sequence of calls behaves the way it would on a store.
 */
function memoryStore(records: Array<Record<string, any>>) {
  const byId = new Map(records.map((r) => [String(r.id), structuredClone(r)]));
  const stateOf = (r: Record<string, any>) => r.$app?.mailchimp ?? {};
  const matches = (r: Record<string, any>, where: Record<string, any>) =>
    Object.entries(where).every(([key, cond]) => {
      if (["limit", "page", "sort", "expand", "include", "id"].includes(key)) return true;
      const value = key.startsWith("$app.mailchimp.")
        ? stateOf(r)[key.slice("$app.mailchimp.".length)]
        : r[key];
      if (cond && typeof cond === "object" && "$nin" in cond) return !cond.$nin.includes(value);
      if (cond === null) return value == null;
      return value === cond;
    });

  const get: GetFn = async (url, params = {}) => {
    const single = url.match(/^\/\w+\/\{id\}$/);
    if (single) return byId.get(String(params.id)) ?? null;
    const hits = [...byId.values()].filter((r) => matches(r, params));
    return listResponse(hits.slice(0, params.limit ?? 25));
  };
  const put: PutFn = async (url, body) => {
    const record = byId.get(url.split("/").pop() as string);
    if (record) {
      record.$app = { mailchimp: { ...stateOf(record), ...body.$app.mailchimp } };
    }
    return {};
  };
  return { get, put, byId };
}

describe("direct-mode pagination", () => {
  it("moves past ten records that keep failing, so has_more eventually turns false", async () => {
    // Ten failing records used to keep `remote_key: null`, stay first in line, and pin
    // has_more at true: the caller repeated the same call forever and the records behind
    // them were never sent.
    const failing = Array.from({ length: 10 }, (_, i) => product({ id: `bad_${i}` }));
    const good = [product({ id: "good_1" }), product({ id: "good_2" })];
    const store = memoryStore([...failing, ...good]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT" && url.includes("/products/bad_")) {
        return jsonResponse(400, mailchimpError(400, "Invalid resource"));
      }
      return jsonResponse(200, { id: url.split("/").pop() });
    };

    const responses: Array<Record<string, any>> = [];
    for (let call = 0; call < 5; call += 1) {
      const { req, put } = harness({ body: { collection: "products" }, get: store.get, fetchImpl });
      put.mockImplementation(store.put);
      const response: Record<string, any> = await backfill(req);
      responses.push(response);
      if (!response.has_more) break;
    }

    expect(responses.map((r) => r.has_more)).toEqual([true, false]);
    expect(responses[1].pushed).toBe(2);
    expect(store.byId.get("good_1")?.$app.mailchimp.sync_status).toBe("synced");
    expect(store.byId.get("bad_0")?.$app.mailchimp.sync_status).toBe("error");
    // The failures are not lost: the last call says how to re-run them.
    expect(responses.at(-1)?.message ?? "").not.toContain("sync_status");
  });

  it("records an unexpected throw as an error so the record leaves the selection", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = memoryStore([product({ id: "boom" })]);
    const { req, put } = harness({
      body: { collection: "products" },
      get: async (url, params) => {
        if (url.includes("{id}")) throw new Error("Swell read failed");
        return store.get(url, params);
      },
    });
    put.mockImplementation(store.put);

    const response: Record<string, any> = await backfill(req);

    expect(response.failed).toBe(1);
    expect(store.byId.get("boom")?.$app.mailchimp).toMatchObject({
      sync_status: "error",
      last_error: "Swell read failed",
    });
    expect(response.message).toContain('"sync_status":"error"');
  });

  it("stops a sync_status re-run whose whole page fails again instead of cycling it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = Array.from({ length: 10 }, (_, i) =>
      withSyncState(product({ id: `bad_${i}` }), { sync_status: "error", remote_key: null }),
    );
    const store = memoryStore(failing);
    const { req, put, get } = harness({
      body: { collection: "products", sync_status: "error" },
      get: store.get,
      fetchImpl: async (_input, init) =>
        init?.method === "PATCH"
          ? jsonResponse(200, { id: "test-store" })
          : jsonResponse(400, mailchimpError(400, "Invalid resource")),
    });
    put.mockImplementation(store.put);

    const response: Record<string, any> = await backfill(req);

    expect(response.has_more).toBe(false);
    expect(response.message).toMatch(/failed again/);
    // Least recently touched first, so a repeat reaches the records behind these.
    const listCall = get.mock.calls.find(([url]) => url === "/products");
    expect(listCall?.[1]?.sort).toBe("date_updated asc");
  });
});

// ---------------------------------------------------------------------------
// 6. Batch errors can be found again, and accounts keep their address
// ---------------------------------------------------------------------------

describe("batch error recovery", () => {
  it("tells the operator to re-run with sync_status error, which the poll's records match", async () => {
    const pending = withSyncState(product({ id: "prod_a" }), {
      sync_status: "pending",
      remote_key: "prod_a",
      batch_id: "batch_A",
    });
    const { req, put } = harness({
      body: { batch_id: "batch_A", collection: "products" },
      get: async () => listResponse([pending]),
      fetchImpl: async () =>
        jsonResponse(200, { id: "batch_A", status: "finished", errored_operations: 1 }),
    });

    const response: Record<string, any> = await backfill(req);

    const hint = '{"collection":"products","sync_status":"error"}';
    expect(response.message).toContain(hint);
    expect(put.mock.calls[0][1].$app.mailchimp.last_error).toContain(hint);
    expect(put.mock.calls[0][1].$app.mailchimp.sync_status).toBe("error");
  });

  it("records the member's address on submit and leaves an account's remote_id alone on poll", async () => {
    // remote_email is how a later email change finds the existing member. Without it the
    // direct path creates a second member at the new address.
    const submit = harness({
      body: { collection: "accounts", mode: "batch" },
      get: async () => listResponse([account({ email: " Ada@Example.com " })]),
    });
    await backfill(submit.req);
    expect(submit.put.mock.calls[0][1].$app.mailchimp).toMatchObject({
      sync_status: "pending",
      remote_email: "Ada@Example.com",
    });

    const poll = harness({
      body: { batch_id: "batch_A", collection: "accounts" },
      get: async () =>
        listResponse([
          withSyncState(account(), { sync_status: "pending", remote_key: ACCOUNT_ID, batch_id: "batch_A" }),
        ]),
      fetchImpl: async () => jsonResponse(200, { id: "batch_A", status: "finished", errored_operations: 0 }),
    });
    await backfill(poll.req);
    const settled = poll.put.mock.calls[0][1].$app.mailchimp;
    expect(settled.sync_status).toBe("synced");
    // The member's id is the hash of its address, not the Swell id.
    expect(settled).not.toHaveProperty("remote_id");
  });
});

// ---------------------------------------------------------------------------
// 7. No backfill without automations paused
// ---------------------------------------------------------------------------

describe("store syncing failure", () => {
  it("stops before sending anything when the store cannot be marked as syncing", async () => {
    const calls: string[] = [];
    const { req, get, put } = harness({
      body: { collection: "products", mode: "batch" },
      get: async () => listResponse([product()]),
      fetchImpl: async (input, init) => {
        calls.push(`${init?.method} ${String(input)}`);
        return jsonResponse(404, mailchimpError(404, "Resource Not Found"));
      },
    });

    await expect(backfill(req)).rejects.toThrow(/nothing was sent/);
    // Only the failed store PATCH: no batch, no record read, no state write.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^PATCH .*\/ecommerce\/stores\/test-store$/);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
