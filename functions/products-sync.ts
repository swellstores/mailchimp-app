import {
  changedFields,
  eventType,
  hasRelevantChange,
  resyncRequested,
} from './lib/events';
import { deleteRecord, pushRecord, throwIfFailed } from './lib/push';
import { errorText } from './lib/mailchimp-client';
import { getSettings } from './lib/settings';

/**
 * Products → the Mailchimp ecommerce store's `products`, each with its variants.
 *
 * Products are the dependency the rest of the app rests on: Mailchimp rejects a cart or
 * order line naming a `product_id` it has never seen, so a store whose products have not
 * been backfilled produces order failures rather than product failures. That is why
 * `lib/push.ts` adds an explicit hint to the 404 message on carts and orders.
 *
 * `config.model.conditions` is deliberately absent — see `lib/events.ts` for why.
 */
export const config: SwellConfig = {
  description: 'Sync products and variants to Mailchimp',
  model: {
    events: [
      'product.created',
      'product.updated',
      'product.deleted',
      'product.stock_adjusted',
      'product.variant.updated',
    ],
  },
};

/**
 * Variant events carry the *variant* id. Mailchimp holds variants inside the product, so
 * the parent has to be resolved before anything can be pushed.
 *
 * `product.stock_adjusted` is the exception: its payload carries the product id in `id`
 * and the variant in `variant_id`, confirmed against live events on this store.
 */
async function resolveProductId(req: SwellRequest, variantId: string): Promise<string | null> {
  try {
    const variant = (await req.swell.get('/products:variants/{id}', {
      id: variantId,
    } as any)) as Record<string, any> | null;
    return (variant?.parent_id as string) ?? null;
  } catch (err) {
    console.warn(`Mailchimp: could not resolve the parent product of variant ${variantId}: ${errorText(err)}`);
    return null;
  }
}

export default async function (req: SwellRequest) {
  const settings = await getSettings(req);
  if (!settings.enabled || !settings.sync_products) {
    return;
  }

  const changed = changedFields(req);
  const type = eventType(req);

  switch (type) {
    case 'product.created': {
      if (!settings.event_created || settings.push_trigger === 'manual') {
        return;
      }
      throwIfFailed(await pushRecord(req, settings, 'products', req.data.id));
      return;
    }

    case 'product.stock_adjusted':
    case 'product.variant.updated':
    case 'product.updated': {
      const resync = resyncRequested(req, changed);

      // Stock and variant events have no changed-field set to filter on — the event itself
      // is the signal — so the relevance filter only applies to plain updates.
      if (type === 'product.updated' && !resync && !hasRelevantChange('products', changed)) {
        return;
      }
      if (!resync && !settings.event_updated) {
        return;
      }
      if (!resync && settings.push_trigger === 'manual') {
        return;
      }

      let productId = req.data.id as string;
      if (type === 'product.variant.updated') {
        const parentId = await resolveProductId(req, productId);
        if (!parentId) {
          // Nothing to push and nothing to record it against: the variant is gone.
          return;
        }
        productId = parentId;
      }

      throwIfFailed(
        await pushRecord(req, settings, 'products', productId, {
          requireExisting: !resync && type === 'product.updated',
        }),
      );
      return;
    }

    case 'product.deleted': {
      if (!settings.event_deleted) {
        return;
      }
      throwIfFailed(await deleteRecord(req, settings, 'products', req.data.id));
      return;
    }

    default:
      return;
  }
}
