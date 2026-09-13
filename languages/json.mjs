// JSON, in JavaScript: the twin of fig's compiled `json` format — the
// strict dialect, RFC 8259 — row for row.
//
// `fig lang check js-json --against json <files…>` holds this module to the
// compiled parser's node table on every file given, and this module is
// written against `fig lang table -i json`, which prints that table. What
// the compiled format accepts is stated in fig's `src/languages/json/`, and
// this follows it:
//
//   * a document is one value, whitespace (space, tab, `\n`, `\r`) around
//     it, a byte-order mark before it; nothing may follow;
//   * a value is `null`, `true`, `false`, a number, a string, `[...]` or
//     `{...}`; the containers take `,` between elements and no trailing
//     comma; an object's key is a string;
//   * a number is `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?` — a
//     leading zero is refused with its own message — and its kind is
//     `float` when it has a fraction or an exponent, `int` otherwise; the
//     lexeme is kept verbatim as the row's text;
//   * a string decodes `\" \\ \/ \b \f \n \r \t` and `\uXXXX`, a surrogate
//     pair as one character; a string with an unpaired surrogate escape is
//     kept as written, every escape in it undecoded; a raw control
//     character inside, a newline among them, is refused;
//   * a repeated key keeps both entries, as the compiled parser does (it
//     warns; a warning has no row).
//
// Strict JSON has no comments, so the comment table is always empty and
// `syntax.comments` names no delimiter: the comment ops refuse rather than
// write a `//` that the dialect could not read back. Spans are byte
// offsets, 0-based, `[start, end)`; a container's span includes its
// brackets and a string's its quotes.
//
// This is the same object `@diaryx/fig`'s `registerLanguage` takes, so it
// serves the browser and Node unchanged.
import * as fig from "fig";
import * as G from "fig/grammar";

// ── errors, as the compiled parser words them ─────────────────────────────
// Nearly everything is `UnexpectedToken`: the compiled tokenizer runs first
// and its refusals are what a document meets, so the parser's more specific
// messages (a missing colon, an unquoted key) are not reached.

const MESSAGES = {
  UnexpectedToken: "unexpected token here; check for a missing comma, colon, key, or closing bracket/brace",
  UnexpectedEndOfInput: "the document ended before this value/token was complete",
  UnclosedString: "unclosed string; a JSON string cannot span multiple lines — add the closing quote, or escape the newline as `\\n`",
  LeadingZero: "a number cannot have a leading zero; write the digits without the padding, or quote it as a string to keep the padding (e.g. a zip code)",
};

// ── scalars ───────────────────────────────────────────────────────────────

const SIMPLE_ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const HEX4 = /^[0-9a-fA-F]{4}$/;

