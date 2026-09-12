// dotenv, in JavaScript: the twin of fig's compiled `dotenv` format, row
// for row.
//
// `fig lang check js-dotenv --against dotenv <files…>` holds this module to
// the compiled parser's node table on every file given, and this module is
// written against `fig lang table -i dotenv`, which prints that table. What
// the compiled format accepts is stated in fig's `src/languages/dotenv/`,
// and this follows it line for line:
//
//   * a key is a bash identifier, `[A-Za-z_][A-Za-z0-9_]*`; an `export `
//     before one is recognized and discarded;
//   * a value is unquoted (trimmed, to end of line, or to a `#` that at
//     least one space or tab precedes), double-quoted (`\n \t \r \\ \"`
//     decoded, may span lines) or single-quoted (raw, may span lines); a
//     `\r\n` inside a quoted value reads as `\n`;
//   * a full-line `#` is a comment, leading for the next key, or dangling
//     on the root when no key follows; a `#` after a value on its line is
//     the value's trailing comment; a `#` right after a closing quote needs
//     no space before it;
//   * a repeated key keeps the FIRST entry's place and takes the LAST
//     value; the later key's own leading comments go with it.
//
// Every value is a string: dotenv has no typed scalars and does no `$VAR`
// interpolation. Spans are byte offsets, 0-based, `[start, end)`.
//
// The grammar refuses what the compiled parser refuses, in its words and at
// its offsets, with two differences. The compiled tokenizer runs over the
// whole file before its parser, so on a file with two errors it may report
// the later one when that is the tokenizer's; this reports the first. And
// its `InvalidUtf8` refusal cannot arise here: the input reaches a language
// as text the host already decoded.
import * as fig from "fig";
import * as G from "fig/grammar";

// ── errors, as the compiled parser words them ─────────────────────────────

const MESSAGES = {
  UnexpectedToken: "unexpected content here; expected `KEY=value` (optionally `export KEY=value`)",
  MissingEquals: "expected `=` after this key; every dotenv line is `KEY=value`",
  BadEscape:
    "invalid escape in a double-quoted value; supported: \\n \\t \\r \\\\ \\\" — use a single-quoted value for raw text with backslashes",
  UnexpectedCarriageReturn: "a bare `\\r` must be followed by `\\n`; line endings must be `\\n` or `\\r\\n`",
  UnclosedString: "unclosed quoted value; expected a matching `\"`/`'` before the end of the file",
  UnexpectedChar: "not a valid key here; a dotenv key is a bash identifier (`[A-Za-z_][A-Za-z0-9_]*`)",
  TrailingContent: "unexpected content after this quoted value; only a `#` comment may follow it on the same line",
};

// ── the grammar ───────────────────────────────────────────────────────────

// A bare `\r` is refused wherever the compiled tokenizer meets one.
const bareCr = G.failIf(G.lit("\r"), MESSAGES.UnexpectedCarriageReturn);

// After a closing quote only spaces, a comment or the line's end may
// follow. Answers where a bad escape in the value is reported: at the
// comment's text or the line end, as the compiled parser does.
function afterQuoted(sc) {
  const save = sc.pos;
  sc.hs();
  let at = sc.pos;
  if (sc.starts("#")) at += 1;
  else if (!(sc.eof() || sc.starts("\n") || sc.starts("\r"))) sc.fail(MESSAGES.TrailingContent);
  sc.pos = save;
  return at;
}

const ESCAPES = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"' };

const value = G.choice([
  G.quoted({
    open: '"',
    escapes: ESCAPES,
    unclosed: MESSAGES.UnclosedString,
    badEscape: MESSAGES.BadEscape,
    bareCr: MESSAGES.UnexpectedCarriageReturn,
    after: afterQuoted,
  }),
  G.quoted({
    open: "'",
    unclosed: MESSAGES.UnclosedString,
    bareCr: MESSAGES.UnexpectedCarriageReturn,
    after: afterQuoted,
  }),
  // Unquoted: to the line's end, or to a `#` that a space or tab precedes —
  // the one right after `=` counts, since `A= #c` is empty.
  G.bare({
    stop: (sc) => {
      const before = sc.byte(-1);
      return sc.starts("#") && (before === 32 || before === 9);
    },
  }),
]);

const entry = G.entry({
  // `export` is a prefix only when a key follows it on the line; alone
  // before `=` it is the key.
  prefix: G.seq([G.lit("export"), G.hs1, G.ahead(G.pat(/[A-Za-z_]/))]),
  key: G.key(G.pat(/[A-Za-z_][A-Za-z0-9_]*/)),
  sep: G.lit("="),
  value,
  missingSep: MESSAGES.MissingEquals,
});

