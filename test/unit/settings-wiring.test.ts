import { describe, expect, it } from "vitest";
import settingsSchema from "../../settings/mailchimp.json";
import { getSettings, resolveApiBase } from "../../functions/lib/settings";
import { createMockRequest } from "../helpers/mock-request";
import { strippedSources } from "../helpers/source-scan";

/**
 * ===========================================================================
 * THE SETTINGS FILE AND THE CODE MUST AGREE, IN BOTH DIRECTIONS.
 *
 * STARTER AMENDMENT (Wave 2). About forty lines, and it catches a whole class of bug that
 * nothing else in the suite can see, because both halves are individually valid:
 *
 *   1. A field the code reads with no toggle in `settings/mailchimp.json`. The merchant
 *      sees no control at all, and the behaviour is pinned to whatever the code's fallback
 *      is with no way to tell which. `app_object_id` - added in this reconciliation - is
 *      exactly that shape, which is why this test arrives with it.
 *   2. A toggle in the settings UI that no code reads. The merchant flips it, the dashboard
 *      saves it, and nothing happens. This is the one a one-way check misses: "every field
 *      the code reads has a toggle" passes happily while an orphan sits in the UI doing
 *      nothing, and it will be reported as a bug months later by someone who trusted it.
 *   3. A `default` in the settings file that disagrees with the code's fallback. The UI
 *      shows one state and the app behaves as the other. The worst kind of settings bug,
 *      because nothing errors and both sides look right in isolation.
 *
 * All three are caught by reading `settings/mailchimp.json` as DATA rather than by
 * restating its contents here. A test that hardcodes the field list is a third thing to
 * keep in step, and it drifts like the other two.
 *
 * This app needs no `readFieldIds()` fan-out: every key `getSettings()` returns maps to a
 * settings-file id of the same name, including the four `sync_<collection>` toggles, which
 * are flat here rather than folded into a `collections` record.
 *
 * House rule, kept here too: ASCII-only in `describe()` and `it()` titles.
 * ===========================================================================
 */

interface SettingsField {
  id?: string;
  type?: string;
  default?: unknown;
  fields?: SettingsField[];
}

/**
 * Every leaf field, flattened out of its `field_group`s. A group flattens to the parent
 * level at runtime, so a nested id is reachable at `settings.mailchimp.<id>` exactly as a
 * top-level one is — which is why nesting is irrelevant to every assertion below.
 */
function flatten(fields: SettingsField[] | undefined): SettingsField[] {
  const out: SettingsField[] = [];
  for (const field of fields ?? []) {
    if (Array.isArray(field.fields)) out.push(...flatten(field.fields));
    else if (field.id) out.push(field);
  }
  return out;
}

const DECLARED = flatten((settingsSchema as { fields?: SettingsField[] }).fields);
const BY_ID = new Map(DECLARED.map((field) => [field.id as string, field]));

// `import.meta.glob` is a Vite compile-time transform, not a runtime function: it is only
// rewritten when written as a literal call with literal arguments.
// @ts-ignore - Vite-only, see above
const sources: Record<string, string> = import.meta.glob(
  "../../functions/**/*.ts",
  { eager: true, query: "?raw", import: "default" },
);

/** Every function source, comments removed. See `test/helpers/source-scan.ts`. */
const SOURCES = strippedSources(sources);

/** The fully-defaulted settings object, as a handler sees it before anything is configured. */
async function resolveSettings() {
  return getSettings(
    createMockRequest({ swell: { settings: async () => ({}) } }),
  );
}

