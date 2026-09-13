// INI, in JavaScript: the twin of fig's compiled `ini` format, row for
// row, region for region, mention for mention.
//
// `fig lang check js-ini --against ini <files…>` holds this module to the
// compiled parser's node table on every file given, and this module is
// written against `fig lang table -i ini`, which prints that table. What
// the compiled format accepts is stated in fig's `src/languages/ini/`, and
// this follows it:
//
//   * a line is a `[section]` header, a `key = value`, a `;` or `#`
//     comment, or blank; `=` is the only separator; a value is the rest of
//     its line, trimmed, with one layer of matching `"…"`/`'…'` quotes
//     removed and nothing decoded — a `;` after a value is value text, not
//     a comment;
//   * the root is a mapping spanning the whole input; a section is a
//     keyvalue and a mapping, both spanning the name token of the header
//     that created it; a `key = value` is a keyvalue from the key's start
//     to the value's end, its key and value strings spanning their trimmed
//     text (an absent value spans nothing at the line's end);
//   * a repeated key keeps the first entry's place and takes the last
//     value; a repeated `[section]` reopens the section, which then holds
//     every header line as a *region* and every header's name as a
//     *mention*; a section named like a root key is refused;
//   * a comment leads the next key or section, and at the end of the file
//     dangles on the section the last header opened.
//
// One level deep by construction (`max_mapping_depth = 1`): there is no
// spelling for a section inside a section. The refusals are the compiled
// parser's, in its words and at its offsets, with one difference of order:
// the compiled tokenizer runs over the whole file before its parser, so a
// file with a lexical error after a grammatical one reports the lexical
// one; this reports the first. Every offset is a byte offset: the
// tokenizer walks the scanner's one-char-per-byte shadow of the input.
// The same object `@diaryx/fig`'s `registerLanguage` takes, so it serves
// the browser and Node unchanged.
import * as fig from "fig";
import * as G from "fig/grammar";

// ── errors, as the compiled parser words them ─────────────────────────────

const MESSAGES = {
  UnexpectedToken: "unexpected content here; expected a `[section]` header or a `key = value` line",
  InvalidKey: "a key/section name cannot be empty",
  DuplicateKey: "this section conflicts with a key of the same name already defined at this level",
  UnexpectedCarriageReturn: "a bare `\\r` must be followed by `\\n`; line endings must be `\\n` or `\\r\\n`",
  UnclosedSection: "unclosed `[section]` header; expected a `]` before the end of the line",
  MissingEquals: "expected `=` after this key; every INI line is `key = value`",
  TrailingContent: "unexpected content after `]`; a section header must be alone on its line",
};

// ── the tokenizer ─────────────────────────────────────────────────────────
// Line-oriented, as the compiled one: what a byte means depends on whether
// the line's `=` has passed. Every token is `{kind, s, e}`; a `text` token
// is a section name, a key or a value by position, its span trimmed of
// spaces and tabs.

function tokenize(bin) {
  const n = bin.length;
  const tokens = [];
  const at = (i) => (i < n ? bin.charCodeAt(i) : undefined);
  const lineEnd = (i) => i >= n || at(i) === 10 || at(i) === 13;
  const emit = (kind, s, e) => tokens.push({ kind, s, e });
  const trimmed = (s, e) => {
    while (s < e && (at(s) === 32 || at(s) === 9)) s += 1;
    while (e > s && (at(e - 1) === 32 || at(e - 1) === 9)) e -= 1;
    emit("text", s, e);
  };
  let i = bin.startsWith("\xef\xbb\xbf") ? 3 : 0;
  let inValue = false;
  while (i < n) {
    const c = at(i);
    if (c === 10) {
      emit("newline", i, i + 1);
      i += 1;
      inValue = false;
    } else if (c === 13) {
      if (at(i + 1) !== 10) fig.fail(MESSAGES.UnexpectedCarriageReturn, i);
      emit("newline", i, i + 2);
      i += 2;
      inValue = false;
    } else if (c === 32 || c === 9) {
      i += 1;
    } else if (inValue) {
      const s = i;
      while (!lineEnd(i)) i += 1;
      trimmed(s, i);
    } else if (c === 59 || c === 35) {
      i += 1;
      const s = i;
      while (!lineEnd(i)) i += 1;
      emit("comment", s, i);
    } else if (c === 91) {
      emit("open_bracket", i, i + 1);
      i += 1;
      const s = i;
      while (i < n && at(i) !== 93) {
        if (lineEnd(i)) fig.fail(MESSAGES.UnclosedSection, i);
        i += 1;
      }
      if (i >= n) fig.fail(MESSAGES.UnclosedSection, i);
      trimmed(s, i);
      emit("close_bracket", i, i + 1);
      i += 1;
      while (i < n && (at(i) === 32 || at(i) === 9)) i += 1;
      if (!lineEnd(i)) fig.fail(MESSAGES.TrailingContent, i);
    } else {
      const s = i;
      while (i < n && at(i) !== 61 && !lineEnd(i)) i += 1;
      if (i >= n || at(i) !== 61) fig.fail(MESSAGES.MissingEquals, i);
      trimmed(s, i);
      emit("equals", i, i + 1);
      i += 1;
      inValue = true;
    }
  }
  emit("end_of_file", n, n);
  return tokens;
}

