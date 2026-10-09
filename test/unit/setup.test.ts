import { afterEach, describe, expect, it, vi } from "vitest";
import { post as setup } from "../../functions/setup";
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
    app_object_id: "6ab53ef6a2a6910012cd4b95",
  },
};

function request(nativeEnabled: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(200, { account_name: "Test", id: "test-store", list_id: "a6b5da1054" }),
    ),
  );
  return createMockRequest({
    appId: "mailchimp",
    data: { skip_webhook: true } as any,
    swell: {
      settings: vi.fn(async () => SETTINGS),
      get: vi.fn(async (url: string) =>
        url === "/settings/integrations/services/mailchimp" ? { enabled: nativeEnabled } : null,
      ),
    },
  });
}

describe("setup POST", () => {
  it("warns that the built-in Mailchimp integration is still on, as GET does", async () => {
    const response: Record<string, any> = await setup(request(true));

    expect(response.native_integration_enabled).toBe(true);
    expect(response.warning).toMatch(/built-in Mailchimp integration is still on \(Integrations\)/);
  });

  it("adds no warning when the built-in integration is off", async () => {
    const response: Record<string, any> = await setup(request(false));

    expect(response.native_integration_enabled).toBe(false);
    expect(response).not.toHaveProperty("warning");
  });
});
