import { describe, expect, it } from "vitest";
import {
  buildCartPayload,
  buildCustomerPayload,
  buildLines,
  buildMemberPayload,
  buildOrderPayload,
  buildProductPayload,
  customerAddress,
  financialStatus,
  fulfillmentStatus,
  orderAddress,
  variantPrice,
} from "../../functions/lib/mappers";
import type { MailchimpSettings } from "../../functions/lib/settings";
import {
  ACCOUNT_ID,
  PRODUCT_ID,
  VARIANT_ID,
  account,
  address,
  cart,
  lineItem,
  order,
  product,
  variant,
} from "../helpers/fixtures";

/**
 * Mapper tests. These are the ones worth having: Mailchimp rejects an incomplete ecommerce
 * payload with a 400 whose field-level detail is easy to miss, and several fields that read
 * as optional in the prose are required in the spec. Each `expect` below pins one of those.
 *
 * No network anywhere in this file — mappers are pure functions of a Swell record.
 */

const ORIGIN = "https://shop.example.com";

function settings(overrides: Partial<MailchimpSettings> = {}): MailchimpSettings {
  return {
    enabled: true,
    api_key: "key-us14",
    list_id: "a6b5da1054",
    api_base: "",
    store_id: "test-store",
    store_name: "Test Store",
    store_currency: "USD",
    store_domain: "shop.example.com",
    push_trigger: "automatic",
    sync_accounts: true,
    sync_products: true,
    sync_carts: true,
    cart_scope: "all",
    sync_orders: true,
    event_created: true,
    event_updated: true,
    event_deleted: false,
    push_optout: true,
    archive_on_delete: true,
    webhook_secret: "a-long-enough-secret",
    webhook_signing_secret: "",
    webhook_writeback: true,
    callback_url: "",
    app_object_id: "",
    allow_test_payload: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Customers and audience members
// ---------------------------------------------------------------------------

describe("buildCustomerPayload", () => {
  it("sends every field Mailchimp requires on an ecommerce customer", () => {
    const payload = buildCustomerPayload(account());

    // `id` and `opt_in_status` are the two the spec marks required. `email_address` is not
    // marked required but is unusable without.
    expect(payload.id).toBe(ACCOUNT_ID);
    expect(payload.opt_in_status).toBe(true);
    expect(payload.email_address).toBe("ada@example.com");
  });

  it("treats a missing opt-in as false rather than omitting it", () => {
    // Omitting `opt_in_status` fails the create; sending `undefined` for a bool is the
    // classic way to produce a 400 that reads as "invalid resource" and nothing else.
    expect(buildCustomerPayload(account({ email_optin: undefined })).opt_in_status).toBe(
      false,
    );
  });

  it("refuses an account with no email instead of sending an unusable customer", () => {
    // Throwing here is the contract with push.ts: it records `skipped`, non-retryable.
    expect(() => buildCustomerPayload(account({ email: null }))).toThrow(/email/i);
    expect(() => buildCustomerPayload(account({ email: "   " }))).toThrow(/email/i);
  });

  it("uses the customer address shape, not the order one", () => {
    // Mailchimp's customer address has no name/phone/company. Sending them is a 400.
    const payload = buildCustomerPayload(account());
    expect(Object.keys(payload.address).sort()).toEqual([
      "address1",
      "address2",
      "city",
      "country_code",
      "postal_code",
      "province",
      "province_code",
    ]);
  });

  it("omits the address entirely when there is nothing to send", () => {
    const payload = buildCustomerPayload(account({ shipping: null, billing: null }));
    expect(payload.address).toBeUndefined();
    expect("address" in payload).toBe(false);
  });
});

describe("buildMemberPayload", () => {
  it("sends status_if_new and never status", () => {
    // Mailchimp refuses an API re-subscribe of someone who unsubscribed. A PUT carrying
    // `status: "subscribed"` for such a member fails the whole push, so this app never
    // sends `status` on the upsert path at all.
    const payload = buildMemberPayload(account());
    expect(payload.status_if_new).toBe("subscribed");
    expect("status" in payload).toBe(false);
    expect(payload.email_address).toBe("ada@example.com");
  });

  it("writes a non-opted-in account as transactional rather than skipping it", () => {
    // Transactional members receive order notifications and no marketing — which is what
    // makes post-purchase automations work for customers who declined marketing.
    expect(buildMemberPayload(account({ email_optin: false })).status_if_new).toBe(
      "transactional",
    );
  });

  it("carries name merge fields when they exist and omits them when they do not", () => {
    expect(buildMemberPayload(account()).merge_fields).toEqual({
      FNAME: "Ada",
      LNAME: "Lovelace",
    });
    expect(
      buildMemberPayload(account({ first_name: null, last_name: null, phone: null }))
        .merge_fields,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

describe("buildProductPayload", () => {
  it("sends id, title and a non-empty variants array", () => {
    const payload = buildProductPayload(product(), settings(), ORIGIN);
    expect(payload.id).toBe(PRODUCT_ID);
    expect(payload.title).toBe("MD Bamboo Tee");
    expect(Array.isArray(payload.variants)).toBe(true);
    expect(payload.variants.length).toBe(1);
    // Every variant needs both, per the spec.
    for (const v of payload.variants) {
      expect(v.id).toBeTruthy();
      expect(v.title).toBeTruthy();
    }
  });

  it("synthesises a default variant sharing the product id when Swell has none", () => {
    // This is the contract cart and order lines depend on: a product with no variants is
    // referenced by `product_variant_id === product_id`. If these ever disagree, every
    // order line 404s.
    const payload = buildProductPayload(product({ variants: [] }), settings(), ORIGIN);
    expect(payload.variants).toHaveLength(1);
    expect(payload.variants[0].id).toBe(PRODUCT_ID);
    expect(payload.variants[0].title).toBe("MD Bamboo Tee");

    const lines = buildLines([lineItem({ variant_id: null })]);
    expect(lines[0].product_variant_id).toBe(payload.variants[0].id);
  });

  it("falls back to the product name for an unnamed variant", () => {
    // Swell allows a variant with no name; Mailchimp requires a title on every one.
    const payload = buildProductPayload(
      product({ variants: [variant({ name: null })] }),
      settings(),
      ORIGIN,
    );
    expect(payload.variants[0].title).toBe("MD Bamboo Tee");
  });

  it("accepts both the { results } envelope and a bare array of variants", () => {
    const fromEnvelope = buildProductPayload(product(), settings(), ORIGIN);
    const fromArray = buildProductPayload(
      { ...product({ variants: null }), variants: [variant()] },
      settings(),
      ORIGIN,
    );
    expect(fromArray.variants).toEqual(fromEnvelope.variants);
  });

  it("drops an image that is missing either half of Mailchimp's required pair", () => {
    // Mailchimp requires id AND url on each image; a partial one fails the whole product.
    const payload = buildProductPayload(
      product({ images: [{ id: "img_1" }, { file: { url: "https://x/y.jpg" } }] }),
      settings(),
      ORIGIN,
    );
    expect(payload.images).toBeUndefined();
    expect(payload.image_url).toBeUndefined();
  });

  it("refuses a product with no name", () => {
    expect(() => buildProductPayload(product({ name: null }), settings(), ORIGIN)).toThrow(
      /id or name/i,
    );
  });
});

describe("variantPrice", () => {
  it("prefers the variant sale price, then the variant price", () => {
    expect(variantPrice(product(), variant({ sale: true, sale_price: 7 }))).toBe(7);
    expect(variantPrice(product(), variant({ price: 15 }))).toBe(15);
  });

  it("inherits the parent price when the variant has none", () => {
    // Live Swell variants routinely carry no price at all. Reading `variant.price` blindly
    // would push every one of them to Mailchimp at 0.
    expect(variantPrice(product(), variant())).toBe(12);
    expect(variantPrice(product({ sale: true, sale_price: 9 }), variant())).toBe(9);
  });

  it("never returns NaN for a junk price", () => {
    expect(variantPrice(product({ price: null }), null)).toBe(0);
    expect(variantPrice({ price: "twelve" }, null)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

describe("buildLines", () => {
  it("sends all five fields Mailchimp requires on every line", () => {
    const [line] = buildLines([lineItem()]);
    expect(Object.keys(line).sort()).toEqual([
      "id",
      "price",
      "product_id",
      "product_variant_id",
      "quantity",
    ]);
  });

  it("uses the line total rather than the unit price", () => {
    // Mailchimp sums line prices for revenue reporting and `order_total` is a grand total,
    // so unit prices would make the two disagree on every multi-quantity order.
    expect(buildLines([lineItem({ quantity: 2, price: 12, price_total: 24 })])[0].price).toBe(
      24,
    );
    // …and computes it when Swell did not supply one.
    expect(
      buildLines([lineItem({ quantity: 3, price: 5, price_total: undefined })])[0].price,
    ).toBe(15);
  });

  it("falls back to the product id when the line has no variant", () => {
    expect(buildLines([lineItem({ variant_id: null })])[0].product_variant_id).toBe(
      PRODUCT_ID,
    );
    expect(buildLines([lineItem()])[0].product_variant_id).toBe(VARIANT_ID);
  });

  it("drops a line with no product rather than sending an unusable one", () => {
    // A shipping or custom line with no product_id cannot be expressed in Mailchimp and
    // would fail the whole cart or order.
    expect(buildLines([lineItem(), { id: "x", quantity: 1, price: 5 }])).toHaveLength(1);
    expect(buildLines(null as any)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Carts
// ---------------------------------------------------------------------------

describe("buildCartPayload", () => {
  it("sends every field Mailchimp requires on a cart", () => {
    const payload = buildCartPayload(cart(), settings(), ORIGIN);
    for (const field of ["id", "customer", "currency_code", "order_total", "lines"]) {
      expect(payload[field], `cart payload is missing ${field}`).toBeDefined();
    }
    expect(payload.customer.id).toBe(ACCOUNT_ID);
    expect(payload.customer.email_address).toBe("ada@example.com");
    expect(payload.currency_code).toBe("USD");
  });

  it("carries checkout_url, which Mailchimp needs for abandoned-cart recovery", () => {
    expect(buildCartPayload(cart(), settings(), ORIGIN).checkout_url).toBe(
      "https://shop.example.com/checkout/chk_1",
    );
    // Derived from the checkout id when Swell has not materialised the URL yet.
    expect(
      buildCartPayload(cart({ checkout_url: null }), settings(), ORIGIN).checkout_url,
    ).toBe("https://shop.example.com/checkout/chk_1");
  });

  it("refuses a guest cart, because Mailchimp requires a customer", () => {
    expect(() => buildCartPayload(cart({ account: null }), settings(), ORIGIN)).toThrow(
      /customer account/i,
    );
  });

  it("refuses an empty cart", () => {
    expect(() => buildCartPayload(cart({ items: [] }), settings(), ORIGIN)).toThrow(
      /no line items/i,
    );
  });

  it("falls back to the store currency when the cart has none", () => {
    expect(
      buildCartPayload(cart({ currency: null }), settings({ store_currency: "GBP" }), ORIGIN)
        .currency_code,
    ).toBe("GBP");
  });
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

describe("buildOrderPayload", () => {
  it("sends every field Mailchimp requires on an order", () => {
    const payload = buildOrderPayload(order(), settings(), ORIGIN);
    for (const field of ["id", "customer", "currency_code", "order_total", "lines"]) {
      expect(payload[field], `order payload is missing ${field}`).toBeDefined();
    }
    expect(payload.order_total).toBe(31);
    expect(payload.tax_total).toBe(2);
    expect(payload.shipping_total).toBe(5);
  });

  it("links the order back to the cart it came from", () => {
    // This is what lets Mailchimp attribute recovered-cart revenue to the automation.
    expect(buildOrderPayload(order(), settings(), ORIGIN).cart_id).toBe(
      "6a7324fb5733910012ad7565",
    );
  });

  it("only sends cancelled_at_foreign for an order that is actually canceled", () => {
    // Mailchimp: "passing a value for this parameter will cancel the order". Sending it
    // unconditionally would cancel every order in Mailchimp.
    expect(buildOrderPayload(order(), settings(), ORIGIN).cancelled_at_foreign).toBeUndefined();

    const canceled = buildOrderPayload(
      order({ canceled: true, date_canceled: "2026-07-03T00:00:00.000Z" }),
      settings(),
      ORIGIN,
    );
    expect(canceled.cancelled_at_foreign).toBe("2026-07-03T00:00:00.000Z");
    expect(canceled.financial_status).toBe("cancelled");
  });

  it("sends a promo only when there is both a code and a discount", () => {
    expect(buildOrderPayload(order(), settings(), ORIGIN).promos).toBeUndefined();

    const promos = buildOrderPayload(
      order({ coupon_code: "SAVE10", discount_total: 3 }),
      settings(),
      ORIGIN,
    ).promos;
    // All three of code, type and amount_discounted are required on a promo.
    expect(promos).toEqual([{ code: "SAVE10", type: "fixed", amount_discounted: 3 }]);
  });

  it("drops an unparseable date instead of sending it", () => {
    // Mailchimp rejects a malformed date-time outright, failing the whole order.
    const payload = buildOrderPayload(
      order({ date_created: "not a date", date_updated: null }),
      settings(),
      ORIGIN,
    );
    expect(payload.processed_at_foreign).toBeUndefined();
    expect(payload.updated_at_foreign).toBeUndefined();
  });

  it("uses the richer order address shape", () => {
    const payload = buildOrderPayload(order(), settings(), ORIGIN);
    expect(payload.shipping_address.name).toBe("Ada Lovelace");
    expect(payload.shipping_address.phone).toBe("+15550100");
    expect(payload.billing_address.address1).toBe("1 Billing Way");
  });

  it("refuses a guest order and an empty order", () => {
    expect(() => buildOrderPayload(order({ account: null }), settings(), ORIGIN)).toThrow(
      /customer account/i,
    );
    expect(() => buildOrderPayload(order({ items: [] }), settings(), ORIGIN)).toThrow(
      /no line items/i,
    );
  });
});

describe("order status mapping", () => {
  it("maps Swell's booleans onto the values Mailchimp's automations key on", () => {
    expect(financialStatus(order({ paid: false }))).toBe("pending");
    expect(financialStatus(order({ paid: true }))).toBe("paid");
    expect(financialStatus(order({ refund_total: 10, payment_total: 31 }))).toBe(
      "partially_refunded",
    );
    expect(financialStatus(order({ refund_total: 31, payment_total: 31 }))).toBe("refunded");
    // Cancellation wins over everything, including a full refund.
    expect(financialStatus(order({ canceled: true, refund_total: 31 }))).toBe("cancelled");
  });

  it("maps fulfillment from delivery state", () => {
    expect(fulfillmentStatus(order())).toBe("unfulfilled");
    expect(fulfillmentStatus(order({ item_quantity_delivered: 1 }))).toBe(
      "partially_fulfilled",
    );
    expect(fulfillmentStatus(order({ delivered: true }))).toBe("fulfilled");
  });
});

describe("address shapes", () => {
  it("keeps the two Mailchimp address schemas distinct", () => {
    const customer = customerAddress(address());
    const shipping = orderAddress(address());

    expect("name" in customer!).toBe(false);
    expect("phone" in customer!).toBe(false);
    expect(shipping!.name).toBe("Ada Lovelace");
    expect(shipping!.phone).toBe("+15550100");
  });

  it("returns undefined rather than an empty object", () => {
    expect(customerAddress(null)).toBeUndefined();
    expect(orderAddress({})).toBeUndefined();
  });
});