// A string. Scanned by hand rather than with `G.quoted`, because a `\u`
// escape is not a fixed replacement and a raw control character is a
// refusal, not a byte. The scan runs over bytes (`sc.bin`), so every
// offset is the wire's; the text is decoded from the bytes it covers.
function stringValue(sc) {
  const s = sc.pos;
  if (sc.byte() !== 34) return null;
  const { bin, n } = sc;
  const parts = [];
  let raw = false;
  let i = s + 1;
  let from = i; // where the pending run of plain bytes begins
  for (;;) {
    if (i >= n) sc.fail(MESSAGES.UnclosedString, n);
    const c = bin.charCodeAt(i);
    if (c === 34) {
      parts.push(sc.slice(from, i));
      i += 1;
      break;
    } else if (c === 92) {
      parts.push(sc.slice(from, i));
      const e = bin[i + 1];
      if (e === "u") {
        const hex = bin.slice(i + 2, i + 6);
        if (!HEX4.test(hex)) {
          const bad = hex.search(/[^0-9a-fA-F]/);
          const at = i + 2 + (bad < 0 ? hex.length : bad);
          if (at >= n) sc.fail(MESSAGES.UnclosedString, n);
          sc.fail(MESSAGES.UnexpectedToken, at);
        }
        const cp = parseInt(hex, 16);
        if (cp >= 0xd800 && cp <= 0xdbff && bin.slice(i + 6, i + 8) === "\\u") {
          const lo = bin.slice(i + 8, i + 12);
          const lcp = HEX4.test(lo) ? parseInt(lo, 16) : -1;
          if (lcp >= 0xdc00 && lcp <= 0xdfff) {
            parts.push(String.fromCodePoint(0x10000 + ((cp - 0xd800) << 10) + (lcp - 0xdc00)));
            i += 12;
            from = i;
            continue;
          }
        }
        // Unpaired: the compiled parser gives up decoding and keeps the
        // whole string as written.
        if (cp >= 0xd800 && cp <= 0xdfff) raw = true;
        else parts.push(String.fromCodePoint(cp));
        i += 6;
      } else if (e !== undefined && Object.hasOwn(SIMPLE_ESCAPES, e)) {
        parts.push(SIMPLE_ESCAPES[e]);
        i += 2;
      } else if (e === undefined) {
        sc.fail(MESSAGES.UnclosedString, n);
      } else {
        sc.fail(MESSAGES.UnexpectedToken, i + 1);
      }
      from = i;
    } else if (c < 32) {
      sc.fail(MESSAGES.UnexpectedToken, i);
    } else {
      i += 1;
    }
  }
  sc.pos = i;
  return fig.scalar("string", [s, i], raw ? sc.slice(s + 1, i - 1) : parts.join(""));
}

const isDigit = (c) => c !== undefined && c >= 48 && c <= 57;

function unexpected(sc) {
  if (sc.eof()) sc.fail(MESSAGES.UnexpectedEndOfInput);
  sc.fail(MESSAGES.UnexpectedToken);
}

// A number: the lexeme verbatim, its kind by whether it has a fraction or
// an exponent.
function number(sc) {
  const s = sc.pos;
  let c = sc.byte();
  if (!(c === 45 || isDigit(c))) return null;
  if (c === 45) {
    sc.advance();
    c = sc.byte();
    if (!isDigit(c)) unexpected(sc);
  }
  if (c === 48) {
    sc.advance();
    if (isDigit(sc.byte())) sc.fail(MESSAGES.LeadingZero);
  } else {
    sc.match(/[0-9]+/);
  }
  let kind = "int";
  if (sc.byte() === 46) {
    sc.advance();
    if (!sc.match(/[0-9]+/)) unexpected(sc);
    kind = "float";
  }
  const e = sc.byte();
  if (e === 101 || e === 69) {
    sc.advance();
    const sign = sc.byte();
    if (sign === 43 || sign === 45) sc.advance();
    if (!sc.match(/[0-9]+/)) unexpected(sc);
    kind = "float";
  }
  return fig.scalar(kind, [s, sc.pos], sc.slice(s, sc.pos));
}

// `null`, `true`, `false`, whole words; anything else that begins like one
// is the compiled tokenizer's unexpected token.
function literal(sc) {
  const s = sc.pos;
  const m = sc.match(/[a-z]+/);
  if (m === null) return null;
  const word = sc.slice(m[0], m[1]);
  if (word === "null") return fig.scalar("null", [s, m[1]], undefined);
  if (word === "true" || word === "false") return fig.scalar("bool", [s, m[1]], word);
  sc.fail(MESSAGES.UnexpectedToken, s);
}

// ── containers ────────────────────────────────────────────────────────────

const trivia = G.trivia({ space: G.ws1 });

let value;

// After an element: `,` and then another element, or the close. The
// compiled parser refuses a trailing comma where the next element should
// be, so the comma is consumed here and the container's loop finds the
// close and refuses it as the missing element.
function separator(close) {
  return (sc, ctx) => {
    trivia(sc, ctx);
    if (sc.lit(",")) {
      trivia(sc, ctx);
      if (close(sc)) sc.fail(MESSAGES.UnexpectedToken, sc.pos - 1);
      return;
    }
    const p = sc.pos;
    if (close(sc)) {
      sc.pos = p;
      return;
    }
    if (sc.eof()) return;
    sc.fail(MESSAGES.UnexpectedToken);
  };
}

