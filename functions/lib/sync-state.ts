/**
 * THE SINGLE WRITER.
 *
 * Invariant, and the central safety property of this app: **this module is the only place
 * that writes to a synced collection**, and every write goes through `req.appValues()`,
 * which confines it to `$app.<app_id>.*`.
 *
 * That is what stops the app's own writes from re-triggering its own `*.updated` handler.
 * A write that touches any top-level field would fire `<collection>.updated`, the handler
 * would push again, that push would write again, and the loop only ends when the platform
 * auto-disables the function after ~4 days of failures.
 *
 * The matching regression test asserts the write touched nothing else:
 *
 *   expect(Object.keys(swell.put.mock.calls[0][1])).toEqual(['$app']);
 *
 * ---------------------------------------------------------------------------------------
 * THE ONE EXCEPTION IN THIS APP, AND HOW IT IS MADE SAFE
 *
 * `lib/account-writeback.ts` writes `email_optin` and `email` on an account, because an
 * inbound Mailchimp unsubscribe is worthless if it stays inside `$app`. That module:
 *
 *   - is the *only* other writer, carries the exception marker in its header, and is
 *     declared explicitly in test/unit/single-writer.test.ts;
 *   - writes `$app.mailchimp.last_webhook_at` in the same call, so its own change is
 *     self-identifying;
 *   - is matched by a guard at the top of `functions/accounts-sync.ts`, which returns
 *     early when `last_webhook_at` is among `$event.data`'s changed fields.
 *
 * That guard is the loop breaker. Removing it turns every inbound unsubscribe into an
 * outbound push, and outbound pushes are what generate inbound webhooks.
 * ---------------------------------------------------------------------------------------
 */

import { appId } from './settings';
import { errorText } from './mailchimp-client';

/**
 * The four collections this app stamps. Passing the collection per call rather than
 * hardcoding one module-level constant is what lets a single sync-state module serve a
 * multi-collection app.
 */
export type SyncCollection = 'accounts' | 'products' | 'carts' | 'orders';

export const SYNC_COLLECTIONS: readonly SyncCollection[] = [
  'accounts',
  'products',
  'carts',
  'orders',
];

/** Vendor messages can be arbitrarily long; the model field is not a log. */
const MAX_ERROR_LENGTH = 500;

export type SyncStatus = 'pending' | 'synced' | 'error' | 'skipped' | 'canceled';

export type ListStatus =
  | 'subscribed'
  | 'unsubscribed'
  | 'cleaned'
  | 'pending'
  | 'transactional'
  | 'archived';

export interface SyncState {
  sync_status?: SyncStatus | null;
  remote_key?: string | null;
  remote_id?: string | null;
  /**
   * The Mailchimp batch submission that queued this record, stamped with the 'pending'
   * status at submission. Poll settlement is scoped to it — see functions/backfill.ts —
   * so one batch's poll can never settle another batch's in-flight records.
   */
  batch_id?: string | null;
  last_synced_at?: string | null;
  last_error?: string | null;
  resync_requested?: boolean | null;
  /** accounts only */
  remote_email?: string | null;
  list_status?: ListStatus | null;
  last_webhook_at?: string | null;
  last_webhook_event?: string | null;
  last_webhook_fired_at?: string | null;
  /** products only */
  variant_count?: number | null;
}

/**
 * Reads this app's slice of a record. `$app` is keyed by the slug-form app id, which is why
 * `appId(req)` and not the settings filename is used here.
 */
export function readSyncState(req: SwellRequest, record: unknown): SyncState {
  const app = (record as Record<string, any>)?.$app;
  return (app?.[appId(req)] ?? {}) as SyncState;
}

/** Truncates `last_error` so a multi-megabyte vendor body cannot bloat a record. */
export function normalizeState(patch: SyncState): SyncState {
  const values: SyncState = { ...patch };
  if (typeof values.last_error === 'string') {
    values.last_error = values.last_error.slice(0, MAX_ERROR_LENGTH);
  }
  return values;
}

/** The only write path. Throws if the write fails — see `recordSyncState` for the other case. */
export async function setSyncState(
  req: SwellRequest,
  collection: SyncCollection,
  recordId: string,
  patch: SyncState,
): Promise<void> {
  await req.swell.put(`/${collection}/${recordId}`, req.appValues(normalizeState(patch)));
}

/**
 * Records sync state without letting a failed write mask the error that prompted it.
 *
 * Almost every call site is inside a `catch`: something already went wrong and we are
 * writing that fact down. If the write itself throws, the original error is lost and the
 * handler reports the wrong cause. So this variant swallows and logs.
 *
 * Use `setSyncState` when the write *is* the operation and its failure should propagate.
 */
export async function recordSyncState(
  req: SwellRequest,
  collection: SyncCollection,
  recordId: string,
  patch: SyncState,
): Promise<void> {
  try {
    await setSyncState(req, collection, recordId, patch);
  } catch (err) {
    console.error(
      `Mailchimp: could not record sync state on ${collection}/${recordId}: ${errorText(err)}`,
    );
  }
}
