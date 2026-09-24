/**
 * Shared gating for the four model-event handlers.
 *
 * ---------------------------------------------------------------------------------------
 * TWO PLATFORM FACTS THIS FILE EXISTS BECAUSE OF, both measured:
 *
 *  1. **`$settings` in `config.model.conditions` kills dispatch entirely.** The event
 *     records zero pending deliveries and there is nothing to debug. So every gate — the
 *     master switch, the per-collection toggles, the push trigger — is evaluated here, in
 *     code, and `conditions` is left off the config blocks altogether.
 *
 *  2. **`$data.<field>` conditions match every update**, because `$data` resolves against
 *     the whole record rather than the change. `req.data.$event.data` is the one place
 *     that really does hold only the changed fields on `updated` — confirmed against live
 *     events on this store, which show e.g. `{id, order_count, date_last_order}` for an
 *     account touched by an order.
 *
 * That second point is not a nicety. Swell fires `account.updated` on every order for
 * `order_count` and `date_last_order`; without a relevance filter this app would push every
 * customer to Mailchimp on every purchase, twice over.
 * ---------------------------------------------------------------------------------------
 */

import { appId } from './settings';
import { SyncCollection } from './sync-state';

/** Changed fields on `updated`; empty on `created` and `deleted`, which is fine. */
export function changedFields(req: SwellRequest): Record<string, any> {
  return (req.data as any)?.$event?.data ?? {};
}

export function eventType(req: SwellRequest): string {
  return String((req.data as any)?.$event?.type ?? '');
}

/** The merchant's manual re-sync button: a writable `$app.<app_id>.resync_requested` bool. */
export function resyncRequested(req: SwellRequest, changed: Record<string, any>): boolean {
  return changed.$app?.[appId(req)]?.resync_requested === true;
}

/**
 * True when the change is this app's own write-back from an inbound webhook.
 *
 * `lib/account-writeback.ts` always stamps `last_webhook_at` in the same PUT as the
 * `email_optin` or `email` it writes, so its change is self-identifying. Without this the
 * app would push an unsubscribe straight back to Mailchimp the moment it received one.
 */
export function isOwnWebhookWriteback(
  req: SwellRequest,
  changed: Record<string, any>,
): boolean {
  return Boolean(changed.$app?.[appId(req)]?.last_webhook_at);
}

/**
 * Fields whose change is worth a push. Everything else — counters, timestamps, another
 * app's `$app` namespace — is ignored.
 *
 * Kept as data rather than as conditions in `config` because of platform fact 2 above.
 */
export const WATCHED_FIELDS: Record<SyncCollection, readonly string[]> = {
  accounts: [
    'email',
    'email_optin',
    'first_name',
    'last_name',
    'name',
    'phone',
    'shipping',
    'billing',
  ],
  products: [
    'name',
    'slug',
    'sku',
    'price',
    'sale',
    'sale_price',
    'active',
    'description',
    'images',
    'stock_level',
    'stock_status',
    'brand',
    'type',
    'variants',
    'options',
  ],
  carts: [
    'items',
    'account_id',
    'currency',
    'grand_total',
    'sub_total',
    'tax_total',
    'checkout_url',
    'abandoned',
    'recovered',
    'order_id',
  ],
  orders: [
    'items',
    'paid',
    'canceled',
    'delivered',
    'status',
    'refund_total',
    'payment_total',
    'grand_total',
    'discount_total',
    'tax_total',
    'shipment_total',
    'coupon_code',
    'shipping',
    'billing',
    'item_quantity_delivered',
    'date_canceled',
  ],
};

export function hasRelevantChange(
  collection: SyncCollection,
  changed: Record<string, any>,
): boolean {
  return WATCHED_FIELDS[collection].some((field) => field in changed);
}
