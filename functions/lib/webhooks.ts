/**
 * Registering this app's inbound webhook with Mailchimp, idempotently.
 *
 * Converge-to-desired-state, never unconditional-subscribe: `reconcile.ts` runs this every
 * day, and an unconditional POST would accumulate one duplicate subscription per day until
 * Mailchimp started dropping deliveries.
 */

import { ListWebhook, MailchimpClient, errorText } from './mailchimp-client';
import { CallbackUrl, MailchimpSettings, redact, webhookCallbackUrl } from './settings';

/** Re-exported so callers that already reached for it here keep working. */
export { redact };

/**
 * The message shown whenever the public callback URL cannot be built.
 *
 * Kept in one place because it is the single most likely thing to go wrong at install time
 * and it has three distinct causes, only one of which is obvious. See `appObjectId()` in
 * settings.ts for why the URL is not simply assembled from `req.appId`.
 */
export const NO_CALLBACK_URL_MESSAGE =
  'Could not determine this app’s public callback URL, so nothing was registered with ' +
  'Mailchimp. A public route resolves by the app’s 24-character hex ObjectId, not by its ' +
  'string id, and that ObjectId is read from /:functions — which answers only once the app ' +
  'has been pushed. Push the app, or paste the id= value from .swellrc into the "App ' +
  'ObjectId override" setting, or point "Callback URL override" at a tunnel. Deliberately ' +
  'no fallback to the /functions/mailchimp/… form: Mailchimp would accept that URL, report ' +
  'success, and drop every delivery.';

/** Throws the shared message rather than returning a URL that 404s. */
async function requireCallbackUrl(
  req: SwellRequest,
  settings: MailchimpSettings,
): Promise<CallbackUrl> {
  const callback = await webhookCallbackUrl(req, settings);
  if (!callback) {
    throw new Error(NO_CALLBACK_URL_MESSAGE);
  }
  return callback;
}

/**
 * `sources.api = false` is the important one and is not a preference.
 *
 * This app writes to Mailchimp constantly. With `api: true`, every one of those writes
 * would come back as a webhook, the webhook would write to the Swell account, that write
 * would fire `account.updated`, and the handler would push to Mailchimp again. Turning the
 * API source off cuts the loop at Mailchimp's end; the `last_webhook_at` guard in
 * `accounts-sync.ts` cuts it at ours. Both, because either alone is one edit from being an
 * outage.
 *
 * `subscribe` is off because this app is the thing doing the subscribing, and `campaign`
 * is off because it reports on sends rather than on people — nothing here consumes it.
 */
export const WEBHOOK_EVENTS: Record<string, boolean> = {
  subscribe: false,
  unsubscribe: true,
  profile: true,
  cleaned: true,
  upemail: true,
  campaign: false,
};

export const WEBHOOK_SOURCES: Record<string, boolean> = {
  user: true,
  admin: true,
  api: false,
};

const WEBHOOK_TIMEOUT_MS = 2500;

/** Same endpoint, ignoring the secret in the query string — i.e. "one of ours". */
function isOurEndpoint(candidate: string, desired: string): boolean {
  try {
    const a = new URL(candidate);
    const b = new URL(desired);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

export interface WebhookSyncResult {
  url: string;
  created: boolean;
  removed: number;
  /** Returned by Mailchimp exactly once, on creation, and never retrievable again. */
  signingSecret?: string;
  message: string;
}

/**
 * Reports what is registered without changing anything. Used by `setup`'s GET so an
 * installer can see the current state before deciding to act on it.
 */
export async function describeWebhooks(
  req: SwellRequest,
  settings: MailchimpSettings,
  client: MailchimpClient,
): Promise<{
  desired: string | null;
  registered: number;
  matches: boolean;
  stale: number;
  message?: string;
}> {
  const callback = await webhookCallbackUrl(req, settings);
  const existing = await client.listWebhooks(settings.list_id, WEBHOOK_TIMEOUT_MS);

  if (!callback) {
    return {
      desired: null,
      registered: existing.length,
      matches: false,
      stale: 0,
      message: NO_CALLBACK_URL_MESSAGE,
    };
  }

  const desired = callback.url;
  return {
    desired: callback.redacted,
    registered: existing.length,
    matches: existing.some((hook) => hook.url === desired),
    stale: existing.filter((hook) => hook.url !== desired && isOurEndpoint(hook.url, desired))
      .length,
  };
}

export async function ensureWebhook(
  req: SwellRequest,
  settings: MailchimpSettings,
  client: MailchimpClient,
): Promise<WebhookSyncResult> {
  const callback = await requireCallbackUrl(req, settings);
  const desired = callback.url;

  let existing: ListWebhook[] = [];
  try {
    existing = await client.listWebhooks(settings.list_id, WEBHOOK_TIMEOUT_MS);
  } catch (err) {
    throw new Error(`Could not list Mailchimp webhooks: ${errorText(err)}`);
  }

  const exact = existing.find((hook) => hook.url === desired);
  // Same route, different query string: a rotated webhook secret, or an old callback_url.
  const stale = existing.filter((hook) => hook.url !== desired && isOurEndpoint(hook.url, desired));

  let removed = 0;
  for (const hook of stale) {
    try {
      await client.deleteWebhook(settings.list_id, hook.id, WEBHOOK_TIMEOUT_MS);
      removed += 1;
    } catch (err) {
      // Per-item, so one undeletable subscription cannot abort the whole convergence.
      console.warn(`Mailchimp: could not remove stale webhook ${hook.id}: ${errorText(err)}`);
    }
  }

  if (exact) {
    return {
      url: callback.redacted,
      created: false,
      removed,
      message: `Webhook already registered on audience ${settings.list_id}.`,
    };
  }

  const created = await client.createWebhook(
    settings.list_id,
    { url: desired, events: WEBHOOK_EVENTS, sources: WEBHOOK_SOURCES },
    WEBHOOK_TIMEOUT_MS,
  );

  return {
    url: callback.redacted,
    created: true,
    removed,
    signingSecret: typeof created?.signing_secret === 'string' ? created.signing_secret : undefined,
    message:
      `Registered webhook on audience ${settings.list_id}` +
      (removed > 0 ? `, replacing ${removed} stale registration(s).` : '.'),
  };
}
