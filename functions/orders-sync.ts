import {
  changedFields,
  eventType,
  hasRelevantChange,
  resyncRequested,
} from './lib/events';
import { deleteRecord, pushRecord, throwIfFailed } from './lib/push';
import { getSettings } from './lib/settings';

/**
 * Orders → the Mailchimp ecommerce store's `orders`. This is what makes purchase history,
 * post-purchase automations, customer lifetime value and product recommendations work —
 * none of which the native integration provides, because it syncs no orders.
 *
 * `order.submitted` rather than `order.created` is the first push: a draft order is not a
 * purchase, and `submitted` is the event Swell fires when it becomes one. Both are
 * subscribed so a merchant can change the trigger without a redeploy.
 *
 * `config.model.conditions` is deliberately absent — see `lib/events.ts` for why.
 */
export const config: SwellConfig = {
  description: 'Sync orders to Mailchimp for purchase history and post-purchase automations',
  model: {
    events: [
      'order.created',
      'order.submitted',
      'order.updated',
      'order.paid',
      'order.canceled',
      'order.delivered',
      'order.deleted',
    ],
  },
};

export default async function (req: SwellRequest) {
  const settings = await getSettings(req);
  if (!settings.enabled || !settings.sync_orders) {
    return;
  }

  const changed = changedFields(req);
  const type = eventType(req);

  switch (type) {
    // `order.created` fires for drafts too. Left subscribed but not acted on: the payload
    // is identical to `order.submitted`'s and pushing both would double every order push
    // for no gain.
    case 'order.created':
      return;

    case 'order.submitted': {
      if (!settings.event_created || settings.push_trigger === 'manual') {
        return;
      }
      throwIfFailed(await pushRecord(req, settings, 'orders', req.data.id));
      return;
    }

    // Lifecycle events carry no changed-field set worth filtering on — the event *is* the
    // change — and each one moves `financial_status` or `fulfillment_status`, which is
    // what Mailchimp's Order Notification automations key on. So they push directly.
    case 'order.paid':
    case 'order.canceled':
    case 'order.delivered': {
      if (!settings.event_updated) {
        return;
      }
      throwIfFailed(
        await pushRecord(req, settings, 'orders', req.data.id, {
          requireExisting: true,
          successStatus: type === 'order.canceled' ? 'canceled' : undefined,
        }),
      );
      return;
    }

    case 'order.updated': {
      const resync = resyncRequested(req, changed);

      if (!resync && !hasRelevantChange('orders', changed)) {
        return;
      }
      if (!resync && !settings.event_updated) {
        return;
      }
      if (!resync && settings.push_trigger === 'manual') {
        return;
      }

      throwIfFailed(
        await pushRecord(req, settings, 'orders', req.data.id, {
          requireExisting: !resync,
        }),
      );
      return;
    }

    case 'order.deleted': {
      if (!settings.event_deleted) {
        return;
      }
      throwIfFailed(await deleteRecord(req, settings, 'orders', req.data.id));
      return;
    }

    default:
      return;
  }
}
