// git's configuration files, in JavaScript: `~/.gitconfig`, `.git/config`,
// `.gitmodules`, and whatever `include.path` names — the format
// git-config(1) describes, read and written as git reads it.
//
// The format:
//
//   * a line is a `[section]` or `[section "subsection"]` header, a
//     `name = value` variable, a `#` or `;` comment, or blank; the
//     deprecated `[section.subsection]` spelling is read too, its
//     subsection lowercased, as git does;
//   * a section name is letters, digits and `-`; a subsection is any text
//     in double quotes with `\"` and `\\` as its escapes; a variable name
//     is letters, digits and `-`, and starts with a letter;
//   * a value is the rest of its line, trimmed; a double-quoted run keeps
//     its inner whitespace and takes `\n`, `\t`, `\b`, `\"` and `\\`; a
//     `\` at the end of a line continues the value on the next; a `#` or
//     `;` outside quotes begins a comment, which trails the value; a
//     variable with no `=` is the boolean `true`;
//   * a variable before the first header is refused, as git refuses it.
//
// The tree: the root is a mapping over the whole input; `[core]` is an
// entry `core` whose value is a mapping; `[remote "origin"]` is `remote`
// holding `origin` holding the variables. A repeated header reopens the
// section it names, comparing names case-insensitively as git does, and
// the section then holds every header line as a *region* and every
// header's name as a *mention*. A repeated variable keeps every entry —
// git's multivalued variables (`remote.origin.fetch`, `include.path`) are
// the ones that repeat, and each keeps its own line to be edited or
// deleted by. A section and a variable spell their names as written.
//
// Partial by design, and honest about it: the generic editor replaces a
// value, adds or deletes a variable in an existing section, and comments
// one; a new section is `insertContainer`, spelled `[a.b]` in the
// deprecated form because the header syntax has one separator; `set`
// does not vivify a section that is not there. Spans are byte offsets,
// 0-based, `[start, end)`. The same object `@diaryx/fig`'s
// `registerLanguage` takes, so it serves the browser and Node unchanged.
import * as fig from "fig";
import * as G from "fig/grammar";

// ── lexical pieces ────────────────────────────────────────────────────────

const isSpace = (c) => c === 32 || c === 9;
const isEol = (c) => c === 10 || c === 13 || c === undefined;
const isNameChar = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
const isLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

// Blank lines and whole-line `#`/`;` comments, waiting in the section
// context for the variable or header they lead.
const trivia = G.trivia({
  space: G.choice([
    G.hs1,
    G.eol,
    G.failIf(G.lit("\r"), "a bare `\\r` must be followed by `\\n`; line endings must be `\\n` or `\\r\\n`"),
  ]),
  comment: G.choice([G.comment("#"), G.comment(";")]),
});

// A `#` or `;` comment to the end of the line, met after a value or a
// header: bound as trailing on `node`, or waiting when there is none.
function lineComment(sc, S, node) {
  sc.hs();
  const c = sc.byte();
  if (c !== 35 && c !== 59) return;
  const r = G.comment(c === 35 ? "#" : ";")(sc);
  if (node) node.comment("trailing", r.text, "line");
  else S.comment(r.text);
}

function endOfLine(sc, what) {
  const c = sc.byte();
  if (c === 13 && sc.byte(1) !== 10) sc.fail("a bare `\\r` must be followed by `\\n`; line endings must be `\\n` or `\\r\\n`");
  if (!isEol(c)) sc.fail("unexpected content after " + what + "; nothing but a comment may follow it on its line");
}

