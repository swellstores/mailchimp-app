import {
  BatchOperation,
  MailchimpClient,
  errorText,
} from './lib/mailchimp-client';
import {
  buildCartPayload,
  buildCustomerPayload,
  buildMemberPayload,
  buildOrderPayload,
  buildProductPayload,
} from './lib/mappers';
import { setStoreSyncing } from './lib/store';
import { PushResult, RECORD_EXPAND, collectionEnabled, pushRecord } from './lib/push';
import {
  appId,
  configurationError,
  getSettings,
  storeId,
  storefrontOrigin,
  type MailchimpSettings,
} from './lib/settings';
import {
  SYNC_COLLECTIONS,
  SyncCollection,
  readSyncState,
  recordSyncState,
} from './lib/sync-state';

/**
 * Backfill and manual re-sync.
 *
 * Private route (`public: false`), so it is reachable through the admin API with your CLI
 * session and never from the internet:
 *
 *   swell api post /functions/mailchimp/backfill --body '{"collection":"products","mode":"batch"}'
 *   swell api post /functions/mailchimp/backfill --body '{"batch_id":"a1b2c3","collection":"products"}'
 *   swell api post /functions/mailchimp/backfill --body '{"collection":"orders","record_id":"<id>"}'
 *   swell api post /functions/mailchimp/backfill --body '{"collection":"orders","sync_status":"error"}'
 *
 * ---------------------------------------------------------------------------------------
 * TWO MODES, AND WHY BOTH EXIST
 *
 * **direct** (default) pushes one record per API call and records exact sync state for each
 * one. Ten records per invocation, because each is a Mailchimp round trip plus a Swell
 * write and the function budget is 10 seconds. Correct, observable, slow.
 *
 * **batch** uses Mailchimp's `/batches` endpoint: up to 25 records go out as one
 * asynchronous submission that Mailchimp processes on its own time, which is the only way
 * to move a catalogue of thousands through a 10-second function.
 *
 * The honest cost of batch mode: Mailchimp returns per-operation results only as a
 * **gzipped tar archive** at `response_body_url`, and a Workers isolate has no gzip or tar.
 * So this app can read a batch's *counts* but not its individual failures. Batch mode
 * therefore marks records `pending` on submission — stamped with the batch's id — and,
 * once the batch finishes, flips *that batch's* records to `synced` if
 * `errored_operations` is zero and to `error` if it is not. The stamp is what makes
 * overlapping batches safe: polling batch A settles only the records A queued, never the
 * ones batch B still has in flight. When a batch reports errors, re-run the same
 * collection in direct mode: it is idempotent, and it will name each failing record.
 *
 * THERE IS NO `page` PARAMETER, by design. Every processed record leaves the selection —
 * a pushed or submitted record gains a `remote_key`, a skipped one gains a terminal
 * `sync_status` — so the records that would have been "page 2" have moved to the front by
 * the time a second call arrives. Advancing a page number over a draining selection skips
 * one page-worth of records per call, silently and permanently: nothing ever retries a
 * record that was never pushed. So every call selects from the front, and the caller
 * simply repeats the same call until `has_more` is false.
 * ---------------------------------------------------------------------------------------
 */
export const config: SwellConfig = {
  description: 'Backfill existing records into Mailchimp, directly or through the batch API',
  route: {
    methods: ['post'],
    public: false,
  },
};

/**
 * Keeps one direct invocation inside the 10s budget. Each push is a round trip plus a
 * sync-state write, so this is a small number on purpose — the caller repeats the call
 * until `has_more` is false.
 */
const MAX_DIRECT = 10;

/**
 * Batch mode's page size. 25, not 100 — bounded by the platform, not by Mailchimp
 * (Mailchimp documents no per-batch operation cap, only 500 *pending batches* per
 * account). Two platform limits meet here:
 *
 *  - Response bodies over 75 KB are **silently dropped**, and this selection reads
 *    records expanded (items, account, up to 1,000 variants per product). 100 expanded
 *    orders or products can plausibly clear 75 KB, and a dropped body is the worst
 *    possible failure — it reads as an empty page, i.e. "backfill complete".
 *    (`selectRecords` also refuses to treat a null body as an empty page, so if a page
 *    ever does trip the cap it is an error the operator sees, not a silent stop.)
 *  - The selection is an unindexed `$app`-field collection scan; the plan's guidance is
 *    a page size in the ~10–25 range (§2.3 — shipstation uses 10).
 *
 * 25 keeps batch mode's throughput advantage over direct mode while staying inside both.
 */
