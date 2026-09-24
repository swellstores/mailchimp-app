/**
 * Fixture builders.
 *
 * Shapes mirror what the Swell admin API on a test store actually
 * returns — they were read off live records with `swell api get`, not invented. Where a
 * field is absent below it is absent because the live record did not have it (Swell omits
 * unset fields rather than sending `null`), which is exactly the case a mapper has to
 * survive.
 *
 * Every builder takes an overrides object and merges it last, so a test can express only
 * the field it is actually about:
 *
 *     order({ items: [orderItem({ variant_id: null })] })
 *
 * Ids are stable and obviously fake. Do not switch them to random values — a test that
 * asserts on an id should keep asserting on the same one.
 */

/** A plausible 24-char Mongo-style id, the shape Swell record ids actually take. */
export const RECORD_ID = "6650f1a2b3c4d5e6f7a8b9c0";
export const ACCOUNT_ID = "6a158c35198ea40013d6bc72";
export const PRODUCT_ID = "f4d42125281c4a9b4ac602af";
export const VARIANT_ID = "69f49a49d7f4b70012ebce2a";
export const CART_ID = "6a7324fb5733910012ad7565";

// ---------------------------------------------------------------------------
// Swell-side fixtures
// ---------------------------------------------------------------------------

export function account(
  overrides: Record<string, any> = {},
): Record<string, any> {
  return {
    id: ACCOUNT_ID,
    email: "ada@example.com",
    first_name: "Ada",
    last_name: "Lovelace",
    name: "Ada Lovelace",
    email_optin: true,
    type: "individual",
    currency: "USD",
    date_created: "2026-06-01T09:00:00.000Z",
    shipping: address(),
    ...overrides,
  };
}

export function address(
  overrides: Record<string, any> = {},
): Record<string, any> {
  return {
    name: "Ada Lovelace",
    first_name: "Ada",
    last_name: "Lovelace",
    address1: "221 Baker St",
    address2: "Apt 2",
    city: "Benicia",
    state: "CA",
    zip: "94510",
    country: "US",
    phone: "+15550100",
    company: null,
    ...overrides,
  };
}

export function variant(
  overrides: Record<string, any> = {},
): Record<string, any> {
  return {
    id: VARIANT_ID,
    parent_id: PRODUCT_ID,
    name: "M, green",
    // Live variants routinely have a null sku and no price of their own — they inherit
    // the parent's. Both are load-bearing in `variantPrice`.
    sku: null,
    option_value_ids: ["69f49a4670d38ed4564a6345"],
    ...overrides,
  };
}

/**
 * `expand`/`include` on a link field returns `{ count, results }`, not a bare array. The
 * product mapper accepts either, and this fixture uses the real envelope on purpose.
 */
export function product(
  options: { variants?: Array<Record<string, any>> | null; [key: string]: any } = {},
): Record<string, any> {
  const { variants = [variant()], ...overrides } = options;
  return {
    id: PRODUCT_ID,
    name: "MD Bamboo Tee",
    slug: "md-bamboo-tee-fl296",
    sku: null,
    active: true,
    price: 12,
    sale: false,
    sale_price: null,
    currency: "USD",
    stock_level: 4,
    stock_tracking: false,
    type: "physical",
    brand: null,
    tags: [],
    description: "A soft bamboo tee.",
    date_created: "2026-06-01T09:00:00.000Z",
    images: [
      {
        id: "69de165d759e5a329464d740",
        file: { id: "6a4e142934f4370012653667", url: "https://cdn.swell.store/tee.jpg" },
      },
    ],
    ...(variants === null ? {} : { variants: { count: variants.length, results: variants } }),
    ...overrides,
  };
}

export function lineItem(
  overrides: Record<string, any> = {},
): Record<string, any> {
  return {
    id: "6a73250bad24570012f7de07",
    product_id: PRODUCT_ID,
    variant_id: VARIANT_ID,
    quantity: 2,
    price: 12,
    price_total: 24,
    discount_each: 0,
    ...overrides,
  };
}

export function cart(
  options: { items?: Array<Record<string, any>>; [key: string]: any } = {},
): Record<string, any> {
  const { items = [lineItem()], ...overrides } = options;
  return {
    id: CART_ID,
    account_id: ACCOUNT_ID,
    account: account(),
    currency: "USD",
    sub_total: 24,
    tax_total: 0,
    grand_total: 24,
    checkout_id: "chk_1",
    checkout_url: "https://shop.example.com/checkout/chk_1",
    date_created: "2026-08-05T11:56:43.920Z",
    items,
    ...overrides,
  };
}

