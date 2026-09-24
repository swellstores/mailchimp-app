import { MailchimpClient, PROBE_TIMEOUT_MS, errorText } from './lib/mailchimp-client';
import {
  NATIVE_INTEGRATION_WARNING,
  WEBHOOK_FUNCTION_NAME,
  appId,
  configurationError,
  getSettings,
  nativeIntegrationEnabled,
  resolveAppObjectId,
  storeId,
  webhookCallbackUrl,
} from './lib/settings';
import { describeEnsureResult, ensureStore } from './lib/store';
import { NO_CALLBACK_URL_MESSAGE, describeWebhooks, ensureWebhook } from './lib/webhooks';

/**
 * One-time (and re-runnable) provisioning: validate the credential, create or converge the
 * Mailchimp ecommerce store, and register the inbound webhook.
 *
 * Private route (`public: false`), so it is reachable through the admin API with your CLI
 * session and never from the internet:
 *
 *   swell api get  /functions/mailchimp/setup                      # report, changes nothing
 *   swell api post /functions/mailchimp/setup                      # provision
 *   swell api post /functions/mailchimp/setup --body '{"skip_webhook":true}'
 *
 * (Those are *admin API* paths, which do resolve by the string app id. The **public** URL
 * this route reports does not — see below.)
 *
 * ---------------------------------------------------------------------------------------
 * WHY PROVISIONING LIVES HERE RATHER THAN IN THE PUSH PATH
 *
 * Everything Mailchimp's ecommerce API accepts is scoped to a store record that must exist
 * first, and creating it can fail in ways only a person can resolve: a wrong audience id,
 * an audience already bound to a different store, a key from the wrong account. Those
 * deserve one call whose entire job is to succeed or say precisely why, with the answer in
 * front of whoever is installing the app — not a line in a log at 06:00.
 *
 * `reconcile.ts` re-runs the same convergence daily so drift repairs itself, and
 * `lib/store.ts` provisions lazily if a push 404s before anyone has run this. See that
 * file's header for the full argument.
 * ---------------------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------------------
 * IT REPORTS TWO IDS, SIDE BY SIDE, AND THAT IS DELIBERATE
 *
 * `runtime_app_id` is what `req.appId` hands the function: the **string** id from
 * swell.json. `app_object_id` is the app's 24-character hex **ObjectId**. A public route
 * function resolves by the second one, and the string-id form 404s — which Mailchimp does
 * not report as a failure, because it accepts the URL and simply drops every delivery.
 *
 * The two are printed together because seeing them differ is what makes the distinction
 * stick. See `appObjectId()` in lib/settings.ts.
 * ---------------------------------------------------------------------------------------
 */
export const config: SwellConfig = {
  description: 'Create the Mailchimp ecommerce store and register webhooks',
  route: {
    methods: ['get', 'post'],
    public: false,
  },
};

/**
 * Reports the current state and changes nothing. Safe to call at any time, including before
 * the credential is filled in — that is the case it is most useful for.
 */
export async function get(req: SwellRequest) {
  const settings = await getSettings(req);
  const configError = configurationError(settings);
  const objectId = await resolveAppObjectId(req, settings);
  const callback = await webhookCallbackUrl(req, settings);

  const report: Record<string, any> = {
    ok: !configError,
    enabled: settings.enabled,
    configuration_error: configError,
    store_id: storeId(req, settings),
    list_id: settings.list_id,

    // The two ids, side by side — see this file's header.
    runtime_app_id: appId(req),
    app_object_id: objectId,
    public_route_base: objectId
      ? `https://${req.store.id}.swell.store/functions/${objectId}`
      : null,
    public_route_note: objectId
      ? 'Public routes resolve by the app ObjectId above, NOT by runtime_app_id. They serve ' +
        'the LIVE environment only, so a test-only push answers 404 even with the right id.'
      : NO_CALLBACK_URL_MESSAGE,

    callback_url: callback ? callback.redacted : null,
    callback_url_derived: callback ? callback.derived : null,
    webhook_secret_set: Boolean(settings.webhook_secret),
  };

  const native = await nativeIntegrationEnabled(req);
  report.native_integration_enabled = native;
  if (native) {
    report.warning = NATIVE_INTEGRATION_WARNING;
  }

  if (configError) {
    return report;
  }

  const client = new MailchimpClient(settings);
  report.api_base = client.apiBase;

  // Both probes are advisory: a GET that reports state must not fail because Mailchimp is
  // briefly down. Each records why it could not answer instead.
  try {
    const account = await client.ping(PROBE_TIMEOUT_MS);
    report.credentials = `ok (${account?.account_name ?? 'unknown account'})`;
  } catch (err) {
    report.ok = false;
    report.credentials = errorText(err);
  }

  if (settings.webhook_secret) {
    try {
      report.webhooks = await describeWebhooks(req, settings, client);
    } catch (err) {
      report.webhooks = { error: errorText(err) };
    }
  }

  return report;
}

