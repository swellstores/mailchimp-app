import { afterEach, describe, expect, it, vi } from "vitest";
import { setSyncState } from "../../functions/lib/sync-state";
import { writeAccountFromWebhook } from "../../functions/lib/account-writeback";
import { createMockRequest } from "../helpers/mock-request";
import {
  SCANNER_CONTROL,
  stripComments,
  strippedSources,
} from "../helpers/source-scan";

/**
 * ===========================================================================
 * THE SINGLE-WRITER INVARIANT — INTEGRATION-PLAN §2.5, house gate 6.
 *
 * This file ships in every generated app and must never be deleted or weakened.
 * If you are here because it went red, the app has a real bug, not a stale test.
 *
 * The invariant: `functions/lib/sync-state.ts` is the ONLY module that writes to a
 * synced collection, and every one of its writes goes through `req.appValues()`, which
 * confines the patch to `$app.<app_id>.*`.
 *
 * Why it matters, concretely: a sync app subscribes to `<collection>.updated`. If the
 * app writes any field outside its own `$app` namespace, that write is itself an update
 * — so the platform re-dispatches `<collection>.updated` to the app, which writes again.
 * The loop is not theoretical: it burns the 10s function budget per hop, hammers the
 * vendor API, and after ~4 days of continuous failure the platform auto-disables the
 * function until it is redeployed. `$app`-only writes are what breaks the cycle.
 *
 * A second, quieter reason: writing outside `$app` means the app can clobber merchant
 * data or another app's fields. Confinement makes uninstalling the app a clean removal.
 *
 * ---------------------------------------------------------------------------
 * THIS APP'S ONE DECLARED EXCEPTION
 *
 * A two-way app cannot honour the invariant literally: writing an inbound unsubscribe
 * into `$app.mailchimp.*` and nowhere else changes nothing anyone can see. So
 * `functions/lib/account-writeback.ts` writes `email_optin` and `email` on accounts.
 *
 * The exception is *declared*, not tolerated. The structural test at the bottom accepts
 * a writer only if it both carries the `@single-writer-exception` marker AND appears in
 * `DECLARED_EXCEPTIONS` below, and it separately asserts that no file carries the marker
 * without being declared. Adding a second writer therefore takes two deliberate edits and
 * shows up in review, which is the whole point.
 * ===========================================================================
 */

/** The complete set of modules allowed to write outside `$app.<app_id>.*`. */
const DECLARED_EXCEPTIONS = ["lib/account-writeback.ts"];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * `swell.put` is the only method stubbed. Everything else on the mock throws by design,
 * so if `setSyncState` ever grows a read or a second write, this test fails loudly
 * instead of silently passing on `undefined`.
 */
function swellStub() {
  return {
    put: vi.fn(async (_url: string, _body: Record<string, any>) => ({})),
  };
}

