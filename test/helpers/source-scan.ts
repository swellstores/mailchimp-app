/**
 * Raw-source scanning for the structural half of the single-writer gate.
 *
 * ---------------------------------------------------------------------------------
 * WHY THIS EXISTS — STARTER AMENDMENT (Wave 2, Smarty).
 *
 * The structural scan greps raw source for `swell.put(`, `swell.post(`, `appValues(` and
 * friends. Raw source includes comments, so **prose cannot quote the pattern it hunts**.
 * Smarty's `lib/verification-state.ts` failed its own gate for writing `req.swell.put()`
 * inside an explanatory comment about why it does not call `req.swell.put()`. The author's
 * options were then all bad: reword the comment into something vaguer, add the file to the
 * exception list (the exact "looks like housekeeping in a diff" edit the mechanism exists to
 * prevent), or weaken the regex.
 *
 * The real fix is to scan code, not text. Strip comments first, and the documentation is
 * free to be as explicit as it likes about the thing it is documenting — which is precisely
 * where these modules most need to be explicit.
 *
 * The stripper deliberately does NOT strip string literals. A `swell.put` inside a string is
 * far more likely to be a dynamically-built call or a URL template than prose, and a scan
 * that ignored strings would have a hole you could drive a writer through.
 * ---------------------------------------------------------------------------------
 */

/**
 * A `/` opens a regex literal, rather than dividing, only after one of these. `)` and `]`
 * are deliberately absent: `(a + b) / 2` and `xs[0] / 2` are division, and treating them as
 * regexes would swallow the rest of the line.
 */
const REGEX_AFTER_PUNCTUATION = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
  "<",
  ">",
]);

/** ...or after one of these keywords, where the preceding character is a word character. */
const REGEX_AFTER_KEYWORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

/** The trailing identifier already emitted, for the keyword test above. */
function trailingWord(out: string): string {
  let end = out.length;
  while (end > 0 && /\s/.test(out[end - 1])) end -= 1;
  let start = end;
  while (start > 0 && /[A-Za-z0-9_$]/.test(out[start - 1])) start -= 1;
  return out.slice(start, end);
}

function lastSignificant(out: string): string {
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (!/\s/.test(out[i])) return out[i];
  }
  return "";
}

function opensRegex(out: string): boolean {
  const previous = lastSignificant(out);
  if (REGEX_AFTER_PUNCTUATION.has(previous)) return true;
  if (/[A-Za-z0-9_$]/.test(previous)) {
    return REGEX_AFTER_KEYWORD.has(trailingWord(out));
  }
  return false;
}

type Frame = { type: "code"; braces: number } | { type: "template" };

/**
 * Removes `//` and block comments, leaving everything else — including string and template
 * literals and regex literals — byte-identical. Newlines inside a stripped block comment are
 * preserved so line numbers in any reported offset still line up.
 *
 * Correctness matters more here than tidiness: over-stripping would delete real code and
 * open a silent hole in the fleet's central safety gate, so string, template (including
 * nested `${...}`) and regex literals are all tracked rather than approximated.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  const frames: Frame[] = [{ type: "code", braces: 0 }];

  while (i < n) {
    const frame = frames[frames.length - 1];
    const ch = source[i];
    const next = source[i + 1];

    if (frame.type === "template") {
      if (ch === "\\") {
        out += ch + (next ?? "");
        i += 2;
        continue;
      }
      if (ch === "`") {
        out += ch;
        i += 1;
        frames.pop();
        continue;
      }
      if (ch === "$" && next === "{") {
        out += "${";
        i += 2;
        frames.push({ type: "code", braces: 0 });
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      out += ch;
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        const closed = source[i] === ch || source[i] === "\n";
        i += 1;
        if (closed) break;
      }
      continue;
    }

    if (ch === "`") {
      out += ch;
      i += 1;
      frames.push({ type: "template" });
      continue;
    }

    if (ch === "{") {
      frame.braces += 1;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "}") {
      if (frame.braces === 0 && frames.length > 1) {
        frames.pop();
      } else {
        frame.braces -= 1;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && opensRegex(out)) {
      out += ch;
      i += 1;
      let inClass = false;
      while (i < n) {
        const c = source[i];
        if (c === "\\") {
          out += c + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (c === "\n") break;
        out += c;
        i += 1;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * `import.meta.glob(..., { query: '?raw' })` output, comment-stripped, as entries.
 *
 * The glob itself has to stay a literal call in the file that uses it — it is a Vite
 * compile-time transform, not a runtime function — so it is passed in rather than done here.
 */
export function strippedSources(
  sources: Record<string, string> | undefined,
): Array<[string, string]> {
  return Object.entries(sources ?? {}).map(([file, source]) => [
    file,
    stripComments(source ?? ""),
  ]);
}

/**
 * A synthetic module carrying every pattern the structural scans hunt for, once as real code
 * and once as prose. Used as a positive control: a scan that does not flag the code half is
 * broken, and one that flags the prose half is the Smarty bug coming back.
 *
 * Kept here rather than inline in the test so both shape variants share one control.
 */
export const SCANNER_CONTROL = {
  /** Real calls. Every structural scan must flag this. */
  code: [
    "const url = 'https://api.example.test/x'; // trailing comment",
    "const re = /https?:\\/\\//;",
    "const label = `a ${count > 1 ? `many//not-a-comment` : 'one'} b`;",
    "await req.swell.put(`/orders/${id}`, req.appValues({ ok: true }));",
    "await req.swell.post('/orders', {});",
    "await req.swell.delete('/orders/1');",
    "await req.swell.transaction('/orders/1', {});",
  ].join("\n"),

  /** The same names, in comments only. No scan may flag this. */
  prose: [
    "/**",
    " * This module never calls req.swell.put() or req.swell.delete(), and it does not",
    " * reach for req.appValues() either. It also avoids swell.post( and swell.transaction(.",
    " */",
    "// Deliberately no swell.put( here.",
    "export const NOTES = 'see the header';",
  ].join("\n"),
};
