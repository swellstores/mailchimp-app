import { MailchimpClient, errorText } from './lib/mailchimp-client';
import { collectionEnabled, pushRecord } from './lib/push';
import {
  NATIVE_INTEGRATION_WARNING,
  appId,
  configurationError,
  getSettings,
  nativeIntegrationEnabled,
  storeId,
} from './lib/settings';
import { describeEnsureResult, ensureStore, setStoreSyncing } from './lib/store';
import { SYNC_COLLECTIONS, SyncCollection } from './lib/sync-state';
import { ensureWebhook } from './lib/webhooks';

/**
 * Daily reconciliation: converge, idempotently.
 *
 * There is no event for an app's own settings changing, no event for "someone deleted the
 * ecommerce store in Mailchimp's UI", and no event for "Mailchimp dropped our webhook
 * subscription". All three converge here. The same pass retries records left in `error` or
 * stuck in `pending` — a Mailchimp outage that outlasted the platform's own redelivery
 * window would otherwise sit there forever, and a `pending` record is one whose batch never
 * got polled.
 *
 * Everything this function does must be safe to run twice, because it will be.
 */
export const config: SwellConfig = {
  description: 'Daily Mailchimp reconciliation: repair the store and webhook, retry failures',
  cron: {
    schedule: '0 6 * * *',
  },
};

/**
 * One cron tick is still one 10s function invocation. Retry a page, not the backlog — and
 * spread it across the four collections rather than spending the whole budget on the first.
 */
const MAX_RETRY_PER_COLLECTION = 3;

export default async function (req: SwellRequest) {
  const settings = await getSettings(req);

  const configError = configurationError(settings);
  if (!settings.enabled || configError) {
    console.log(
      `Mailchimp: skipping reconciliation — ${configError ?? 'the app is switched off'}.`,
    );
    return;
  }

  const client = new MailchimpClient(settings);

  if (await nativeIntegrationEnabled(req)) {
    console.warn(`Mailchimp: ${NATIVE_INTEGRATION_WARNING}`);
  }

  // ---- 1. Ecommerce store ---------------------------------------------------------------
  // Cheap, and it is the prerequisite for everything else. A store deleted in Mailchimp's
  // UI comes back here without anyone noticing it went.
  try {
    const result = await ensureStore(req, settings, client);
    if (result.created || result.listMismatch) {
      console.log(`Mailchimp: ${describeEnsureResult(result)}`);
    }
    if (result.listMismatch) {
      // Every push would go to the wrong audience. Stop rather than retry into the mistake.
      return;
    }
  } catch (err) {
    console.error(`Mailchimp: could not verify the ecommerce store: ${errorText(err)}`);
    return;
  }

  // ---- 2. Webhook subscription ----------------------------------------------------------
  // Converge-to-desired-state, never unconditional-subscribe: an unconditional POST on a
  // daily cron accumulates one duplicate subscription per day. `ensureWebhook` removes the
  // stale registrations a rotated webhook secret leaves behind.
  if (settings.webhook_secret) {
    try {
      const result = await ensureWebhook(req, settings, client);
      if (result.created || result.removed > 0) {
        console.log(`Mailchimp: ${result.message} Callback: ${result.url}`);
      }
    } catch (err) {
      // Registration needs the live environment; a test-only push cannot succeed here and
      // that must not stop the retry pass below.
      console.warn(`Mailchimp: webhook registration could not be verified: ${errorText(err)}`);
    }
  }

  // ---- 3. Retry failed and stalled pushes -----------------------------------------------
  // This query is a collection scan: Swell has no index declaration yet (§2.3), which is
  // exactly why the page size is three per collection rather than a sweep.
  let attempted = 0;
  let recovered = 0;

  for (const collection of SYNC_COLLECTIONS) {
    if (!collectionEnabled(settings, collection)) continue;

    let records: Array<{ id: string }> = [];
    try {
      const response = (await req.swell.get(`/${collection}`, {
        // `pending` is included on purpose: it is where a batch that was never polled to
        // completion leaves its records, and nothing else would ever clear them.
        [`$app.${appId(req)}.sync_status`]: { $in: ['error', 'pending'] },
        limit: MAX_RETRY_PER_COLLECTION,
        // Least recently touched first. Every attempt rewrites the record's sync state,
        // which moves it to the back, so a few records that always fail cannot hold the
        // front of the queue and starve the rest. (`date_created` did exactly that.)
        sort: 'date_updated asc',
      } as any)) as { results?: Array<{ id: string }> } | null;
      records = response?.results ?? [];
    } catch (err) {
      console.error(`Mailchimp: could not query failed ${collection}: ${errorText(err)}`);
      continue;
    }

    for (const record of records) {
      attempted += 1;
      // Per-item try/catch so one bad record cannot fail the whole reconciliation pass.
      try {
        const result = await pushRecord(req, settings, collection as SyncCollection, record.id);
        if (result.ok) recovered += 1;
      } catch (err) {
        console.error(`Mailchimp: reconcile failed for ${collection}/${record.id}: ${errorText(err)}`);
      }
    }
  }

  console.log(
    `Mailchimp: reconciled ${attempted} record(s) across ${SYNC_COLLECTIONS.length} collections, ${recovered} recovered.`,
  );

  // ---- 4. End a finished backfill -------------------------------------------------------
  // A backfill turns Mailchimp's `is_syncing` on to keep automations quiet. If nobody ran
  // the backfill's `finish` action, turn it off here once nothing is left to send, so live
  // receipts and abandoned-cart emails are not suppressed indefinitely.
  try {
    const store = await client.getStore(storeId(req, settings));
    if (store?.is_syncing === true && !(await backfillOutstanding(req, settings))) {
      await setStoreSyncing(req, settings, client, false);
      console.log('Mailchimp: backfill complete; turned store syncing off so automations run again.');
    }
  } catch (err) {
    console.warn(`Mailchimp: could not check the store's syncing flag: ${errorText(err)}`);
  }
}

/**
 * True while any enabled collection still has a record the backfill would send (never
 * pushed and not skipped) or one waiting on a Mailchimp batch. One row per collection is
 * enough to answer; these are collection scans, so nothing more is read.
 */
async function backfillOutstanding(
  req: SwellRequest,
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<boolean> {
  const statusKey = `$app.${appId(req)}.sync_status`;
  const keyKey = `$app.${appId(req)}.remote_key`;
  for (const collection of SYNC_COLLECTIONS) {
    if (!collectionEnabled(settings, collection)) continue;
    for (const where of [
      { [keyKey]: null, [statusKey]: { $nin: ['skipped', 'canceled', 'error'] } },
      { [statusKey]: 'pending' },
    ]) {
      const response = (await req.swell.get(`/${collection}`, { ...where, limit: 1 } as any)) as {
        results?: unknown[];
      } | null;
      if ((response?.results ?? []).length > 0) return true;
    }
  }
  return false;
}