// `[name]`, `[name "sub"]`, `[name.sub]`: the segments as key nodes, each
// spanning its own token.
function header(sc) {
  if (sc.byte() !== 91) return null;
  const open = sc.pos;
  sc.advance();
  sc.hs();
  const nameStart = sc.pos;
  while (isNameChar(sc.byte())) sc.advance();
  if (sc.pos === nameStart) sc.fail("a `[section]` header needs a name of letters, digits and `-`", nameStart);
  const name = fig.scalar("string", [nameStart, sc.pos], sc.slice(nameStart, sc.pos));
  let sub = null;
  if (sc.byte() === 46) {
    // The deprecated dotted form: everything to the `]`, lowercased.
    sc.advance();
    const s = sc.pos;
    while (!isEol(sc.byte()) && sc.byte() !== 93) sc.advance();
    if (sc.pos === s) sc.fail("a `[section.subsection]` header needs a subsection after the `.`", s);
    sub = fig.scalar("string", [s, sc.pos], sc.slice(s, sc.pos).toLowerCase());
  } else if (isSpace(sc.byte())) {
    sc.hs();
    if (sc.byte() === 34) {
      const s = sc.pos;
      sc.advance();
      let out = "";
      for (;;) {
        const c = sc.byte();
        if (isEol(c)) sc.fail("unclosed subsection name; expected a closing `\"` before the end of the line", s);
        if (c === 34) break;
        if (c === 92) {
          sc.advance();
          if (isEol(sc.byte())) sc.fail("unclosed subsection name; expected a closing `\"` before the end of the line", s);
          // `\"` and `\\` are the escapes; any other `\x` is `x`.
          out += sc.slice(sc.pos, sc.pos + 1);
          sc.advance();
          continue;
        }
        const from = sc.pos;
        sc.advance();
        while (sc.byte() >= 128) sc.advance();
        out += sc.slice(from, sc.pos);
      }
      sc.advance();
      sub = fig.scalar("string", [s, sc.pos], out);
      sc.hs();
    }
  }
  if (sc.byte() !== 93) sc.fail("unclosed `[section]` header; expected a `]` before the end of the line", open);
  sc.advance();
  return { open, name, sub };
}

// A value after `=`, read as git's own `parse_value` reads it: leading
// whitespace dropped, inner whitespace outside quotes kept as written,
// trailing whitespace dropped; a quoted run kept verbatim; `\`-ended
// lines continued; a `#` or `;` outside quotes ending it. Answers the
// scalar, with a zero-width span where nothing is written; the cursor is
// left before any comment.
function value(sc) {
  sc.hs();
  const s = sc.pos;
  let out = "";
  let e = s; // one past the last byte of value text
  let space = "";
  let inQuote = false;
  for (;;) {
    const c = sc.byte();
    if (isEol(c)) {
      if (inQuote) sc.fail("unclosed quoted value; expected a closing `\"` before the end of the line", s);
      break;
    }
    if (!inQuote && isSpace(c)) {
      if (out.length > 0) space += c === 9 ? "\t" : " ";
      sc.advance();
      continue;
    }
    if (!inQuote && (c === 35 || c === 59)) break;
    out += space;
    space = "";
    if (c === 92) {
      const next = sc.byte(1);
      if (next === 10 || (next === 13 && sc.byte(2) === 10)) {
        // A continuation: the line break is not part of the value.
        sc.advance(next === 10 ? 2 : 3);
        continue;
      }
      if (next === undefined) sc.fail("a value cannot end in a lone `\\`");
      const rep = next === 110 ? "\n" : next === 116 ? "\t" : next === 98 ? "\b" : next === 34 ? '"' : next === 92 ? "\\" : null;
      if (rep === null) {
        sc.fail("invalid escape `\\" + sc.slice(sc.pos + 1, sc.pos + 2) + "` in a value; git knows `\\n`, `\\t`, `\\b`, `\\\"` and `\\\\`");
      }
      out += rep;
      sc.advance(2);
      e = sc.pos;
      continue;
    }
    if (c === 34) {
      inQuote = !inQuote;
      sc.advance();
      e = sc.pos;
      continue;
    }
    const from = sc.pos;
    sc.advance();
    while (sc.byte() >= 128) sc.advance();
    out += sc.slice(from, sc.pos);
    e = sc.pos;
  }
  return fig.scalar("string", [s, e], out);
}

// ── the parser ────────────────────────────────────────────────────────────

const lower = (s) => s.toLowerCase();

