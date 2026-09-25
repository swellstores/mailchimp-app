Mailchimp for Swell connects your store to your Mailchimp account and keeps customers, products, carts and orders in sync. That's what switches on Mailchimp's ecommerce features: abandoned-cart emails, order notifications, product recommendations, purchase-based segments and order history on every contact. It works in both directions. When someone unsubscribes, bounces or changes their email address in Mailchimp, their Swell account is updated too, so you never keep marketing to someone who opted out.

It replaces Swell's built-in Mailchimp integration, which only adds the email addresses of opted-in customers to an audience.

## Customers and your audience

Every customer becomes a Mailchimp customer and an audience member, with their name and phone number. Customers who opted in to marketing are subscribed. Customers who didn't are added as transactional contacts, so order emails and purchase history still work for them without them receiving marketing.

- **Opting in or out in Swell** subscribes or unsubscribes the customer in Mailchimp. Someone who previously unsubscribed through Mailchimp gets Mailchimp's own confirmation email, as Mailchimp requires.
- **Changing an email address in Swell** updates the existing Mailchimp member rather than creating a second one.
- **Deleting a customer account** archives the member in Mailchimp. Archiving can be undone, and the customer's order history is kept for reporting.

## Abandoned-cart emails that stop when they should

Carts are sent to Mailchimp with their items and a link back to checkout, which is what Mailchimp's abandoned-cart automation needs. The moment a cart becomes an order it's removed from Mailchimp, so nobody gets a reminder for something they already bought. If you prefer, sync only the carts Swell has marked abandoned.

## Orders, segments and purchase history

Orders are sent with their items, totals, discounts, and payment and fulfillment status. That powers Mailchimp's order notifications and post-purchase automations, lets you build segments from what customers bought and how much they spent, and shows each contact's order history in Mailchimp.

## Products in your emails

Products and their variants are sent with prices (including sale prices), stock, images and links to your storefront, so Mailchimp can show them in emails and recommend them.

## Changes in Mailchimp come back to Swell

When a customer unsubscribes in Mailchimp, or Mailchimp stops emailing an address because it bounced, their marketing opt-in in Swell is switched off. When they change their email address in Mailchimp, the Swell account is updated. Every change is confirmed with Mailchimp before it's applied, and profile edits made in Mailchimp never overwrite your customer records.

## A first sync that doesn't email anyone

When you set the app up, your existing customers, products, carts and orders are sent in bulk. While that runs, Mailchimp's automations are paused, so customers aren't emailed about orders they placed months ago. They start again once the first sync is done.

## See the sync status on every record

Every customer, product, cart and order gets a Mailchimp tab with its sync status, Mailchimp ID, last sync time and any error. Each list gains a Mailchimp column, a Mailchimp errors view, and a view of records Mailchimp won't accept, such as a guest cart with no email address. Fix the cause and switch on "Re-sync on save" to send a record again. A daily check also retries failed records and makes sure Mailchimp stays connected.

## Setup

You need a Mailchimp account, the audience your customers should join, an API key (Profile → Extras → API keys in Mailchimp) and the audience ID.

1. Install the app and turn off Swell's built-in Mailchimp integration, so customers aren't sent twice. The app warns you if it's still on.
2. Enter your API key, audience ID, store name and storefront domain in the app's settings, choose what to sync, and switch the app on.
3. Run the app's one-time setup to create your Mailchimp store and connect unsubscribes, then send your existing data. The README walks through both.

## Good to know

- Every synced customer counts as a Mailchimp contact, subscribed or not. That's how Mailchimp's ecommerce data works, and it matters on plans priced by contact count.
- Only customers who opted in are subscribed. Customers who never answered are added as transactional contacts.
- Unsubscribes come back to your store's live environment.
- Orders aren't tagged with the Mailchimp campaign that led to them, so Mailchimp doesn't credit revenue to individual campaigns.
- Mailchimp promo codes, site tracking and campaign webhooks are not included.
- This app is built and supported by Swell and is open source at github.com/swellstores/mailchimp-app.
