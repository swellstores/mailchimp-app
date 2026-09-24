/**
 * Layer 2 of the three-layer error model: orchestration.
 *
 * `pushRecord` never throws for an *expected* failure. It returns `{ ok, action, message,
 * retryable }` and records sync state before returning, so the merchant sees the outcome in
 * the dashboard whether or not the caller does anything with the result.
 *
 * Distinct non-retryable outcomes get distinct actions — `skipped_not_configured`,
 * `skipped_never_pushed`, `skipped_no_items`, `skipped_guest` — because "error" tells a
 * merchant nothing.
 *
 * Layer 3 is `throwIfFailed` at the bottom: the only place a result becomes a thrown
 * `SwellError`, and therefore the only place that decides whether the platform redelivers.
 */

import {
  MailchimpClient,
  MailchimpError,
  PROBE_TIMEOUT_MS,
  errorText,
  isComplianceState,
  isNotFound,
} from './mailchimp-client';
import {
  MailchimpSettings,
  configurationError,
  storeId,
  storefrontOrigin,
} from './settings';
import {
  buildCartPayload,
  buildCustomerPayload,
  buildMemberPayload,
  buildOrderPayload,
  buildProductPayload,
} from './mappers';
import { provisionAfterNotFound } from './store';
import {
  SyncCollection,
  SyncState,
  SyncStatus,
  readSyncState,
  recordSyncState,
} from './sync-state';

export type PushAction =
  | 'pushed'
  | 'deleted'
  | 'skipped_not_configured'
  | 'skipped_collection_off'
  | 'skipped_never_pushed'
  | 'skipped_no_items'
  | 'skipped_guest'
  | 'skipped_no_email'
  | 'error';

export interface PushResult {
  collection: SyncCollection;
  recordId: string;
  ok: boolean;
  action: PushAction;
  message?: string;
  /** Only meaningful when ok is false: whether the platform should redeliver the event. */
  retryable?: boolean;
  remoteId?: string;
}

export interface PushOptions {
  /** Update and delete paths only touch records Mailchimp already knows about. */
  requireExisting?: boolean;
  /** Overrides the status written on success, e.g. 'canceled' from the cart-converted path. */
  successStatus?: SyncStatus;
  /**
   * Accounts only: this event changed `email_optin`. An opt-in then (re)subscribes an
   * existing member, which the upsert's `status_if_new` alone never does.
   */
  optinChanged?: boolean;
}

/**
 * Relations each mapper needs, and nothing more — every expand costs latency inside a 10
 * second budget.
 *
 * Note what is deliberately absent: carts and orders do **not** expand `items.product`.
 * Mailchimp lines carry ids, quantities and prices, all of which live on the line item
 * itself. Expanding the product for every line would double the read for data that is
 * never sent.
 */
export const RECORD_EXPAND: Record<SyncCollection, string[]> = {
  accounts: [],
  products: [],
  carts: ['account'],
  orders: ['account'],
};

/**
 * Variants come back through `include` rather than `expand` so the limit is explicit.
 * Mailchimp's own product GET caps at 50 variants; Swell products can exceed that, and a
 * silently-truncated variant list is a cart line that 404s later.
 */
const PRODUCT_INCLUDE = {
  variants: {
    url: '/products:variants',
    params: { parent_id: 'id', limit: 1000 },
  },
};

export async function loadRecord(
  req: SwellRequest,
  collection: SyncCollection,
  recordId: string,
): Promise<Record<string, any> | null> {
  const params: Record<string, any> = { id: recordId };
  const expand = RECORD_EXPAND[collection];
  if (expand.length > 0) params.expand = expand;
  if (collection === 'products') params.include = PRODUCT_INCLUDE;

  return (await req.swell.get(`/${collection}/{id}`, params as any)) as Record<
    string,
    any
  > | null;
}

/** Per-collection master toggle, so a merchant can sync orders without syncing carts. */
export function collectionEnabled(
  settings: MailchimpSettings,
  collection: SyncCollection,
): boolean {
  switch (collection) {
    case 'accounts':
      return settings.sync_accounts;
    case 'products':
      return settings.sync_products;
    case 'carts':
      return settings.sync_carts;
    case 'orders':
      return settings.sync_orders;
    default:
      return false;
  }
}

export function buildPayload(
  collection: SyncCollection,
  record: Record<string, any>,
  settings: MailchimpSettings,
  origin: string,
): Record<string, any> {
  switch (collection) {
    case 'accounts':
      return buildCustomerPayload(record);
    case 'products':
      return buildProductPayload(record, settings, origin);
    case 'carts':
      return buildCartPayload(record, settings, origin);
    case 'orders':
      return buildOrderPayload(record, settings, origin);
    default:
      throw new Error(`No Mailchimp mapper for collection "${collection}".`);
  }
}

