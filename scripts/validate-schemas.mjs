#!/usr/bin/env node
/**
 * validate-schemas.mjs — Gate 3 schema validation.
 *
 * ---------------------------------------------------------------------------------
 * WHY THIS SCRIPT EXISTS
 *
 * `swell schema <type> <file>` — the CLI's own documented way to validate a config file
 * — is broken in CLI 2.9.7. Every invocation fails with:
 *
 *     Error: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
 *
 * ...and, worse, still exits 0, so a naive `npm run validate` wired to the CLI would go
 * green while validating nothing. The failure was reproduced against a known-good
 * reference file that the same CLI had just scaffolded, which rules out the manifest:
 * the CLI ships the 2020-12 meta-schema as a `$ref` but never registers it with its own
 * validator.
 *
 * What still works is `--format=json-schema-bundle`, which emits the same schema with
 * every `$ref` resolved. So: pull the bundle from the CLI (always current — this script
 * never vendors a stale copy of the schema) and validate against it with ajv, which
 * does understand 2020-12.
 *
 * Delete this script the day `swell schema <type> <file>` works. Until then it is the
 * only real validation the fleet has. Re-check on each CLI upgrade.
 * ---------------------------------------------------------------------------------
 *
 * Usage:
 *   node scripts/validate-schemas.mjs              # every type
 *   node scripts/validate-schemas.mjs model content # named types only
 *
 * Exit code 0 if everything validated, 1 if anything failed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ajvModule from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv and ajv-formats are CJS; both ship their real export on `.default` under ESM
// interop, but the shape differs between them and between bundler resolutions.
const Ajv2020 = ajvModule.Ajv2020 ?? ajvModule.default ?? ajvModule;
const addFormats = addFormatsModule.default ?? addFormatsModule;

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Type → directory mapping, taken from `swell schema` with no arguments (it prints the
 * glob it expects for each type). Non-recursive on purpose: `functions/lib/**` is shared
 * code and is not a function resource.
 */
const SCHEMA_TYPES = [
  { type: "setting", dir: "settings", ext: ".json" },
  { type: "model", dir: "models", ext: ".json" },
  { type: "content", dir: "content", ext: ".json" },
  { type: "notification", dir: "notifications", ext: ".json" },
  { type: "webhook", dir: "webhooks", ext: ".json" },
  // `function` resources are TypeScript, and the CLI has no JSON Schema for them at all
  // (`swell schema function --format=json-schema-bundle` errors with
  // "'function' does not have a JSON Schema"). Their `export const config` block is
  // covered by `npm run typecheck` against @swell/app-types instead. Listed here so the
  // output says so explicitly rather than leaving a silent hole in the gate.
  { type: "function", dir: "functions", ext: ".ts", noJsonSchema: true },
];

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `[${code}m${text}[0m` : text);
const green = (t) => paint("32", t);
const red = (t) => paint("31", t);
const yellow = (t) => paint("33", t);
const dim = (t) => paint("2", t);
const bold = (t) => paint("1", t);

// ---------------------------------------------------------------------------
// Schema loading
// ---------------------------------------------------------------------------

function loadBundledSchema(type) {
  let raw;
  try {
    raw = execFileSync(
      "swell",
      ["schema", type, "--format=json-schema-bundle", "-y"],
      { cwd: APP_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(
        "`swell` is not on PATH. Install the CLI: npm i -g @swell/cli",
      );
    }
    const detail = String(err?.stderr || err?.stdout || err?.message || err).trim();
    throw new Error(`\`swell schema ${type}\` failed: ${detail}`);
  }

  // The CLI prints some errors to stdout and exits 0, so a parse failure here is more
  // likely an error message than malformed JSON. Surface the text either way.
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `\`swell schema ${type}\` did not return JSON. It printed:\n${raw.trim().slice(0, 500)}`,
    );
  }
}

