/**
 * @single-writer-exception
 *
 * ---------------------------------------------------------------------------------------
 * THE ONLY MODULE IN THIS APP THAT WRITES A FIELD OUTSIDE `$app.mailchimp.*`.
 *
 * Read `lib/sync-state.ts`'s header first. The single-writer invariant exists because an
 * app that writes a top-level field on a collection it subscribes to re-triggers its own
 * `*.updated` handler, and the loop ends only when the platform disables the function.
 *
 * This module breaks that rule deliberately, because the entire point of the inbound
 * webhook is to land outside `$app`: an unsubscribe that only updates the app's private
 * namespace has changed nothing a merchant, a checkout, or another integration can see.
 * The native Mailchimp integration cannot do this at all — nothing flows back — so it is
 * one of the rows in the README's comparison table.
 *
 * Three things make it safe, and all three must stay:
 *
 *  1. **Every write from here also stamps `$app.mailchimp.last_webhook_at`.** That makes
 *     the change self-identifying in the `account.updated` event that follows.
 *  2. **`functions/accounts-sync.ts` returns early** when `last_webhook_at` is among
 *     `req.data.$event.data`'s changed fields. `$event.data` really does carry only the
 *     changed fields on `updated` — unlike `$data`, which resolves against the whole
 *     record and therefore matches everything.
 *  3. **Webhooks are registered with `sources.api = false`**, so a change this app makes
 *     through the API never comes back as a webhook. Belt, braces, and a second belt: the
 *     loop is cut at Mailchimp's end as well as ours.
 *
 * The allowed field list is closed on purpose. Anything not in `WRITABLE_FIELDS` is
 * dropped rather than written, so a future edit here cannot quietly widen the app's write
 * surface across the whole `accounts` collection.
 * ---------------------------------------------------------------------------------------
 */

import { errorText } from './mailchimp-client';
import { SyncState, normalizeState } from './sync-state';

/** The complete set of non-`$app` fields this app may ever write. */
const WRITABLE_FIELDS = ['email_optin', 'email'] as const;

export type WritableAccountField = (typeof WRITABLE_FIELDS)[number];

export type AccountWriteback = Partial<Record<WritableAccountField, unknown>>;

/**
 * Writes the allowed account fields together with the sync-state stamp that identifies the
 * change as ours. Both halves go in one PUT: two writes would produce two
 * `account.updated` events, and only one of them would carry the marker.
 */
export async function writeAccountFromWebhook(
  req: SwellRequest,
  accountId: string,
  fields: AccountWriteback,
  state: SyncState,
): Promise<void> {
  const values: Record<string, unknown> = {};
  for (const field of WRITABLE_FIELDS) {
    if (field in fields && fields[field] !== undefined) {
      values[field] = fields[field];
    }
  }

  // The marker is not optional. Writing account fields without it is the loop.
  const stamped: SyncState = {
    ...state,
    last_webhook_at: state.last_webhook_at ?? new Date().toISOString(),
  };

  await req.swell.put(`/accounts/${accountId}`, {
    ...values,
    ...req.appValues(normalizeState(stamped)),
  });
}

/**
 * Finds the Swell account a Mailchimp webhook is about.
 *
 * Mailchimp identifies people by email address and nothing else, so this is a lookup by
 * address — first the account's current email, then the address the app last pushed under.
 * The second pass matters for `upemail`: after the address changes in Mailchimp, the Swell
 * account still holds the old one, and `$app.mailchimp.remote_email` is the only link left.
 */
export async function findAccountByEmail(
  req: SwellRequest,
  appId: string,
  email: string,
): Promise<Record<string, any> | null> {
  const address = email.trim().toLowerCase();
  if (!address) return null;

  const byEmail = (await req.swell.get('/accounts', {
    where: { email: address },
    limit: 1,
  } as any)) as { results?: Array<Record<string, any>> } | null;

  if (byEmail?.results?.[0]) {
    return byEmail.results[0];
  }

  const byRemote = (await req.swell.get('/accounts', {
    where: { [`$app.${appId}.remote_email`]: address },
    limit: 1,
  } as any)) as { results?: Array<Record<string, any>> } | null;

  return byRemote?.results?.[0] ?? null;
}

/** Never let a write-back failure mask the webhook it came from. */
export async function tryWriteAccountFromWebhook(
  req: SwellRequest,
  accountId: string,
  fields: AccountWriteback,
  state: SyncState,
): Promise<boolean> {
  try {
    await writeAccountFromWebhook(req, accountId, fields, state);
    return true;
  } catch (err) {
    console.error(
      `Mailchimp: could not write back to accounts/${accountId}: ${errorText(err)}`,
    );
    return false;
  }
}
