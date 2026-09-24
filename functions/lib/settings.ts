/**
 * Typed, coercing reader for this app's settings.
 *
 * Every field goes through a guard with an explicit default, so a handler never sees
 * `undefined` and never needs `settings?.x as any`. Adding a field to
 * `settings/mailchimp.json` means adding it here too — that is the point.
 */

// Settings are namespaced by the settings *filename*, not the app id. `settings/foo.json`
// is always reachable at `settings.foo`, even if swell.json declares `"id": "bar"`.
// Hardcoding the filename here is what keeps the two from drifting.
const SETTINGS_KEY = 'mailchimp';

/** `req.appId` is declared optional in @swell/app-types but is always set at runtime. */
export function appId(req: SwellRequest): string {
  return req.appId || SETTINGS_KEY;
}

export type PushTrigger = 'automatic' | 'manual';
export type CartScope = 'all' | 'abandoned';

export interface MailchimpSettings {
  enabled: boolean;
  api_key: string;
  list_id: string;
  api_base: string;
  store_id: string;
  store_name: string;
  store_currency: string;
  store_domain: string;
  push_trigger: PushTrigger;
  sync_accounts: boolean;
  sync_products: boolean;
  sync_carts: boolean;
  cart_scope: CartScope;
  sync_orders: boolean;
  event_created: boolean;
  event_updated: boolean;
  event_deleted: boolean;
  push_optout: boolean;
  archive_on_delete: boolean;
  webhook_secret: string;
  webhook_signing_secret: string;
  webhook_writeback: boolean;
  callback_url: string;
  /** Escape hatch for the public callback URL when ObjectId discovery fails. See `appObjectId`. */
  app_object_id: string;
  allow_test_payload: boolean;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * The `enum()` guard from the starter spec, renamed because `enum` is a reserved word in
 * TypeScript. Anything the settings UI cannot produce falls back to the declared default.
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

const PUSH_TRIGGERS: readonly PushTrigger[] = ['automatic', 'manual'];
const CART_SCOPES: readonly CartScope[] = ['all', 'abandoned'];

export async function getSettings(req: SwellRequest): Promise<MailchimpSettings> {
  const all = await req.swell.settings();
  const raw = (all?.[SETTINGS_KEY] ?? {}) as Record<string, unknown>;

  return {
    enabled: flag(raw.enabled, false),
    api_key: text(raw.api_key),
    list_id: text(raw.list_id),
    api_base: text(raw.api_base),
    store_id: text(raw.store_id),
    store_name: text(raw.store_name),
    store_currency: (text(raw.store_currency) || 'USD').toUpperCase(),
    store_domain: text(raw.store_domain).replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    push_trigger: oneOf(raw.push_trigger, PUSH_TRIGGERS, 'automatic'),
    sync_accounts: flag(raw.sync_accounts, true),
    sync_products: flag(raw.sync_products, true),
    sync_carts: flag(raw.sync_carts, true),
    cart_scope: oneOf(raw.cart_scope, CART_SCOPES, 'all'),
    sync_orders: flag(raw.sync_orders, true),
    event_created: flag(raw.event_created, true),
    event_updated: flag(raw.event_updated, true),
    event_deleted: flag(raw.event_deleted, false),
    push_optout: flag(raw.push_optout, true),
    archive_on_delete: flag(raw.archive_on_delete, true),
    webhook_secret: text(raw.webhook_secret),
    webhook_signing_secret: text(raw.webhook_signing_secret),
    webhook_writeback: flag(raw.webhook_writeback, true),
    callback_url: text(raw.callback_url),
    app_object_id: text(raw.app_object_id),
    allow_test_payload: flag(raw.allow_test_payload, false),
  };
}

// ---------------------------------------------------------------------------------------
// Datacenter derivation — the reason `api_base` exists as a settings field at all.
// ---------------------------------------------------------------------------------------

/**
 * Mailchimp API keys end in a datacenter suffix: `…-us14`. The API for that key lives at
 * `https://us14.api.mailchimp.com/3.0` and nowhere else — a key sent to the wrong
 * datacenter comes back 401, which reads as "bad credential" and sends the merchant
 * looking for the wrong problem. So the host is derived from the credential, and the
 * `api_base` setting is an override rather than the source of truth.
 *
 * Deliberately strict: `us14`, `us1`, `dc22` all match; anything with a slash, a dot or a
 * capital does not. The suffix is interpolated into a URL, so a permissive regex here
 * would be an SSRF hole rather than a convenience.
 */
export function datacenterFromKey(apiKey: string): string {
  const suffix = apiKey.slice(apiKey.lastIndexOf('-') + 1);
  return apiKey.includes('-') && /^[a-z]{2,6}[0-9]{1,3}$/.test(suffix) ? suffix : '';
}

/** Resolved API base, or `null` when neither the key nor the override can produce one. */
/**
 * Deliberately NOT restricted to `*.api.mailchimp.com`. Pointing `api_base` at a mock or a
 * local proxy is a supported development workflow, and a hostname allow-list would block it
 * to buy very little: the field is only settable by someone with admin access to the store
 * settings, who can already read the API key from the same panel. The checks below are the
 * ones that carry real weight regardless of who set the value.
 */
export function resolveApiBase(settings: Partial<MailchimpSettings>): string | null {
  if (settings.api_base) {
    const trimmed = settings.api_base.trim().replace(/\/+$/, '');

    let url: URL;
    try {
      // Single-argument `new URL` throws for anything not absolute, which is the check
      // wanted: a bare hostname would otherwise resolve against the worker's own origin.
      url = new URL(trimmed);
    } catch {
      return null;
    }
    // http:// would put the API key on the wire in clear, as Basic auth.
    if (url.protocol !== 'https:') {
      return null;
    }
    // Rebuilt from the parsed URL rather than returned verbatim, so credentials in the
    // authority (`https://user:pass@host`), a fragment or a query string cannot ride
    // along into every request path.
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}`;
  }
  const dc = datacenterFromKey(settings.api_key ?? '');
  return dc ? `https://${dc}.api.mailchimp.com/3.0` : null;
}

/**
 * Cheap pre-flight so a missing credential is reported as configuration, not as an error.
 * Returns the merchant-facing reason, or `null` when the app is ready to talk to Mailchimp.
 */
export function configurationError(settings: MailchimpSettings): string | null {
  if (!settings.api_key) {
    return 'Mailchimp API key is not set in app settings.';
  }
  if (!resolveApiBase(settings)) {
    return (
      'Mailchimp API key has no datacenter suffix, so the API host cannot be derived. ' +
      'Paste the whole key (it ends in something like "-us14"), or set the API base URL override.'
    );
  }
  if (!settings.list_id) {
    return 'Mailchimp audience ID is not set in app settings.';
  }
  return null;
}

export function hasCredentials(settings: MailchimpSettings): boolean {
  return configurationError(settings) === null;
}

/**
 * The Mailchimp ecommerce store id this app owns. Defaults to the Swell store id, which is
 * stable, unique per store, and already URL-safe.
 */
export function storeId(req: SwellRequest, settings: MailchimpSettings): string {
  return settings.store_id || req.store.id;
}

export function storeName(req: SwellRequest, settings: MailchimpSettings): string {
  return settings.store_name || req.store.id;
}

/**
 * Storefront origin used to build product and order URLs. Mailchimp shows these in
 * product blocks and order notifications, so an empty one just means no link.
 */
export function storefrontOrigin(req: SwellRequest, settings: MailchimpSettings): string {
  if (settings.store_domain) {
    return `https://${settings.store_domain}`;
  }
  return (req.store.url || '').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------------------
// The public callback URL
// ---------------------------------------------------------------------------------------

/** This app's public route function — what Mailchimp calls. */
export const WEBHOOK_FUNCTION_NAME = 'mailchimp-webhook';

/**
 * Must match `mailchimp-webhook.ts`'s `config.description` **verbatim**. It is half of the
 * match `appObjectId()` makes — `/:functions` cannot be filtered by app, so the name alone
 * is ambiguous across apps. Change one and you must change the other.
 */
export const WEBHOOK_FUNCTION_DESCRIPTION = 'Receive Mailchimp audience webhooks';

/**
 * This app's ObjectId — the 24-character hex id in `.swellrc`, and `app_id` on every row of
 * `/:functions`.
 *
 * =========================================================================================
 * THIS IS THE PART THIS APP GOT WRONG, AND IT SHIPPED LIVE.
 *
 * A public route function resolves at
 *
 *     https://<store_id>.swell.store/functions/<APP OBJECT ID>/<function name>
 *
 * using the app's **ObjectId**, not the string app id from `swell.json`. The string-id form
 * — `/functions/mailchimp/mailchimp-webhook` — is what this file used to build, and it
 * **404s**. Measured on a test store: the ObjectId form answers 200,
 * the slug form answers 404.
 *
 * That failure is worse than it sounds, because it is not loud. Mailchimp accepts the URL,
 * reports the subscription as created, and then silently drops every delivery — so the app
 * looks like it has no inbound path at all and nothing anywhere says why.
 *
 * `req.appId` is the *string* id, so the ObjectId cannot be read off the request and has to
 * be looked up. `/:functions` is the platform's own function registry and carries it on
 * every row:
 *
 *     swell api get '/:functions?where[name]=mailchimp-webhook&limit=2'
 *     → { name: "mailchimp-webhook", app_id: "0123456789abcdef01234567", … }
 *
 * `/:functions` cannot be filtered by app, so the **name alone is ambiguous** across apps.
 * The description is matched too, because it is this app's own string. Exactly one match, or
 * nothing: a URL that silently points at another app's function is worse than no URL.
 *
 * Only `setup` and `reconcile` ever need this, so the read is paid once per provisioning
 * call and never on a delivery path.
 * =========================================================================================
 *
 * Advisory throughout: a failure downgrades to the `app_object_id` settings override, never
 * to an error.
 */
export async function appObjectId(req: SwellRequest): Promise<string | null> {
  try {
    const response = (await req.swell.get('/:functions', {
      where: { name: WEBHOOK_FUNCTION_NAME },
      limit: 20,
    } as any)) as { results?: Array<Record<string, any>> } | null;

    const matches = (response?.results ?? []).filter(
      (fn) =>
        fn?.name === WEBHOOK_FUNCTION_NAME &&
        fn?.description === WEBHOOK_FUNCTION_DESCRIPTION &&
        /^[0-9a-f]{24}$/i.test(String(fn?.app_id ?? '')),
    );
    // Zero: the app has not been pushed yet, or the function was renamed. Two or more:
    // another app answers to the same name and description and there is no way to tell
    // which row is ours. Both cases want the override, not a guess.
    return matches.length === 1 ? String(matches[0].app_id) : null;
  } catch (err) {
    console.warn(
      `Mailchimp: could not read /:functions to derive this app's ObjectId: ${String(err)}`,
    );
    return null;
  }
}

/**
 * The ObjectId this app should use, override first: the `app_object_id` settings field when
 * it is set and well formed, otherwise discovery. `setup` reports the result alongside
 * `appId(req)` so the two can be seen to differ.
 */
export async function resolveAppObjectId(
  req: SwellRequest,
  settings: MailchimpSettings,
): Promise<string | null> {
  if (/^[0-9a-f]{24}$/i.test(settings.app_object_id)) {
    return settings.app_object_id;
  }
  return appObjectId(req);
}

export interface CallbackUrl {
  /** The URL Mailchimp should be given, secret included. Never log or return this. */
  url: string;
  /** Safe to show a merchant: the same URL with the secret masked. */
  redacted: string;
  /** False when the URL came from the `callback_url` override rather than being derived. */
  derived: boolean;
  /** The ObjectId the URL was built from, when it was derived. */
  appObjectId: string | null;
}

/**
 * Public URL Mailchimp posts webhooks to, or `null` when one cannot be built.
 *
 * The secret travels in the query string because Mailchimp's list webhooks let you configure
 * a URL and nothing else — no custom headers, no basic auth. The webhook function also
 * accepts it in the body, so the route stays testable from the CLI.
 *
 * ---------------------------------------------------------------------------------------
 * RETURNS `null` RATHER THAN FALLING BACK TO THE STRING-ID FORM.
 *
 * That is deliberate: **a 404 URL is worse than no URL.** Mailchimp accepts the string-id
 * form, reports the subscription as created, and drops every delivery — so a fallback would
 * convert a loud, fixable failure ("setup could not determine the callback URL") into a
 * silent one that looks like success. Callers must handle `null` by telling the installer
 * what to do, which is what `setup.ts` does.
 * ---------------------------------------------------------------------------------------
 *
 * Three ways to get a URL, in order:
 *   1. the `callback_url` settings override — a tunnel during development;
 *   2. the `app_object_id` settings override — the escape hatch when discovery fails;
 *   3. discovery against `/:functions`, which is the path that should normally be taken.
 *
 * Public route functions resolve the **live** environment only. An app that has only been
 * pushed to test answers 404 even with the right ObjectId, so the round trip still needs
 * `swell app version minor && swell app install`.
 */
export async function webhookCallbackUrl(
  req: SwellRequest,
  settings: MailchimpSettings,
): Promise<CallbackUrl | null> {
  if (settings.callback_url) {
    const url = withSecret(settings.callback_url, settings.webhook_secret);
    return { url, redacted: redact(url), derived: false, appObjectId: null };
  }

  const objectId = await resolveAppObjectId(req, settings);

  if (!objectId) {
    return null;
  }

  const base = `https://${req.store.id}.swell.store/functions/${objectId}/${WEBHOOK_FUNCTION_NAME}`;
  const url = withSecret(base, settings.webhook_secret);
  return { url, redacted: redact(url), derived: true, appObjectId: objectId };
}

function withSecret(base: string, secret: string): string {
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}secret=${encodeURIComponent(secret)}`;
}

/** Never log the shared secret: these strings end up in function logs and API responses. */
export function redact(url: string): string {
  return url.replace(/([?&]secret=)[^&]*/, '$1***');
}

/**
 * Whether Swell's built-in Mailchimp integration is still switched on. Both would push the
 * same customers and orders, so every change reaches Mailchimp twice. The built-in one keeps
 * its settings at `/settings/integrations/services/mailchimp` and runs while `enabled` is
 * set (schema-api-server `integrations/index.js`). `null` when it cannot be read.
 */
export async function nativeIntegrationEnabled(req: SwellRequest): Promise<boolean | null> {
  try {
    const native = (await req.swell.get('/settings/integrations/services/mailchimp')) as {
      enabled?: unknown;
    } | null;
    return native?.enabled === true;
  } catch {
    return null;
  }
}

export const NATIVE_INTEGRATION_WARNING =
  "Swell's built-in Mailchimp integration is still on (Settings → Integrations). Turn it off, " +
  'or customers and orders reach Mailchimp twice.';