// ── the parser ────────────────────────────────────────────────────────────

// One layer of matching quotes around the whole value comes off; nothing
// inside is decoded.
function decodeValue(raw) {
  if (raw.length >= 2) {
    const q = raw[0];
    if ((q === '"' || q === "'") && raw[raw.length - 1] === q) return raw.slice(1, -1);
  }
  return raw;
}

function parse(_dialect, input) {
  const sc = fig.scanner(input);
  const { bin } = sc;
  const tokens = tokenize(bin);
  let pos = 0;
  const S = G.sections(bin);
  const root = fig.mapping([0, sc.n]);
  let current = root;

  const peek = () => tokens[pos];
  const advance = () => {
    const t = tokens[pos];
    if (pos < tokens.length - 1) pos += 1;
    return t;
  };
  const text = (t) => sc.slice(t.s, t.e);
  const skipBlank = () => {
    for (;;) {
      const k = peek().kind;
      if (k === "comment") {
        S.comment(text(peek()).replace(/^[ \t\r]+|[ \t\r]+$/g, ""));
        pos += 1;
      } else if (k === "newline") {
        pos += 1;
      } else return;
    }
  };

  // `[name]`: reopen the section when the name was seen, else a fresh
  // section under the root.
  const sectionHeader = () => {
    advance(); // [
    const nameTok = peek();
    if (nameTok.kind !== "text") fig.fail(MESSAGES.UnexpectedToken, nameTok.s);
    advance();
    const name = text(nameTok);
    if (peek().kind !== "close_bracket") fig.fail(MESSAGES.UnexpectedToken, peek().s);
    advance();
    if (name === "") fig.fail(MESSAGES.InvalidKey, nameTok.s);
    const span = [nameTok.s, nameTok.e];
    const existing = root.byKey.get(name);
    if (existing) {
      const m = existing.value;
      if (m.kind !== "mapping") fig.fail(MESSAGES.DuplicateKey, nameTok.s);
      S.reopen(m, span, "header");
      current = m;
    } else {
      const key = fig.scalar("string", span, name);
      S.claim(key, "leading");
      current = S.open(root, fig.entry(key, fig.mapping(span)), "header");
    }
  };

  const keyValue = () => {
    const keyTok = advance();
    const name = text(keyTok);
    if (name === "") fig.fail(MESSAGES.InvalidKey, keyTok.s);
    if (peek().kind !== "equals") fig.fail(MESSAGES.UnexpectedToken, peek().s);
    advance();
    // `key=` at the line's end has no value token: an empty value there.
    let raw = "";
    let span = [peek().s, peek().s];
    if (peek().kind === "text") {
      const valueTok = advance();
      raw = text(valueTok);
      span = [valueTok.s, valueTok.e];
    }
    const key = fig.scalar("string", [keyTok.s, keyTok.e], name);
    S.claim(key, "leading");
    current.put(fig.entry(key, fig.scalar("string", span, decodeValue(raw))));
  };

  skipBlank();
  while (peek().kind !== "end_of_file") {
    const k = peek().kind;
    if (k === "open_bracket") sectionHeader();
    else if (k === "text") keyValue();
    else fig.fail(MESSAGES.UnexpectedToken, peek().s);
    skipBlank();
  }
  S.claim(current, "dangling");
  return fig.rows(root);
}