const MAX_BATCH = 25;

/** Concurrency for those writes. Serial would not fit; unbounded would open a socket per record. */
const WRITE_CONCURRENCY = 10;

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

function isSyncCollection(value: string): value is SyncCollection {
  return (SYNC_COLLECTIONS as readonly string[]).includes(value);
}

/** Runs `fn` over `items` with a fixed concurrency ceiling. */
async function mapChunked<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/**
 * Always reads page 1, on purpose: every caller's selection drains from the front as
 * records are processed (see the header), so "the next page" is always the front again.
 */
async function selectRecords(
  req: SwellRequest,
  collection: SyncCollection,
  where: Record<string, unknown>,
  limit: number,
  withExpansions: boolean,
): Promise<Array<Record<string, any>>> {
  const params: Record<string, any> = {
    ...where,
    limit,
    page: 1,
    sort: 'date_created asc',
  };
  if (withExpansions && RECORD_EXPAND[collection].length > 0) {
    params.expand = RECORD_EXPAND[collection];
  }
  if (withExpansions && collection === 'products') {
    params.include = {
      variants: { url: '/products:variants', params: { parent_id: 'id', limit: 1000 } },
    };
  }

  const response = (await req.swell.get(`/${collection}`, params as any)) as {
    results?: Array<Record<string, any>>;
  } | null;

  // A null or malformed response is NOT an empty page, and conflating the two is the
  // worst failure this route can have. The platform silently drops response bodies over
  // 75 KB, and an expanded read that trips the cap comes back as nothing at all — which
  // `response?.results ?? []` used to report as "0 records, has_more: false", i.e.
  // "backfill complete" for a backfill that never ran. A genuinely empty page is
  // `{ count: 0, results: [] }`; anything else is an error the operator must see.
  if (!response || !Array.isArray(response.results)) {
    throw new SwellError(
      `Reading /${collection} returned no result set (limit ${limit}). This usually means ` +
        'the response body exceeded the platform\'s silent 75 KB cap — retry with a ' +
        'smaller "limit".',
      { status: 502 },
    );
  }
  return response.results;
}

/**
 * Mailchimp batch operations for one record. Note `body` is a JSON **string**, not an
 * object — that is Mailchimp's contract, and sending an object silently produces a batch
 * whose every operation fails.
 */
function batchOperations(
  req: SwellRequest,
  settings: MailchimpSettings,
  collection: SyncCollection,
  record: Record<string, any>,
): BatchOperation[] {
  const store = encodeURIComponent(storeId(req, settings));
  const origin = storefrontOrigin(req, settings);
  const id = String(record.id);
  const encoded = encodeURIComponent(id);

  switch (collection) {
    case 'accounts':
      return [
        {
          method: 'PUT',
          path: `/ecommerce/stores/${store}/customers/${encoded}`,
          body: JSON.stringify(buildCustomerPayload(record)),
          operation_id: `customer:${id}`,
        },
        {
          method: 'PUT',
          path: `/lists/${encodeURIComponent(settings.list_id)}/members/${encodeURIComponent(
            String(record.email).trim().toLowerCase(),
          )}`,
          body: JSON.stringify(buildMemberPayload(record)),
          operation_id: `member:${id}`,
        },
      ];
    case 'products':
      return [
        {
          method: 'PUT',
          path: `/ecommerce/stores/${store}/products/${encoded}`,
          body: JSON.stringify(buildProductPayload(record, settings, origin)),
          operation_id: `product:${id}`,
        },
      ];
    case 'orders':
      return [
        {
          method: 'PUT',
          path: `/ecommerce/stores/${store}/orders/${encoded}`,
          body: JSON.stringify(buildOrderPayload(record, settings, origin)),
          operation_id: `order:${id}`,
        },
      ];
    case 'carts': {
      // Carts have no PUT, so the operation depends on whether Mailchimp already has it.
      // `remote_key` is the flag; inside a batch there is no chance to retry on a 400, so
      // getting this right from sync state is the only option.
      const pushed = Boolean(readSyncState(req, record).remote_key);
      const payload = buildCartPayload(record, settings, origin);
      if (pushed) {
        const { id: _ignored, ...patch } = payload;
        return [
          {
            method: 'PATCH',
            path: `/ecommerce/stores/${store}/carts/${encoded}`,
            body: JSON.stringify(patch),
            operation_id: `cart:${id}`,
          },
        ];
      }
      return [
        {
          method: 'POST',
          path: `/ecommerce/stores/${store}/carts`,
          body: JSON.stringify(payload),
          operation_id: `cart:${id}`,
        },
      ];
    }
    default:
      return [];
  }
}

