import { afterEach, describe, expect, it, vi } from "vitest";
import reconcile from "../../functions/reconcile";
import { createMockRequest } from "../helpers/mock-request";
import { jsonResponse } from "../helpers/fixtures";

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

type Call = { url: string; method: string; body: any };

function stubMailchimp(store: Record<string, any>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return jsonResponse(200, store);
    }),
  );
  return calls;
}

function request(options: { outstanding?: boolean; nativeEnabled?: boolean } = {}) {
  const get = vi.fn(async (url: string, _query?: Record<string, any>) => {
    if (url === "/settings/integrations/services/mailchimp") {
      return { enabled: options.nativeEnabled ?? false };
    }
    return { results: options.outstanding ? [{ id: "x" }] : [] };
  });
  const req = createMockRequest({
    appId: "mailchimp",
    swell: { settings: vi.fn(async () => SETTINGS), get, put: vi.fn(async () => ({})) },
  });
  return { req, get };
}

const syncingOff = (calls: Call[]) =>
  calls.some((c) => c.method === "PATCH" && c.body?.is_syncing === false);

describe("reconcile", () => {
  it("retries the least recently touched failures first, so stuck records rotate out", async () => {
    stubMailchimp({ id: "test-store", list_id: "a6b5da1054", is_syncing: false });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { req, get } = request();

    await reconcile(req);

    const retryQueries = get.mock.calls.filter(([, q]) => q?.["$app.mailchimp.sync_status"]?.$in);
    expect(retryQueries.length).toBeGreaterThan(0);
    for (const [, query] of retryQueries) {
      expect(query?.sort).toBe("date_updated asc");
    }
  });

  it("turns store syncing off once a backfill has nothing left to send", async () => {
    const calls = stubMailchimp({ id: "test-store", list_id: "a6b5da1054", is_syncing: true });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await reconcile(request({ outstanding: false }).req);

    expect(syncingOff(calls)).toBe(true);
  });

  it("keeps store syncing on while records are still waiting to be sent", async () => {
    const calls = stubMailchimp({ id: "test-store", list_id: "a6b5da1054", is_syncing: true });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await reconcile(request({ outstanding: true }).req);

    expect(syncingOff(calls)).toBe(false);
  });

  it("warns when Swell's built-in Mailchimp integration is still on", async () => {
    stubMailchimp({ id: "test-store", list_id: "a6b5da1054", is_syncing: false });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await reconcile(request({ nativeEnabled: true }).req);

    expect(warn.mock.calls.some(([m]) => /built-in Mailchimp integration is still on/.test(String(m)))).toBe(true);
  });
});
