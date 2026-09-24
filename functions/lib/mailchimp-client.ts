/**
 * Mailchimp Marketing API v3 client — layer 1 of the three-layer error model.
 *
 * Layer 1 (here) classifies every transport failure into `MailchimpError`, which carries
 * `retryable`. Layer 2 (`push.ts`) turns that into a result object and records it.
 * Layer 3 (`push.ts#throwIfFailed`) turns the result into a platform retry decision.
 *
 * Three things about Mailchimp shape this file:
 *
 *  1. **The base URL comes from the credential.** An API key ends in a datacenter suffix
 *     (`…-us14`) and only that datacenter will answer for it. `resolveApiBase()` in
 *     settings.ts derives it; `api_base` is an override, not the source of truth.
 *
 *  2. **The ecommerce resources are not uniformly upsertable.** Customers, products,
 *     product variants, orders and audience members all have a PUT add-or-update.
 *     **Carts and stores do not** — they are POST-to-create, PATCH-to-update, which is why
 *     `upsertCart()` below is the only method that takes a "does it already exist?" hint.
 *     Verified against Mailchimp's own OpenAPI spec (3.0.91), not inferred.
 *
 *     The starter expresses this as one generic `writeRecord()` create/update selector with
 *     409 recovery. This app keeps its **per-collection methods** instead, deliberately:
 *     Mailchimp's resources are non-uniform in *three* ways at once — the method (PUT vs
 *     POST/PATCH), the path (`/ecommerce/stores/<store>/…` vs `/lists/<list>/…`), and the
 *     duplicate signal (400 with a message, not 409) — and a single selector parameterised
 *     over all three is harder to read than the four methods it replaces. The starter's
 *     invariant is honoured where it matters: the key is always the Swell record id, and
 *     `push.ts#sendPayload` is the one place that chooses per collection.
 *
 *  3. **`send()` classifies twice, and the second step is not optional.** Transport
 *     (`res.ok`) first, then the body (`classifyBody()`). Mailchimp carries an
 *     application-level status inside a 200 for several endpoints — see `classifyBody`.
 */

import {
  MailchimpSettings,
  resolveApiBase,
} from './settings';

/**
 * Functions get a hard 10 second budget. Mailchimp's own documented request timeout is
 * 120s, which is an eternity we do not have, so every call is bounded here: the difference
 * between a visible error recorded on the record and a silent timeout is whether there is
 * budget left to write it down. Paths that make two calls in one invocation (create-then-
 * fallback, provision-then-push) have to fit both budgets plus the sync-state write in 10s.
 */
const DEFAULT_TIMEOUT_MS = 4000;

/** Tighter budget for advisory or second-chance calls inside an already-spent invocation. */
export const PROBE_TIMEOUT_MS = 2000;

/**
 * How long we are willing to block on a 429 before giving up and letting the platform
 * redeliver. Anything longer would eat the budget above with nothing to show for it.
 */
const MAX_INLINE_WAIT_MS = 2000;

/**
 * Fallback pause for a 429 that carries **no** timing header at all.
 *
 * Mailchimp's 429 is a *concurrency* rejection ("more than 10 simultaneous connections")
 * rather than a quota window, and it usually arrives with no hint whatsoever — so before
 * this amendment the client never paused for a 429 in its life and went straight to handing
 * the event back. One short pause and one inline retry is cheaper than a platform
 * redelivery, and against a concurrency limit it is exactly the right response.
 *
 * Jittered by up to `DEFAULT_429_JITTER_MS`, because every function in the fleet waking at
 * the same moment is how a throttle becomes an outage.
 */
const DEFAULT_429_WAIT_MS = 600;
const DEFAULT_429_JITTER_MS = 400;