export async function post(req: SwellRequest) {
  const settings = await getSettings(req);
  if (!settings.enabled) {
    throw new SwellError('Mailchimp sync is turned off in app settings.', { status: 409 });
  }
  const configError = configurationError(settings);
  if (configError) {
    throw new SwellError(configError, { status: 400 });
  }

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<
    string,
    any
  >;

  // Ends a backfill: lets Mailchimp run automations again. Run it once every collection
  // reports `has_more: false`. The daily reconcile also does this on its own once nothing
  // is left to send, so a forgotten call cannot leave automations off for good.
  if (text(body.action) === 'finish') {
    await setStoreSyncing(req, settings, new MailchimpClient(settings), false);
    return { ok: true, store_syncing: false, message: 'Backfill finished; Mailchimp automations are active again.' };
  }

  const collectionInput = text(body.collection) || 'orders';
  if (!isSyncCollection(collectionInput)) {
    throw new SwellError(
      `Unknown collection "${collectionInput}". One of: ${SYNC_COLLECTIONS.join(', ')}.`,
      { status: 400 },
    );
  }
  const collection: SyncCollection = collectionInput;

  if (!collectionEnabled(settings, collection)) {
    throw new SwellError(`Syncing ${collection} is switched off in app settings.`, {
      status: 409,
    });
  }

  const batchId = text(body.batch_id);
  if (batchId) {
    return pollBatch(req, settings, collection, batchId, body);
  }

  const recordId = text(body.record_id);
  const syncStatus = text(body.sync_status);

  // A bulk run sends historical records. Without this, Mailchimp treats each one as new
  // and fires its automations: order receipts and abandoned-cart emails for purchases
  // customers made long ago. A single-record re-sync is a correction, not a backfill.
  let storeSyncing: boolean | undefined;
  if (!recordId) {
    try {
      await setStoreSyncing(req, settings, new MailchimpClient(settings), true);
      storeSyncing = true;
    } catch (err) {
      console.warn(`Mailchimp: could not mark the store as syncing: ${errorText(err)}`);
      storeSyncing = false;
    }
  }
  const statusKey = `$app.${appId(req)}.sync_status`;
  const keyKey = `$app.${appId(req)}.remote_key`;

  // Default selection: everything never pushed. `remote_key` doubles as the "has this
  // ever been pushed?" flag — but the terminal statuses must be excluded explicitly,
  // because the skip paths record `sync_status: 'skipped'` WITHOUT a remote_key (nothing
  // was pushed, so there is no key to record). Without the `$nin`, every guest cart and
  // email-less account in the store would sit at the front of this selection forever.
  // Records with no sync state at all still match: a missing field is not in the list.
  //
  // Note there is deliberately no `page` here or anywhere below — see the header. The
  // selection drains from the front as records are pushed or skipped, so callers repeat
  // the same call until `has_more` is false. (Records whose push *fails* keep
  // `remote_key: null` and stay in the selection; they reappear, named, in `results`
  // until the cause is fixed — visible and retryable beats silently skipped.)
  const where: Record<string, unknown> = syncStatus
    ? { [statusKey]: syncStatus }
    : { [keyKey]: null, [statusKey]: { $nin: ['skipped', 'canceled'] } };

  if (text(body.mode) === 'batch' && !recordId) {
    const submitted = await submitBatch(req, settings, collection, where, body);
    return { ...submitted, store_syncing: storeSyncing };
  }

  // ---- direct mode ----------------------------------------------------------------------
  const recordIds = recordId
    ? [recordId]
    : (await selectRecords(req, collection, where, MAX_DIRECT, false)).map((r) =>
        String(r.id),
      );

  const results: PushResult[] = [];
  for (const id of recordIds) {
    // Per-item try/catch: one bad record must not fail the batch. `pushRecord` already
    // returns rather than throws for expected failures, so this only catches the unexpected.
    try {
      results.push(await pushRecord(req, settings, collection, id));
    } catch (err) {
      results.push({
        collection,
        recordId: id,
        ok: false,
        action: 'error',
        message: errorText(err),
        retryable: true,
      });
    }
  }

  // Response bodies over 75 KB are silently dropped by the platform, which is why each
  // call is bounded and the caller repeats rather than asking for everything at once.
  const hasMore = !recordId && recordIds.length === MAX_DIRECT;
  return {
    ok: results.every((result) => result.ok),
    mode: 'direct',
    collection,
    requested: recordIds.length,
    pushed: results.filter((result) => result.action === 'pushed').length,
    // A full page means there is probably more behind it.
    has_more: hasMore,
    store_syncing: storeSyncing,
    message: hasMore
      ? 'More records match. Repeat the exact same call until has_more is false — the ' +
        'selection drains from the front as records are pushed or skipped, so there is ' +
        'no page to advance.'
      : recordId
        ? 'Requested record processed — see results.'
        : 'Nothing further matches this selection.',
    results,
  };
}

