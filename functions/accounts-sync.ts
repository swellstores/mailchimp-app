import {
  changedFields,
  eventType,
  hasRelevantChange,
  isOwnWebhookWriteback,
  resyncRequested,
} from './lib/events';
import { errorText, isNotFound, MailchimpClient } from './lib/mailchimp-client';
import { pushRecord, throwIfFailed } from './lib/push';
import { configurationError, getSettings } from './lib/settings';

/**
 * Customer accounts → the Mailchimp ecommerce store's `customers`, and the audience's
 * `members`.
 *
 * This is the handler that overlaps the native integration. The native pushes an email
 * address to one list on create/update when `email_optin` is true, and stops there. This
 * one additionally creates the ecommerce customer that carts and orders hang off, records
 * the audience status back on the account, and leaves a merchant-visible trail.
 *
 * `config.model.conditions` is deliberately absent — see `lib/events.ts` for why.
 */
export const config: SwellConfig = {
  description: 'Sync customer accounts to Mailchimp customers and audience members',
  model: {
    events: ['account.created', 'account.updated', 'account.deleted'],
  },
};

export default async function (req: SwellRequest) {
  const settings = await getSettings(req);
  if (!settings.enabled || !settings.sync_accounts) {
    return;
  }

  const changed = changedFields(req);

  switch (eventType(req)) {
    case 'account.created': {
      if (!settings.event_created || settings.push_trigger === 'manual') {
        return;
      }
      throwIfFailed(await pushRecord(req, settings, 'accounts', req.data.id));
      return;
    }

    case 'account.updated': {
      // THE LOOP BREAKER. `lib/account-writeback.ts` stamps `last_webhook_at` in the same
      // write as the `email_optin` it clears, so an inbound unsubscribe is recognisable
      // here and never pushed straight back out. See lib/sync-state.ts's header.
      if (isOwnWebhookWriteback(req, changed)) {
        return;
      }

      const resync = resyncRequested(req, changed);

      // Swell fires `account.updated` for `order_count` and `date_last_order` on every
      // order. Without this filter every purchase would re-push the customer.
      if (!resync && !hasRelevantChange('accounts', changed)) {
        return;
      }
      if (!resync && !settings.event_updated) {
        return;
      }
      if (!resync && settings.push_trigger === 'manual') {
        return;
      }

      // Opting in is a reason to create the member even if this account was never sent:
      // the native integration does, and otherwise a customer who ticks the box after
      // signing up never reaches the audience.
      const optinChanged = 'email_optin' in changed;
      const optedInNow = optinChanged && req.data.email_optin === true;

      throwIfFailed(
        await pushRecord(req, settings, 'accounts', req.data.id, {
          // A manual re-sync may legitimately be the first push, and so may an opt-in.
          // Any other incidental edit should not create a customer Mailchimp has never seen.
          requireExisting: !resync && !optedInNow,
          optinChanged,
        }),
      );
      return;
    }

    case 'account.deleted': {
      await archiveDeletedMember(req, settings);
      return;
    }

    default:
      // Subscribing to more events than the settings currently use lets a merchant change
      // the trigger without a redeploy. Unknown types are simply ignored.
      return;
  }
}

/**
 * Archives the deleted account's audience member, as the native integration does on
 * `account.deleted`. Archiving stops campaigns and is reversible in Mailchimp.
 *
 * The ecommerce customer is deliberately kept: deleting it takes the customer's order
 * history and the revenue reporting built on it with it.
 *
 * A deleted record cannot be re-read, so the address comes from `$event.data`, which on a
 * `deleted` event holds the whole record as it was.
 */
async function archiveDeletedMember(
  req: SwellRequest,
  settings: Awaited<ReturnType<typeof getSettings>>,
) {
  if (!settings.archive_on_delete || configurationError(settings)) {
    return;
  }
  const deleted = (req.data.$event?.data ?? {}) as Record<string, any>;
  const email = String(deleted.email ?? req.data.email ?? '').trim();
  if (!email) {
    return;
  }
  try {
    await new MailchimpClient(settings).archiveMember(settings.list_id, email);
    console.log(`Mailchimp: archived audience member for deleted account ${deleted.id ?? ''}`);
  } catch (err) {
    if (isNotFound(err)) return; // Never a member, or already archived.
    // Thrown so the platform redelivers: a missed archive keeps emailing a deleted customer.
    throw new SwellError(`Could not archive the Mailchimp member: ${errorText(err)}`, {
      status: 503,
    });
  }
}