/**
 * Writes the audience member alongside the ecommerce customer.
 *
 * This is the row of the comparison table the native integration occupies, and the only
 * place this app talks to `/lists`. Two rules, both of them Mailchimp's:
 *
 *  - Subscribing is `status_if_new` only. Mailchimp refuses an API re-subscribe of someone
 *    who unsubscribed, and asking anyway fails the whole push.
 *  - Unsubscribing is a PATCH, never a PUT. A PUT would create the member if they were not
 *    there, which is an absurd thing to do on the way to unsubscribing them.
 *
 * Returns the state fields to merge into the sync-state write. Never throws for "the member
 * is not there": that is a normal outcome of unsubscribing someone who never subscribed.
 */
async function pushAudienceMember(
  client: MailchimpClient,
  settings: MailchimpSettings,
  account: Record<string, any>,
  state: SyncState,
  optinChanged = false,
): Promise<SyncState> {
  const optedIn = account.email_optin === true;
  const email = String(account.email ?? '').trim();
  if (!email) return {};

  // The address changed since the last push. Mailchimp addresses members by their email,
  // so update the OLD member's address rather than orphaning them and creating a second.
  const previousEmail = String(state.remote_email ?? '').trim().toLowerCase();
  if (previousEmail && previousEmail !== email.toLowerCase()) {
    try {
      await client.patchMember(
        settings.list_id,
        previousEmail,
        { email_address: email },
        PROBE_TIMEOUT_MS,
      );
    } catch (err) {
      if (!isNotFound(err)) throw err;
      // The old member is gone; the upsert below creates the new one.
    }
  }

  // Only an explicit `false` is an opt-out, as in the native integration. An unset
  // `email_optin` must not unsubscribe someone who signed up through a Mailchimp form.
  // No longer gated on this app having recorded them as subscribed: members who joined
  // through Mailchimp were never unsubscribed by a Swell opt-out before. A member already
  // recorded as unsubscribed is not patched again on every unrelated edit.
  const optedOut = account.email_optin === false;
  if (optedOut && settings.push_optout && state.list_status !== 'unsubscribed') {
    try {
      const member = await client.patchMember(
        settings.list_id,
        email,
        { status: 'unsubscribed' },
        PROBE_TIMEOUT_MS,
      );
      return {
        remote_email: email,
        remote_id: member?.id != null ? String(member.id) : (state.remote_id ?? null),
        list_status: 'unsubscribed',
      };
    } catch (err) {
      if (!isNotFound(err)) throw err;
      return { remote_email: email, list_status: null };
    }
  }

  // Shorter budget than the default 4s: this is the *second* Mailchimp call of the account
  // push (the ecommerce customer went first), and both plus the sync-state write have to
  // fit inside the platform's 10 second ceiling.
  // An opt-in made in this very event is explicit consent, so an existing member who had
  // unsubscribed or was transactional-only is subscribed again, as the native integration
  // does. Any other push leaves an existing member's status alone.
  const payload = buildMemberPayload(account);
  if (optedIn && optinChanged) {
    payload.status = 'subscribed';
  }
  let member: Record<string, any>;
  try {
    member = await client.upsertMember(settings.list_id, email, payload, 3000);
  } catch (err) {
    if (!(payload.status === 'subscribed' && isComplianceState(err))) throw err;
    // They unsubscribed through Mailchimp. Only they can undo that, so ask Mailchimp to
    // send its confirmation email rather than subscribing them directly.
    member = await client.upsertMember(
      settings.list_id,
      email,
      { ...payload, status: 'pending' },
      PROBE_TIMEOUT_MS,
    );
  }

  return {
    remote_email: email,
    remote_id: member?.id != null ? String(member.id) : (state.remote_id ?? null),
    list_status: typeof member?.status === 'string' ? (member.status as any) : null,
  };
}