async function submitBatch(
  req: SwellRequest,
  settings: MailchimpSettings,
  collection: SyncCollection,
  where: Record<string, unknown>,
  body: Record<string, any>,
) {
  const limit = Math.min(Number(body.limit) > 0 ? Number(body.limit) : MAX_BATCH, MAX_BATCH);
  // Always from the front: everything below leaves the selection on this very call
  // (queued records gain a remote_key, skipped ones a terminal status), so the next
  // tranche is at the front by the time the caller repeats.
  const records = await selectRecords(req, collection, where, limit, true);

  const operations: BatchOperation[] = [];
  const queued: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const record of records) {
    // Per-item, because a mapper throws for a record that can never be mapped — a guest
    // cart, an account with no email — and one of those must not abort the whole batch.
    try {
      const ops = batchOperations(req, settings, collection, record);
      if (ops.length === 0) continue;
      operations.push(...ops);
      queued.push(String(record.id));
    } catch (err) {
      skipped.push({ id: String(record.id), reason: errorText(err) });
    }
  }

  // Skipped records are recorded FIRST and unconditionally — before the early return
  // below, or an all-skipped tranche would never leave the selection and a caller
  // repeating the same call would loop on it forever. The skip path cannot stamp a
  // remote_key (nothing was pushed, so there is no key to record); what actually keeps
  // these records out of every later call is the default selection's
  // `$nin: ['skipped', 'canceled']` exclusion.
  await mapChunked(skipped, WRITE_CONCURRENCY, (entry) =>
    recordSyncState(req, collection, entry.id, {
      sync_status: 'skipped',
      last_error: entry.reason,
      resync_requested: false,
    }),
  );

  if (operations.length === 0) {
    // Every record in the tranche was unmappable (all just recorded 'skipped') or the
    // selection is empty. The skips have left the selection, so when the page was full
    // the caller repeats the same call for the next tranche.
    const hasMore = records.length === limit;
    return {
      ok: true,
      mode: 'batch',
      collection,
      queued: 0,
      skipped,
      has_more: hasMore,
      message: hasMore
        ? 'Every record in this tranche was skipped. Repeat the same call until has_more is false.'
        : 'Nothing left to backfill for this selection.',
    };
  }

  const client = new MailchimpClient(settings);
  const batch = await client.submitBatch(operations);

  // Marked before anything is known, on purpose: a record submitted in a batch is genuinely
  // "pending" until the batch finishes, and leaving it unmarked would make the same records
  // eligible for the next call's selection. The batch id is stamped alongside because it is
  // the ONLY tie between these records and this submission: `pollBatch` settles by batch id,
  // never by bare 'pending', so an operator can submit a second batch before polling the
  // first and each poll still touches only its own records.
  await mapChunked(queued, WRITE_CONCURRENCY, (id) =>
    recordSyncState(req, collection, id, {
      sync_status: 'pending',
      remote_key: id,
      batch_id: batch.id,
      last_error: null,
      resync_requested: false,
    }),
  );

  const hasMore = records.length === limit;
  return {
    ok: true,
    mode: 'batch',
    collection,
    batch_id: batch.id,
    operations: operations.length,
    queued: queued.length,
    skipped: skipped.length,
    has_more: hasMore,
    message:
      `Submitted ${operations.length} operation(s) as Mailchimp batch ${batch.id}. ` +
      `Poll it with: swell api post /functions/mailchimp/backfill --body ` +
      `'{"batch_id":"${batch.id}","collection":"${collection}"}'. ` +
      (hasMore
        ? 'More records match: repeat this same submit call until has_more is false — the ' +
          'selection drains from the front, so there is no page to advance.'
        : 'Nothing further matches this selection.'),
  };
}

