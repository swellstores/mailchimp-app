import { MailchimpClient, MailchimpError, errorText, isNotFound } from './lib/mailchimp-client';
import {
  NATIVE_INTEGRATION_WARNING,
  configurationError,
  getSettings,
  nativeIntegrationEnabled,
} from './lib/settings';

export const config: SwellConfig = {
  description: 'Check the Mailchimp API key and audience ID',
  action: true,
};

// a thrown 400 shows in the admin as a red error popup, a returned message as a regular one
function fail(message: string): never {
  throw new SwellError(message, { status: 400 });
}

// What Mailchimp rejected, in words a merchant can act on.
function keyError(err: unknown, apiBase: string): string {
  if (err instanceof MailchimpError && err.status === 401) {
    return "Mailchimp didn't accept the API key. Check that you pasted the whole key, including the data center at the end (like -us14).";
  }
  if (err instanceof MailchimpError && err.status === 403) {
    return `Mailchimp refused the API key: ${errorText(err)}`;
  }
  if (err instanceof MailchimpError && err.status === 0) {
    return `Couldn't reach Mailchimp at ${apiBase}. Check that the API key ends in the right data center (like -us14), or try again in a minute.`;
  }
  return errorText(err);
}

export default async function (req: SwellRequest) {
  const settings = await getSettings(req);

  const missing = [!settings.api_key && 'API key', !settings.list_id && 'audience ID'].filter(Boolean);
  if (missing.length) {
    fail(`Add the ${missing.join(' and ')} and save the settings first.`);
  }
  // the key has no data center suffix and there's no API base override
  const configError = configurationError(settings);
  if (configError) {
    fail(configError);
  }

  const client = new MailchimpClient(settings);
  let account: Record<string, unknown>;
  try {
    account = await client.ping();
  } catch (err) {
    fail(keyError(err, client.apiBase));
  }
  const accountName = String(account.account_name || 'your account');

  let list: Record<string, unknown>;
  try {
    list = await client.request<Record<string, unknown>>(
      'GET',
      `/lists/${encodeURIComponent(settings.list_id)}?fields=id,name`,
    );
  } catch (err) {
    if (isNotFound(err)) {
      fail(
        `Connected to Mailchimp account ${accountName}, but it has no audience with the ID ${settings.list_id}. Copy the ID from Audience → Settings → Audience name and defaults.`,
      );
    }
    fail(keyError(err, client.apiBase));
  }

  const notes = [`Connected to Mailchimp account ${accountName}, audience ${String(list.name || settings.list_id)}.`];
  if (await nativeIntegrationEnabled(req)) {
    notes.push(NATIVE_INTEGRATION_WARNING);
  }
  return { message: notes.join(' ') };
}