const parse = G.document({
  bom: true,
  root: G.map({
    whole: true,
    entry,
    trivia: G.trivia({
      space: G.choice([G.hs1, G.eol, bareCr]),
      comment: G.comment("#"),
    }),
    // Where a key should be: `=` is a token the compiled parser refuses;
    // anything else is a byte its tokenizer refuses.
    otherwise: (sc) => {
      if (sc.starts("=")) sc.fail(MESSAGES.UnexpectedToken);
      sc.fail(MESSAGES.UnexpectedChar);
    },
  }),
});

// ── the printer ───────────────────────────────────────────────────────────
// Canonical `.env`, as the compiled printer writes it: one `KEY=value` line
// per entry, a value bare when that is unambiguous and double-quoted with
// escapes otherwise (never a literal embedded newline), leading comments as
// `# …` lines above the key, a trailing comment inline after the value,
// dangling comments at the end.

const isIdentifier = (name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

function needsQuoting(v) {
  if (v === "") return false;
  const first = v[0];
  const last = v[v.length - 1];
  if (first === " " || first === "\t" || last === " " || last === "\t") return true;
  return /[\n\r"\\#]/.test(v);
}

const QUOTE = { "\n": "\\n", "\r": "\\r", "\t": "\\t", '"': '\\"', "\\": "\\\\" };

function writeValue(w, row) {
  const k = row.kind;
  if (k === "string") {
    const v = row.text ?? "";
    if (needsQuoting(v)) w.put('"', v.replace(/[\n\r\t"\\]/g, (ch) => QUOTE[ch]), '"');
    else w.put(v);
  } else if (k === "int" || k === "float" || k === "bool") {
    w.put(row.text ?? "");
  } else if (k === "null") {
    throw new Error("dotenv has no null; a null value cannot be written");
  } else if (k === "sequence" || k === "mapping") {
    throw new Error("dotenv holds a flat map of strings; a nested value cannot be written");
  } else if (k === "alias") {
    throw new Error("an alias must be resolved before it is written as dotenv");
  } else {
    throw new Error("a " + k + " is not a value");
  }
}

function commentLines(w, c) {
  for (const line of c.text.split("\n")) {
    const trimmed = line.replace(/^[ \t]+|[ \t]+$/g, "");
    w.put(trimmed === "" ? "#\n" : "# " + trimmed + "\n");
  }
}

function print(_dialect, t, _options) {
  fig.index(t);
  const w = fig.writer();
  const root = t.byid(0);
  if (root.kind !== "mapping") {
    // A fragment: the scalar as it stands alone.
    writeValue(w, root);
    return w.string();
  }
  for (const kv of root.items) {
    const { key, value } = kv;
    if (key.kind !== "string") throw new Error("a dotenv key must be a string");
    if (!isIdentifier(key.text ?? "")) {
      throw new Error("`" + (key.text ?? "") + "` is not a dotenv key; a key is a bash identifier");
    }
    for (const c of key.leading) commentLines(w, c);
    w.put(key.text, "=");
    writeValue(w, value);
    const trailing = value.trailing[0];
    if (trailing) {
      w.put(" #");
      if (trailing.text !== "") w.put(" ", trailing.text.replace(/\n/g, " "));
    }
    w.put("\n");
  }
  for (const c of root.dangling) commentLines(w, c);
  return w.string();
}

// ── the language ──────────────────────────────────────────────────────────
// The declarations are the wire's `description`, field for field — the
// same object `@diaryx/fig`'s `registerLanguage` takes.

export default {
  name: "js-dotenv",
  caps: { read: true, edit: true, serialize: true },
  // Flat: no mapping inside the root.
  max_mapping_depth: 0,
  syntax: {
    comments: { style: "hash", line: { open: "#" }, trailing: { open: "#" } },
    kv_sep: "=",
    empty_map_literal: "{}",
    flow_containers: false,
  },
  dialects: [
    // `env`, the extension: the compiled format owns `.env` too, and a
    // compiled format's extension wins, so this is reached by `--lang`.
    { name: "js-dotenv", extensions: ["env"], splice: "raw", empty_doc_seed: "" },
  ],
  samples: ["A=1\nB=\"two words\"\n", "# top\nexport C='raw \\n'\nD=x # trailing\n"],
  renderers: [],
  parse,
  print,
};