function compile(schema, type) {
  // `strict: false` because the Swell bundles use keyword combinations ajv's strict mode
  // rejects (unknown annotations, `const` inside `allOf`). Strict mode would fail to
  // compile the schema at all, which is a tooling complaint, not a config error.
  const ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
  // `date-time`, `uri`, `email` etc. appear throughout the Swell schemas and are no-ops
  // without this — silently passing anything.
  addFormats(ajv);
  try {
    return ajv.compile(schema);
  } catch (err) {
    throw new Error(
      `Could not compile the ${type} schema returned by the CLI: ${err?.message ?? err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Error reporting
// ---------------------------------------------------------------------------

/**
 * ajv with `allErrors` emits one error per failed `anyOf`/`oneOf` branch, which for a
 * single bad field type can be forty near-identical lines. Group by location and
 * collapse const/enum branches into one "must be one of" line.
 */
function summarize(errors, limit = 10) {
  const groups = new Map();

  for (const error of errors ?? []) {
    // The parent anyOf/oneOf/allOf error adds nothing the branch errors do not say.
    if (["anyOf", "oneOf", "allOf", "if"].includes(error.keyword)) continue;

    const location = error.instancePath || "(root)";
    if (!groups.has(location)) {
      groups.set(location, { allowed: new Set(), messages: new Set() });
    }
    const group = groups.get(location);

    switch (error.keyword) {
      case "const":
        group.allowed.add(JSON.stringify(error.params.allowedValue));
        break;
      case "enum":
        for (const value of error.params.allowedValues ?? []) {
          group.allowed.add(JSON.stringify(value));
        }
        break;
      case "additionalProperties":
        group.messages.add(
          `unknown property "${error.params.additionalProperty}"`,
        );
        break;
      case "required":
        group.messages.add(
          `missing required property "${error.params.missingProperty}"`,
        );
        break;
      default:
        group.messages.add(error.message ?? error.keyword);
    }
  }

  const lines = [];
  for (const [location, group] of groups) {
    const parts = [...group.messages];
    if (group.allowed.size > 0) {
      parts.push(`must be one of: ${[...group.allowed].join(", ")}`);
    }
    if (parts.length === 0) continue;
    lines.push(`${location} — ${parts.join("; ")}`);
  }

  // Belt and braces: never report a failure with no explanation.
  if (lines.length === 0 && (errors ?? []).length > 0) {
    for (const error of errors.slice(0, limit)) {
      lines.push(`${error.instancePath || "(root)"} — ${error.message}`);
    }
  }

  const shown = lines.slice(0, limit);
  if (lines.length > limit) {
    shown.push(`… and ${lines.length - limit} more`);
  }
  return shown;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function listFiles(dir, ext) {
  const full = path.join(APP_ROOT, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(ext))
    .map((entry) => entry.name)
    .sort();
}

function main() {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const selected = requested.length
    ? SCHEMA_TYPES.filter((entry) => requested.includes(entry.type))
    : SCHEMA_TYPES;

  if (requested.length && selected.length !== requested.length) {
    const known = SCHEMA_TYPES.map((entry) => entry.type).join(", ");
    console.error(red(`Unknown schema type. Known types: ${known}`));
    process.exit(1);
  }

  console.log(bold("Validating app config against Swell schemas"));
  console.log(dim(`  app:  ${APP_ROOT}`));
  console.log(
    dim("  via:  swell schema <type> --format=json-schema-bundle + ajv (2020-12)"),
  );
  console.log(
    dim("        `swell schema <type> <file>` is broken in CLI 2.9.7 — see header."),
  );
  console.log("");

  let failures = 0;
  let passes = 0;
  let checked = 0;

  for (const { type, dir, ext, noJsonSchema } of selected) {
    const files = listFiles(dir, ext);

    if (files.length === 0) {
      console.log(`${dim("○")} ${bold(type)} ${dim(`— no ${dir}/*${ext} files`)}`);
      continue;
    }

    if (noJsonSchema) {
      console.log(
        `${yellow("○")} ${bold(type)} ${dim(
          `— ${files.length} file(s); the CLI publishes no JSON Schema for this type.`,
        )}`,
      );
      console.log(
        dim(
          "    `export const config` is validated by `npm run typecheck` against @swell/app-types.",
        ),
      );
      continue;
    }

    let validate;
    try {
      validate = compile(loadBundledSchema(type), type);
    } catch (err) {
      console.log(`${red("✗")} ${bold(type)} ${red(err.message)}`);
      failures += files.length;
      checked += files.length;
      continue;
    }

    console.log(bold(type));

    for (const file of files) {
      const relative = `${dir}/${file}`;
      checked += 1;

      let data;
      try {
        // Strip a BOM: JSON.parse rejects it and the resulting message is opaque.
        data = JSON.parse(
          readFileSync(path.join(APP_ROOT, dir, file), "utf8").replace(/^﻿/, ""),
        );
      } catch (err) {
        failures += 1;
        console.log(`  ${red("✗")} ${relative}`);
        console.log(`      ${red(`not valid JSON: ${err.message}`)}`);
        continue;
      }

      if (validate(data)) {
        passes += 1;
        console.log(`  ${green("✓")} ${relative}`);
        continue;
      }

      failures += 1;
      console.log(`  ${red("✗")} ${relative}`);
      for (const line of summarize(validate.errors)) {
        console.log(`      ${red(line)}`);
      }
    }
  }

  console.log("");

  if (checked === 0) {
    console.log(yellow("Nothing to validate."));
    return 0;
  }

  if (failures > 0) {
    console.log(
      red(bold(`${failures} file(s) failed validation`)) +
        dim(`, ${passes} passed`),
    );
    return 1;
  }

  console.log(green(bold(`All ${passes} file(s) valid.`)));
  return 0;
}

process.exit(main());
