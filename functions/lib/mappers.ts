/**
 * Swell record → Mailchimp payload. This is the vendor-shaped hole the starter leaves; the
 * rest of `lib/` is portable and this file is not.
 *
 * Contract with `push.ts`: a mapper **throws a plain `Error`** for a record that can never
 * be mapped (no email, no items, no customer). The caller records that as a *non-retryable*
 * `skipped`, because redelivering the same event reproduces the same failure and the
 * platform disables a function that fails for four days straight.
 *
 * Required-field sets below are taken from Mailchimp's OpenAPI spec 3.0.91, not from the
 * prose docs — several fields that read as optional are rejected at runtime:
 *
 *   customers  POST requires id, opt_in_status          (email_address in practice too)
 *   products   POST requires id, title, variants[]      each variant requires id + title
 *   carts      POST requires id, customer, currency_code, order_total, lines[]
 *              each line requires id, product_id, product_variant_id, quantity, price
 *   orders     POST requires id, customer, currency_code, order_total, lines[]
 *
 * The PUT add-or-update variants declare only `id` as required, but that is the *update*
 * contract; a PUT that creates the record still needs the full set. Everything here always
 * sends the full set.
 */

import { MailchimpSettings } from './settings';

/** Mailchimp takes decimal money, same as Swell. No cents conversion anywhere. */
function money(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Mailchimp rejects a malformed date-time outright, so anything unparseable is dropped. */
function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** Drops `undefined` keys so a payload never carries a key Mailchimp will complain about. */
function compact<T extends Record<string, any>>(input: T): T {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

function joinUrl(origin: string, path: string): string | undefined {
  if (!origin) return undefined;
  return `${origin.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

// ---------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------

/**
 * Two shapes, deliberately. Mailchimp's *customer* address has no `name`, `phone`,
 * `company`, `longitude` or `latitude`; its *order/cart* shipping and billing addresses do.
 * Sending the richer shape to the customer endpoint is the kind of thing that produces a
 * 400 with a field-level error nobody reads.
 */
export function customerAddress(source: any): Record<string, any> | undefined {
  if (!source) return undefined;
  const address = compact({
    address1: str(source.address1),
    address2: str(source.address2),
    city: str(source.city),
    province: str(source.state),
    province_code: str(source.state),
    postal_code: str(source.zip),
    country_code: str(source.country),
  });
  return Object.keys(address).length > 0 ? address : undefined;
}

export function orderAddress(source: any): Record<string, any> | undefined {
  if (!source) return undefined;
  const address = compact({
    name: str(source.name),
    address1: str(source.address1),
    address2: str(source.address2),
    city: str(source.city),
    province: str(source.state),
    province_code: str(source.state),
    postal_code: str(source.zip),
    country_code: str(source.country),
    phone: str(source.phone),
    company: str(source.company),
  });
  return Object.keys(address).length > 0 ? address : undefined;
}

// ---------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------

/**
 * The ecommerce customer. Distinct from the audience member below: the customer record is
 * what carts and orders hang off, and it exists whether or not the person is subscribed.
 * That separation is why this app can sync purchase history for people who never opted in
 * to marketing — which is precisely what the native integration cannot do.
 */
export function buildCustomerPayload(account: any): Record<string, any> {
  const email = str(account?.email);
  if (!email) {
    throw new Error('Account has no email address, so Mailchimp cannot identify it.');
  }

  return compact({
    id: String(account.id),
    email_address: email,
    // Mailchimp's own note: "This value will never overwrite the opt-in status of a
    // pre-existing Mailchimp list member." So it is safe to send on every push.
    opt_in_status: account.email_optin === true,
    first_name: str(account.first_name),
    last_name: str(account.last_name),
    company: str(account.shipping?.company) ?? str(account.billing?.company),
    address: customerAddress(account.shipping ?? account.billing),
  });
}

/**
 * The audience member — the one thing the native integration does, done more carefully.
 *
 * `status_if_new` and never `status`: Mailchimp refuses to re-subscribe someone who
 * previously unsubscribed, and a PUT carrying `status: "subscribed"` for such a member
 * fails the whole push with a 400. Sending only `status_if_new` means a new address is
 * created at the right status and an existing member's status is left exactly as the
 * subscriber set it. That is both the working behaviour and the lawful one.
 *
 * Accounts that have not opted in are still written, as `transactional`. Transactional
 * members receive order notifications and nothing else, which is what makes post-purchase
 * automations work for customers who declined marketing.
 */
export function buildMemberPayload(account: any): Record<string, any> {
  const email = str(account?.email);
  if (!email) {
    throw new Error('Account has no email address, so Mailchimp cannot identify it.');
  }

  const mergeFields = compact({
    FNAME: str(account.first_name),
    LNAME: str(account.last_name),
    PHONE: str(account.phone),
  });

  return compact({
    email_address: email,
    status_if_new: account.email_optin === true ? 'subscribed' : 'transactional',
    merge_fields: Object.keys(mergeFields).length > 0 ? mergeFields : undefined,
  });
}

// ---------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------

/**
 * Swell variants inherit the parent price when their own is unset, and a sale price wins
 * over the list price at either level. Getting this wrong shows up as wrong revenue in
 * Mailchimp's product reports rather than as an error, so it is worth the branch.
 */
export function variantPrice(product: any, variant: any): number {
  if (variant) {
    if (variant.sale === true && typeof variant.sale_price === 'number') {
      return money(variant.sale_price);
    }
    if (typeof variant.price === 'number') {
      return money(variant.price);
    }
  }
  if (product?.sale === true && typeof product.sale_price === 'number') {
    return money(product.sale_price);
  }
  return money(product?.price);
}

function variantList(product: any): any[] {
  const raw = product?.variants;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.results)) return raw.results;
  return [];
}

export function buildProductPayload(
  product: any,
  settings: MailchimpSettings,
  storefrontOrigin: string,
): Record<string, any> {
  const title = str(product?.name);
  if (!product?.id || !title) {
    throw new Error('Product has no id or name, both of which Mailchimp requires.');
  }

  const handle = str(product.slug) ?? String(product.id);
  const url = joinUrl(storefrontOrigin, `products/${handle}`);

  const images = (Array.isArray(product.images) ? product.images : [])
    .map((image: any) => {
      const imageUrl = str(image?.file?.url) ?? str(image?.url);
      const id = str(image?.id) ?? str(image?.file?.id);
      // Mailchimp requires both id and url on an image; one without the other is dropped
      // rather than sent, because a partial image object fails the whole product push.
      return imageUrl && id ? { id, url: imageUrl } : null;
    })
    .filter(Boolean) as Array<{ id: string; url: string }>;

  const variants = variantList(product);

  const mapped =
    variants.length > 0
      ? variants.map((variant: any) =>
          compact({
            id: String(variant.id),
            // Mailchimp requires a non-empty variant title. Swell allows an unnamed
            // variant, so the product name is the fallback rather than an empty string.
            title: str(variant.name) ?? title,
            sku: str(variant.sku) ?? str(product.sku),
            price: variantPrice(product, variant),
            inventory_quantity:
              typeof variant.stock_level === 'number'
                ? variant.stock_level
                : typeof product.stock_level === 'number'
                  ? product.stock_level
                  : undefined,
            url,
            visibility: product.active === false ? 'hidden' : 'visible',
          }),
        )
      : [
          // Mailchimp will not accept a product with an empty `variants` array, and cart
          // and order lines must name a `product_variant_id`. A single-variant product in
          // Swell therefore syncs as one Mailchimp variant sharing the product's own id —
          // and the line mapper below uses exactly the same fallback, so the two agree.
          compact({
            id: String(product.id),
            title,
            sku: str(product.sku),
            price: variantPrice(product, null),
            inventory_quantity:
              typeof product.stock_level === 'number' ? product.stock_level : undefined,
            url,
            visibility: product.active === false ? 'hidden' : 'visible',
          }),
        ];

  return compact({
    id: String(product.id),
    title,
    handle,
    url,
    description: str(product.description),
    type: str(product.type),
    vendor: str(product.brand),
    image_url: images[0]?.url,
    images: images.length > 0 ? images : undefined,
    published_at_foreign: isoDate(product.date_created),
    variants: mapped,
  });
}

// ---------------------------------------------------------------------------------------
// Lines, shared by carts and orders
// ---------------------------------------------------------------------------------------

/**
 * `product_variant_id` falls back to the product id for products with no variants, which
 * is the same fallback `buildProductPayload` uses when it synthesises a default variant.
 * If these two ever disagree, Mailchimp answers 404 on every order line and the cause is
 * three files away — so they are deliberately written next to each other.
 *
 * `price` is the **line total**, not the unit price. Mailchimp sums line prices for its
 * revenue and product-recommendation reports, and `order_total` is a grand total, so line
 * totals are the only choice that makes the two agree.
 */
export function buildLines(items: any[]): Array<Record<string, any>> {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && item.product_id)
    .map((item) =>
      compact({
        id: String(item.id),
        product_id: String(item.product_id),
        product_variant_id: String(item.variant_id || item.product_id),
        quantity: typeof item.quantity === 'number' ? item.quantity : 1,
        price: money(
          typeof item.price_total === 'number'
            ? item.price_total
            : money(item.price) * (typeof item.quantity === 'number' ? item.quantity : 1),
        ),
      }),
    );
}

/**
 * The embedded customer object carts and orders carry. Mailchimp upserts the customer from
 * it, which is what stops an order failing merely because the account has not synced yet.
 */
function embeddedCustomer(account: any): Record<string, any> {
  const email = str(account?.email);
  if (!account?.id || !email) {
    throw new Error(
      'Record has no customer account with an email address, and Mailchimp requires one.',
    );
  }
  return compact({
    id: String(account.id),
    email_address: email,
    opt_in_status: account.email_optin === true,
    first_name: str(account.first_name),
    last_name: str(account.last_name),
  });
}

// ---------------------------------------------------------------------------------------
// Carts
// ---------------------------------------------------------------------------------------

export function buildCartPayload(
  cart: any,
  settings: MailchimpSettings,
  storefrontOrigin: string,
): Record<string, any> {
  const lines = buildLines(cart?.items);
  if (lines.length === 0) {
    throw new Error('Cart has no line items with a product, so there is nothing to sync.');
  }

  return compact({
    id: String(cart.id),
    customer: embeddedCustomer(cart.account),
    currency_code: (str(cart.currency) ?? settings.store_currency).toUpperCase(),
    order_total: money(cart.grand_total),
    tax_total: money(cart.tax_total),
    // Mailchimp's own docs: checkout_url is "required for Abandoned Cart". Without it the
    // automation still fires but the recovery link in the email goes nowhere useful.
    checkout_url:
      str(cart.checkout_url) ??
      (cart.checkout_id ? joinUrl(storefrontOrigin, `checkout/${cart.checkout_id}`) : undefined),
    lines,
  });
}

// ---------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------

/**
 * Mailchimp declares `financial_status` and `fulfillment_status` as free strings with no
 * enum, but the values below are the ones its own platform integrations emit and the ones
 * its Order Notification automations key on. Inventing new ones silently disables those
 * automations, which is worse than being wrong loudly.
 */
export function financialStatus(order: any): string {
  if (order?.canceled === true) return 'cancelled';
  const refunded = money(order?.refund_total);
  const paid = money(order?.payment_total);
  if (refunded > 0 && paid > 0 && refunded >= paid) return 'refunded';
  if (refunded > 0) return 'partially_refunded';
  if (order?.paid === true) return 'paid';
  return 'pending';
}

export function fulfillmentStatus(order: any): string {
  if (order?.delivered === true) return 'fulfilled';
  if (typeof order?.item_quantity_delivered === 'number' && order.item_quantity_delivered > 0) {
    return 'partially_fulfilled';
  }
  return 'unfulfilled';
}

export function buildOrderPayload(
  order: any,
  settings: MailchimpSettings,
  storefrontOrigin: string,
): Record<string, any> {
  const lines = buildLines(order?.items);
  if (lines.length === 0) {
    throw new Error('Order has no line items with a product, so there is nothing to sync.');
  }

  const discountTotal = money(order.discount_total);

  return compact({
    id: String(order.id),
    customer: embeddedCustomer(order.account),
    currency_code: (str(order.currency) ?? settings.store_currency).toUpperCase(),
    order_total: money(order.grand_total),
    discount_total: discountTotal,
    tax_total: money(order.tax_total),
    shipping_total: money(order.shipment_total),
    financial_status: financialStatus(order),
    fulfillment_status: fulfillmentStatus(order),
    // Linking the order back to its cart is what lets Mailchimp attribute a recovered
    // abandoned cart to the revenue it produced.
    cart_id: str(order.cart_id),
    order_url: joinUrl(storefrontOrigin, `account/orders/${order.id}`),
    processed_at_foreign: isoDate(order.date_created),
    updated_at_foreign: isoDate(order.date_updated),
    // Mailchimp: "passing a value for this parameter will cancel the order". Only ever
    // sent for an order Swell has actually canceled.
    cancelled_at_foreign:
      order.canceled === true
        ? (isoDate(order.date_canceled) ?? new Date().toISOString())
        : undefined,
    shipping_address: orderAddress(order.shipping),
    billing_address: orderAddress(order.billing),
    promos:
      str(order.coupon_code) && discountTotal > 0
        ? [
            {
              code: String(order.coupon_code),
              // Swell resolves every discount to an amount before this point, so the
              // Mailchimp type is always "fixed" even for a percentage coupon.
              type: 'fixed',
              amount_discounted: discountTotal,
            },
          ]
        : undefined,
    lines,
  });
}
