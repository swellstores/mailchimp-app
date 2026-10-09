Keep your customers, products, carts and orders in sync with Mailchimp, and use Mailchimp's abandoned-cart emails, order notifications, product recommendations and purchase-based segments with your store data. When someone unsubscribes, bounces or changes their email address in Mailchimp, their Swell account is updated too.

Connect your Mailchimp account with an API key and choose the audience your customers join. The app replaces Swell's built-in Mailchimp integration, which adds only the email addresses of opted-in customers to an audience.

- **Customers in your audience.** Customers join your audience with their name and phone number. Customers who opt in are subscribed, customers who haven't answered are added as transactional contacts so they still get order emails, and customers who opt out in Swell are unsubscribed. Someone who unsubscribed through Mailchimp and opts in again gets Mailchimp's confirmation email.
- **Abandoned-cart emails that stop at checkout.** Carts go to Mailchimp with their items and checkout link, and are removed the moment they become orders, so nobody is reminded about something they bought.
- **Orders for notifications and segments.** Orders are sent with their items, totals, discount, coupon code, and payment and fulfillment status, for order notifications, purchase-based segments and each contact's order history.
- **Products ready for your emails.** Products and their variants are sent with prices, sale prices, stock, images and links to your storefront.
- **Unsubscribes come back to Swell.** Unsubscribes, bounced addresses and email changes made in Mailchimp update the Swell account in your live store, after the app confirms each change with Mailchimp.
- **Your history, without the emails.** The first sync sends your existing products, customers and orders in bulk with Mailchimp's automations paused, so customers aren't emailed about old orders.

Setup takes a few minutes. In Mailchimp, create an API key and copy your audience ID. Turn off the built-in Mailchimp integration (installing the app offers to do it for you), enter the key, audience ID and a webhook secret in the app settings, and turn the app on. To send the records you already have, run the first sync with the Swell CLI. Each customer, product, cart and order shows its Mailchimp sync status and any error.