async function pollBatch(
  req: SwellRequest,
  settings: MailchimpSettings,
  collection: SyncCollection,
  batchId: string,
  body: Record<string, any>,
) {
  const client = new MailchimpClient(settings);
  const batch = await client.getBatch(batchId);

  const finished = batch.status === 'finished';
  const errored = Number(batch.errored_operations ?? 0);

  if (!finished) {
    return {
      ok: true,
      mode: 'batch',
      collection,
      batch_id: batchId,
      status: batch.status,
      total_operations: batch.total_operations,
      finished_operations: batch.finished_operations,
      errored_operations: batch.errored_operations,
      settled: 0,
      has_more: true,
      message: 'Batch is still running. Poll again.',
    };
  }

  // Mailchimp publishes per-operation results only as a gzipped tar at `response_body_url`,
  // which a Workers isolate cannot open. So the batch's aggregate outcome is applied to the
  // records it left `pending` — and ONLY to those, matched by the batch id stamped at
  // submission. The scope is load-bearing: nothing stops an operator submitting batch B
  // before polling batch A (the route invites exactly that), and an unscoped 'pending'
  // sweep would settle B's still-in-flight records against A's counts. B's failures would
  // then never surface anywhere — the records read 'synced', and the daily reconciler
  // retries only error/pending.
  const limit = Math.min(Number(body.limit) > 0 ? Number(body.limit) : MAX_BATCH, MAX_BATCH);
  const pending = await selectRecords(
    req,
    collection,
    {
      [`$app.${appId(req)}.sync_status`]: 'pending',
      [`$app.${appId(req)}.batch_id`]: batchId,
    },
    limit,
    false,
  );

  const now = new Date().toISOString();
  await mapChunked(pending, WRITE_CONCURRENCY, (record) =>
    recordSyncState(req, collection, String(record.id), {
      sync_status: errored > 0 ? 'error' : 'synced',
      remote_id: String(record.id),
      last_synced_at: errored > 0 ? null : now,
      last_error:
        errored > 0
          ? `Mailchimp batch ${batchId} finished with ${errored} errored operation(s). ` +
            'Per-operation detail is only available as a gzipped archive, which this app ' +
            'cannot read — re-run this collection in direct mode to find the failures.'
          : null,
    }),
  );

  // Settled records flip out of 'pending', so a full page means this same poll call is
  // repeated — again from the front — until everything the batch queued is settled.
  const hasMore = pending.length === limit;
  return {
    ok: errored === 0,
    mode: 'batch',
    collection,
    batch_id: batchId,
    status: batch.status,
    total_operations: batch.total_operations,
    finished_operations: batch.finished_operations,
    errored_operations: batch.errored_operations,
    response_body_url: batch.response_body_url,
    settled: pending.length,
    has_more: hasMore,
    message:
      (errored > 0
        ? `Batch finished with ${errored} errored operation(s). Re-run this collection in direct mode to identify them.`
        : `Batch finished cleanly. Settled ${pending.length} record(s).`) +
      (hasMore
        ? ' More of this batch\'s records are still pending — repeat the same poll until has_more is false.'
        : ''),
  };
}
