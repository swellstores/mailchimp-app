import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Tests run on the Cloudflare Workers pool because Swell functions run in a Workers
 * isolate: `fetch`, `Response`, `btoa`, no Node builtins. Running them under Node would
 * let code pass here and fail in production.
 *
 * Pin `@cloudflare/vitest-pool-workers` to `~0.12.0`. `latest` requires vitest ^4.1 and
 * no longer exports `./config`, so `defineWorkersConfig` cannot be imported at all.
 * `swell create tests` scaffolds an unusable pair of pins — do not take them.
 */

type SdkAuth = {
  storeId: string;
  sessionId: string;
  apiBaseUrl: string;
};

const isCI = Boolean(process.env.CI || process.env.CONTINUOUS_INTEGRATION);

/**
 * Resolves admin-API credentials for the integration tests, in strict precedence:
 *
 *   1. `SWELL_STORE_ID` + `SWELL_SESSION_ID` env vars — the only path CI should use.
 *   2. If `CI` is set and those are missing, fail hard. Silently falling through to a
 *      developer config that does not exist in CI produces a confusing "config not
 *      found" error instead of "you forgot the secrets".
 *   3. Locally, the `swell login` session in `~/.swell/config.json`: `defaultStore`
 *      plus the matching entry in `stores[]`.
 *
 * `~/.swell/env.json` may override the API base URL (used when pointing tests at a
 * non-production Swell environment); `${STORE_ID}` in it is substituted.
 *
 * This runs in Node at config time, not in the isolate — which is why credentials reach
 * the tests as Miniflare bindings rather than being read from disk by the helpers.
 */
function loadSwellAuth(): SdkAuth {
  const envStoreId = process.env.SWELL_STORE_ID;
  const envSessionId = process.env.SWELL_SESSION_ID;
  const envApiBaseUrl = process.env.SWELL_API_BASE_URL;

  if (envStoreId && envSessionId) {
    return {
      storeId: envStoreId,
      sessionId: envSessionId,
      apiBaseUrl: envApiBaseUrl || `https://${envStoreId}.swell.store/admin/api`,
    };
  }

  if (isCI) {
    throw new Error(
      "CI environment detected but SWELL_STORE_ID and SWELL_SESSION_ID are not set. " +
        "Add these as CI secrets/variables to run integration tests.",
    );
  }

  const home = homedir();
  const configPath = path.resolve(home, ".swell", "config.json");
  if (!existsSync(configPath)) {
    throw new Error(
      `Swell CLI config not found at ${configPath}. Run \`swell login\` or set SWELL_STORE_ID and SWELL_SESSION_ID.`,
    );
  }

  const rawConfig = readFileSync(configPath, "utf-8");

  interface CliConfig {
    defaultStore?: string;
    stores?: { storeId: string; sessionId?: string }[];
  }

  let configJson: CliConfig;

  try {
    configJson = JSON.parse(rawConfig) as CliConfig;
  } catch (error) {
    throw new Error(
      `Unable to parse Swell CLI config at ${configPath}: ${String(error)}`,
    );
  }

  const defaultStore = configJson.defaultStore;
  const stores = configJson.stores || [];

  const store = defaultStore
    ? stores.find((item) => item.storeId === defaultStore)
    : undefined;

  if (!defaultStore || !store?.sessionId) {
    throw new Error(
      "No active Swell CLI session found. Run `swell login` or set SWELL_STORE_ID and SWELL_SESSION_ID.",
    );
  }

  const envPath = path.join(home, ".swell", "env.json");
  let apiBaseUrl = `https://${defaultStore}.swell.store/admin/api`;

  if (existsSync(envPath)) {
    try {
      const rawEnv = readFileSync(envPath, "utf-8");
      const envJson = JSON.parse(rawEnv) as { ADMIN_API_BASE_URL?: string };
      if (envJson.ADMIN_API_BASE_URL) {
        apiBaseUrl = envJson.ADMIN_API_BASE_URL.replace(
          "${STORE_ID}",
          defaultStore,
        );
      }
    } catch {
      // Ignore env parsing errors and fall back to the default host.
    }
  }

  return {
    storeId: defaultStore,
    sessionId: store.sessionId!,
    apiBaseUrl,
  };
}

const sdkAuth = loadSwellAuth();

export default defineWorkersConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "docs"],
    // Defines SwellError, SwellRejection and SwellResponse. Without it, any function
    // returning a SwellResponse dies with `SwellResponse is not defined`.
    setupFiles: ["./test/setup-globals.ts"],
    poolOptions: {
      workers: {
        // One worker, so integration tests hitting the same store cannot race each
        // other. It also makes the shared-runtime caveat explicit: because every test
        // file runs in this single isolate, a stubbed global leaks across files unless
        // each file restores it in `afterEach`. See the example tests.
        singleWorker: true,
        isolatedStorage: true,
        miniflare: {
          bindings: {
            SWELL_STORE_ID: sdkAuth.storeId,
            SWELL_SESSION_ID: sdkAuth.sessionId,
            SWELL_API_BASE_URL: sdkAuth.apiBaseUrl,
            // Substituted by generate.mjs. Must match `id` in swell.json.
            SWELL_APP_ID: "mailchimp",
            SWELL_ENVIRONMENT: "test",
          },
        },
      },
    },
  },
});
