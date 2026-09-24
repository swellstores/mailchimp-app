import {
  changedFields,
  eventType,
  hasRelevantChange,
  resyncRequested,
} from './lib/events';
import { deleteRecord, pushRecord, throwIfFailed } from './lib/push';
import { getSettings } from './lib/settings';

/**
 * Carts → the Mailchimp ecommerce store's `carts`, which is what makes abandoned-cart
 * automations possible. The native integration syncs no carts at all, so this whole
 * capability is new rather than improved.
 *
 * ---------------------------------------------------------------------------------------
 * THE DELETE-ON-CONVERSION RULE
 *
 * Mailchimp's abandoned-cart automation runs off carts *present in the store*. It has no
 * concept of a cart that became an order; the integration is expected to delete the cart at
 * that moment. Skip that and the automation cheerfully emails "you left something behind"
 * to a customer who has already paid — the single most visible way this kind of integration
 * goes wrong.
 *
 * So `cart.converted` deletes unconditionally, regardless of the "Sync deletions" setting.
 * That setting is about propagating a merchant's destructive action; this is about not
 * sending a wrong email.
 * ---------------------------------------------------------------------------------------
 *
 * `config.model.conditions` is deliberately absent — see `lib/events.ts` for why.
 */
export const config: SwellConfig = {
  description: 'Sync carts to Mailchimp for abandoned-cart automations',
  model: {
    events: [
      'cart.created',
      'cart.updated',
      'cart.abandoned',
      'cart.converted',
      'cart.deleted',
    ],
  },
};

export default async function (req: SwellRequest) {
  const settings = await getSettings(req);
  if (!settings.enabled || !settings.sync_carts) {
    return;
  }

  const changed = changedFields(req);
  const type = eventType(req);

  // A cart that has become an order, or been emptied, must leave Mailchimp whatever else
  // is configured. Handled before every other gate for that reason.
  if (type === 'cart.converted') {
    throwIfFailed(await deleteRecord(req, settings, 'carts', req.data.id));
    return;
  }

  if (type === 'cart.deleted') {
    if (!settings.event_deleted) {
      return;
    }
    throwIfFailed(await deleteRecord(req, settings, 'carts', req.data.id));
    return;
  }

  const resync = resyncRequested(req, changed);

  // "Abandoned only" trades automation latency for outbound traffic: Mailchimp starts its
  // own timer when the cart arrives, so a cart that only appears once Swell has already
  // called it abandoned triggers the automation later than a merchant expects.
  if (!resync && settings.cart_scope === 'abandoned' && type !== 'cart.abandoned') {
    return;
  }

  switch (type) {
    case 'cart.created': {
      if (!resync && (!settings.event_created || settings.push_trigger === 'manual')) {
        return;
      }
      throwIfFailed(await pushRecord(req, settings, 'carts', req.data.id));
      return;
    }

    case 'cart.abandoned':
    case 'cart.updated': {
      // `cart.abandoned` is the event the whole feature exists for, so it pushes even when
      // the cart has never been sent before — `requireExisting` would skip exactly the
      // carts Mailchimp most needs.
      const firstPushAllowed = resync || type === 'cart.abandoned';

      if (type === 'cart.updated' && !resync && !hasRelevantChange('carts', changed)) {
        return;
      }
      if (!resync && !settings.event_updated) {
        return;
      }
      if (!resync && settings.push_trigger === 'manual') {
        return;
      }

      throwIfFailed(
        await pushRecord(req, settings, 'carts', req.data.id, {
          requireExisting: !firstPushAllowed,
        }),
      );
      return;
    }

    default:
      return;
  }
}
