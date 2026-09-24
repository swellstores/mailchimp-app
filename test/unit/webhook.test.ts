import { afterEach, describe, expect, it, vi } from "vitest";
import { get, post } from "../../functions/mailchimp-webhook";
import {
  parseSignatureHeader,
  parseWebhookPayload,
  secretsMatch,
  unflatten,
  verifySignature,
} from "../../functions/lib/webhook-payload";
import { createMockRequest } from "../helpers/mock-request";
import { fetchCalls, stubFetch, type FetchStub } from "../helpers/stub-fetch";
import {
  ACCOUNT_ID,
  account,
  jsonResponse,
  listResponse,
  mailchimpError,
  mailchimpMember,
  mailchimpWebhookForm,
  withSyncState,
} from "../helpers/fixtures";

/**
 * The inbound webhook route: parsing, authentication, and the write-back that is the
 * whole reason two-way sync exists.
 *
 * Swell is stubbed at the object level throughout. Mailchimp is stubbed at `fetch`: the
 * route confirms every change by reading the member back (`lib/webhook-confirm.ts`), because
 * on Swell today neither the URL secret nor the signature reaches it intact.
 */

/**
 * Mailchimp's member endpoint, keyed by lowercased address. `null` answers 404; a number
 * answers that status with an error envelope.
 */
function stubMembers(members: Record<string, Record<string, any> | null | number>): FetchStub {
  return stubFetch((input) => {
    const url = String(input instanceof Request ? input.url : input);
    const email = decodeURIComponent(url.split("/members/")[1] ?? "").toLowerCase();
    const member = members[email];
    if (typeof member === "number") return jsonResponse(member, mailchimpError(member, "boom"));
    if (!member) return jsonResponse(404, mailchimpError(404, "The requested resource could not be found."));
    return jsonResponse(200, member);
  });
}

const UNSUBSCRIBED = { "ada@example.com": mailchimpMember({ status: "unsubscribed" }) };

const SECRET = "a-long-enough-secret";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function appSettings(overrides: Record<string, any> = {}) {
  return {
    mailchimp: {
      enabled: true,
      api_key: "0123456789abcdef-us14",
      list_id: "a6b5da1054",
      webhook_secret: SECRET,
      webhook_writeback: true,
      ...overrides,
    },
  };
}

/**
 * Builds a request shaped like a real Mailchimp delivery: form-encoded raw bytes, the
 * shared secret in the query string.
 */
function webhookRequest(
  form: string,
  options: {
    settings?: Record<string, any>;
    accounts?: Array<Record<string, any>>;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    put?: ReturnType<typeof vi.fn>;
    members?: Record<string, Record<string, any> | null | number>;
  } = {},
) {
  const put = options.put ?? vi.fn(async () => ({}));
  const mailchimp = stubMembers(options.members ?? UNSUBSCRIBED);
  const accounts = options.accounts ?? [account()];
  let getCall = 0;
  const swell = {
    settings: vi.fn(async () => options.settings ?? appSettings()),
    // `findAccountByEmail` tries the account email first, then `remote_email`.
    get: vi.fn(async () => listResponse(getCall++ === 0 ? accounts : [])),
    put,
  };

  const req = createMockRequest({
    swell,
    appId: "mailchimp",
    rawBody: form,
    // `req.body` is what the platform parsed; for a form delivery it is not what the
    // handler relies on, which is precisely what the raw-body path is for.
    data: {} as any,
    query: options.query ?? { secret: SECRET },
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(options.headers ?? {}),
    },
  });

  return { req, swell, put, mailchimp };
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

