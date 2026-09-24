import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MailchimpClient,
  MailchimpError,
  retryAfterMs,
} from "../../functions/lib/mailchimp-client";
import { jsonResponse, mailchimpError } from "../helpers/fixtures";
import { stubFetch } from "../helpers/stub-fetch";

/**
 * ===========================================================================
 * REGRESSION SUITE FOR THE THREE CLIENT BUGS THIS APP INHERITED FROM WAVE 1.
 *
 * Every test here pins behaviour that was WRONG before this reconciliation, and every one
 * of the three failed silently — which is why they are pinned rather than left to review.
 *
 *   1. CLASSIFYING ON HTTP STATUS ALONE. Mailchimp carries an application-level status
 *      inside a 200 for several endpoints. Against those, a status-only client does not
 *      degrade, it INVERTS: every failure is recorded as a successful push and the only
 *      symptom is data that never appears in Mailchimp.
 *
 *   2. `X-RateLimit-Reset` READ AS A DELTA. It is a unix timestamp on several vendors;
 *      multiplied by 1000 that is a ~44,000-year sleep, which the inline-wait cap rejects -
 *      so the bug never surfaced as a bug. It degraded invisibly into "never wait inline".
 *
 *   3. NO 429 FALLBACK. Mailchimp's 429 is a concurrency rejection and usually carries no
 *      timing header at all, so a client that only waits when the header is present never
 *      paused for a 429 in its life - which is precisely the case where a short pause is
 *      the correct response.
 *
 * House rule, as everywhere in this scaffold: ASCII-only in `describe()` and `it()` titles.
 * ===========================================================================
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const KEY = "0123456789abcdef0123456789abcde-us14";

// ---------------------------------------------------------------------------
// 1. Body classification
// ---------------------------------------------------------------------------

describe("HTTP 200 with an application-level failure", () => {
  it("throws instead of returning, so a lost write can never read as a delivered one", async () => {
    // The whole point. If this ever returns, the app reports success for every request
    // Mailchimp refused, and nothing anywhere says otherwise.
    stubFetch(jsonResponse(200, mailchimpError(400, "Your merge fields were invalid.")));

    await expect(new MailchimpClient(KEY).getStore("store_1")).rejects.toBeInstanceOf(
      MailchimpError,
    );
  });

  it("records the real HTTP status and keeps the machine-readable code", async () => {
    stubFetch(jsonResponse(200, mailchimpError(404, "Resource not found")));

    let error: MailchimpError | null = null;
    try {
      await new MailchimpClient(KEY).getStore("store_1");
    } catch (err) {
      error = err as MailchimpError;
    }

    // HTTP really was 200. Recording it keeps `status` honest rather than inventing a 4xx
    // that never came off the wire; callers switch on `code`.
    expect(error?.status).toBe(200);
    expect(error?.code).toContain("mailchimp.com/developer");
    expect(error?.message).toContain("Resource not found");
  });

  it("classifies an embedded 4xx as permanent and an embedded 5xx as retryable", async () => {
    // Getting this backwards is silent in both directions: a permanent payload error
    // retried forever takes the handler offline after ~4 days, and a transient failure
    // marked permanent drops the record for good.
    stubFetch(jsonResponse(200, mailchimpError(422, "Invalid resource")));
    await expect(new MailchimpClient(KEY).getStore("s")).rejects.toMatchObject({
      retryable: false,
    });

    stubFetch(jsonResponse(200, mailchimpError(503, "Try later")));
    await expect(new MailchimpClient(KEY).getStore("s")).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("flags the per-member error array the batch-subscribe endpoints return", async () => {
    // `POST /lists/{id}` answers 200 with `{ new_members, errors, error_count }`. A 200
    // carrying `error_count: 2` is two people who were never added.
    stubFetch(
      jsonResponse(200, {
        new_members: [],
        error_count: 2,
        errors: [
          { email_address: "ada@example.com", error: "is already a list member", error_code: "ERROR_CONTACT_EXISTS" },
        ],
      }),
    );

    await expect(
      new MailchimpClient(KEY).request("POST", "/lists/a6b5da1054"),
    ).rejects.toMatchObject({
      retryable: false,
      code: "ERROR_CONTACT_EXISTS",
    });
  });

  it("does NOT mistake a member's string status for an error status", async () => {
    // The false positive that would matter most: `upsertMember` legitimately answers
    // `{ status: "subscribed" }`. A numeric check alone would be fine, but a loose one
    // would fail every successful subscribe in the app.
    stubFetch(jsonResponse(200, { id: "hash", status: "subscribed" }));

    await expect(
      new MailchimpClient(KEY).upsertMember("list_1", "ada@example.com", {}),
    ).resolves.toMatchObject({ status: "subscribed" });
  });

  it("does NOT flag a numeric status with no RFC-7807 fields beside it", async () => {
    // Narrow on purpose: a false positive here fails a push that actually succeeded.
    stubFetch(jsonResponse(200, { id: "x", status: 404 }));
    await expect(new MailchimpClient(KEY).getStore("s")).resolves.toMatchObject({ id: "x" });
  });

  it("leaves an ordinary success untouched", async () => {
    stubFetch(jsonResponse(200, { id: "store_1", currency_code: "USD" }));
    await expect(new MailchimpClient(KEY).getStore("store_1")).resolves.toMatchObject({
      id: "store_1",
    });
  });

  it("still treats an empty 204 as success", async () => {
    // DELETE answers 204 with no body; the body classifier must not see that as a failure.
    stubFetch(new Response("", { status: 204 }));
    await expect(new MailchimpClient(KEY).deleteCart("store_1", "cart_1")).resolves.toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 2. Rate-limit timing
// ---------------------------------------------------------------------------

describe("retryAfterMs", () => {
  it("reads Retry-After as delta-seconds, per RFC 9110", () => {
    const res = new Response("", { headers: { "Retry-After": "2" } });
    expect(retryAfterMs(res, Date.now())).toBe(2000);
  });

  it("reads an ABSOLUTE X-RateLimit-Reset as an instant, not as a delay", () => {
    // THE BUG. Treating an epoch timestamp as a delta asks for a ~44,000-year sleep, which
    // MAX_INLINE_WAIT_MS silently rejects - so it degrades into "never wait inline" with
    // nothing to see. Disambiguated by magnitude, which is unambiguous in practice.
    const now = 1_780_000_000_000;
    const res = new Response("", { headers: { "X-RateLimit-Reset": "1780000003" } });
    expect(retryAfterMs(res, now)).toBe(3000);
  });

  it("still reads a small X-RateLimit-Reset as a delta", () => {
    const res = new Response("", { headers: { "X-RateLimit-Reset": "2" } });
    expect(retryAfterMs(res, Date.now())).toBe(2000);
  });

  it("clamps a reset that is already in the past to zero rather than going negative", () => {
    const now = 1_780_000_000_000;
    const res = new Response("", { headers: { "X-RateLimit-Reset": "1779999000" } });
    expect(retryAfterMs(res, now)).toBe(0);
  });

  it("prefers Retry-After when both headers are present", () => {
    const res = new Response("", {
      headers: { "Retry-After": "1", "X-RateLimit-Reset": "1780000030" },
    });
    expect(retryAfterMs(res, 1_780_000_000_000)).toBe(1000);
  });

  it("returns null when Mailchimp sent no usable timing", () => {
    expect(retryAfterMs(new Response(""), Date.now())).toBeNull();
    expect(
      retryAfterMs(new Response("", { headers: { "Retry-After": "soon" } }), Date.now()),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. The 429 fallback
// ---------------------------------------------------------------------------

describe("429 handling", () => {
  it("waits out a short Retry-After once and retries", async () => {
    const fetchMock = stubFetch([
      jsonResponse(429, {}, { "Retry-After": "1" }),
      jsonResponse(200, { id: "store_1" }),
    ]);

    await expect(new MailchimpClient(KEY).getStore("store_1")).resolves.toMatchObject({
      id: "store_1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still pauses and retries when Mailchimp sends NO timing header at all", async () => {
    // Mailchimp's 429 is a simultaneous-connection rejection and normally carries nothing.
    // Without the jittered fallback this path went straight to "hand it back to the
    // platform", so the client never once paused for a 429 - against the one kind of 429
    // where a sub-second pause is exactly the right answer.
    const fetchMock = stubFetch([
      new Response("", { status: 429 }),
      jsonResponse(200, { id: "store_1" }),
    ]);

    await expect(new MailchimpClient(KEY).getStore("store_1")).resolves.toMatchObject({
      id: "store_1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not wait out a long Retry-After - it hands the event back", async () => {
    // Blocking on 120 seconds inside a 10 second function budget spends the whole
    // invocation and then times out anyway.
    const fetchMock = stubFetch(jsonResponse(429, {}, { "Retry-After": "120" }));

    await expect(new MailchimpClient(KEY).getStore("s")).rejects.toMatchObject({
      status: 429,
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries at most once, so a persistent 429 cannot recurse", async () => {
    const fetchMock = stubFetch([
      new Response("", { status: 429 }),
      new Response("", { status: 429 }),
    ]);

    await expect(new MailchimpClient(KEY).getStore("s")).rejects.toBeInstanceOf(MailchimpError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