function parse(_dialect, input) {
  const sc = fig.scanner(input);
  if (sc.bin.startsWith("\xef\xbb\xbf")) sc.pos = 3;
  const S = G.sections(sc.bin);
  const ctx = { comment: (c) => S.comment(c.text) };
  const root = fig.mapping([0, sc.n], { duplicates: "keep" });
  // Sections by lowercased name, since a header's case does not matter;
  // a variable of the same name is another entry, as `a.b = 1` and
  // `a.b.c = 1` are different keys to git.
  const byName = new Map(); // mapping node -> Map(lower name -> entry)
  const lookup = (parent, key) => byName.get(parent)?.get(lower(key.text)) ?? null;
  const remember = (parent, entry) => {
    if (!byName.has(parent)) byName.set(parent, new Map());
    byName.get(parent).set(lower(entry.key.text), entry);
  };
  let current = null;
  for (;;) {
    trivia(sc, ctx);
    if (sc.eof()) break;
    const h = header(sc);
    if (h != null) {
      let parent = root;
      let key = h.name;
      if (h.sub) {
        // `[a "b"]`: `a` is passed through. A mapping is made for it if
        // none exists yet, and this header line is its first region — a
        // section, so that the editor refuses to replace or line-delete
        // it — as TOML's `[a.b]` makes an implicit `a`; an existing one
        // takes a mention of its name here and no region.
        let mid = lookup(root, h.name);
        if (mid === null) {
          S.claim(h.name, "leading");
          mid = fig.entry(h.name, fig.mapping(h.name.span, { duplicates: "keep" }));
          S.open(root, mid, "header");
          remember(root, mid);
        } else {
          S.mention(mid.value, h.name.span, "header");
        }
        parent = mid.value;
        key = h.sub;
      }
      const existing = lookup(parent, key);
      if (existing) {
        S.reopen(existing.value, key.span, "header");
        current = existing.value;
      } else {
        S.claim(key, "leading");
        const entry = fig.entry(key, fig.mapping(key.span, { duplicates: "keep" }));
        S.open(parent, entry, "header");
        remember(parent, entry);
        current = entry.value;
      }
      lineComment(sc, S, current);
      endOfLine(sc, "a `[section]` header");
      continue;
    }
    // A variable.
    const s = sc.pos;
    if (!isLetter(sc.byte())) sc.fail("unexpected content here; expected a `[section]` header or a `name = value` line");
    while (isNameChar(sc.byte())) sc.advance();
    const key = fig.scalar("string", [s, sc.pos], sc.slice(s, sc.pos));
    if (current === null) fig.fail("a variable before any `[section]` header has no section; git refuses it too", s);
    sc.hs();
    let v;
    let sep;
    if (sc.byte() === 61) {
      sep = [sc.pos, sc.pos + 1];
      sc.advance();
      v = value(sc);
    } else {
      // A bare name is the boolean true: nothing written where the
      // separator and value would be.
      sep = [key.span[1], key.span[1]];
      v = fig.scalar("bool", [key.span[1], key.span[1]], "true");
    }
    const e = fig.entry(key, v);
    e.sep = sep;
    S.claim(key, "leading");
    current.put(e);
    lineComment(sc, S, v);
    endOfLine(sc, "a value");
  }
  S.claim(current ?? root, "dangling");
  return fig.rows(root);
}

// ── the printer ───────────────────────────────────────────────────────────
// git's own layout: `[section]` and `[section "sub"]` headers, variables
// under them indented by one tab, a blank line between sections. A value
// is bare unless bare would not read back the same — empty, padded,
// holding a `#`, `;`, `"`, `\` or a control character — then quoted with
// git's escapes. A `#` comment leads its variable, or trails its value.

