# Mailchimp for Swell

## What the app does

Connects a Swell store to [Mailchimp](https://mailchimp.com). Customers, products, carts and
orders are kept in sync with the merchant's Mailchimp account, so Mailchimp's ecommerce
features work: abandoned-cart emails, order notifications, product recommendations,
purchase-based segments and order history on each contact. Unsubscribes, bounced addresses and email
changes made in Mailchimp flow back into Swell, so the store never keeps marketing to
someone who opted out there. It replaces Swell's built-in Mailchimp integration, which only
adds opted-in email addresses to an audience.

| | Built-in integration | This app |
| --- | --- | --- |
| What reaches Mailchimp | Email addresses of opted-in customers | Customers, products and variants, carts and orders, plus audience members |
| Direction | Swell → Mailchimp | Both ways: unsubscribes, bounces and email changes come back to Swell |
| Abandoned-cart and order emails | Not possible | Carts and orders synced with the fields Mailchimp's automations use |
| Customer opts in or out in Swell | Audience updated | Audience updated; someone who unsubscribed through Mailchimp gets Mailchimp's confirmation email instead |
| Customer account deleted | Member archived | Member archived; order history kept |
| Past data at setup | Not sent | Sent in bulk, with Mailchimp's automations held off so customers aren't emailed about old orders |
| Sync problems | Not shown | Recorded on each record, with errors tabs in every list |
| Re-sending | Not possible | Per-record switch, bulk re-send, and a daily retry |

## Features

### Customers and audience members

**What it does.** Each customer account becomes a Mailchimp ecommerce customer and an
audience member with first name, last name and phone. A customer who opted in to marketing
is subscribed; one who didn't is added as *transactional*, which is what lets order emails
and purchase history work for them without marketing to them.

- **Opting in** in Swell subscribes them in Mailchimp, even if they had been removed or were
  never sent before. Someone who unsubscribed through Mailchimp can't be re-subscribed by an
  app, so they're set to *pending* and Mailchimp emails them to confirm.
- **Opting out** in Swell unsubscribes them (**Push opt-in changes to Mailchimp**). Only an
  explicit opt-out does this; an account that simply has no answer is left alone.
- **Changing email address** in Swell updates the existing member rather than creating a
  second one.
- **Deleting an account** archives the member in Mailchimp (**Archive audience member when
  an account is deleted**). Archiving is reversible in Mailchimp, and the customer's order
  history is kept.

**How it's built.** `functions/accounts-sync.ts` on `account.created`, `account.updated`
and `account.deleted`. It only reacts to fields Mailchimp uses, so the account updates Swell
makes on every order don't re-send the customer.

### Products

**What it does.** Products and their variants are sent with prices (sale price when on
sale), stock, images and storefront links, so Mailchimp can show them in emails and
recommend them.

**How it's built.** `functions/products-sync.ts` on product and variant events.

### Carts and abandoned-cart emails

**What it does.** Carts are sent with their items and checkout link, which is what
Mailchimp's abandoned-cart automation emails. The moment a cart becomes an order it is
removed from Mailchimp, so nobody gets an abandoned-cart email for something they bought.
**Which carts to sync** can limit this to carts Swell has marked abandoned.

**How it's built.** `functions/carts-sync.ts`.

### Orders and order emails

**What it does.** Orders are sent with their items, totals, discounts, and payment and
fulfillment status, which is what Mailchimp's order notification and post-purchase
automations, and its purchase-based segments, use.

**How it's built.** `functions/orders-sync.ts` on submission and on the status changes those
automations key on.

### Changes coming back from Mailchimp

**What it does.** When someone unsubscribes in Mailchimp, or Mailchimp stops emailing them
because the address bounced, their Swell account's marketing opt-in is switched off. When
they change their address in Mailchimp, the Swell account's email is updated. Profile edits
in Mailchimp are noted but never overwrite the merchant's customer record. Turn this off
with **Write unsubscribes back to Swell**.

Every change is checked with Mailchimp before it's applied, so a fake notification can't
change a customer's account (see *Limits*).

**How it's built.** `functions/mailchimp-webhook.ts`, a public route Mailchimp calls, with
`functions/lib/webhook-confirm.ts` doing the check.

### Sending existing data

**What it does.** Sends everything that already exists, in bulk, when the app is first set
up. While it runs, Mailchimp is told a bulk sync is in progress, which stops its automations
emailing customers about old orders and carts. That's switched off again when the backfill
is finished, or by the daily check once there's nothing left to send.

**How it's built.** `functions/backfill.ts`, a private route; see *Setup*.

### Sync status on every record

**What it does.** Every customer, product, cart and order gets a **Mailchimp** tab with its
sync status, Mailchimp id, when it last synced, and the last error. Customers also show their
audience status. Each list gets a **Mailchimp** column and two tabs: **Mailchimp errors**
(worth retrying) and **Not synced to Mailchimp** (records Mailchimp won't accept, such as a
guest cart with no customer).

| Status | Meaning |
| --- | --- |
| Pending | Waiting to be sent, or sent in a bulk batch Mailchimp hasn't finished |
| Synced | Accepted by Mailchimp |
| Error | The last attempt failed; the error is on the record |
| Skipped | Mailchimp won't accept it and retrying can't help (a guest cart, an account with no email) |
| Canceled | Removed from Mailchimp, such as a cart after it became an order |

**How it's built.** `content/*.json` and `models/*.json`; everything is stored under the
app's own namespace on each record.

### Re-sending and daily upkeep

**What it does.** Switch on **Re-sync on save** in a record's Mailchimp tab and save to send
it again. Once a day the app checks the Mailchimp store and webhook are still set up,
retries a few failed records per collection (least recently tried first, so one that keeps
failing doesn't block the rest), ends a finished backfill, and logs a warning if the
built-in Mailchimp integration is still on.

**How it's built.** `functions/reconcile.ts`, a daily cron.

## Setup

### What you need from Mailchimp

- A Mailchimp account and the **audience** the store's customers should go into.
- An **API key**: Mailchimp → Profile → Extras → API keys. Copy the whole key, including the
  part after the dash (for example `-us14`); that's how the app knows which Mailchimp server
  your account is on.
- The **Audience ID**: Mailchimp → Audience → Settings → Audience name and defaults. It can't
  be changed later: Mailchimp ties the store to one audience for good.

### Install and configure

1. Install **Mailchimp** from the Swell App Store.
2. **Turn off the built-in Mailchimp integration** (Settings → Integrations) if it's on, or
   customers reach Mailchimp twice. The app's setup report and daily check warn if it's
   still on.
3. Open **Apps → Mailchimp → Settings**, fill in the settings below, and switch on **Enable
   Mailchimp sync**. At minimum: API key, Audience ID, store name, and storefront domain.
4. Run setup once with the store's secret API key. It checks the key, creates the Mailchimp
   store and registers the webhook that brings unsubscribes back:

   ```bash
   curl -X POST "https://<store-id>.swell.store/functions/mailchimp/setup" \
     -u "<store-id>:<secret-key>"
   ```

   A `GET` to the same address reports the same without changing anything. If the response
   includes a webhook signing secret, paste it into **Webhook signing secret**; Mailchimp
   shows it only once.
5. Send existing data, products first, since Mailchimp rejects carts and orders that name
   products it hasn't seen. Then accounts, orders and carts. Repeat each call until it
   answers `"has_more": false`:

   ```bash
   curl -X POST "https://<store-id>.swell.store/functions/mailchimp/backfill" \
     -u "<store-id>:<secret-key>" -H "Content-Type: application/json" \
     -d '{"collection":"products"}'
   ```

   Add `"mode":"batch"` for large catalogues: it sends 25 at a time through Mailchimp's
   batch API and returns a `batch_id` to check with `{"collection":"products","batch_id":"…"}`.
   When every collection is done, let Mailchimp's automations run again:

   ```bash
   curl -X POST "https://<store-id>.swell.store/functions/mailchimp/backfill" \
     -u "<store-id>:<secret-key>" -H "Content-Type: application/json" \
     -d '{"action":"finish"}'
   ```

   If you forget, the daily check does it once nothing is left to send.

### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Enable Mailchimp sync | Off | Master switch. |
| API key | — | Mailchimp API key, including the `-us14`-style ending. |
| Audience ID | — | The audience customers go into. Can't be changed once the store is created. |
| API base URL override | — | Leave empty. Only for a test server, or a key with no ending. |
| Store ID | Swell store id | Id of the store in Mailchimp. Changing it after syncing starts over with a new, empty store. |
| Store name | Swell store id | Shown in Mailchimp's reports. |
| Store currency | `USD` | The store's reporting currency in Mailchimp. Orders and carts carry their own. |
| Storefront domain | — | Used to build product and checkout links. |
| Push records to Mailchimp | Automatically | Or manual only, sending records only through backfill and re-sync. |
| Sync customer accounts | On | Customers and audience members. |
| Sync products | On | Products and variants. Carts and orders need this. |
| Sync carts | On | For abandoned-cart emails. |
| Which carts to sync | All active carts | Or only carts Swell has marked abandoned, which makes the email fire later. |
| Sync orders | On | Purchase history and order emails. |
| Sync new records | On | Send records when they're created or submitted. |
| Sync edits | On | Re-send records when they change. |
| Sync deletions | Off | Permanently delete products, carts and orders from Mailchimp when they're deleted in Swell. Mailchimp can't undo this. Converted carts are always removed regardless. |
| Push opt-in changes to Mailchimp | On | Subscribe or unsubscribe the member when the customer's marketing opt-in changes in Swell. |
| Archive audience member when an account is deleted | On | Archive (not delete) the member when the Swell account is deleted. |
| Webhook secret | — | Any random string of 16+ characters. Added to the webhook address and required for test payloads. See *Limits*. |
| Webhook signing secret | — | Optional. Shown once by Mailchimp when the webhook is created. |
| Write unsubscribes back to Swell | On | Let unsubscribes, bounces and email changes from Mailchimp update the Swell account. |
| Callback URL override | — | Leave empty. Only for pointing Mailchimp somewhere else, such as a tunnel during development. |
| App ObjectId override | — | Leave empty unless setup says it couldn't work out the webhook address. |
| Accept test webhook payloads | Off | Development only. Keep it off. |

## Day-to-day use

- **Nothing to do for normal traffic.** New customers, orders, carts and product changes
  reach Mailchimp as they happen; build automations and segments in Mailchimp as usual.
- **A customer unsubscribes.** Whether they do it in Mailchimp or tick the box off in Swell,
  both sides end up unsubscribed.
- **Checking for problems.** Open the **Mailchimp errors** tab in the customer, product,
  order or cart list. Each record's Mailchimp tab shows the last error. Fix the cause, then
  switch on **Re-sync on save** and save. The daily check also retries a few on its own.
- **Something never reached Mailchimp?** The **Not synced to Mailchimp** tab lists records
  Mailchimp won't accept, with the reason.

## Limits and known issues

- **Every synced customer counts as a Mailchimp contact**, opted in or not. That's how
  Mailchimp's ecommerce data works: a customer who declined marketing is still a
  *transactional* contact, which is what makes order emails possible. On Mailchimp plans
  priced by total contacts this raises the count. The alternative is to switch off **Sync
  customer accounts**, though carts and orders still create customers.
- **An account with no opt-in answer is not subscribed.** The built-in integration
  subscribed anyone who hadn't explicitly declined. This app subscribes only customers who
  opted in; the rest are transactional.
- **Unsubscribes come back to Swell on the live environment only.** Mailchimp can only reach
  a store's live environment.
- **How incoming changes are verified.** Swell currently drops the query string from calls
  like Mailchimp's, so the webhook secret never reaches the app, and it doesn't pass the
  original request bytes, so Mailchimp's signature can't be checked either. The app doesn't
  rely on them: before applying an unsubscribe, bounce or address change it reads the member
  back from Mailchimp with the store's API key and acts only on what Mailchimp says. That
  costs one or two Mailchimp API calls per notification. This is filed with the Swell
  platform team.
- **Deleting an account doesn't delete the Mailchimp customer.** Only the audience member is
  archived; the ecommerce customer and order history stay for reporting.
- **One currency per Mailchimp store.** Orders and carts carry their own currency, but
  product prices are sent without conversion, so a multi-currency store sees mixed
  currencies in Mailchimp's product reports.
- **No campaign attribution.** Orders are sent without the `campaign_id` of the Mailchimp
  email that led to them (the `mc_cid` link parameter isn't captured), so Mailchimp doesn't
  credit revenue to individual campaigns or automations.
- **Not included:** Mailchimp promo rules and promo codes (coupons are sent on each order),
  campaign webhooks, Mailchimp's site tracking script, and forced removal of deleted product
  variants.
- **Limits of the platform.** Each function has 10 seconds, so backfill works 10 records at a
  time (25 in batch mode) and the daily retry takes three per collection. Queries on sync
  status aren't indexed yet, so very large stores catch up more slowly.

## Development

The repository is the source of truth. `.swellrc` is committed on purpose: it pins the app to
its official record on the Swell Apps account, so a clone pushes to the same app. Never
commit a `.swellrc` created against another store.

```bash
npm install
npm run typecheck
npm run validate    # checks every JSON config against the platform's own schemas
npm test
```

`npm run validate` exists because `swell schema <type> <file>` fails on known-good files and
still exits 0. The unit tests cover the mappers, the API client (datacenters, errors,
retries), the handlers' gates, opt-in and deletion handling, backfill and batch settlement,
the daily reconcile, webhook parsing and confirmation, and the rule that the app never
triggers its own updates. They make no network calls. The integration tests in
`test/integration/` run the real mappers over real records through your Swell CLI session.

Push to Swell Apps and check that everything registered, since a push can succeed with
nothing registered if the build failed:

```bash
swell switch swell-apps
swell app push
swell inspect functions --app=.
```

From the CLI, the private routes are reached through the admin API:

```bash
swell api get  /functions/mailchimp/setup
swell api post /functions/mailchimp/backfill --body '{"collection":"orders","record_id":"<id>"}'
swell api post /functions/mailchimp/backfill --body '{"collection":"orders","sync_status":"error"}'
```

To test incoming changes without a Mailchimp account, switch on **Accept test webhook
payloads** and post a payload. It's still checked against Mailchimp, so it only changes the
account if Mailchimp agrees:

```bash
swell api post '/functions/mailchimp/mailchimp-webhook?secret=<webhook secret>' --body '{
  "type": "unsubscribe",
  "fired_at": "2026-08-07 09:00:00",
  "data": { "email": "<a customer email>" }
}'
```

Things worth knowing before changing the code:

- **The record id is the Mailchimp id.** `$app.mailchimp.remote_key` is always the Swell
  record id and every call is made under it, which turns a repeated event into an update
  instead of a duplicate. Never derive it from anything a merchant can edit.
- **Carts and the store have no add-or-update call** in Mailchimp's API: they're created with
  POST and updated with PATCH. `remote_key` picks between them, with one fallback if it's
  stale.
- **The app must not trigger itself.** Only `lib/account-writeback.ts` writes outside
  `$app.mailchimp`, and it stamps `last_webhook_at` in the same write so `accounts-sync`
  recognises and ignores the resulting update. Mailchimp webhooks are also registered with
  API-sourced events off.
- **Public route addresses use the app's ObjectId**, the id in `.swellrc`:
  `https://<store-id>.swell.store/functions/<app ObjectId>/mailchimp-webhook`. The form with
  the app's name only works for callers with a Swell API key, which Mailchimp isn't. Setup
  finds the ObjectId in the platform's function registry and reports an error rather than
  registering an address it can't build.
- **Don't put app settings in function `conditions`.** A condition on `$settings` stops the
  event being delivered at all, and `$data` conditions match every update. All gating is in
  the handlers, which read `$event.data` for the fields that actually changed.
- **Mailchimp limits concurrency, not volume.** Ten simultaneous connections; calls here are
  serial. A short `Retry-After` is waited out, anything longer is retried by the platform.
  Errors at high volume can arrive with no body.
- **Batch results can't be read per record.** Mailchimp publishes them as a gzipped tar,
  which the Workers runtime can't open, so batch mode reads counts only and stamps each
  record with its batch id. When a batch reports errors, re-run that collection in direct
  mode to see which records failed.
- **Members are addressed by email.** The API also accepts the address instead of its MD5,
  which is what the app sends; the Workers runtime has no MD5.
- **No npm runtime dependencies**, deliberately: everything is `fetch`, `crypto.subtle` and
  `btoa`.

## Contributing

Issues and pull requests are welcome. For questions, visit the
[Swell Discord](https://discord.gg/VakSbyjDGZ) or
[GitHub discussions](https://github.com/orgs/swellstores/discussions/).

## License

MIT. See [LICENSE.md](LICENSE.md).
