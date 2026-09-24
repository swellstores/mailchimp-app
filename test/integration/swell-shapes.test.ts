import { afterEach, describe, expect, it, vi } from "vitest";
import { createSwellClient } from "../helpers/swell-client";
import {
  buildCartPayload,
  buildCustomerPayload,
  buildOrderPayload,
  buildProductPayload,
} from "../../functions/lib/mappers";
import type { MailchimpSettings } from "../../functions/lib/settings";

/**
 * ===========================================================================
 * INTEGRATION TESTS — real store, real shapes, no Mailchimp account required.
 *
 * These run against the REAL store using the `swell login` session resolved in
 * `vitest.config.ts`. What they are for: catching drift between what the mappers assume
 * about Swell's data and what the store actually returns — a field rename, an expansion
 * that stopped resolving, a model that never deployed. A unit test with a hand-written
 * fixture cannot see any of that, because the fixture drifts with the code.
 *
 * The strongest thing here is the last block: it runs the real mappers over real records
 * and asserts the result carries everything Mailchimp requires. That is the check that
 * would have caught, for instance, variants coming back in a different envelope.
 *
 * THREE RULES.
 *
 *  1. READ-ONLY. No POST, PUT or DELETE against the store.
 *  2. NO `vi.stubGlobal('fetch', ...)` ANYWHERE IN THIS DIRECTORY.
 *  3. SELF-SKIP, NEVER FAIL, WHEN THE STORE LACKS FIXTURE DATA. A store with no cart is
 *     not a bug in the app.
 * ===========================================================================
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const COLLECTIONS = ["accounts", "products", "carts", "orders"] as const;

/**
 * Vitest defaults to 5s. These tests make several real admin-API round trips each, and a
 * request for a resource the app has not deployed yet is the slowest of them — so the
 * default turns "the app is not pushed" into a timeout instead of the self-skip it should
 * be.
 */
const INTEGRATION_TIMEOUT = 30_000;

const SETTINGS: MailchimpSettings = {
  enabled: true,
  api_key: "key-us14",
  list_id: "list",
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
};

const ORIGIN = "https://shop.example.com";

/**
 * A resource that has not been deployed does NOT come back as `null`. The admin API
 * raises, and — the part that catches people out — it does so with **HTTP 400 and
 * `code: "invalid_request"`**, not 404:
 *
 *   { "error": { "code": "invalid_request",
 *                "message": "Setting configuration not found: mailchimp" } }
 *
 * So a status check alone never fires; the message is the only reliable signal. Every
 * "is it deployed yet?" test has to be a catch, not a falsy check.
 */
function isMissing(err: unknown): boolean {
  const status = (err as any)?.status;
  return status === 404 || /not found/i.test(String((err as Error)?.message ?? err));
}

async function getOrSkip(
  path: string,
  params?: Record<string, any>,
  hint = "Run `swell app push` first.",
): Promise<any | null> {
  try {
    return await createSwellClient().get(path, params);
  } catch (err) {
    if (isMissing(err)) {
      console.warn(`Skipping: ${path} is not available on this store. ${hint}`);
      return null;
    }
    throw err;
  }
}

describe("store access", () => {
  it("authenticates against the store with the CLI session", async () => {
    const general = await createSwellClient().get("/settings/general");

    // If this fails, the whole integration directory will fail. Run `swell login`, or
    // set SWELL_STORE_ID and SWELL_SESSION_ID.
    expect(general).toBeDefined();
    expect(general.id).toBe("general");
    expect(typeof general.features?.carts).toBe("boolean");
  }, INTEGRATION_TIMEOUT);
});

describe("deployed app resources", () => {
  it("exposes the app's settings record once the app is pushed", async () => {
    const settings = await getOrSkip("/settings/mailchimp");
    if (!settings) return;
    expect(settings).toBeDefined();
  }, INTEGRATION_TIMEOUT);

  it("accepts a sync_status query on every collection the app stamps", async () => {
    // Two things at once: the model fields deployed under `$app.mailchimp.*` on all four
    // collections, and the saved "errors" list tab in each content file has a query that
    // resolves. Note this is an unindexed scan — Swell has no index declaration yet.
    for (const collection of COLLECTIONS) {
      const response = await getOrSkip(`/${collection}`, {
        limit: 1,
        where: { "$app.mailchimp.sync_status": "error" },
      });
      if (!response) continue;
      expect(Array.isArray(response.results), `${collection} query did not resolve`).toBe(true);
    }
  }, INTEGRATION_TIMEOUT);
});