const NEEDS_QUOTES = /^[ \t]|[ \t]$|[#;"\\\n\t\b]|^$/;

function spellValue(v) {
  if (!NEEDS_QUOTES.test(v)) return v;
  let out = '"';
  for (const ch of v) {
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\r") throw new Error("a value with a `\\r` has no git config spelling");
    else out += ch;
  }
  return out + '"';
}

function valueText(row) {
  const k = row.kind;
  if (k === "string" || k === "int" || k === "float" || k === "bool") return row.text ?? "";
  if (k === "null") throw new Error("git config has no null; a null value cannot be written");
  if (k === "sequence" || k === "mapping") throw new Error("a section inside a subsection has no git config spelling");
  if (k === "alias") throw new Error("an alias must be resolved before it is written as git config");
  throw new Error("a " + k + " is not a value");
}

function keyText(row, what) {
  if (row.kind !== "string") throw new Error("a " + what + " name must be a string");
  return row.text ?? "";
}

const validName = (s) => /^[A-Za-z][A-Za-z0-9-]*$/.test(s);
const validSection = (s) => /^[A-Za-z0-9-]+$/.test(s);

function spellSubsection(s) {
  return '"' + s.replace(/[\\"]/g, (c) => "\\" + c) + '"';
}

function print(_dialect, t, _options) {
  fig.index(t);
  const w = fig.writer();
  const root = t.byid(0);
  if (root.kind !== "mapping") {
    w.put(valueText(root), "\n");
    return w.string();
  }
  let wrote = false;
  const comments = (list) => {
    wrote = w.comments(list, "#") || wrote;
  };
  const variable = (e) => {
    const name = keyText(e.key, "variable");
    if (!validName(name)) throw new Error("`" + name + "` is not a git variable name: letters, digits and `-`, starting with a letter");
    comments(e.key.leading);
    w.put("\t", name);
    if (e.value.kind === "bool" && e.value.text === "true" && e.value.leading.length === 0) {
      // Spelled bare, as git reads a name alone.
    } else {
      w.put(" = ", spellValue(valueText(e.value)));
    }
    for (const c of e.value.trailing) w.put(" # ", c.text);
    w.put("\n");
    wrote = true;
  };
  const section = (headerText, key, m) => {
    if (wrote) w.put("\n");
    comments(key.leading);
    w.put("[", headerText, "]");
    for (const c of m.trailing) w.put(" # ", c.text);
    w.put("\n");
    wrote = true;
    for (const e of m.items) {
      if (e.value.kind === "mapping") throw new Error("a section inside a subsection has no git config spelling");
      variable(e);
    }
    comments(m.dangling);
  };
  for (const e of root.items) {
    const name = keyText(e.key, "section");
    if (!validSection(name)) throw new Error("`" + name + "` is not a git section name: letters, digits and `-`");
    if (e.value.kind !== "mapping") throw new Error("`" + name + "` is a variable outside any section, which git config cannot spell");
    // The section's own variables first, under `[name]`, then each
    // subsection under `[name "sub"]`.
    const own = e.value.items.filter((x) => x.value.kind !== "mapping");
    const subs = e.value.items.filter((x) => x.value.kind === "mapping");
    if (own.length > 0 || subs.length === 0) {
      if (wrote) w.put("\n");
      comments(e.key.leading);
      w.put("[", name, "]");
      for (const c of e.value.trailing) w.put(" # ", c.text);
      w.put("\n");
      wrote = true;
      for (const x of own) variable(x);
    } else if (e.key.leading.length > 0) {
      if (wrote) w.put("\n");
      comments(e.key.leading);
    }
    for (const x of subs) section(name + " " + spellSubsection(keyText(x.key, "subsection")), x.key, x.value);
    comments(e.value.dangling);
  }
  comments(root.dangling);
  return w.string();
}

// ── the language ──────────────────────────────────────────────────────────

export default {
  name: "js-gitconfig",
  caps: { read: true, edit: true, serialize: true },
  max_mapping_depth: 2,
  syntax: {
    // `;` is read; `#` is what is written, and what the editor writes.
    comments: { style: "hash", line: { open: "#" }, trailing: { open: "#" } },
    kv_sep: " = ",
    // `{}` in a value is the two-character string `{}`, so nothing can be
    // auto-vivified; and a `[` opening the file is a header, not a flow
    // container.
    empty_map_literal: null,
    flow_containers: false,
    indent_unit: "\t",
    section_noun: "section",
    // A new section spelled `[a.b]`: the deprecated form, which git still
    // reads, with the subsection lowercased — `[a "B"]` has no
    // one-separator spelling.
    section_header: { open: "[", close: "]", sep: "." },
  },
  dialects: [{ name: "js-gitconfig", extensions: ["gitconfig", "gitmodules"], splice: "raw", empty_doc_seed: "" }],
  samples: ['[core]\n\tbare = false\n\n[remote "origin"]\n\turl = git@example.com:a/b.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'],
  renderers: [],
  parse,
  print,
};