export async function post(req: SwellRequest) {
  const settings = await getSettings(req);

  const configError = configurationError(settings);
  if (configError) {
    throw new SwellError(configError, { status: 400 });
  }

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<
    string,
    any
  >;
  const skipWebhook = body.skip_webhook === true;

  const steps: Array<{ step: string; ok: boolean; message: string }> = [];
  const client = new MailchimpClient(settings);

  // ---- 1. Credentials -------------------------------------------------------------------
  // The cheapest authenticated call Mailchimp offers. Doing it first means a bad key is
  // reported as a bad key rather than as a confusing store-creation failure.
  try {
    const account = await client.ping(PROBE_TIMEOUT_MS);
    steps.push({
      step: 'credentials',
      ok: true,
      message: `Authenticated against Mailchimp account "${account?.account_name ?? 'unknown'}" at ${client.apiBase}.`,
    });
  } catch (err) {
    throw new SwellError(`Mailchimp rejected the API key: ${errorText(err)}`, { status: 400 });
  }

  // ---- 2. Ecommerce store ---------------------------------------------------------------
  try {
    const result = await ensureStore(req, settings, client, { patchExisting: true });
    steps.push({
      step: 'store',
      ok: !result.listMismatch,
      message: describeEnsureResult(result),
    });
    if (result.listMismatch) {
      // A store bound to the wrong audience is not something a retry fixes, and every
      // subsequent push would fail against the wrong list. Stop and say so.
      return { ok: false, store_id: storeId(req, settings), steps };
    }
  } catch (err) {
    throw new SwellError(`Could not create the Mailchimp ecommerce store: ${errorText(err)}`, {
      status: 502,
    });
  }

  // ---- 3. This app's public identity ------------------------------------------------------
  // Reported whether or not a webhook is registered, because it is what every public route
  // in the app is reachable under and there is nowhere else to read it from.
  const objectId = await resolveAppObjectId(req, settings);
  steps.push({
    step: 'public_route',
    ok: objectId !== null,
    message: objectId
      ? `Public routes resolve at https://${req.store.id}.swell.store/functions/${objectId}/<name> ` +
        `— built from this app's ObjectId, not from its string id "${appId(req)}", which 404s. ` +
        `(e.g. .../${objectId}/${WEBHOOK_FUNCTION_NAME})`
      : NO_CALLBACK_URL_MESSAGE,
  });

  // ---- 4. Webhook subscription ----------------------------------------------------------
  if (skipWebhook) {
    steps.push({ step: 'webhook', ok: true, message: 'Skipped at the caller’s request.' });
  } else if (!settings.webhook_secret) {
    steps.push({
      step: 'webhook',
      ok: false,
      message:
        'No webhook secret is set, so no webhook was registered. Set one in app settings ' +
        '(16+ random characters) and run setup again — without it, unsubscribes in Mailchimp ' +
        'never reach Swell.',
    });
  } else {
    try {
      const result = await ensureWebhook(req, settings, client);
      steps.push({
        step: 'webhook',
        ok: true,
        message:
          `${result.message} Callback: ${result.url}` +
          (result.signingSecret
            ? ` — Mailchimp issued a signing secret for this webhook. Paste it into the ` +
              `"Webhook signing secret" setting now; it cannot be retrieved again: ${result.signingSecret}`
            : ''),
      });
    } catch (err) {
      // A failed webhook registration does not invalidate the store, so this reports rather
      // than throws — outbound sync works without it.
      steps.push({
        step: 'webhook',
        ok: false,
        message:
          `${errorText(err)} — public route functions serve the LIVE environment only, so a ` +
          'test-only push answers 404 and Mailchimp refuses to register the URL. Run ' +
          '`swell app version minor && swell app install`, or point the Callback URL override ' +
          'at a tunnel.',
      });
    }
  }

  const callback = await webhookCallbackUrl(req, settings);

  return {
    ok: steps.every((step) => step.ok),
    store_id: storeId(req, settings),
    list_id: settings.list_id,
    api_base: client.apiBase,
    runtime_app_id: appId(req),
    app_object_id: objectId,
    public_route_base: objectId
      ? `https://${req.store.id}.swell.store/functions/${objectId}`
      : null,
    callback_url: callback ? callback.redacted : null,
    steps,
  };
}