/** Sends the mapped payload for one collection and returns the state fields to record. */
async function sendPayload(
  client: MailchimpClient,
  settings: MailchimpSettings,
  store: string,
  collection: SyncCollection,
  recordId: string,
  record: Record<string, any>,
  payload: Record<string, any>,
  state: SyncState,
  options: PushOptions = {},
): Promise<SyncState> {
  switch (collection) {
    case 'accounts': {
      const customer = await client.upsertCustomer(store, recordId, payload);
      const memberState = await pushAudienceMember(
        client,
        settings,
        record,
        state,
        options.optinChanged,
      );
      return {
        remote_id: customer?.id != null ? String(customer.id) : recordId,
        ...memberState,
      };
    }
    case 'products': {
      const product = await client.upsertProduct(store, recordId, payload);
      return {
        remote_id: product?.id != null ? String(product.id) : recordId,
        variant_count: Array.isArray(payload.variants) ? payload.variants.length : null,
      };
    }
    case 'carts': {
      // The one resource with no PUT. `remote_key` is the create-or-update hint.
      const cart = await client.upsertCart(store, recordId, payload, Boolean(state.remote_key));
      return { remote_id: cart?.id != null ? String(cart.id) : recordId };
    }
    case 'orders': {
      const order = await client.upsertOrder(store, recordId, payload);
      return { remote_id: order?.id != null ? String(order.id) : recordId };
    }
    default:
      throw new Error(`No Mailchimp endpoint for collection "${collection}".`);
  }
}

async function sendDelete(
  client: MailchimpClient,
  store: string,
  collection: SyncCollection,
  recordId: string,
): Promise<void> {
  switch (collection) {
    case 'accounts':
      await client.deleteCustomer(store, recordId);
      return;
    case 'products':
      await client.deleteProduct(store, recordId);
      return;
    case 'carts':
      await client.deleteCart(store, recordId);
      return;
    case 'orders':
      await client.deleteOrder(store, recordId);
      return;
    default:
      throw new Error(`No Mailchimp delete endpoint for collection "${collection}".`);
  }
}

/**
 * Creates or replaces a record in Mailchimp and records the outcome on the Swell record.
 * Never throws for an expected failure — callers decide, via `throwIfFailed`, whether a
 * failure should be retried by the platform.
 */
export async function pushRecord(
  req: SwellRequest,
  settings: MailchimpSettings,
  collection: SyncCollection,
  recordId: string,
  options: PushOptions = {},
): Promise<PushResult> {
  const base = { collection, recordId } as const;

  const configError = configurationError(settings);
  if (configError) {
    // No sync-state write here on purpose: nothing has been attempted, and stamping every
    // record in the store with an error the moment the app is installed is noise.
    return {
      ...base,
      ok: false,
      action: 'skipped_not_configured',
      message: configError,
      // Retrying cannot fix a missing credential; record it once and stop.
      retryable: false,
    };
  }

  if (!collectionEnabled(settings, collection)) {
    return {
      ...base,
      ok: true,
      action: 'skipped_collection_off',
      message: `Syncing ${collection} is switched off in app settings.`,
    };
  }

  const record = await loadRecord(req, collection, recordId);
  if (!record) {
    return {
      ...base,
      ok: false,
      action: 'error',
      message: `Record ${collection}/${recordId} was not found.`,
      retryable: false,
    };
  }

  const state = readSyncState(req, record);

  if (options.requireExisting && !state.remote_key) {
    // `remote_key` doubles as the "has this ever been pushed?" flag. An incidental edit
    // should not create a record Mailchimp has never seen.
    return {
      ...base,
      ok: true,
      action: 'skipped_never_pushed',
      message: 'Record has not been pushed to Mailchimp yet.',
    };
  }

  const origin = storefrontOrigin(req, settings);

  let payload: Record<string, any>;
  try {
    payload = buildPayload(collection, record, settings, origin);
  } catch (err) {
    const message = errorText(err);
    await recordSyncState(req, collection, recordId, {
      sync_status: 'skipped',
      last_error: message,
      resync_requested: false,
    });
    // A payload this record can never produce: retrying reproduces the same failure.
    return {
      ...base,
      ok: true,
      // Order matters: the guest message also mentions an email address, and "this record
      // has no customer at all" is a different thing for a merchant to read than "this
      // customer has no address".
      action: /customer account/i.test(message)
        ? 'skipped_guest'
        : /email/i.test(message)
          ? 'skipped_no_email'
          : 'skipped_no_items',
      message,
    };
  }

  const client = new MailchimpClient(settings);
  const store = storeId(req, settings);

  try {
    const remoteState = await sendPayload(
      client,
      settings,
      store,
      collection,
      recordId,
      record,
      payload,
      state,
      options,
    );
    await recordSyncState(req, collection, recordId, {
      sync_status: options.successStatus ?? 'synced',
      remote_key: recordId,
      last_synced_at: new Date().toISOString(),
      last_error: null,
      resync_requested: false,
      ...remoteState,
    });
    console.log(`Mailchimp: pushed ${collection}/${recordId}`);
    return {
      ...base,
      ok: true,
      action: 'pushed',
      remoteId: remoteState.remote_id ?? undefined,
    };
  } catch (err) {
    return failure(req, settings, client, base, err);
  }
}