describe("single-writer invariant", () => {
  it("writes nothing outside its own $app namespace", async () => {
    const swell = swellStub();
    const req = createMockRequest({ swell, appId: "mailchimp" });

    await setSyncState(req, "orders", "record_1", {
      sync_status: "synced",
      remote_id: "remote_1",
      last_synced_at: "2026-07-01T10:05:00.000Z",
      last_error: null,
    });

    expect(swell.put).toHaveBeenCalledTimes(1);

    // The assertion from INTEGRATION-PLAN §2.5, verbatim. `$app` and nothing else.
    expect(Object.keys(swell.put.mock.calls[0][1])).toEqual(["$app"]);
  });

  it("nests the patch under this app's id and no other", async () => {
    const swell = swellStub();
    const req = createMockRequest({ swell, appId: "mailchimp" });

    await setSyncState(req, "accounts", "record_1", { sync_status: "error" });

    const [url, body] = swell.put.mock.calls[0];

    // Targets the record it was asked to, not a list endpoint or a bulk write.
    expect(url).toContain("record_1");
    expect(url).toContain("/accounts/");

    expect(Object.keys(body.$app)).toEqual(["mailchimp"]);
    expect(body.$app.mailchimp).toMatchObject({ sync_status: "error" });
  });

  it("stamps each of the four collections at its own endpoint", async () => {
    // Multi-collection is the part of this app the starter's single-COLLECTION module
    // could not express. Pin that the collection really does reach the URL.
    for (const collection of ["accounts", "products", "carts", "orders"] as const) {
      const swell = swellStub();
      const req = createMockRequest({ swell, appId: "mailchimp" });

      await setSyncState(req, collection, "rec", { sync_status: "synced" });

      expect(swell.put.mock.calls[0][0]).toBe(`/${collection}/rec`);
      expect(Object.keys(swell.put.mock.calls[0][1])).toEqual(["$app"]);
    }
  });

  it("truncates last_error instead of writing an unbounded string", async () => {
    const swell = swellStub();
    const req = createMockRequest({ swell, appId: "mailchimp" });

    await setSyncState(req, "orders", "record_1", {
      sync_status: "error",
      last_error: "e".repeat(5000),
    });

    const written = swell.put.mock.calls[0][1].$app.mailchimp.last_error as string;

    // A vendor error body can be megabytes. Unbounded, it bloats every record it
    // touches and can push a response past the silent 75 KB drop threshold.
    expect(written.length).toBeLessThanOrEqual(500);
    expect(Object.keys(swell.put.mock.calls[0][1])).toEqual(["$app"]);
  });

  it("wraps only plain objects, and refuses anything else", () => {
    const req = createMockRequest({ swell: swellStub(), appId: "mailchimp" });

    expect(req.appValues({ sync_status: "synced" })).toEqual({
      $app: { mailchimp: { sync_status: "synced" } },
    });

    // Arrays, class instances, null and primitives serialise into shapes the API
    // silently mangles, so the guard rejects them at the call site rather than letting
    // a malformed patch reach the collection. Asserted against `appValues` directly:
    // `setSyncState` spreads its patch into a fresh object, so passing it an array
    // would be normalised into `{}` before the guard ever saw it.
    for (const bad of [[], null, "synced", 42, new Date()]) {
      expect(() => req.appValues(bad as any)).toThrow(/plain object/);
    }
  });

  it("refuses to write when the app id is missing", () => {
    const req = createMockRequest({ swell: swellStub(), appId: "mailchimp" });

    // Without an app id there is no namespace to confine the write to, so the only
    // safe outcome is a hard failure rather than a write to an empty key.
    expect(() => req.appValues("", { sync_status: "synced" })).toThrow(
      /missing app id/,
    );
  });

  it("does not let a failed state write mask the error that prompted it", async () => {
    // `recordSyncState` is the swallow-and-log wrapper (§2.6, layer 2). It is optional
    // in apps that never record state from inside a catch block, so this self-skips.
    const mod: Record<string, any> = await import(
      "../../functions/lib/sync-state"
    );
    if (typeof mod.recordSyncState !== "function") {
      console.warn(
        "Skipping: lib/sync-state.ts does not export recordSyncState().",
      );
      return;
    }

    const swell = {
      put: vi.fn(async () => {
        throw new Error("admin API unavailable");
      }),
    };
    const req = createMockRequest({ swell, appId: "mailchimp" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      mod.recordSyncState(req, "orders", "record_1", { sync_status: "error" }),
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalled();
  });
});

/**
 * The declared exception, held to the contract that makes it safe. If any of these go
 * red, the loop breaker in `functions/accounts-sync.ts` no longer has anything to match
 * on, and every inbound unsubscribe becomes an outbound push.
 */
describe("account write-back (the one declared exception)", () => {
  it("writes only the allow-listed fields, and drops everything else", async () => {
    const swell = swellStub();
    const req = createMockRequest({ swell, appId: "mailchimp" });

    await writeAccountFromWebhook(
      req,
      "acct_1",
      { email_optin: false, name: "attacker", password: "x" } as any,
      { last_webhook_event: "unsubscribe" },
    );

    const body = swell.put.mock.calls[0][1];
    expect(Object.keys(body).sort()).toEqual(["$app", "email_optin"]);
    expect(body.email_optin).toBe(false);
  });

  it("always stamps last_webhook_at in the same write", async () => {
    const swell = swellStub();
    const req = createMockRequest({ swell, appId: "mailchimp" });

    await writeAccountFromWebhook(req, "acct_1", { email_optin: false }, {});

    // THE LOOP BREAKER. `accounts-sync.ts` returns early when this field appears in
    // `$event.data`. A write-back without it re-triggers the push handler.
    expect(swell.put.mock.calls[0][1].$app.mailchimp.last_webhook_at).toBeTruthy();
  });

  it("makes exactly one write, so only one account.updated event carries the marker", async () => {
    const swell = swellStub();
    const req = createMockRequest({ swell, appId: "mailchimp" });

    await writeAccountFromWebhook(
      req,
      "acct_1",
      { email: "new@example.com" },
      { remote_email: "new@example.com" },
    );

    expect(swell.put).toHaveBeenCalledTimes(1);
    expect(swell.put.mock.calls[0][1].email).toBe("new@example.com");
  });
});

/**
 * The structural half of the invariant. The tests above prove the writers behave;
 * this proves nothing *else* writes, which is the part a behavioural test cannot see.
 *
 * STARTER AMENDMENT (Wave 2, Smarty): the scan reads COMMENT-STRIPPED source. Smarty's
 * `lib/verification-state.ts` failed this gate for writing `req.swell.put()` inside a
 * comment explaining why it never calls `req.swell.put()`. Scanning raw text means prose
 * cannot quote the pattern it hunts, and the workarounds — vaguer wording, a bogus entry in
 * the exception list, a weakened regex — are all worse than the bug. See
 * `test/helpers/source-scan.ts`.
 *
 * The individual scans self-skip if the sources cannot be read as raw text — they are a
 * bonus, not the primary guarantee, and must never fail for environmental reasons. The
 * non-vacuity tests are the exception: they are what stop a silently-empty glob, or a regex
 * that stopped matching, from turning every scan green while checking nothing.
 */
describe("single-writer invariant (structural)", () => {
  // `import.meta.glob` is a Vite compile-time transform, not a runtime function: it
  // is only rewritten when written as a literal call with literal arguments. Reading
  // it indirectly (`const g = import.meta.glob`) leaves it undefined at runtime.
  // The `@ts-ignore` is because `vite/client` types are deliberately not in
  // test/tsconfig.json's `types` array — adding them would pull DOM lib into a
  // Workers project.
  // @ts-ignore - Vite-only, see above
  const sources: Record<string, string> = import.meta.glob(
    "../../functions/**/*.ts",
    { eager: true, query: "?raw", import: "default" },
  );

  /** Every function source with its comments removed, as `[path, code]` pairs. */
  const scanned = strippedSources(sources);

  /** Must match the marker comment in every declared exception module, verbatim. */
  const MARKER = "@single-writer-exception";

  /**
   * `swell.put(...)` / `swell.delete(...)` on anything. Reads and `swell.post` to a
   * non-collection endpoint are fine; mutating an existing record is not.
   */
  const MUTATION = /\bswell\s*\.\s*(put|delete)\s*\(/;

  /**
   * Its only job is to stop the scans below from passing vacuously: they are all filters
   * over `scanned`, so if the glob ever stops matching — a moved directory, a Vite change,
   * a `functions/` renamed — every one of them goes green while checking nothing, and the
   * fleet's central safety gate becomes decorative without a single test turning red.
   */
  const MINIMUM_SOURCES = 10;

  it("resolves the function sources at all", () => {
    expect(
      scanned.length,
      "The functions/**/*.ts glob resolved nothing, so every structural scan in this file " +
        "would pass without reading a line of source. Fix the glob rather than the count.",
    ).toBeGreaterThanOrEqual(MINIMUM_SOURCES);
  });

  it("flags real calls and ignores the same names in prose", () => {
    // The other half of non-vacuity: proving the scan can still fail. A regex that stopped
    // matching, or a comment stripper that ate the code instead of the comments, produces
    // exactly the same all-green run as an empty glob.
    const code = stripComments(SCANNER_CONTROL.code);
    expect(MUTATION.test(code), "the mutation scan no longer matches a real write").toBe(true);
    expect(code).toContain("https://api.example.test");

    const prose = stripComments(SCANNER_CONTROL.prose);
    expect(
      MUTATION.test(prose),
      "the mutation scan matched a commented-out mention, which is the Smarty bug.",
    ).toBe(false);
  });

  it("routes every collection write through lib/sync-state.ts", () => {
    if (scanned.length === 0) {
      console.warn("Skipping: no function sources were resolved by the glob.");
      return;
    }

    const offenders = scanned
      .filter(([file]) => !file.endsWith("lib/sync-state.ts"))
      .filter(([file]) => !DECLARED_EXCEPTIONS.some((a) => file.endsWith(a)))
      .filter(([, code]) => MUTATION.test(code))
      .map(([file]) => file);

    expect(
      offenders,
      "These modules write to a collection directly. Route the write through " +
        "lib/sync-state.ts so it is confined to $app.<app_id>.* — see " +
        "INTEGRATION-PLAN §2.5. If a write outside $app is genuinely required, add the " +
        `${MARKER} marker to the module AND declare it in DECLARED_EXCEPTIONS at the top ` +
        "of this file. Do not add the path to this filter.",
    ).toEqual([]);
  });

  it("has no undeclared exception markers, and no declared file missing its marker", () => {
    const paths = Object.keys(sources ?? {});
    if (paths.length === 0) {
      console.warn("Skipping: no function sources were resolved by the glob.");
      return;
    }

    // Scanned raw, NOT comment-stripped: the marker *is* a comment. This is the one place
    // the raw text is the right input, and it is why `sources` is still in scope.
    const marked = paths.filter((file) => {
      // `lib/sync-state.ts` documents this whole mechanism in its own header, so it may
      // contain the marker string as prose. It is the single writer — definitionally not
      // an exception to itself — and it is already skipped by the scan above.
      if (file.endsWith("lib/sync-state.ts")) return false;
      return (sources[file] ?? "").includes(MARKER);
    });

    // Direction 1: a file that carries the marker but is not declared here would be a
    // writer that granted itself permission. The list is the review surface, so the list
    // has to be complete.
    for (const file of marked) {
      expect(
        DECLARED_EXCEPTIONS.some((allowed) => file.endsWith(allowed)),
        `${file} carries ${MARKER} but is not in DECLARED_EXCEPTIONS.`,
      ).toBe(true);
    }

    // Direction 2: a declared file whose marker was deleted or renamed. Without this, the
    // declaration alone would keep waving the module through the scan above long after the
    // source stopped documenting why.
    for (const declared of DECLARED_EXCEPTIONS) {
      expect(
        marked.some((file) => file.endsWith(declared)),
        `${declared} is declared as an exception but does not carry the ${MARKER} marker.`,
      ).toBe(true);
    }
  });
});