const mapping = G.map({
  open: G.lit("{"),
  close: G.lit("}"),
  trivia,
  entry: G.entry({
    key: stringValue,
    between: G.ws,
    sep: G.lit(":"),
    value: (sc, ctx) => value(sc, ctx),
    missingSep: MESSAGES.UnexpectedToken,
    missingValue: MESSAGES.UnexpectedToken,
  }),
  after: separator(G.lit("}")),
  duplicates: "keep",
  expected: MESSAGES.UnexpectedToken,
  unclosed: MESSAGES.UnexpectedToken,
});

const sequence = G.sequence({
  open: G.lit("["),
  close: G.lit("]"),
  trivia,
  item: (sc, ctx) => value(sc, ctx),
  after: separator(G.lit("]")),
  expected: MESSAGES.UnexpectedToken,
  unclosed: MESSAGES.UnexpectedToken,
});

value = G.choice([mapping, sequence, stringValue, number, literal]);

const parse = G.document({
  bom: true,
  root: value,
  trivia,
  missing: MESSAGES.UnexpectedToken,
  trailing: MESSAGES.UnexpectedToken,
});

// ── the printer ───────────────────────────────────────────────────────────
// The compiled printer's layout: `pretty` (the default) puts one element
// per line at `indent` spaces a level, `"key": value`, an empty container
// as `{}` or `[]`; compact writes no whitespace at all. Strings escape the
// quote, the backslash and the control characters — the C0 short forms
// where JSON has them, `\u00xx` otherwise — and pass everything else
// through as UTF-8. Strict JSON has nowhere to put a comment, so a tree's
// comments are dropped.

const QUOTE = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

function quote(s) {
  return (
    '"' +
    s.replace(/[\x00-\x1f"\\]/g, (ch) => QUOTE[ch] ?? "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")) +
    '"'
  );
}

function writeNode(w, row, depth) {
  const k = row.kind;
  if (k === "null") {
    w.put("null");
  } else if (k === "bool" || k === "int" || k === "float") {
    w.put(row.text);
  } else if (k === "string") {
    w.put(quote(row.text ?? ""));
  } else if (k === "sequence" || k === "mapping") {
    const [open, close] = k === "mapping" ? ["{", "}"] : ["[", "]"];
    if (row.items.length === 0) return w.put(open, close);
    w.put(open).nl();
    row.items.forEach((child, i) => {
      w.indent(depth + 1);
      if (k === "mapping") {
        if (child.key.kind !== "string") throw new Error("a JSON key must be a string");
        w.put(quote(child.key.text ?? ""), w.pretty ? ": " : ":");
        writeNode(w, child.value, depth + 1);
      } else {
        writeNode(w, child, depth + 1);
      }
      if (i < row.items.length - 1) w.put(",");
      w.nl();
    });
    w.indent(depth).put(close);
  } else if (k === "alias") {
    throw new Error("an alias must be resolved before it is written as JSON");
  } else {
    throw new Error("a " + k + " is not a value");
  }
}

function print(_dialect, t, options) {
  fig.index(t);
  const w = fig.writer(options);
  writeNode(w, t.byid(0), 0);
  w.put("\n");
  return w.string();
}

// ── the language ──────────────────────────────────────────────────────────

export default {
  name: "js-json",
  caps: { read: true, edit: true, serialize: true },
  // JSON holds `null` natively and nothing beyond the core kinds; every
  // extended scalar rides in a `$fig` envelope.
  lossless: { null: true },
  syntax: {
    comments: { style: "slashes" },
    kv_sep: ": ",
    key_style: "json_quoted",
    empty_map_literal: "{}",
  },
  // The compiled format owns `.json`, and a compiled format's extension
  // wins, so this is reached by `--lang js-json`.
  dialects: [{ name: "js-json", extensions: ["json"], splice: "json_string", empty_doc_seed: "{}\n" }],
  samples: ['{"a": 1, "b": [true, null, "s"], "c": {"d": 2.5}}\n', "[]\n"],
  renderers: [],
  parse,
  print,
};