export class MailchimpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly body: unknown;
  /**
   * Mailchimp's own machine-readable failure code, when it sent one. Populated from
   * `classifyBody()` for the endpoints that answer 200 on failure, and from the error body
   * otherwise. Callers switch on this rather than parsing `message`.
   */
  readonly code: string | null;

  constructor(
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      body?: unknown;
      code?: string | null;
    } = {},
  ) {
    super(message);
    this.name = 'MailchimpError';
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.body = options.body;
    this.code = options.code ?? null;
  }
}

/** Anything can be thrown; this is the one place that turns it into a message. */
export function errorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === 'string' ? err : JSON.stringify(err);
}

/** True when Mailchimp says the resource does not exist — the cue to create it instead. */
export function isNotFound(err: unknown): boolean {
  return err instanceof MailchimpError && err.status === 404;
}

/**
 * True when Mailchimp refused to subscribe an address because it is in a compliance state:
 * the person unsubscribed themselves, bounced, or was reported. An app may not subscribe
 * them again; setting them to `pending` makes Mailchimp ask them to confirm instead.
 */
export function isComplianceState(err: unknown): boolean {
  return (
    err instanceof MailchimpError &&
    err.status === 400 &&
    /compliance state|member in compliance/i.test(`${err.message} ${JSON.stringify(err.body ?? '')}`)
  );
}

/**
 * True when Mailchimp rejected a create because the record is already there. Mailchimp
 * answers 400 rather than 409 for this, so the message is the only signal.
 */
