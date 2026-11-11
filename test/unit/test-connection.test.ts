import { afterEach, describe, expect, it, vi } from "vitest";
import testConnection from "../../functions/test-connection";
import { createMockRequest } from "../helpers/mock-request";
import { jsonResponse } from "../helpers/fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function request(settings: Record<string, unknown>, respond: (url: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => respond(String(url))));
  return createMockRequest({
    swell: {
      settings: vi.fn(async () => ({ mailchimp: settings })),
      get: vi.fn(async () => ({ enabled: false })),
    },
  });
}

const SETTINGS = { api_key: "0123456789abcdef-us14", list_id: "a6b5da1054" };

describe("test-connection action", () => {
  it("names the account and audience it reached", async () => {
    const req = request(SETTINGS, (url) =>
      url.includes("/lists/")
        ? jsonResponse(200, { id: "a6b5da1054", name: "Newsletter" })
        : jsonResponse(200, { account_name: "Acme" }),
    );

    await expect(testConnection(req)).resolves.toEqual({
      message: "Connected to Mailchimp account Acme, audience Newsletter.",
    });
  });

  it("asks for the missing settings before calling Mailchimp", async () => {
    const req = request({}, () => jsonResponse(200, {}));

    await expect(testConnection(req)).rejects.toThrow(
      "Add the API key and audience ID and save the settings first.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says the key was rejected on a 401", async () => {
    const req = request(SETTINGS, () =>
      jsonResponse(401, { title: "API Key Invalid", status: 401, detail: "Your API key may be invalid." }),
    );

    await expect(testConnection(req)).rejects.toThrow(/didn't accept the API key/);
  });

  it("fails when the audience ID is not in the account", async () => {
    const req = request(SETTINGS, (url) =>
      url.includes("/lists/")
        ? jsonResponse(404, { title: "Resource Not Found", status: 404 })
        : jsonResponse(200, { account_name: "Acme" }),
    );

    await expect(testConnection(req)).rejects.toThrow(/has no audience with the ID a6b5da1054/);
  });
});
