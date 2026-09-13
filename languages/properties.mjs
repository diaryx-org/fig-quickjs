// Java `.properties`, in JavaScript: the twin of fig's compiled
// `properties` format, row for row.
//
// `fig lang check js-properties --against properties <files…>` holds this
// module to the compiled parser's node table on every file given, and this
// module is written against `fig lang table -i properties`, which prints
// that table. What the compiled format accepts is stated in fig's
// `src/languages/properties/`, and this follows it — `java.util.Properties
// .load` as documented, not INI or dotenv re-skinned:
//
//   * a logical line is `key`, then the first unescaped `=`, `:` or run of
//     spaces and tabs, then the value to the line's end; `a=b`, `a:b`,
//     `a b` and `a = b` are the same statement; a line with nothing after
//     its separator, or no separator at all, is a key with an empty value
//     spanning nothing where a value would begin — after the separator,
//     or at the key's end;
//   * key and value both decode `\t \n \r \f`, `\uXXXX`, and `\` before any
//     other byte as that byte (`\:`, `\=`, `\#`, `\ `); a `\` before a line
//     ending is a continuation — it, the newline and the next line's
//     leading spaces and tabs vanish, and the token's span runs on;
//   * a full-line `#` or `!` is a comment, leading for the next key, or
//     dangling on the root when no key follows; nothing trails a value;
//   * a repeated key keeps the first entry's place and takes the last
//     value; the later key's own leading comments go with it.
//
// Every value is a string: the format has no typed scalars. Spans are byte
// offsets, 0-based, `[start, end)`. The refusals are the compiled parser's,
// in its words and at its offsets: a bad `\uXXXX` is reported where the
// token after the offending one begins, as the compiled parser decodes a
// token once it has moved past it. The one warning (a duplicate key) has
// no row and is not carried. There is no UTF-8 refusal: the input reaches
// a module as text the host already decoded.
import * as fig from "fig";

// ── errors, as the compiled parser words them ─────────────────────────────

const MESSAGES = {
  InvalidUnicode: "invalid \\uXXXX escape; expected exactly 4 hex digits forming a valid Unicode codepoint",
  UnexpectedCarriageReturn: "a bare `\\r` must be followed by `\\n`; line endings must be `\\n` or `\\r\\n`",
  UnclosedEscape: "a `\\` at the very end of the file has nothing to escape",
};

// ── the tokenizer ─────────────────────────────────────────────────────────
// Tokens are `{ kind, s, e }` over 0-based byte offsets: `key`, `value`
// (both raw, decoded by the parser; a value follows every key), `comment`
// (the text after its leader), `newline`, `end_of_file`.

const isInlineWs = (b) => b === 32 || b === 9 || b === 12;
const isSeparator = (b) => b === 61 || b === 58 || isInlineWs(b);