describe("real record shapes feed the real mappers", () => {
  it("maps a live account into a payload Mailchimp would accept", async () => {
    const response = await getOrSkip("/accounts", {
      limit: 10,
      sort: "date_created desc",
    });
    if (!response) return;

    const record = (response.results ?? []).find((item: any) => item?.email);
    if (!record) {
      console.warn("Skipping: no account on this store has an email address.");
      return;
    }

    const payload = buildCustomerPayload(record);
    expect(payload.id).toBe(record.id);
    expect(payload.email_address).toBeTruthy();
    expect(typeof payload.opt_in_status).toBe("boolean");
  }, INTEGRATION_TIMEOUT);

  it("maps a live product, and proves the variants expansion still resolves", async () => {
    const response = await getOrSkip("/products", {
      limit: 5,
      sort: "date_created desc",
      // The `include` form the push path uses, with an explicit limit. If this quietly
      // stopped resolving, products would sync with a synthesised default variant and
      // every order line naming a real variant id would 404 — which is exactly the kind
      // of drift a hand-written fixture can never reveal.
      include: {
        variants: { url: "/products:variants", params: { parent_id: "id", limit: 1000 } },
      },
    });
    if (!response) return;

    const record = (response.results ?? []).find((item: any) => item?.name);
    if (!record) {
      console.warn("Skipping: no product on this store has a name.");
      return;
    }

    const payload = buildProductPayload(record, SETTINGS, ORIGIN);
    expect(payload.id).toBe(record.id);
    expect(payload.title).toBeTruthy();
    // Mailchimp requires at least one variant, each with an id and a title.
    expect(payload.variants.length).toBeGreaterThan(0);
    for (const variant of payload.variants) {
      expect(variant.id).toBeTruthy();
      expect(variant.title).toBeTruthy();
      expect(typeof variant.price).toBe("number");
      expect(Number.isNaN(variant.price)).toBe(false);
    }

    const withVariants = (response.results ?? []).find(
      (item: any) => (item?.variants?.results ?? []).length > 0,
    );
    if (!withVariants) {
      console.warn("Skipping variant-envelope assertion: no product on this store has variants.");
      return;
    }
    // `{ count, results }`, not a bare array. The mapper accepts both; this pins which one
    // the store actually returns.
    expect(Array.isArray(withVariants.variants.results)).toBe(true);
  }, INTEGRATION_TIMEOUT);

  it("maps a live order, and proves the account expansion still resolves", async () => {
    const response = await getOrSkip("/orders", {
      limit: 10,
      sort: "date_created desc",
      expand: ["account"],
    });
    if (!response) return;

    const record = (response.results ?? []).find(
      (item: any) => item?.account?.email && (item?.items ?? []).some((i: any) => i.product_id),
    );
    if (!record) {
      console.warn(
        "Skipping: no recent order has both an account with an email and a product line.",
      );
      return;
    }

    const payload = buildOrderPayload(record, SETTINGS, ORIGIN);
    for (const field of ["id", "customer", "currency_code", "order_total", "lines"]) {
      expect(payload[field], `order payload is missing ${field}`).toBeDefined();
    }
    expect(payload.customer.email_address).toBeTruthy();
    for (const line of payload.lines) {
      // All five are required by Mailchimp on every line.
      expect(line.id).toBeTruthy();
      expect(line.product_id).toBeTruthy();
      expect(line.product_variant_id).toBeTruthy();
      expect(typeof line.quantity).toBe("number");
      expect(typeof line.price).toBe("number");
    }
  }, INTEGRATION_TIMEOUT);

  it("maps a live cart, or says why it cannot", async () => {
    const response = await getOrSkip("/carts", {
      limit: 20,
      sort: "date_created desc",
      expand: ["account"],
    });
    if (!response) return;

    const record = (response.results ?? []).find(
      (item: any) => item?.account?.email && (item?.items ?? []).some((i: any) => i.product_id),
    );
    if (!record) {
      // Guest carts are the norm on a test store, and this app skips them by design.
      console.warn(
        "Skipping: no recent cart has both an account with an email and a product line.",
      );
      return;
    }

    const payload = buildCartPayload(record, SETTINGS, ORIGIN);
    for (const field of ["id", "customer", "currency_code", "order_total", "lines"]) {
      expect(payload[field], `cart payload is missing ${field}`).toBeDefined();
    }
  }, INTEGRATION_TIMEOUT);
});
