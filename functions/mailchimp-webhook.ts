import {
  findAccountByEmail,
  tryWriteAccountFromWebhook,
  type AccountWriteback,
} from './lib/account-writeback';
import { MailchimpClient } from './lib/mailchimp-client';
import { appId, configurationError, getSettings } from './lib/settings';
import { readSyncState, recordSyncState, type SyncState } from './lib/sync-state';
import {
  ConfirmationUnavailable,
  confirmWithMailchimp,
  type Confirmation,
} from './lib/webhook-confirm';
import {
  SIGNATURE_HEADER,
  isHandledEvent,
  parseWebhookPayload,
  secretsMatch,
  verifySignature,
} from './lib/webhook-payload';

/**
 * Inbound Mailchimp webhooks — the half of this app the native integration has no
 * equivalent for. Nothing flows back from Mailchimp today; an unsubscribe there leaves the
 * Swell account still marked as opted in, and the merchant emails them again through some
 * other channel.
 *
 * ---------------------------------------------------------------------------------------
 * AUTHENTICATION: CONFIRM EVERY CHANGE WITH MAILCHIMP
 *
 * The URL secret and the HMAC signature cannot authenticate a real delivery today. Swell's
 * public-route proxy passes a function the body *or* the query string, never both, so a
 * form-encoded POST arrives without its `?secret=`; and `req.rawBody` is a re-serialised
 * copy, so no signature over the original bytes can match. Both measured live 2026-09-24,
 * filed as Asana 1218816382065204.
 *
 * So the delivery is only a notification. Before anything is written, `lib/webhook-confirm`
 * reads the member back from Mailchimp with the merchant's API key and acts on what
 * Mailchimp says now: an unsubscribe is applied only if Mailchimp reports the member as
 * unsubscribed. A forged call can make the app look something up; it cannot change an
 * account.
 *
 * The secret and the signature are still checked when they *do* arrive (a CLI test, or
 * once the platform forwards them): a wrong secret is rejected outright, and an invalid
 * signature is logged. Neither is required, and neither replaces the confirmation.
 * ---------------------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------------------
 * THE PUBLIC URL USES THE APP'S **ObjectId**, NOT ITS STRING ID.
 *
 *     https://<store_id>.swell.store/functions/<APP OBJECT ID>/mailchimp-webhook
 *
 * `/functions/mailchimp/mailchimp-webhook` — the form this app documented and built until
 * this amendment — **404s**. Mailchimp accepts it, reports the subscription as created, and
 * drops every delivery, so the failure is silent at both ends. `req.appId` is the string id
 * and cannot be used to build this; `appObjectId()` in `lib/settings.ts` discovers the real
 * one, and `swell api get /functions/mailchimp/setup` prints it.
 *
 * The route also serves the **live** environment only. An app that has only been pushed to
 * test answers 404 there even with the correct ObjectId, so end-to-end needs
 * `swell app version minor && swell app install` — or a `callback_url` override pointing
 * Mailchimp at a tunnel.
 * ---------------------------------------------------------------------------------------
 */
export const config: SwellConfig = {
  route: {
    // GET as well as POST. Mailchimp validates a webhook URL by fetching it before the
    // subscription is created; a route that only answers POST fails registration with an
    // error that says nothing about the cause.
    methods: ['get', 'post'],
    public: true,
  },
  // MUST MATCH `WEBHOOK_FUNCTION_DESCRIPTION` in lib/settings.ts, verbatim. ObjectId
  // discovery matches on name AND description, because `/:functions` cannot be filtered by
  // app and two apps declaring a function with the same name is not hypothetical. A literal
  // rather than the imported constant on purpose: `export const config` is read by the
  // platform's own function registration and nothing guarantees it is evaluated with this
  // module's imports resolved. Change one of the two and you must change the other.
  description: 'Receive Mailchimp audience webhooks',
};