function tokenize(bin) {
  const n = bin.length;
  let i = 0;
  const tokens = [];
  const at = (k) => (k < n ? bin.charCodeAt(k) : undefined);
  const emit = (kind, s, e) => tokens.push({ kind, s, e });

  const skipContinuationWs = () => {
    while (i < n && (at(i) === 32 || at(i) === 9)) i += 1;
  };

  // An escape-aware run: a `\` protects the byte after it, a `\` before a
  // line ending joins the next line on. Stops before the first unescaped
  // separator in `keyMode`, else at the logical line's end.
  const scanEscaped = (keyMode) => {
    while (i < n) {
      const c = at(i);
      if (c === 10 || c === 13) return;
      if (c === 92) {
        if (i + 1 < n && at(i + 1) === 10) {
          i += 2;
          skipContinuationWs();
        } else if (i + 2 < n && at(i + 1) === 13 && at(i + 2) === 10) {
          i += 3;
          skipContinuationWs();
        } else if (i + 1 >= n) {
          fig.fail(MESSAGES.UnclosedEscape, i);
        } else {
          i += 2;
        }
      } else if (keyMode && isSeparator(c)) {
        return;
      } else {
        i += 1;
      }
    }
  };

  if (bin.startsWith("\xef\xbb\xbf")) i = 3;
  while (i < n) {
    while (i < n && isInlineWs(at(i))) i += 1;
    if (i >= n) break;
    const c = at(i);
    if (c === 10) {
      emit("newline", i, i + 1);
      i += 1;
    } else if (c === 13) {
      if (i + 1 < n && at(i + 1) === 10) {
        emit("newline", i, i + 2);
        i += 2;
      } else {
        fig.fail(MESSAGES.UnexpectedCarriageReturn, i);
      }
    } else if (c === 35 || c === 33) {
      i += 1;
      const s = i;
      while (i < n && at(i) !== 10 && at(i) !== 13) i += 1;
      emit("comment", s, i);
    } else {
      const keyStart = i;
      scanEscaped(true);
      emit("key", keyStart, i);
      while (i < n && isInlineWs(at(i))) i += 1;
      if (i < n && (at(i) === 61 || at(i) === 58)) {
        i += 1;
        while (i < n && isInlineWs(at(i))) i += 1;
      }
      // Always a value: zero-width where one would begin when nothing
      // follows.
      const valueStart = i;
      if (i < n && at(i) !== 10 && at(i) !== 13) scanEscaped(false);
      emit("value", valueStart, i);
    }
  }
  emit("end_of_file", n, n);
  return tokens;
}

// ── decoding ──────────────────────────────────────────────────────────────

const SIMPLE = { t: "\t", n: "\n", r: "\r", f: "\f" };

// The text of a raw key or value token; `failAt` is where a bad `\uXXXX`
// is reported.
function decodeEscaped(raw, failAt) {
  if (!raw.includes("\\")) return raw;
  let out = "";
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const c = raw[i];
    if (c !== "\\") {
      out += c;
      i += 1;
    } else if (raw[i + 1] === "\n") {
      i += 2;
      while (i < n && (raw[i] === " " || raw[i] === "\t")) i += 1;
    } else if (raw[i + 1] === "\r" && raw[i + 2] === "\n") {
      i += 3;
      while (i < n && (raw[i] === " " || raw[i] === "\t")) i += 1;
    } else {
      const ch = raw[i + 1];
      if (ch in SIMPLE) {
        out += SIMPLE[ch];
      } else if (ch === "u") {
        const hex = raw.slice(i + 2, i + 6);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fig.fail(MESSAGES.InvalidUnicode, failAt);
        const cp = parseInt(hex, 16);
        if (cp >= 0xd800 && cp <= 0xdfff) fig.fail(MESSAGES.InvalidUnicode, failAt);
        out += String.fromCodePoint(cp);
        i += 4;
      } else {
        out += ch;
      }
      i += 2;
    }
  }
  return out;
}

// ── the parser ────────────────────────────────────────────────────────────

function parse(_dialect, input) {
  const sc = fig.scanner(input);
  const tokens = tokenize(sc.bin);
  let pos = 0;
  let pending = [];
  const root = fig.mapping([0, sc.n]);

  const peek = () => tokens[pos];
  const advance = () => {
    const t = tokens[pos];
    if (pos < tokens.length - 1) pos += 1;
    return t;
  };
  const text = (t) => sc.slice(t.s, t.e);
  const claim = (node, slot) => {
    for (const c of pending) node.comment(slot, c);
    pending = [];
  };
  const skipBlank = () => {
    for (;;) {
      const k = peek().kind;
      if (k === "comment") {
        pending.push(text(peek()).replace(/^[ \t\r]+|[ \t\r]+$/g, ""));
        pos += 1;
      } else if (k === "newline") {
        pos += 1;
      } else return;
    }
  };

  skipBlank();
  while (peek().kind !== "end_of_file") {
    const keyTok = advance();
    const name = decodeEscaped(text(keyTok), peek().s);
    const valueTok = advance();
    const valueText = decodeEscaped(text(valueTok), peek().s);
    const key = fig.scalar("string", [keyTok.s, keyTok.e], name);
    claim(key, "leading");
    root.put(fig.entry(key, fig.scalar("string", [valueTok.s, valueTok.e], valueText)));
    skipBlank();
  }
  claim(root, "dangling");
  return fig.rows(root);
}