describe("parseWebhookPayload", () => {
  it("parses Mailchimp's real wire format: form-encoded with bracket keys", () => {
    const form = mailchimpWebhookForm("unsubscribe", {
      email: "ada@example.com",
      list_id: "a6b5da1054",
      action: "unsub",
      reason: "manual",
    });

    const event = parseWebhookPayload(form);

    expect(event.type).toBe("unsubscribe");
    expect(event.fired_at).toBe("2026-08-07 09:00:00");
    expect(event.data.email).toBe("ada@example.com");
    expect(event.data.reason).toBe("manual");
  });

  it("accepts a flat object of literal bracket keys", () => {
    // How the platform hands a form body to a route function is not documented, so the
    // parser accepts every plausible shape rather than betting on one.
    const event = parseWebhookPayload({
      type: "cleaned",
      fired_at: "2026-08-07 09:00:00",
      "data[email]": "ada@example.com",
      "data[reason]": "hard",
    });

    expect(event.type).toBe("cleaned");
    expect(event.data).toEqual({ email: "ada@example.com", reason: "hard" });
  });

  it("accepts an already-nested object, which is what `swell api post` produces", () => {
    const event = parseWebhookPayload({
      type: "upemail",
      fired_at: "x",
      data: { old_email: "a@b.c", new_email: "d@e.f" },
    });
    expect(event.data.new_email).toBe("d@e.f");
  });

  it("sniffs a JSON string rather than shredding it through URLSearchParams", () => {
    const event = parseWebhookPayload(
      JSON.stringify({ type: "unsubscribe", fired_at: "x", data: { email: "a@b.c" } }),
    );
    expect(event.type).toBe("unsubscribe");
    expect(event.data.email).toBe("a@b.c");
  });

  it("returns an empty event rather than throwing on junk", () => {
    expect(parseWebhookPayload(null).type).toBe("");
    expect(parseWebhookPayload(42).data).toEqual({});
    expect(parseWebhookPayload("").type).toBe("");
  });
});