/**
 * Removes a record from Mailchimp. Used by the delete handlers and — regardless of the
 * `event_deleted` setting — by `cart.converted`, because a cart left in Mailchimp after it
 * becomes an order keeps the abandoned-cart automation emailing someone who already bought.
 */
export async function deleteRecord(
  req: SwellRequest,
  settings: MailchimpSettings,
  collection: SyncCollection,
  recordId: string,
): Promise<PushResult> {
  const base = { collection, recordId } as const;

  const configError = configurationError(settings);
  if (configError) {
    return {
      ...base,
      ok: false,
      action: 'skipped_not_configured',
      message: configError,
      retryable: false,
    };
  }

  // No read first: on `*.deleted` the record is already gone from Swell, and the id is all
  // Mailchimp needs. A delete for something Mailchimp does not have answers 404, which is
  // handled below as success rather than as an error.
  const client = new MailchimpClient(settings);
  const store = storeId(req, settings);

  try {
    await sendDelete(client, store, collection, recordId);
  } catch (err) {
    if (isNotFound(err)) {
      // Already gone. Deleting twice is the normal result of a redelivered event — but a
      // 404 is also what "someone deleted this in Mailchimp's UI" and "Mailchimp expired
      // the cart before cart.converted arrived" look like, and in those cases the record
      // still reads 'synced' in the admin. Stamp 'canceled' exactly like the successful
      // delete below, so the admin never claims Mailchimp holds a record it does not.
      // On a redelivered `*.deleted` event the Swell record is gone too and
      // `recordSyncState` swallows-and-logs the failed write — the same cost the success
      // branch already pays.
      await recordSyncState(req, collection, recordId, {
        sync_status: 'canceled',
        last_error: null,
        resync_requested: false,
      });
      return { ...base, ok: true, action: 'deleted', message: 'Already absent in Mailchimp.' };
    }
    return failure(req, settings, client, base, err);
  }

  await recordSyncState(req, collection, recordId, {
    sync_status: 'canceled',
    last_error: null,
    resync_requested: false,
  });
  console.log(`Mailchimp: deleted ${collection}/${recordId}`);
  return { ...base, ok: true, action: 'deleted' };
}

/**
 * The one place a thrown vendor error becomes a recorded result.
 *
 * The 404 branch is the lazy store-provisioning safety net (see `lib/store.ts`): a 404 on
 * an ecommerce write means either the store is missing — which this app can fix — or a
 * line references a product that has never been pushed, which it cannot. Telling the two
 * apart costs one 2s probe and is the difference between a self-healing install and a
 * merchant reading "404" forever.
 */
async function failure(
  req: SwellRequest,
  settings: MailchimpSettings,
  client: MailchimpClient,
  base: { collection: SyncCollection; recordId: string },
  err: unknown,
): Promise<PushResult> {
  let message = errorText(err);
  // Anything that is not a classified vendor error is unknown, and unknown is retryable.
  let retryable = err instanceof MailchimpError ? err.retryable : true;

  if (isNotFound(err)) {
    try {
      const provisioned = await provisionAfterNotFound(req, settings, client);
      if (provisioned) {
        message = provisioned;
        retryable = true;
      } else if (base.collection === 'orders' || base.collection === 'carts') {
        message +=
          ' — this usually means a line item references a product that has never been ' +
          'pushed to Mailchimp. Run the products backfill; the daily reconciler then ' +
          'clears this automatically.';
      }
    } catch (probeErr) {
      console.warn(`Mailchimp: store probe after a 404 failed: ${errorText(probeErr)}`);
    }
  }

  await recordSyncState(req, base.collection, base.recordId, {
    sync_status: 'error',
    last_error: message,
    resync_requested: false,
  });
  console.error(
    `Mailchimp: push failed for ${base.collection}/${base.recordId}: ${message}`,
  );
  return { ...base, ok: false, action: 'error', message, retryable };
}

/**
 * Layer 3 — the handler boundary. Model-event handlers call this so a failed push shows up
 * as a failed delivery in `/events:webhooks`. Retryable failures are rethrown for
 * redelivery; permanent ones are recorded once and never scheduled again.
 *
 * Note the platform auto-disables a model-event function after roughly four days of
 * continuous failure, so `retry: false` on a permanent failure is not a nicety.
 */
export function throwIfFailed(result: PushResult): void {
  if (result.ok) {
    return;
  }
  throw new SwellError(result.message ?? `Mailchimp push failed (${result.action})`, {
    status: 502,
    retry: result.retryable !== false,
  });
}