// ── the printer ───────────────────────────────────────────────────────────
// Canonical `.properties`, as the compiled printer writes it: one
// `key=value` line per entry, `=` whatever the source's separator was, the
// escapes that keep it reading back the same — control characters, `\`, a
// separator or leading `#`/`!` in a key, leading whitespace in a value —
// and nothing else; leading comments as `# …` lines above the key,
// dangling comments at the end. A comment that trails a value has no
// spelling and is not written.

const ESCAPED = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\f": "\\f", "\\": "\\\\" };

const escapedChar = (c) => ESCAPED[c] ?? "\\" + c;

function writeKey(w, name) {
  let idx = 0;
  for (const c of name) {
    if (idx === 0 && (c === "#" || c === "!")) w.put(escapedChar(c));
    else if (c in ESCAPED || c === "=" || c === ":" || c === " " || c === "\t" || c === "\f") w.put(escapedChar(c));
    else w.put(c);
    idx += 1;
  }
}

function writeValueText(w, v) {
  let idx = 0;
  for (const c of v) {
    if (idx === 0 && (c === " " || c === "\t" || c === "\f")) w.put(escapedChar(c));
    else if (c in ESCAPED) w.put(ESCAPED[c]);
    else w.put(c);
    idx += 1;
  }
}

function writeValue(w, row) {
  const k = row.kind;
  if (k === "string") writeValueText(w, row.text ?? "");
  else if (k === "int" || k === "float" || k === "bool") w.put(row.text ?? "");
  else if (k === "null") throw new Error("a .properties file has no null; a null value cannot be written");
  else if (k === "sequence" || k === "mapping") throw new Error("a .properties file holds a flat map of strings; a nested value cannot be written");
  else if (k === "alias") throw new Error("an alias must be resolved before it is written as .properties");
  else throw new Error("a " + k + " is not a value");
}

function commentLines(w, c) {
  for (const line of c.text.split("\n")) {
    const trimmed = line.replace(/^[ \t]+|[ \t]+$/g, "");
    w.put(trimmed === "" ? "#\n" : "# " + trimmed + "\n");
  }
}

function print(_dialect, t, _options) {
  const w = fig.writer();
  const root = fig.index(t).byid(0);
  if (root.kind !== "mapping") {
    // A fragment: the scalar as it stands alone.
    writeValue(w, root);
    w.put("\n");
    return w.string();
  }
  for (const kv of root.items) {
    const { key, value } = kv;
    if (key.kind !== "string") throw new Error("a .properties key must be a string");
    for (const c of key.leading) commentLines(w, c);
    writeKey(w, key.text ?? "");
    w.put("=");
    writeValue(w, value);
    w.put("\n");
  }
  for (const c of root.dangling) commentLines(w, c);
  return w.string();
}

export default {
  name: "js-properties",
  caps: { read: true, edit: true, serialize: true },
  // Flat: no mapping inside the root.
  max_mapping_depth: 0,
  syntax: {
    // `#` and `!` are read; `#` is written, and what the editor scans for.
    comments: { style: "hash", line: { open: "#" } },
    // `=`, `:` and a space are read; `=` is written.
    kv_sep: "=",
    empty_map_literal: "{}",
    flow_containers: false,
  },
  // The compiled format owns `.properties`, and a compiled format's
  // extension wins, so this is reached by `--lang js-properties`.
  dialects: [{ name: "js-properties", extensions: ["properties"], splice: "raw", empty_doc_seed: "" }],
  samples: ["a=1\nb: two\nc three\n"],
  renderers: [],
  parse,
  print,
};