describe("unflatten", () => {
  it("nests multi-level bracket keys", () => {
    expect(
      unflatten([
        ["data[merges][FNAME]", "Ada"],
        ["data[email]", "ada@example.com"],
      ]),
    ).toEqual({ data: { merges: { FNAME: "Ada" }, email: "ada@example.com" } });
  });

  it("caps nesting depth on an attacker-controlled body", () => {
    // The body is untrusted right up until the secret is checked; unbounded nesting is a
    // cheap way to burn the function's budget.
    const deep = `a${"[b]".repeat(50)}`;
    const out = unflatten([[deep, "x"]]);
    let depth = 0;
    let cursor: any = out;
    while (cursor && typeof cursor === "object") {
      depth += 1;
      cursor = Object.values(cursor)[0];
    }
    expect(depth).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("secretsMatch", () => {
  it("compares without short-circuiting on content", () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
    expect(secretsMatch("a-long-enough-secreT", SECRET)).toBe(false);
    expect(secretsMatch("", SECRET)).toBe(false);
    expect(secretsMatch(SECRET, "")).toBe(false);
  });
});

describe("webhook authentication", () => {
  it("accepts a delivery with no secret once Mailchimp confirms the change", async () => {
    // What a real delivery looks like on Swell today: the platform drops the query string
    // from a POST that has a body, so the secret never arrives. Asana 1218816382065204.
    const { req, put, mailchimp } = webhookRequest(
      mailchimpWebhookForm("unsubscribe", { email: "ada@example.com" }),
      { query: {} },
    );

    const result: any = await post(req);

    expect(result).toMatchObject({ ok: true, event: "unsubscribe" });
    expect(fetchCalls(mailchimp)[0].url).toContain("/lists/a6b5da1054/members/ada%40example.com");
    expect(put.mock.calls[0][1].email_optin).toBe(false);
  });

  it("does not apply a forged unsubscribe for a member who is still subscribed", async () => {
    // The whole security model: the caller's claim is checked against Mailchimp, and
    // Mailchimp says otherwise, so nothing is written.
    const { req, put } = webhookRequest(
      mailchimpWebhookForm("unsubscribe", { email: "ada@example.com" }),
      { query: {}, members: { "ada@example.com": mailchimpMember({ status: "subscribed" }) } },
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result: any = await post(req);

    expect(result.ignored).toMatch(/"subscribed", not "unsubscribed"/);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a delivery with the wrong secret", async () => {
    const { req } = webhookRequest(mailchimpWebhookForm("unsubscribe", {}), {
      query: { secret: "nope" },
    });
    await expect(post(req)).rejects.toMatchObject({ status: 401 });
  });

  it("applies nothing when there is no API key to confirm the change with", async () => {
    // Otherwise an unconfigured app would be an unauthenticated public write route.
    const { req, put, mailchimp } = webhookRequest(
      mailchimpWebhookForm("unsubscribe", { email: "ada@example.com" }),
      { settings: appSettings({ api_key: "" }), query: {} },
    );

    const result: any = await post(req);

    expect(result.ignored).toMatch(/API key/);
    expect(mailchimp).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("accepts the secret from the body, which is where `swell api post` puts it", async () => {
    // `swell api post '/functions/…?secret=x'` folds the query string into `req.body` and
    // leaves `req.query` empty. Drop that branch and the route cannot be tested from the CLI.
    const swell = {
      settings: vi.fn(async () => appSettings()),
      get: vi.fn(async () => listResponse([account()])),
      put: vi.fn(async () => ({})),
    };
    stubMembers(UNSUBSCRIBED);
    const req = createMockRequest({
      swell,
      appId: "mailchimp",
      query: {},
      data: {
        secret: SECRET,
        type: "unsubscribe",
        fired_at: "2026-08-07 09:00:00",
        data: { email: "ada@example.com" },
      } as any,
    });

    const result: any = await post(req);
    expect(result.ok).toBe(true);
    expect(result.event).toBe("unsubscribe");
  });

  it("answers Mailchimp's validation GET without authentication", async () => {
    // Mailchimp fetches the URL before creating the subscription. A route that refuses
    // that GET fails registration with an error that says nothing about the cause.
    await expect(get()).resolves.toEqual({ ok: true });
  });
});

describe("signature verification", () => {
  const SIGNING_SECRET = "whsec-test";

  async function sign(body: string, timestamp: number): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(SIGNING_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`));
    const hex = [...new Uint8Array(mac)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `t=${timestamp},v1=${hex}`;
  }

  it("parses the header Mailchimp sends", () => {
    expect(parseSignatureHeader(`t=1718000000,v1=${"a".repeat(64)}`)).toEqual({
      timestamp: 1718000000,
      signature: "a".repeat(64),
    });
    expect(parseSignatureHeader("garbage")).toBeNull();
    expect(parseSignatureHeader("t=1718000000,v1=short")).toBeNull();
  });

  it("verifies a genuine signature over the raw body", async () => {
    const body = mailchimpWebhookForm("unsubscribe", { email: "ada@example.com" });
    const now = 1_800_000_000_000;
    const header = await sign(body, Math.floor(now / 1000));
    expect(await verifySignature(body, header, SIGNING_SECRET, now)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, and a stale timestamp", async () => {
    const body = mailchimpWebhookForm("unsubscribe", { email: "ada@example.com" });
    const now = 1_800_000_000_000;
    const header = await sign(body, Math.floor(now / 1000));

    expect(await verifySignature(`${body}&extra=1`, header, SIGNING_SECRET, now)).toBe(false);
    expect(await verifySignature(body, header, "wrong", now)).toBe(false);
    // Five minutes is Mailchimp's own guidance and what stops a captured delivery being
    // replayed later.
    expect(await verifySignature(body, header, SIGNING_SECRET, now + 6 * 60 * 1000)).toBe(false);
  });

  it("does not reject on a signature that fails, and confirms with Mailchimp instead", async () => {
    // `req.rawBody` is a re-serialised copy on Swell today, so a genuine signature fails
    // too. Rejecting would drop every signed delivery.
    const form = mailchimpWebhookForm("unsubscribe", { email: "ada@example.com" });
    const { req, put } = webhookRequest(form, {
      settings: appSettings({ webhook_signing_secret: SIGNING_SECRET }),
      headers: { "x-mailchimp-signature": `t=1718000000,v1=${"a".repeat(64)}` },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result: any = await post(req);

    expect(result.event).toBe("unsubscribe");
    expect(put).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/signature did not verify/);
  });

  it("still rejects a wrong URL secret even when signing is configured", async () => {
    const form = mailchimpWebhookForm("unsubscribe", { email: "ada@example.com" });
    const now = Date.now();
    const { req } = webhookRequest(form, {
      settings: appSettings({ webhook_signing_secret: SIGNING_SECRET }),
      query: { secret: "wrong" },
      headers: { "x-mailchimp-signature": await sign(form, Math.floor(now / 1000)) },
    });
    // A valid signature must not be able to substitute for the shared secret.
    await expect(post(req)).rejects.toMatchObject({ status: 401 });
  });
});

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

describe("webhook handling", () => {
  it("clears email_optin on the Swell account for an unsubscribe", async () => {
    const form = mailchimpWebhookForm("unsubscribe", {
      email: "ada@example.com",
      action: "unsub",
      reason: "manual",
    });
    const { req, put } = webhookRequest(form);

    const result: any = await post(req);

    expect(result).toMatchObject({ ok: true, event: "unsubscribe", record_id: ACCOUNT_ID });
    expect(put).toHaveBeenCalledTimes(1);

    const [url, body] = put.mock.calls[0];
    expect(url).toBe(`/accounts/${ACCOUNT_ID}`);
    // The point of the whole app: the opt-out lands where the rest of Swell can see it.
    expect(body.email_optin).toBe(false);
    // …and carries the marker that stops accounts-sync pushing it straight back out.
    expect(body.$app.mailchimp.last_webhook_at).toBeTruthy();
    expect(body.$app.mailchimp.list_status).toBe("unsubscribed");
  });

  it("treats a cleaned address as an opt-out too", async () => {
    const form = mailchimpWebhookForm("cleaned", {
      email: "ada@example.com",
      reason: "hard",
    });
    const { req, put } = webhookRequest(form, {
      members: { "ada@example.com": mailchimpMember({ status: "cleaned" }) },
    });

    await post(req);

    const body = put.mock.calls[0][1];
    expect(body.email_optin).toBe(false);
    expect(body.$app.mailchimp.list_status).toBe("cleaned");
  });

  it("writes the new address on an email change", async () => {
    const form = mailchimpWebhookForm("upemail", {
      old_email: "ada@example.com",
      new_email: "ada.lovelace@example.com",
    });
    const { req, put } = webhookRequest(form, {
      members: {
        "ada.lovelace@example.com": mailchimpMember({ email_address: "ada.lovelace@example.com" }),
        "ada@example.com": null,
      },
    });

    const result: any = await post(req);

    expect(result.applied).toEqual(["email"]);
    const body = put.mock.calls[0][1];
    expect(body.email).toBe("ada.lovelace@example.com");
    expect(body.email_optin).toBeUndefined();
    expect(body.$app.mailchimp.remote_email).toBe("ada.lovelace@example.com");
  });

  it("records a profile update without overwriting Swell's own fields", async () => {
    const form = mailchimpWebhookForm("profile", { email: "ada@example.com" });
    const { req, put } = webhookRequest(form, {
      members: { "ada@example.com": mailchimpMember({ status: "subscribed" }) },
    });

    const result: any = await post(req);

    expect(result.applied).toEqual([]);
    // Only the app's own namespace — the merchant's record is not Mailchimp's to edit.
    expect(Object.keys(put.mock.calls[0][1])).toEqual(["$app"]);
    expect(put.mock.calls[0][1].$app.mailchimp.list_status).toBe("subscribed");
  });

  it("stamps state but writes nothing outside $app when write-back is switched off", async () => {
    const form = mailchimpWebhookForm("unsubscribe", { email: "ada@example.com" });
    const { req, put } = webhookRequest(form, {
      settings: appSettings({ webhook_writeback: false }),
    });

    await post(req);

    expect(Object.keys(put.mock.calls[0][1])).toEqual(["$app"]);
    expect(put.mock.calls[0][1].$app.mailchimp.list_status).toBe("unsubscribed");
  });

  it("skips a redelivery of the same fired_at instead of applying it twice", async () => {
    // Mailchimp sends no delivery id, so `fired_at` plus the event type is the dedupe key.
    // Mailchimp retries for 75 minutes, so redeliveries are routine, not exotic.
    const form = mailchimpWebhookForm("unsubscribe", { email: "ada@example.com" });
    const { req, put } = webhookRequest(form, {
      accounts: [
        withSyncState(account(), {
          last_webhook_event: "unsubscribe",
          last_webhook_fired_at: "2026-08-07 09:00:00",
        }),
      ],
    });

    const result: any = await post(req);

    expect(result.deduped).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it("ignores an event type it does not handle", async () => {
    const { req, put } = webhookRequest(
      mailchimpWebhookForm("subscribe", { email: "ada@example.com" }),
    );
    const result: any = await post(req);
    expect(result.ignored).toMatch(/subscribe/);
    expect(put).not.toHaveBeenCalled();
  });

  it("ignores an address that is not a Swell customer", async () => {
    // Mailchimp audiences routinely hold addresses that were never Swell customers —
    // imports, signup forms, other stores sharing the audience.
    const { req, put } = webhookRequest(
      mailchimpWebhookForm("unsubscribe", { email: "stranger@example.com" }),
      { accounts: [] },
    );
    const result: any = await post(req);
    expect(result.ignored).toMatch(/No Swell account/);
    expect(put).not.toHaveBeenCalled();
  });

  it("acknowledges with 200 while the app is switched off", async () => {
    // 200, not 4xx: Mailchimp disables a subscription that keeps failing, and "the app is
    // switched off" is not a delivery problem.
    const { req, put } = webhookRequest(
      mailchimpWebhookForm("unsubscribe", { email: "ada@example.com" }),
      { settings: appSettings({ enabled: false }) },
    );
    const result: any = await post(req);
    expect(result).toMatchObject({ ok: true });
    expect(result.ignored).toMatch(/turned off/);
    expect(put).not.toHaveBeenCalled();
  });

  it("does not write when the account is already opted out", async () => {
    const { req, put } = webhookRequest(
      mailchimpWebhookForm("unsubscribe", { email: "ada@example.com" }),
      { accounts: [account({ email_optin: false })] },
    );

    const result: any = await post(req);

    expect(result.applied).toEqual([]);
    // Only the $app stamp: re-writing an unchanged field would fire another
    // `account.updated` for nothing.
    expect(Object.keys(put.mock.calls[0][1])).toEqual(["$app"]);
  });

  it("ignores an email change while the old address is still a separate member", async () => {
    // Without this check a forged upemail could point a Swell account at some other
    // subscriber's address.
    const form = mailchimpWebhookForm("upemail", {
      old_email: "ada@example.com",
      new_email: "someone.else@example.com",
    });
    const { req, put } = webhookRequest(form, {
      members: {
        "someone.else@example.com": mailchimpMember({ email_address: "someone.else@example.com" }),
        "ada@example.com": mailchimpMember(),
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result: any = await post(req);

    expect(result.ignored).toMatch(/still has ada@example.com/);
    expect(put).not.toHaveBeenCalled();
  });

  it("ignores an address Mailchimp has no member for", async () => {
    const { req, put } = webhookRequest(
      mailchimpWebhookForm("unsubscribe", { email: "ada@example.com" }),
      { members: { "ada@example.com": null } },
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result: any = await post(req);

    expect(result.ignored).toMatch(/no member/);
    expect(put).not.toHaveBeenCalled();
  });

  it("ignores a delivery for a different audience without calling Mailchimp", async () => {
    const { req, put, mailchimp } = webhookRequest(
      mailchimpWebhookForm("unsubscribe", { email: "ada@example.com", list_id: "other123" }),
    );

    const result: any = await post(req);

    expect(result.ignored).toMatch(/audience other123/);
    expect(mailchimp).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("answers 503 when Mailchimp cannot be reached to confirm, so Mailchimp retries", async () => {
    const { req, put } = webhookRequest(
      mailchimpWebhookForm("unsubscribe", { email: "ada@example.com" }),
      { members: { "ada@example.com": 500 } },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(post(req)).rejects.toMatchObject({ status: 503 });
    expect(put).not.toHaveBeenCalled();
  });

  it("reports a failed write-back rather than acknowledging a change it did not make", async () => {
    // Returning 200 here would tell Mailchimp the unsubscribe was applied when it was not,
    // and Mailchimp would never retry it.
    const put = vi.fn(async () => {
      throw new Error("admin API unavailable");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { req } = webhookRequest(
      mailchimpWebhookForm("unsubscribe", { email: "ada@example.com" }),
      { put },
    );

    await expect(post(req)).rejects.toMatchObject({ status: 503 });
  });
});