export interface OrderFixtureOptions {
  paid?: boolean;
  canceled?: boolean;
  delivered?: boolean;
  items?: Array<Record<string, any>>;
  [key: string]: any;
}

export function order(options: OrderFixtureOptions = {}): Record<string, any> {
  const {
    paid = true,
    canceled = false,
    delivered = false,
    items = [lineItem()],
    ...overrides
  } = options;

  return {
    id: RECORD_ID,
    number: "BVR100677",
    date_created: "2026-07-01T10:00:00.000Z",
    date_updated: "2026-07-02T10:00:00.000Z",
    paid,
    canceled,
    delivered,
    status: paid ? "complete" : "payment_pending",
    currency: "USD",
    sub_total: 24,
    tax_total: 2,
    shipment_total: 5,
    discount_total: 0,
    grand_total: 31,
    payment_total: paid ? 31 : 0,
    refund_total: 0,
    item_quantity_delivered: 0,
    cart_id: CART_ID,
    coupon_code: null,
    shipping: address(),
    billing: address({ address1: "1 Billing Way", address2: null }),
    items,
    account_id: ACCOUNT_ID,
    account: account(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------

/**
 * The standard sync-state block (INTEGRATION-PLAN §2.3) as it appears on a record that
 * has already been pushed once.
 */
export function syncState(
  overrides: Record<string, any> = {},
): Record<string, any> {
  // Mirrors the `SyncState` interface in functions/lib/sync-state.ts. Keep the two in
  // step — a fixture carrying a field the model does not declare produces tests that
  // pass against a write the API would reject.
  return {
    sync_status: "synced",
    remote_key: RECORD_ID,
    remote_id: RECORD_ID,
    last_synced_at: "2026-07-01T10:05:00.000Z",
    last_error: null,
    resync_requested: false,
    ...overrides,
  };
}

/**
 * Attaches sync state under the app's own namespace, the way the API returns it.
 * Use this rather than hand-writing `$app` blocks — it keeps the namespace in one place.
 */
export function withSyncState(
  record: Record<string, any>,
  state: Record<string, any> = syncState(),
  appId = "mailchimp",
): Record<string, any> {
  return {
    ...record,
    $app: {
      ...(record.$app ?? {}),
      [appId]: { ...(record.$app?.[appId] ?? {}), ...state },
    },
  };
}

// ---------------------------------------------------------------------------
// Mailchimp-side fixtures
// ---------------------------------------------------------------------------

/** Mailchimp echoes the id we supplied, which is what makes `remote_key` meaningful. */
export function mailchimpEcommerceRecord(
  overrides: Record<string, any> = {},
): Record<string, any> {
  return {
    id: RECORD_ID,
    currency_code: "USD",
    ...overrides,
  };
}

export function mailchimpMember(
  overrides: Record<string, any> = {},
): Record<string, any> {
  return {
    // Mailchimp's member id is the MD5 of the lowercased address.
    id: "b3f9a4f4bd2a3c62e1c7f1e6a9d0c111",
    email_address: "ada@example.com",
    status: "subscribed",
    list_id: "a6b5da1054",
    ...overrides,
  };
}

/**
 * Mailchimp's RFC-7807 error envelope. Every non-2xx carries this shape — except at high
 * volume, where the docs warn a 429 or 403 may arrive with no body at all.
 */
export function mailchimpError(
  status: number,
  detail: string,
  errors?: Array<{ field: string; message: string }>,
): Record<string, any> {
  return {
    type: "https://mailchimp.com/developer/marketing/docs/errors/",
    title: status === 404 ? "Resource Not Found" : "Invalid Resource",
    status,
    detail,
    instance: "3b4dcb40-0b6b-4820-bfaa-41267b3826ea",
    ...(errors ? { errors } : {}),
  };
}

/**
 * An inbound webhook exactly as Mailchimp sends it: form-encoded, bracket keys.
 * Deliberately a *string*, because that is the wire format and the parser's real input.
 */
export function mailchimpWebhookForm(
  type: string,
  data: Record<string, string>,
  firedAt = "2026-08-07 09:00:00",
): string {
  const params = new URLSearchParams();
  params.set("type", type);
  params.set("fired_at", firedAt);
  for (const [key, value] of Object.entries(data)) {
    params.set(`data[${key}]`, value);
  }
  return params.toString();
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** Builds a `fetch` response for `vi.stubGlobal('fetch', ...)` Mailchimp-API stubs. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The `{ count, results }` envelope every Swell list endpoint returns. */
export function listResponse(
  results: Array<Record<string, any>>,
): Record<string, any> {
  return { count: results.length, results, page: 1, page_count: 1 };
}