// ── the printer ───────────────────────────────────────────────────────────
// The compiled printer's layout: the root's scalar entries first as
// `key = value` lines, then every mapping-valued entry as a `[section]`
// block, in that order whatever the tree's — INI cannot interleave them.
// A value is bare unless bare would not read back the same (empty, padded,
// or already quoted), then `"…"`. Comments are `;` lines: leading above a
// key, a trailing one on its own line after, dangling at the end of its
// section.

function needsQuoting(v) {
  if (v === "") return true;
  const first = v[0];
  const last = v[v.length - 1];
  if (first === " " || first === "\t" || last === " " || last === "\t") return true;
  return v.length >= 2 && (first === '"' || first === "'") && last === first;
}

function writeText(w, v) {
  if (/[\n\r]/.test(v)) throw new Error("a value with a line break has no INI spelling");
  if (needsQuoting(v)) w.put('"', v, '"');
  else w.put(v);
}

function writeValue(w, row) {
  const k = row.kind;
  if (k === "string") writeText(w, row.text ?? "");
  else if (k === "int" || k === "float" || k === "bool") w.put(row.text);
  else if (k === "null") throw new Error("INI has no null; a null value cannot be written");
  else if (k === "sequence" || k === "mapping") throw new Error("a nested container has no INI spelling");
  else if (k === "alias") throw new Error("an alias must be resolved before it is written as INI");
  else throw new Error("a " + k + " is not a value");
}

function commentLines(w, ctx, list) {
  for (const c of list) {
    for (const line of c.text.split("\n")) {
      const t = line.replace(/^[ \t]+|[ \t]+$/g, "");
      w.put(t === "" ? ";" : "; " + t, "\n");
    }
    ctx.wrote = true;
  }
}

function keyText(row) {
  if (row.kind !== "string") throw new Error("an INI key must be a string");
  return row.text ?? "";
}

function kvLine(w, ctx, e) {
  commentLines(w, ctx, e.key.leading);
  writeText(w, keyText(e.key));
  w.put(" = ");
  writeValue(w, e.value);
  w.put("\n");
  ctx.wrote = true;
  commentLines(w, ctx, e.value.trailing);
}

function print(_dialect, t, _options) {
  fig.index(t);
  const w = fig.writer();
  const ctx = { wrote: false };
  const root = t.byid(0);
  if (root.kind !== "mapping") {
    writeValue(w, root);
    w.put("\n");
    return w.string();
  }
  for (const e of root.items) if (e.value.kind !== "mapping") kvLine(w, ctx, e);
  for (const e of root.items) {
    if (e.value.kind !== "mapping") continue;
    commentLines(w, ctx, e.key.leading);
    if (ctx.wrote) w.put("\n");
    w.put("[");
    writeText(w, keyText(e.key));
    w.put("]\n");
    ctx.wrote = true;
    for (const inner of e.value.items) {
      if (inner.value.kind === "mapping") throw new Error("a section inside a section has no INI spelling");
      kvLine(w, ctx, inner);
    }
    commentLines(w, ctx, e.value.dangling);
  }
  commentLines(w, ctx, root.dangling);
  return w.string();
}

// ── the language ──────────────────────────────────────────────────────────

export default {
  name: "js-ini",
  caps: { read: true, edit: true, serialize: true },
  max_mapping_depth: 1,
  syntax: {
    // `#` is read; `;` is what is written, and what the editor writes. No
    // same-line trailing comment: a `;` after a value is value text.
    comments: { style: "semicolon", line: { open: ";" } },
    kv_sep: " = ",
    // `{}` in INI is the two-character string `{}`, so nothing can be
    // auto-vivified; and a `[` opening the file is a header, not a flow
    // container.
    flow_containers: false,
    section_noun: "section",
  },
  // The compiled format owns `.ini`, and a compiled format's extension
  // wins, so this is reached by `--lang js-ini`.
  dialects: [{ name: "js-ini", extensions: ["ini"], splice: "raw", empty_doc_seed: "" }],
  samples: ["a = 1\n\n[s]\nk = v\n"],
  renderers: [],
  parse,
  print,
};