describe("settings file and code agreement", () => {
  it("declares a settings field for everything the code reads", async () => {
    const read = await resolveSettings();

    const missing = Object.keys(read).filter((id) => !BY_ID.has(id));

    expect(
      missing,
      "getSettings() reads these, but settings/mailchimp.json declares no field for them, " +
        "so a merchant has no control over any of them and the behaviour is pinned to the " +
        "code's fallback with nothing in the UI to say so.",
    ).toEqual([]);
  });

  it("has no settings field that nothing reads", async () => {
    // The direction a one-way check misses. An orphaned toggle is a switch in the merchant's
    // settings UI that changes nothing.
    const read = await resolveSettings();

    const orphans = [...BY_ID.keys()].filter((id) => {
      if (id in read) return false;
      // The house pattern makes lib/settings.ts the single reader, but a field consumed
      // somewhere else still counts as read. Two deliberate narrowings: the sources are
      // comment-stripped, so a field mentioned only in prose is still an orphan; and the id
      // has to appear as a property access (`raw.foo`) or a quoted key (`'foo'`), so a
      // local variable that happens to share the name does not wave it through.
      const escaped = id.replace(/[^\w$]/g, "\\$&");
      const mention = new RegExp(`\\.${escaped}\\b|(['"\`])${escaped}\\1`);
      return !SOURCES.some(([, code]) => mention.test(code));
    });

    expect(
      orphans,
      "These fields are in settings/mailchimp.json but nothing in functions/ reads them. " +
        "Either wire them into lib/settings.ts or delete them - a toggle a merchant can " +
        "flip that drives nothing is worse than no toggle.",
    ).toEqual([]);
  });

  it("mirrors every declared default into the value the code falls back to", async () => {
    // `getSettings()` returns the fallback when the merchant has never touched the field;
    // the settings UI shows `default`. If they disagree the app behaves one way and the
    // dashboard claims another. Fields with no declared `default` are skipped: the settings
    // schema leaves text fields undefined and the code coerces them to "".
    const read = (await resolveSettings()) as unknown as Record<string, unknown>;

    let compared = 0;
    for (const [id, field] of BY_ID) {
      if (!("default" in field)) continue;
      if (!(id in read)) continue;
      expect(read[id], `default for "${id}"`).toEqual(field.default);
      compared += 1;
    }

    // Non-vacuity. Both `continue`s above are filters, so a settings file that stopped
    // declaring defaults - or a getSettings() that stopped resolving ids - would make this
    // test pass without comparing anything.
    expect(compared, "no declared default was compared against anything").toBeGreaterThan(0);
  });

  it("keeps every settings field id unique", () => {
    // Two fields with one id is accepted by the schema validator and silently resolves to
    // whichever the dashboard wrote last.
    const ids = DECLARED.map((field) => field.id);
    expect(new Set(ids).size, `duplicate id in settings/mailchimp.json`).toBe(ids.length);
  });

  it("resolves the function sources at all", () => {
    // The orphan scan above is a filter over SOURCES, so a glob that stopped matching would
    // turn it green while reading nothing.
    expect(SOURCES.length).toBeGreaterThanOrEqual(3);
  });

  it("reads the settings under the filename namespace, not the app id", async () => {
    // Settings are namespaced by the settings FILENAME. It is usually the same string as
    // the app id, which is exactly why this is easy to get wrong on the day they diverge.
    const req = createMockRequest({
      swell: { settings: async () => ({ mailchimp: { enabled: true } }) },
      appId: "some-other-app-id",
    });

    expect((await getSettings(req)).enabled).toBe(true);
  });
});

describe("resolveApiBase override validation", () => {
  const key = { api_key: "abc-us14" };
  it("derives the datacenter host when no override is set", () => {
    expect(resolveApiBase(key)).toBe("https://us14.api.mailchimp.com/3.0");
  });
  it("accepts a well-formed mailchimp https override", () => {
    expect(resolveApiBase({ ...key, api_base: "https://us7.api.mailchimp.com/3.0/" })).toBe(
      "https://us7.api.mailchimp.com/3.0",
    );
  });
  it("rejects http, which would put the API key on the wire as Basic auth", () => {
    expect(resolveApiBase({ ...key, api_base: "http://us7.api.mailchimp.com/3.0" })).toBeNull();
  });
  it("rejects a bare hostname, which would resolve against the worker origin", () => {
    expect(resolveApiBase({ ...key, api_base: "us7.api.mailchimp.com" })).toBeNull();
  });
  it("allows a non-mailchimp https host, so a mock or local proxy still works", () => {
    // Deliberate: a hostname allow-list would block a supported development workflow to buy
    // very little, since only an admin can set this and they can already read the API key.
    expect(resolveApiBase({ ...key, api_base: "https://mock.test/3.0" })).toBe(
      "https://mock.test/3.0",
    );
  });
  it("strips credentials, query and fragment from the authority", () => {
    expect(
      resolveApiBase({ ...key, api_base: "https://u:p@us7.api.mailchimp.com/3.0?x=1#f" }),
    ).toBe("https://us7.api.mailchimp.com/3.0");
  });
});
