/**
 * Confirming an inbound webhook against the Mailchimp API before acting on it.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THE PAYLOAD IS NEVER TRUSTED ON ITS OWN
 *
 * Swell's public-route proxy hands a function either the request body or the query
 * string, never both (swell-admin `server/api/functions/index.js:55`). Mailchimp POSTs a
 * form body, so the `?secret=` in the callback URL never reaches this app, and the raw
 * body arrives re-serialised, so `X-Mailchimp-Signature` cannot be verified either.
 * Measured live 2026-09-24; filed as Asana 1218816382065204.
 *
 * So the delivery is treated as a *notification* ("something changed for this address")
 * and the change itself is read back from Mailchimp with the merchant's API key. A forged
 * delivery can then do no more than make the app look up a member and find nothing new:
 * every write below is justified by what Mailchimp says now, not by what the caller said.
 * ---------------------------------------------------------------------------------------
 */

import { errorText, isNotFound, type MailchimpClient } from './mailchimp-client';
import type { ListStatus } from './sync-state';
import type { HandledEvent } from './webhook-payload';

export type Confirmation =
  | { confirmed: true; list_status?: ListStatus }
  | { confirmed: false; reason: string };

const LIST_STATUSES: readonly string[] = ['subscribed', 'unsubscribed', 'cleaned', 'pending', 'transactional', 'archived'];

/** Mailchimp's member status, if it is one this app records. */
function listStatus(status: unknown): ListStatus | undefined {
  return typeof status === 'string' && LIST_STATUSES.includes(status)
    ? (status as ListStatus)
    : undefined;
}

/** Mailchimp answered, but not in a way that settles the question. Worth a retry. */
export class ConfirmationUnavailable extends Error {}

/** A member record, or `null` when Mailchimp has no member at that address. */
async function memberOrNull(
  client: MailchimpClient,
  listId: string,
  email: string,
): Promise<Record<string, any> | null> {
  try {
    return await client.getMember(listId, email);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new ConfirmationUnavailable(
      `Could not read ${email} from Mailchimp to confirm the webhook: ${errorText(err)}`,
    );
  }
}

/**
 * Checks the claimed change against the member's current state in Mailchimp.
 *
 * `email` is the address the delivery is about (for `upemail`, the old one); `newEmail`
 * is only used by `upemail`.
 */
export async function confirmWithMailchimp(
  client: MailchimpClient,
  listId: string,
  type: HandledEvent,
  email: string,
  newEmail: string,
): Promise<Confirmation> {
  switch (type) {
    case 'unsubscribe':
    case 'cleaned': {
      const member = await memberOrNull(client, listId, email);
      if (!member) {
        return { confirmed: false, reason: `Mailchimp has no member ${email} on this audience.` };
      }
      // `cleaned` members report status "cleaned"; unsubscribes report "unsubscribed".
      const expected = type === 'cleaned' ? 'cleaned' : 'unsubscribed';
      if (member.status !== expected) {
        return {
          confirmed: false,
          reason: `Mailchimp reports ${email} as "${member.status}", not "${expected}".`,
        };
      }
      return { confirmed: true, list_status: listStatus(member.status) };
    }

    case 'upemail': {
      if (!newEmail) {
        return { confirmed: false, reason: 'Email-change delivery carried no new address.' };
      }
      // Both halves are required. The new address alone is not enough: if the old one still
      // exists as a separate member, a forged upemail could point a Swell account at some
      // other subscriber's address.
      const [current, previous] = await Promise.all([
        memberOrNull(client, listId, newEmail),
        memberOrNull(client, listId, email),
      ]);
      if (!current) {
        return { confirmed: false, reason: `Mailchimp has no member ${newEmail} on this audience.` };
      }
      if (previous) {
        return {
          confirmed: false,
          reason: `Mailchimp still has ${email} as a member, so the address was not changed.`,
        };
      }
      return { confirmed: true, list_status: listStatus(current.status) };
    }

    case 'profile': {
      const member = await memberOrNull(client, listId, email);
      if (!member) {
        return { confirmed: false, reason: `Mailchimp has no member ${email} on this audience.` };
      }
      return { confirmed: true, list_status: listStatus(member.status) };
    }

    default:
      return { confirmed: false, reason: `Unhandled event type "${type}".` };
  }
}
