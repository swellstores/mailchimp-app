/**
 * Parsing and authenticating an inbound Mailchimp webhook delivery.
 *
 * ---------------------------------------------------------------------------------------
 * MAILCHIMP DOES NOT POST JSON.
 *
 * List webhooks arrive as `application/x-www-form-urlencoded` with PHP-style bracket keys:
 *
 *   type=unsubscribe&fired_at=2026-08-07+09%3A00%3A00&data%5Bemail%5D=ada%40example.com
 *   &data%5Blist_id%5D=a6b5da1054&data%5Baction%5D=unsub&data%5Breason%5D=manual
 *
 * How that reaches a Swell route function is not something the docs pin down, so this
 * module accepts every plausible shape rather than betting on one:
 *
 *   - a raw string body (the platform passed the bytes through),
 *   - a flat object with literal bracket keys (`{"data[email]": "..."}`),
 *   - an already-nested object (`{type, data: {...}}`) — which is also what
 *     `swell api post --body '{...}'` produces when testing the route by hand.
 *
 * `unflatten()` is what turns the first two into the third.
 * ---------------------------------------------------------------------------------------
 */

export interface MailchimpWebhookEvent {
  type: string;
  fired_at: string;
  data: Record<string, any>;
}

/** Events this app acts on. Mailchimp also offers `subscribe` and `campaign`; see README. */
export const HANDLED_EVENTS = ['unsubscribe', 'cleaned', 'upemail', 'profile'] as const;

export type HandledEvent = (typeof HANDLED_EVENTS)[number];

export function isHandledEvent(type: string): type is HandledEvent {
  return (HANDLED_EVENTS as readonly string[]).includes(type);
}

/**
 * Expands `a[b][c]` keys into nested objects. Depth is capped: the input is attacker-
 * controlled up to the point the secret is checked, and an unbounded nesting depth is a
 * cheap way to burn the function's budget.
 */
export function unflatten(entries: Iterable<[string, string]>): Record<string, any> {
  const out: Record<string, any> = {};

  for (const [rawKey, value] of entries) {
    const match = rawKey.match(/^([^[\]]+)((?:\[[^[\]]*\])*)$/);
    if (!match) {
      out[rawKey] = value;
      continue;
    }
    const [, head, rest] = match;
    const path = [head, ...(rest.match(/\[[^[\]]*\]/g) ?? []).map((part) => part.slice(1, -1))]
      .filter((part) => part !== '')
      .slice(0, 6);

    let cursor: Record<string, any> = out;
    for (let i = 0; i < path.length - 1; i += 1) {
      const key = path[i];
      if (typeof cursor[key] !== 'object' || cursor[key] === null) {
        cursor[key] = {};
      }
      cursor = cursor[key];
    }
    cursor[path[path.length - 1]] = value;
  }

  return out;
}

function hasBracketKeys(value: Record<string, any>): boolean {
  return Object.keys(value).some((key) => key.includes('['));
}

/**
 * Normalises whatever arrived into `{ type, fired_at, data }`.
 *
 * `secret` may appear alongside the payload — `swell api post` folds the query string into
 * the body — so it is stripped here rather than being mistaken for webhook data.
 */
export function parseWebhookPayload(input: unknown): MailchimpWebhookEvent {
  let source: Record<string, any>;

  if (typeof input === 'string') {
    const trimmed = input.trim();
    // A raw body is normally form-encoded, but the same route is exercised by hand with
    // `swell api post --body '{...}'`, whose bytes are JSON. Sniff rather than assume:
    // running a JSON document through URLSearchParams produces junk, silently.
    let parsedJson: unknown = null;
    if (trimmed.startsWith('{')) {
      try {
        parsedJson = JSON.parse(trimmed);
      } catch {
        parsedJson = null;
      }
    }
    if (parsedJson && typeof parsedJson === 'object') {
      return parseWebhookPayload(parsedJson);
    }
    // `forEach` rather than `entries()`: the app's tsconfig uses lib "webworker", whose
    // URLSearchParams declaration has no iterator methods even though the runtime does.
    const entries: Array<[string, string]> = [];
    new URLSearchParams(trimmed).forEach((value, key) => {
      entries.push([key, value]);
    });
    source = unflatten(entries);
  } else if (input && typeof input === 'object') {
    const record = input as Record<string, any>;
    source = hasBracketKeys(record)
      ? unflatten(
          Object.entries(record).map(([key, value]) => [key, String(value)] as [string, string]),
        )
      : record;
  } else {
    source = {};
  }

  const data =
    source.data && typeof source.data === 'object' ? (source.data as Record<string, any>) : {};

  return {
    type: typeof source.type === 'string' ? source.type : '',
    fired_at: typeof source.fired_at === 'string' ? source.fired_at : '',
    data,
  };
}

// ---------------------------------------------------------------------------------------
// Shared-secret check
// ---------------------------------------------------------------------------------------

/**
 * Compares the secret without leaking how much of it matched. The length check is fine to
 * short-circuit: the secret's length is not the part worth protecting.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < provided.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------------------
// Optional signature check
// ---------------------------------------------------------------------------------------

/**
 * Mailchimp's newer accounts sign deliveries:
 *
 *   X-Mailchimp-Signature: t=1718000000,v1=<hex hmac-sha256>
 *   signed payload = `${t}.${raw request body}`
 *
 * Signing is optional at Mailchimp's end and the signing secret is shown exactly once, at
 * webhook creation, so this app treats it as an *additional* check the merchant can turn
 * on by pasting the secret into settings — never as the only one. The shared secret in the
 * callback URL stays mandatory either way.
 *
 * A stale timestamp is rejected at five minutes, which is Mailchimp's own guidance and
 * what stops a captured delivery being replayed a week later.
 */
export const SIGNATURE_HEADER = 'x-mailchimp-signature';
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

export function parseSignatureHeader(
  header: string,
): { timestamp: number; signature: string } | null {
  const parts = header.split(',').map((part) => part.trim());
  let timestamp = NaN;
  let signature = '';
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 't') timestamp = Number(value);
    if (key === 'v1') signature = value.toLowerCase();
  }
  if (!Number.isFinite(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) {
    return null;
  }
  return { timestamp, signature };
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifySignature(
  rawBody: string,
  header: string,
  signingSecret: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  if (Math.abs(nowMs - parsed.timestamp * 1000) > MAX_SIGNATURE_AGE_MS) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${parsed.timestamp}.${rawBody}`),
  );

  return secretsMatch(toHex(mac), parsed.signature);
}