export async function get() {
  // Deliberately unauthenticated and content-free. This is Mailchimp's reachability probe,
  // and refusing it would make the webhook impossible to register.
  return { ok: true };
}

/**
 * The raw request body, needed byte-for-byte for signature verification — parsing and
 * re-encoding a form body changes key order and percent-encoding, and every signature then
 * fails.
 *
 * `rawBody` is a declared `string` on `SwellRequest` in `@swell/app-types`. This used to be
 * `await req.originalRequest?.clone?.().text?.()`, which predates the typed field, needed
 * three optional-chains to typecheck, and re-read a stream that had already been consumed.
 */
function readRawBody(req: SwellRequest): string | null {
  const raw = req.rawBody;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export async function post(req: SwellRequest) {
  const settings = await getSettings(req);

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<
    string,
    any
  >;

  // A real Mailchimp delivery never carries the secret (see the header), but a CLI test
  // does: `swell api post '/functions/…?secret=…'` folds the query into `req.body`. A
  // secret that is present and wrong is somebody guessing, so that is still refused.
  const provided =
    req.query.secret ?? (typeof body.secret === 'string' ? body.secret : undefined) ?? '';
  if (provided && !(settings.webhook_secret && secretsMatch(provided, settings.webhook_secret))) {
    console.warn('Mailchimp: rejected a webhook delivery with an invalid secret');
    throw new SwellError('Invalid webhook secret', { status: 401 });
  }

  // Advisory only: `req.rawBody` is not the original bytes on Swell today, so a genuine
  // signature fails too. Rejecting on it would drop every signed delivery. The change is
  // confirmed with Mailchimp below either way.
  const signature = req.headers?.get?.(SIGNATURE_HEADER) ?? '';
  if (settings.webhook_signing_secret && signature) {
    const raw = readRawBody(req);
    if (raw === null || !(await verifySignature(raw, signature, settings.webhook_signing_secret))) {
      console.warn(
        'Mailchimp: webhook signature did not verify (expected on Swell today); confirming with Mailchimp instead',
      );
    }
  }

  if (!settings.enabled) {
    // 200, not 4xx: Mailchimp disables a subscription that keeps failing, and "the app is
    // switched off" is not a delivery problem.
    return { ok: true, ignored: 'Mailchimp sync is turned off in app settings.' };
  }

  const notConfigured = configurationError(settings);
  if (notConfigured) {
    // Without an API key the change cannot be confirmed, so nothing is applied.
    return { ok: true, ignored: notConfigured };
  }

  // Mailchimp posts `application/x-www-form-urlencoded` with bracket keys. Depending on how
  // the platform hands that to a route function it may arrive as a string, a flat object
  // with literal bracket keys, or already nested — `parseWebhookPayload` accepts all three.
  // `allow_test_payload` exists so a JSON body from `swell api post` is usable too.
  const rawSource =
    settings.allow_test_payload && body && typeof body === 'object' && body.type
      ? body
      : (readRawBody(req) ?? body);

  const event = parseWebhookPayload(rawSource);

  if (!event.type) {
    return { ok: true, ignored: 'Delivery carried no event type.' };
  }
  if (!isHandledEvent(event.type)) {
    return { ok: true, ignored: `Unhandled event type "${event.type}".` };
  }

  // Mailchimp does not send a delivery id, so `fired_at` plus the event type is the dedupe
  // key: a redelivery carries exactly the same pair.
  const firedAt = event.fired_at || '';

  // Field names differ per event, and Mailchimp's current docs only publish examples for
  // subscribe and unsubscribe — so every read here is defensive about its key.
  const data = event.data ?? {};
  const newEmail = String(data.new_email ?? data['new-email'] ?? '').trim();
  const lookupEmail = String(data.old_email ?? data['old-email'] ?? data.email ?? '').trim();

  if (!lookupEmail && !newEmail) {
    return { ok: true, ignored: 'Delivery carried no email address to match on.' };
  }

  // One audience per app install. A delivery about another audience is not ours to apply,
  // and confirming it against ours would be checking the wrong list.
  const listId = String(data.list_id ?? '').trim();
  if (listId && listId !== settings.list_id) {
    return { ok: true, ignored: `Delivery is for audience ${listId}, not ${settings.list_id}.` };
  }

  const account = await findAccountByEmail(req, appId(req), lookupEmail || newEmail);
  if (!account) {
    // Not an error: Mailchimp audiences routinely hold addresses that were never Swell
    // customers — imports, forms, other stores on the same audience.
    return { ok: true, ignored: `No Swell account matches ${lookupEmail || newEmail}.` };
  }

  const state = readSyncState(req, account);
  if (firedAt && state.last_webhook_fired_at === firedAt && state.last_webhook_event === event.type) {
    return { ok: true, deduped: true, event: event.type, record_id: account.id };
  }

  // The authentication step: nothing below runs unless Mailchimp itself confirms the change.
  let confirmation: Confirmation;
  try {
    confirmation = await confirmWithMailchimp(
      new MailchimpClient(settings),
      settings.list_id,
      event.type,
      lookupEmail || newEmail,
      newEmail,
    );
  } catch (err) {
    if (err instanceof ConfirmationUnavailable) {
      // 503 so Mailchimp retries: the change may be real, it just could not be checked yet.
      console.error(`Mailchimp: ${err.message}`);
      throw new SwellError('Could not confirm the change with Mailchimp', { status: 503 });
    }
    throw err;
  }
  if (confirmation.confirmed === false) {
    console.warn(`Mailchimp: did not apply ${event.type}: ${confirmation.reason}`);
    return { ok: true, ignored: confirmation.reason };
  }

  const stamp: SyncState = {
    last_webhook_at: new Date().toISOString(),
    last_webhook_event: event.type,
    last_webhook_fired_at: firedAt || null,
  };
  if (confirmation.list_status) {
    stamp.list_status = confirmation.list_status;
  }

  const fields: AccountWriteback = {};

  switch (event.type) {
    case 'unsubscribe': {
      if (settings.webhook_writeback && account.email_optin !== false) {
        fields.email_optin = false;
      }
      break;
    }
    case 'cleaned': {
      // Mailchimp gave up on the address after hard bounces or an abuse report. Continuing
      // to treat it as opted-in is how a sender's reputation gets worse, not better.
      if (settings.webhook_writeback && account.email_optin !== false) {
        fields.email_optin = false;
      }
      break;
    }
    case 'upemail': {
      if (!newEmail) {
        return { ok: true, ignored: 'Email-change delivery carried no new address.' };
      }
      stamp.remote_email = newEmail;
      if (settings.webhook_writeback && account.email !== newEmail) {
        fields.email = newEmail;
      }
      break;
    }
    case 'profile': {
      // Informational. The subscriber edited their profile in Mailchimp; the app records
      // that it happened and refreshes the known status (read from Mailchimp above), but
      // does not overwrite Swell's name or address fields — those are the merchant's
      // record, not Mailchimp's.
      break;
    }
    default:
      break;
  }

  if (Object.keys(fields).length > 0) {
    // Goes through the one declared exception to the single-writer invariant, which stamps
    // `last_webhook_at` in the same PUT so `accounts-sync` recognises the change as ours.
    const written = await tryWriteAccountFromWebhook(req, account.id, fields, stamp);
    if (!written) {
      throw new SwellError('Could not apply the Mailchimp change to the Swell account', {
        status: 503,
      });
    }
  } else {
    await recordSyncState(req, 'accounts', account.id, stamp);
  }

  console.log(`Mailchimp: applied ${event.type} to accounts/${account.id}`);
  return {
    ok: true,
    event: event.type,
    record_id: account.id,
    applied: Object.keys(fields),
  };
}