export function isAlreadyExists(err: unknown): boolean {
  return (
    err instanceof MailchimpError &&
    err.status === 400 &&
    /already exists|already a store|duplicate/i.test(err.message)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBody(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A rate-limit reset header that is an **absolute** unix timestamp rather than a delta is
 * always larger than this; a sane retry delay never is. Nothing waits ~11.5 days, and no
 * epoch second since 1970-01-12 is smaller.
 */
const EPOCH_THRESHOLD_SECONDS = 1_000_000;

/**
 * How long to wait before retrying a rate-limited request, in milliseconds — or `null` when
 * the vendor gave no usable timing.
 *
 * ---------------------------------------------------------------------------------------
 * THE TWO HEADERS DO NOT MEAN THE SAME THING, AND THIS USED TO TREAT THEM AS IF THEY DID.
 *
 * The previous implementation read `Retry-After`, fell back to `X-RateLimit-Reset`, and
 * multiplied **both** by 1000 as a seconds-delta. `Retry-After` really is a delta per RFC
 * 9110. `X-RateLimit-Reset` very often is not — it is a UNIX timestamp in seconds on several
 * vendors, whose example values look like `1392815263`. Multiplying that by 1000 and calling
 * it a delay asks for a ~44,000-year sleep, which `MAX_INLINE_WAIT_MS` silently rejects, so
 * the bug never surfaces as a bug. It degrades invisibly into "never wait inline, always
 * hand the event back".
 *
 * Disambiguating by magnitude is unambiguous in practice, which is why it is done by
 * magnitude and not by configuration.
 * ---------------------------------------------------------------------------------------
 *
 * `nowMs` is injectable so the epoch branch is testable without freezing the clock.
 */
export function retryAfterMs(res: Response, nowMs: number = Date.now()): number | null {
  // RFC 9110: delta-seconds. (An HTTP-date is also legal here and rare enough in practice
  // that vendors documenting one get an explicit branch rather than a speculative parser.)
  const retryAfter = res.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }

  const reset = res.headers.get('X-RateLimit-Reset');
  if (!reset) {
    return null;
  }
  const value = Number(reset);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  if (value >= EPOCH_THRESHOLD_SECONDS) {
    // Absolute: seconds since the epoch. Clamped at 0 so a clock skew that puts the reset
    // in the past reads as "retry now" rather than as a negative sleep.
    return Math.max(0, value * 1000 - nowMs);
  }
  return value * 1000;
}

/**
 * Mailchimp errors are RFC-7807 problem documents: `{ type, title, status, detail,
 * instance }`, plus an optional `errors: [{ field, message }]` on validation failures.
 * The field-level messages are the useful half — "lines.0.product_id is required" tells a
 * merchant something, "Bad Request" does not — so they are folded into the message.
 *
 * Mailchimp also documents that at high volume a 429 or 403 can arrive with **no body at
 * all**, so nothing here may assume a parseable payload.
 */
function describeError(status: number, parsed: unknown, raw: string): string {
  const record = (parsed ?? {}) as Record<string, unknown>;
  const detail =
    (typeof record.detail === 'string' && record.detail) ||
    (typeof record.title === 'string' && record.title) ||
    raw.slice(0, 200) ||
    'no response body';

  const fieldErrors = Array.isArray(record.errors)
    ? (record.errors as Array<Record<string, unknown>>)
        .map((entry) => {
          const field = typeof entry?.field === 'string' ? entry.field : '';
          const message = typeof entry?.message === 'string' ? entry.message : '';
          return field ? `${field}: ${message}` : message;
        })
        .filter(Boolean)
        .slice(0, 5)
    : [];

  // The `instance` id is a UUID Mailchimp support can look up. Worth the characters.
  const instance = typeof record.instance === 'string' ? ` [instance ${record.instance}]` : '';
  const fields = fieldErrors.length > 0 ? ` (${fieldErrors.join('; ')})` : '';

  return `Mailchimp returned ${status}: ${detail}${fields}${instance}`;
}

export interface SendOptions {
  body?: unknown;
  timeoutMs?: number;
  /** Set on the single inline retry after a short 429 wait; prevents unbounded recursion. */
  alreadyWaited?: boolean;
}

export interface BatchOperation {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** Mailchimp wants the operation body as a JSON **string**, not an object. */
  body?: string;
  operation_id?: string;
}

export interface BatchStatus {
  id: string;
  status: 'pending' | 'preprocessing' | 'started' | 'finalizing' | 'finished';
  total_operations?: number;
  finished_operations?: number;
  errored_operations?: number;
  submitted_at?: string;
  completed_at?: string;
  response_body_url?: string;
}

export interface ListWebhook {
  id: string;
  url: string;
  events?: Record<string, boolean>;
  sources?: Record<string, boolean>;
}

export class MailchimpClient {
  readonly apiBase: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  /**
   * Accepts either the whole settings object (what handlers have, and the only form that
   * can honour the `api_base` override) or a bare API key (what a unit test wants, so a
   * transport test does not have to build a full settings object).
   */
  constructor(auth: string | Partial<MailchimpSettings>, options: { timeoutMs?: number } = {}) {
    const settings: Partial<MailchimpSettings> =
      typeof auth === 'string' ? { api_key: auth } : auth;

    const base = resolveApiBase(settings);
    if (!base) {
      // Never guess a datacenter. A key sent to the wrong one comes back 401, which reads
      // as "your credential is wrong" and sends the merchant hunting the wrong problem.
      throw new MailchimpError(
        'Cannot derive the Mailchimp API host: the API key has no datacenter suffix and no API base URL override is set.',
        { status: 0, retryable: false },
      );
    }
    this.apiBase = base;

    // Mailchimp documents HTTP Basic with any username: `--user 'anystring:APIKEY'`.
    // Bearer works too, but Basic is what the official docs and every client library use,
    // so it is the shape their support team recognises.
    this.headers = {
      Authorization: `Basic ${btoa(`swell:${settings.api_key ?? ''}`)}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * **Classification step 2 — Mailchimp's own status, inside a 2xx body.**
   *
   * =======================================================================================
   * MAILCHIMP CARRIES AN APPLICATION-LEVEL STATUS INSIDE A 200, AND A STATUS-ONLY CLIENT
   * DOES NOT DEGRADE AGAINST THAT — IT **INVERTS**.
   *
   * Two shapes, both real:
   *
   *  1. An RFC-7807 problem document with a 4xx/5xx `status` field returned under HTTP 200.
   *     Mailchimp does this for sub-operations and for several endpoints that answer "the
   *     request was received, the operation failed". Reading only `res.ok` records every one
   *     of those as a successful push.
   *  2. `POST /lists/{id}` (batch subscribe) answers 200 with
   *     `{ new_members: [...], errors: [{ email_address, error, error_code }], error_count }`.
   *     A 200 with `error_count: 3` is three people who were never added, reported as a
   *     delivered write.
   *
   * The check is deliberately narrow, because a false positive here fails a push that
   * actually succeeded. A numeric `status` alone is not enough: `upsertMember` legitimately
   * returns `{ status: "subscribed" }`, which is a *string*, and the store/product/order
   * bodies carry no `status` at all. So the problem-document branch requires a numeric
   * `status >= 400` **and** an RFC-7807 `detail` or `title` beside it.
   * =======================================================================================
   */
  protected classifyBody(
    parsed: unknown,
    res: Response,
  ): { error: string; retryable: boolean; code?: string } | null {
    void res;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const payload = parsed as Record<string, any>;

    // Shape 1: an RFC-7807 problem document smuggled inside a 2xx.
    if (
      typeof payload.status === 'number' &&
      payload.status >= 400 &&
      (typeof payload.detail === 'string' || typeof payload.title === 'string')
    ) {
      return {
        error: describeError(payload.status, payload, ''),
        // Same rule as the transport layer: 429 and 5xx are transient, every other 4xx is
        // our payload or our credential and reproduces exactly on retry.
        retryable: payload.status === 429 || payload.status >= 500,
        code: typeof payload.type === 'string' ? payload.type : String(payload.status),
      };
    }

    // Shape 2: the per-item error array on the batch-subscribe endpoints.
    if (typeof payload.error_count === 'number' && payload.error_count > 0) {
      const first = Array.isArray(payload.errors) ? payload.errors[0] : null;
      const detail =
        (first && typeof first.error === 'string' && first.error) || 'no detail supplied';
      return {
        error:
          `Mailchimp accepted the request but rejected ${payload.error_count} member(s): ${detail}`,
        // Per-member validation failures reproduce identically on every retry.
        retryable: false,
        code:
          first && typeof first.error_code === 'string' ? first.error_code : 'member_errors',
      };
    }

    return null;
  }

  /** Absolute-URL send. Everything funnels through here, including paginated follow-ups. */
  protected async send<T>(method: string, url: string, options: SendOptions = {}): Promise<T> {
    const { body, alreadyWaited = false } = options;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Timeout and network failure are both "we never learned the outcome". Retryable:
      // Mailchimp may or may not have applied the change, and every write is keyed on the
      // Swell record id, so a redelivery is safe.
      const timedOut =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new MailchimpError(
        timedOut
          ? `Mailchimp did not respond within ${timeoutMs}ms`
          : `Could not reach Mailchimp: ${errorText(err)}`,
        { retryable: true },
      );
    }

    // ---- Classification step 1: transport -------------------------------------------------
    // A short, explicit backoff is cheaper to honour inline than to hand back to the
    // platform. Exactly one inline retry — `alreadyWaited` is what bounds it.
    if (res.status === 429 && !alreadyWaited) {
      // Mailchimp's 429 usually carries no timing header at all, so it still gets one short
      // jittered pause rather than "never wait inline". See DEFAULT_429_WAIT_MS.
      const wait =
        retryAfterMs(res) ??
        DEFAULT_429_WAIT_MS + Math.floor(Math.random() * DEFAULT_429_JITTER_MS);
      if (wait <= MAX_INLINE_WAIT_MS) {
        await sleep(wait);
        return this.send<T>(method, url, { ...options, alreadyWaited: true });
      }
    }

    const raw = await res.text();
    const parsed = parseBody(raw);

    if (!res.ok) {
      throw new MailchimpError(describeError(res.status, parsed, raw), {
        status: res.status,
        // 429 is Mailchimp's simultaneous-connection limit and every 5xx is transient:
        // hand them back so the platform redelivers. Every other 4xx is our payload or our
        // credential — retrying reproduces it exactly, so record it once and stop.
        retryable: res.status === 429 || res.status >= 500,
        body: parsed ?? raw,
        code: typeof (parsed as any)?.type === 'string' ? (parsed as any).type : null,
      });
    }

    // ---- Classification step 2: the body --------------------------------------------------
    // Mailchimp answers 200 on failure for more than one endpoint. Without this step every
    // one of those failures is recorded as a successful push. See `classifyBody`.
    const classified = this.classifyBody(parsed, res);
    if (classified) {
      if (classified.retryable && !alreadyWaited) {
        const wait = retryAfterMs(res);
        if (wait !== null && wait > 0 && wait <= MAX_INLINE_WAIT_MS) {
          await sleep(wait);
          return this.send<T>(method, url, { ...options, alreadyWaited: true });
        }
      }
      throw new MailchimpError(classified.error, {
        // HTTP really was 2xx. Recording it keeps `status` honest rather than inventing a
        // 4xx that never came off the wire; `code` is what callers should switch on.
        status: res.status,
        retryable: classified.retryable,
        body: parsed ?? raw,
        code: classified.code ?? null,
      });
    }

    // 204 No Content is the normal answer to DELETE.
    return (parsed ?? {}) as T;
  }

  /** Path-relative send against the configured base URL. */
  request<T>(method: string, path: string, options: SendOptions = {}): Promise<T> {
    return this.send<T>(method, `${this.apiBase}${path}`, options);
  }

  // ---------------------------------------------------------------------------------------
  // Account
  // ---------------------------------------------------------------------------------------

  /** Cheapest authenticated call Mailchimp offers. Used by `setup` to validate credentials. */
  ping(timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/', { timeoutMs });
  }

  // ---------------------------------------------------------------------------------------
  // Ecommerce store — POST to create, PATCH to update. There is no PUT.
  // ---------------------------------------------------------------------------------------

  getStore(storeId: string, timeoutMs?: number): Promise<Record<string, any>> {
    return this.request<Record<string, any>>(
      'GET',
      `/ecommerce/stores/${encodeURIComponent(storeId)}`,
      { timeoutMs: timeoutMs ?? PROBE_TIMEOUT_MS },
    );
  }

  createStore(payload: Record<string, any>, timeoutMs?: number): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('POST', '/ecommerce/stores', {
      body: payload,
      timeoutMs,
    });
  }

  updateStore(
    storeId: string,
    payload: Record<string, any>,
    timeoutMs?: number,
  ): Promise<Record<string, any>> {
    return this.request<Record<string, any>>(
      'PATCH',
      `/ecommerce/stores/${encodeURIComponent(storeId)}`,
      { body: payload, timeoutMs },
    );
  }

  // ---------------------------------------------------------------------------------------
  // Customers, products, variants, orders — all true PUT add-or-update.
  // ---------------------------------------------------------------------------------------

  upsertCustomer(
    storeId: string,
    customerId: string,
    payload: Record<string, any>,
  ): Promise<Record<string, any>> {
    return this.request<Record<string, any>>(
      'PUT',
      `/ecommerce/stores/${encodeURIComponent(storeId)}/customers/${encodeURIComponent(customerId)}`,
      { body: payload },
    );
  }

  deleteCustomer(storeId: string, customerId: string): Promise<unknown> {
    return this.request<unknown>(
      'DELETE',
      `/ecommerce/stores/${encodeURIComponent(storeId)}/customers/${encodeURIComponent(customerId)}`,
    );
  }

  upsertProduct(
    storeId: string,
    productId: string,
    payload: Record<string, any>,
  ): Promise<Record<string, any>> {
    return this.request<Record<string, any>>(
      'PUT',
      `/ecommerce/stores/${encodeURIComponent(storeId)}/products/${encodeURIComponent(productId)}`,
      { body: payload },
    );
  }

  deleteProduct(storeId: string, productId: string): Promise<unknown> {
    return this.request<unknown>(
      'DELETE',
      `/ecommerce/stores/${encodeURIComponent(storeId)}/products/${encodeURIComponent(productId)}`,
    );
  }

  upsertOrder(
    storeId: string,
    orderId: string,
    payload: Record<string, any>,
  ): Promise<Record<string, any>> {
    return this.request<Record<string, any>>(
      'PUT',
      `/ecommerce/stores/${encodeURIComponent(storeId)}/orders/${encodeURIComponent(orderId)}`,
      { body: payload },
    );
  }

  deleteOrder(storeId: string, orderId: string): Promise<unknown> {
    return this.request<unknown>(
      'DELETE',
      `/ecommerce/stores/${encodeURIComponent(storeId)}/orders/${encodeURIComponent(orderId)}`,
    );
  }

  // ---------------------------------------------------------------------------------------
  // Carts — the exception. POST creates, PATCH updates, and there is no PUT.
  // ---------------------------------------------------------------------------------------

  createCart(storeId: string, payload: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>(
      'POST',
      `/ecommerce/stores/${encodeURIComponent(storeId)}/carts`,
      { body: payload },
    );
  }

  /**
   * `id` is stripped: it is not a property of Mailchimp's cart PATCH body, and sending an
   * unknown key to a PATCH is exactly the kind of thing that comes back as an opaque 400.
   */
  updateCart(
    storeId: string,
    cartId: string,
    payload: Record<string, any>,
    timeoutMs?: number,
  ): Promise<Record<string, any>> {
    const { id: _ignored, ...patch } = payload;
    return this.request<Record<string, any>>(
      'PATCH',
      `/ecommerce/stores/${encodeURIComponent(storeId)}/carts/${encodeURIComponent(cartId)}`,
      { body: patch, timeoutMs },
    );
  }

  deleteCart(storeId: string, cartId: string): Promise<unknown> {
    return this.request<unknown>(
      'DELETE',
      `/ecommerce/stores/${encodeURIComponent(storeId)}/carts/${encodeURIComponent(cartId)}`,
    );
  }

  /**
   * Emulated add-or-update for carts, which have no PUT.
   *
   * `exists` comes from `$app.mailchimp.remote_key` — the "has this ever been pushed?"
   * flag — so the common case is a single round trip. The fallback exists because that
   * flag can be wrong in both directions: a cart deleted in Mailchimp still has the flag
   * set, and a cart pushed by an earlier install does not. Both cost one extra call, once.
   *
   * The second call runs on the shorter probe budget: two 4s calls plus a sync-state write
   * does not fit in 10s, two calls at 4s + 2s does.
   *
   * Both directions tolerate losing the race to a concurrent invocation. Create's POST
   * recovers from "already exists" with a PATCH; the exists-path's fallback POST does the
   * same, because two invocations can both take the 404 branch and only one create can win.
   */
  async upsertCart(
    storeId: string,
    cartId: string,
    payload: Record<string, any>,
    exists: boolean,
  ): Promise<Record<string, any>> {
    if (exists) {
      try {
        return await this.updateCart(storeId, cartId, payload);
      } catch (err) {
        if (!isNotFound(err)) throw err;
        try {
          return await this.request<Record<string, any>>(
            'POST',
            `/ecommerce/stores/${encodeURIComponent(storeId)}/carts`,
            { body: payload, timeoutMs: PROBE_TIMEOUT_MS },
          );
        } catch (createErr) {
          // Mirror of the create direction below, for the mirror-image race: two
          // concurrent invocations can both see the PATCH 404 and both take this POST
          // branch, and whichever lands second gets Mailchimp's "already exists" 400.
          // That 400 classifies as permanent, so without this recovery a push that
          // SUCCEEDED (the other invocation created the cart) would be recorded as a
          // non-retryable error the merchant stares at until the daily reconciler
          // clears it. One more PATCH on the probe budget settles it now instead.
          if (!isAlreadyExists(createErr)) throw createErr;
          return this.updateCart(storeId, cartId, payload, PROBE_TIMEOUT_MS);
        }
      }
    }

    try {
      return await this.createCart(storeId, payload);
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      return this.updateCart(storeId, cartId, payload, PROBE_TIMEOUT_MS);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Audience members. `subscriber_hash` is documented as MD5(lowercase(email)) — but the
  // endpoint also accepts the raw email address, which is what this client sends. Workers
  // have no MD5 (`crypto.subtle` offers SHA only), so the alternative would be shipping an
  // MD5 implementation into the isolate for no gain.
  // ---------------------------------------------------------------------------------------

  private memberPath(listId: string, email: string): string {
    return `/lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(email.trim().toLowerCase())}`;
  }

  getMember(listId: string, email: string, timeoutMs?: number): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('GET', this.memberPath(listId, email), {
      timeoutMs: timeoutMs ?? PROBE_TIMEOUT_MS,
    });
  }

  upsertMember(
    listId: string,
    email: string,
    payload: Record<string, any>,
    timeoutMs?: number,
  ): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('PUT', this.memberPath(listId, email), {
      body: payload,
      timeoutMs,
    });
  }

  /**
   * DELETE on a list member archives it: it stops receiving campaigns and can be restored
   * from Mailchimp's audience page. It is not the permanent delete (`delete-permanent`).
   */
  archiveMember(listId: string, email: string, timeoutMs?: number): Promise<unknown> {
    return this.request<unknown>('DELETE', this.memberPath(listId, email), {
      timeoutMs: timeoutMs ?? PROBE_TIMEOUT_MS,
    });
  }

  /** PATCH, not PUT: used to unsubscribe an existing member without risking a create. */
  patchMember(
    listId: string,
    email: string,
    payload: Record<string, any>,
    timeoutMs?: number,
  ): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('PATCH', this.memberPath(listId, email), {
      body: payload,
      timeoutMs,
    });
  }

  // ---------------------------------------------------------------------------------------
  // List webhooks
  // ---------------------------------------------------------------------------------------

  async listWebhooks(listId: string, timeoutMs?: number): Promise<ListWebhook[]> {
    const response = await this.request<{ webhooks?: ListWebhook[] }>(
      'GET',
      `/lists/${encodeURIComponent(listId)}/webhooks`,
      { timeoutMs },
    );
    return response?.webhooks ?? [];
  }

  createWebhook(
    listId: string,
    payload: Record<string, any>,
    timeoutMs?: number,
  ): Promise<ListWebhook & { signing_secret?: string }> {
    return this.request<ListWebhook & { signing_secret?: string }>(
      'POST',
      `/lists/${encodeURIComponent(listId)}/webhooks`,
      { body: payload, timeoutMs },
    );
  }

  deleteWebhook(listId: string, webhookId: string, timeoutMs?: number): Promise<unknown> {
    return this.request<unknown>(
      'DELETE',
      `/lists/${encodeURIComponent(listId)}/webhooks/${encodeURIComponent(webhookId)}`,
      { timeoutMs },
    );
  }

  // ---------------------------------------------------------------------------------------
  // Batch operations
  // ---------------------------------------------------------------------------------------

  /**
   * Submits a batch and returns immediately with its id. Mailchimp runs it asynchronously,
   * which is the whole point: a backfill of thousands of records cannot fit in a 10 second
   * function, but *submitting* it can.
   */
  submitBatch(operations: BatchOperation[], timeoutMs?: number): Promise<BatchStatus> {
    return this.request<BatchStatus>('POST', '/batches', {
      body: { operations },
      timeoutMs,
    });
  }

  getBatch(batchId: string, timeoutMs?: number): Promise<BatchStatus> {
    return this.request<BatchStatus>('GET', `/batches/${encodeURIComponent(batchId)}`, {
      timeoutMs: timeoutMs ?? PROBE_TIMEOUT_MS,
    });
  }
}
