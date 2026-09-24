/**
 * Mailchimp ecommerce store provisioning.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE, AND WHERE IT RUNS
 *
 * Nothing — no customer, product, cart or order — can be written until
 * `/ecommerce/stores/{store_id}` exists. Mailchimp answers 404 on every sub-resource until
 * it does, so "the app is configured but every push fails" is the default first experience
 * unless provisioning is handled deliberately. Three plausible homes, and this app uses all
 * three, in this order and for these reasons:
 *
 *  1. **`functions/setup.ts`, a private route — the primary path.** Provisioning is a
 *     one-time act with a real chance of failure (bad key, wrong audience id, audience
 *     already bound to another store). It deserves a call whose whole job is to succeed or
 *     explain why, and whose output the operator reads. Doing it here also means the
 *     audience id — which Mailchimp makes *immutable* on the store — is confirmed once,
 *     loudly, rather than discovered later.
 *
 *  2. **`functions/reconcile.ts`, the daily cron — the repair path.** Settings change and
 *     nothing tells the app; a store can be deleted in Mailchimp's UI. The reconciler runs
 *     `ensureStore` every day so a store that goes missing comes back without anyone
 *     noticing it went.
 *
 *  3. **Lazily from the push path — the safety net, and only on failure.** A merchant who
 *     fills in settings and never runs step 1 would otherwise get 24 hours of failed
 *     pushes before the cron caught it. So when a push 404s, `provisionAfterNotFound()`
 *     checks whether the *store* is what is missing and creates it, then reports the push
 *     as retryable so the platform redelivers. It costs nothing in the happy path because
 *     it only ever runs after a 404.
 *
 * What this module never does is provision *eagerly* on every push. That would be a second
 * round trip on every event, inside a 10 second budget, to re-answer a question whose
 * answer changes roughly once in the lifetime of the app.
 * ---------------------------------------------------------------------------------------
 */

import {
  MailchimpClient,
  MailchimpError,
  PROBE_TIMEOUT_MS,
  errorText,
  isAlreadyExists,
  isNotFound,
} from './mailchimp-client';
import { MailchimpSettings, storeId, storeName, storefrontOrigin } from './settings';

/** Provisioning runs inside an invocation that may already have spent 4s on a failed push. */
const PROVISION_TIMEOUT_MS = 2500;

export interface StorePayload {
  id: string;
  list_id: string;
  name: string;
  currency_code: string;
  platform?: string;
  domain?: string;
  email_address?: string;
  is_syncing?: boolean;
}

export function buildStorePayload(
  req: SwellRequest,
  settings: MailchimpSettings,
): StorePayload {
  const origin = storefrontOrigin(req, settings);
  let domain = settings.store_domain;
  if (!domain && origin) {
    try {
      domain = new URL(origin).hostname;
    } catch {
      domain = '';
    }
  }

  return {
    // All four of these are required by Mailchimp on create. `list_id` is additionally
    // immutable: it is absent from the PATCH body and the docs say so explicitly.
    id: storeId(req, settings),
    list_id: settings.list_id,
    name: storeName(req, settings),
    currency_code: settings.store_currency,
    platform: 'Swell',
    ...(domain ? { domain } : {}),
    // Tells Mailchimp a bulk sync is in progress so it suppresses automations for the
    // records being backfilled. Left false here: `setStoreSyncing` turns it on for a
    // backfill, and the backfill `finish` action or the daily reconcile turns it off.
    is_syncing: false,
  };
}

export interface EnsureStoreResult {
  storeId: string;
  created: boolean;
  /** Set when the store existed but is bound to a different audience than the settings. */
  listMismatch?: string;
}

/**
 * Converges the Mailchimp store to the configured shape. Safe to run repeatedly — that is
 * the entire contract, because the cron runs it daily.
 */
export async function ensureStore(
  req: SwellRequest,
  settings: MailchimpSettings,
  client: MailchimpClient,
  options: { patchExisting?: boolean } = {},
): Promise<EnsureStoreResult> {
  const payload = buildStorePayload(req, settings);

  let existing: Record<string, any> | null = null;
  try {
    existing = await client.getStore(payload.id);
  } catch (err) {
    if (!isNotFound(err)) {
      throw err;
    }
  }

  if (!existing) {
    try {
      await client.createStore(payload, PROVISION_TIMEOUT_MS);
    } catch (err) {
      // Two invocations can race here — a cron tick and a push-path 404 in the same
      // second. Losing that race is success, not failure.
      if (!isAlreadyExists(err)) throw err;
    }
    return { storeId: payload.id, created: true };
  }

  const listMismatch =
    typeof existing.list_id === 'string' && existing.list_id !== payload.list_id
      ? existing.list_id
      : undefined;

  if (options.patchExisting && !listMismatch) {
    // `id` and `list_id` are not accepted by PATCH; everything else is fair game.
    const { id: _id, list_id: _listId, ...patch } = payload;
    await client.updateStore(payload.id, patch, PROVISION_TIMEOUT_MS);
  }

  return { storeId: payload.id, created: false, listMismatch };
}

/**
 * Called from the push path when a write came back 404. Distinguishes "the store is
 * missing" — which this app can fix — from "the product this line references is missing",
 * which it cannot, and which needs a different message to the merchant.
 *
 * Returns a message when the store was provisioned (so the caller can report a retryable
 * failure), or `null` when the store was already there and the 404 was about something
 * else.
 */
export async function provisionAfterNotFound(
  req: SwellRequest,
  settings: MailchimpSettings,
  client: MailchimpClient,
): Promise<string | null> {
  const id = storeId(req, settings);
  try {
    await client.getStore(id, PROBE_TIMEOUT_MS);
    return null;
  } catch (err) {
    if (!isNotFound(err)) {
      // The probe itself failed. Say so rather than claiming to have fixed anything.
      return null;
    }
  }

  try {
    await ensureStore(req, settings, client);
  } catch (err) {
    if (err instanceof MailchimpError && !isAlreadyExists(err)) {
      throw err;
    }
  }

  return (
    `The Mailchimp ecommerce store "${id}" did not exist, so it was created just now. ` +
    'This push will be retried.'
  );
}

/** Human-readable summary for the setup route and the reconciler's log line. */
export function describeEnsureResult(result: EnsureStoreResult): string {
  if (result.listMismatch) {
    return (
      `Mailchimp store "${result.storeId}" already exists but is bound to audience ` +
      `"${result.listMismatch}", not the one in settings. Mailchimp does not allow a store's ` +
      'audience to change: either point the Audience ID setting at that audience, or choose a ' +
      'different Store ID.'
    );
  }
  return result.created
    ? `Created Mailchimp ecommerce store "${result.storeId}".`
    : `Mailchimp ecommerce store "${result.storeId}" is already present.`;
}

/**
 * Turns Mailchimp's `is_syncing` on or off for this app's ecommerce store. While it is on,
 * Mailchimp does not fire order and cart automations (receipts, abandoned-cart emails) for
 * the records coming in, which is what stops a backfill emailing customers about orders
 * from last year. It must be switched off again afterwards, or live automations stay
 * suppressed too.
 */
export async function setStoreSyncing(
  req: SwellRequest,
  settings: MailchimpSettings,
  client: MailchimpClient,
  value: boolean,
): Promise<void> {
  await client.updateStore(storeId(req, settings), { is_syncing: value }, PROVISION_TIMEOUT_MS);
}
