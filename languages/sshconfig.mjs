// OpenSSH client configuration, in JavaScript: `~/.ssh/config` and
// `/etc/ssh/ssh_config`, the format ssh_config(5) describes.
//
// The format:
//
//   * a line is `Keyword arguments` — a keyword, then whitespace or an
//     `=` with optional whitespace around it, then the arguments to the
//     end of the line — or a `#` comment, or blank; a `#` that begins an
//     argument begins a comment, as OpenSSH's own `argv_split` reads it,
//     and a `#` inside one is argument text;
//   * the arguments are one string: the rest of the line, trimmed, kept
//     as written — quotes and all, since `"my key"` is one argument and
//     `my key` is two, and only the spelling tells them apart;
//   * `Host` and `Match` open a block that the keywords after them belong
//     to, until the next `Host` or `Match`; keywords before the first are
//     global.
//
// The tree: the root is a mapping over the whole input holding the global
// keywords and, once one appears, `Host` and `Match` — each a mapping
// whose keys are the pattern arguments of each block, as written
// (`github.com`, `*.example.com`, `host foo user bar`), and whose values
// are the block's keywords. A keyword repeated in a block — `IdentityFile`
// three times, `SendEnv` — keeps every entry, since each is its own line
// and OpenSSH reads them all; a block whose patterns repeat an earlier
// block's reopens it, and holds each header line as a *region* and each
// header's patterns as a *mention*. A keyword's name is kept as written,
// though OpenSSH compares them case-insensitively.
//
// Partial by design: the generic editor replaces a keyword's arguments,
// adds or deletes a keyword in a block or at the top, comments one, and
// spells a new block as `Host pattern` (the header syntax, joined by a
// space, so `insertContainer` under `Host` writes `Host name`); `set`
// does not vivify a block that is not there. A pattern holding a `.` is
// a key the command line's dotted path cannot name, which is the path
// syntax's limit and not the tree's. Spans are byte offsets, 0-based,
// `[start, end)`. The same object `@diaryx/fig`'s `registerLanguage`
// takes, so it serves the browser and Node unchanged.
import * as fig from "fig";
import * as G from "fig/grammar";

// ── lexical pieces ────────────────────────────────────────────────────────

const isSpace = (c) => c === 32 || c === 9;
const isEol = (c) => c === 10 || c === 13 || c === undefined;
const isKeywordChar = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 45;

// Blank lines and whole-line `#` comments, waiting in the section context
// for the keyword or block they lead.
const trivia = G.trivia({
  space: G.choice([
    G.hs1,
    G.eol,
    G.failIf(G.lit("\r"), "a bare `\\r` must be followed by `\\n`; line endings must be `\\n` or `\\r\\n`"),
  ]),
  comment: G.comment("#"),
});

// The arguments after a keyword: the rest of the line up to a `#` that
// begins a token, trimmed, as written. Answers the scalar; the cursor is
// left before any comment.
function args(sc) {
  const s = sc.pos;
  let e = s;
  let inQuote = false;
  let tokenStart = true;
  for (;;) {
    const c = sc.byte();
    if (isEol(c)) {
      if (inQuote) sc.fail("unclosed quoted argument; expected a closing `\"` before the end of the line", s);
      break;
    }
    if (!inQuote && isSpace(c)) {
      tokenStart = true;
      sc.advance();
      continue;
    }
    if (!inQuote && c === 35 && tokenStart) break;
    if (c === 34) inQuote = !inQuote;
    tokenStart = false;
    sc.advance();
    e = sc.pos;
  }
  return fig.scalar("string", [s, e], sc.slice(s, e));
}

// A `#` comment after the arguments, trailing on `node`.
function lineComment(sc, node) {
  sc.hs();
  if (sc.byte() !== 35) return;
  const r = G.comment("#")(sc);
  node.comment("trailing", r.text, "line");
}

// ── the parser ────────────────────────────────────────────────────────────

const BLOCKS = new Set(["host", "match"]);

function parse(_dialect, input) {
  const sc = fig.scanner(input);
  if (sc.bin.startsWith("\xef\xbb\xbf")) sc.pos = 3;
  const S = G.sections(sc.bin);
  const ctx = { comment: (c) => S.comment(c.text) };
  const root = fig.mapping([0, sc.n], { duplicates: "keep" });
  // `Host` and `Match` under the root, made when first met; their blocks
  // by pattern text.
  const groups = new Map();
  let current = root;
  for (;;) {
    trivia(sc, ctx);
    if (sc.eof()) break;
    const s = sc.pos;
    while (isKeywordChar(sc.byte())) sc.advance();
    if (sc.pos === s) sc.fail("unexpected content here; expected a `Keyword arguments` line");
    const key = fig.scalar("string", [s, sc.pos], sc.slice(s, sc.pos));
    sc.hs();
    let sep = [key.span[1], key.span[1]];
    if (sc.byte() === 61) {
      sep = [sc.pos, sc.pos + 1];
      sc.advance();
      sc.hs();
    } else if (!isSpace(sc.byte(-1)) && !isEol(sc.byte())) {
      sc.fail("a keyword is followed by whitespace or `=` before its arguments");
    }
    const v = args(sc);
    const lower = key.text.toLowerCase();
    if (BLOCKS.has(lower)) {
      // A block header. The group (`Host`, `Match`) is a section made on
      // its first header, and passed through with a mention afterwards;
      // the block is a section of its own, reopened when its patterns
      // repeat an earlier block's.
      if (v.text === "") fig.fail("`" + key.text + "` needs at least one pattern after it", key.span[0]);
      let group = groups.get(lower);
      if (!group) {
        S.claim(key, "leading");
        const entry = fig.entry(key, fig.mapping(key.span, { duplicates: "keep" }));
        S.open(root, entry, "header");
        group = { entry, blocks: new Map() };
        groups.set(lower, group);
      } else {
        S.mention(group.entry.value, key.span, "header");
      }
      const existing = group.blocks.get(v.text);
      if (existing) {
        S.reopen(existing.value, v.span, "header");
        current = existing.value;
      } else {
        S.claim(v, "leading");
        const entry = fig.entry(v, fig.mapping(v.span, { duplicates: "keep" }), [key.span[0], v.span[1]]);
        S.open(group.entry.value, entry, "header");
        group.blocks.set(v.text, entry);
        current = entry.value;
      }
      lineComment(sc, current);
    } else {
      const e = fig.entry(key, v);
      e.sep = sep;
      S.claim(key, "leading");
      current.put(e);
      lineComment(sc, v);
    }
    const c = sc.byte();
    if (c === 13 && sc.byte(1) !== 10) sc.fail("a bare `\\r` must be followed by `\\n`; line endings must be `\\n` or `\\r\\n`");
  }
  S.claim(current, "dangling");
  return fig.rows(root);
}

// ── the printer ───────────────────────────────────────────────────────────
// The usual layout: global keywords first, then each `Host` block and each
// `Match` block with its keywords indented by four spaces and a blank line
// between blocks. Arguments are written as they are. A `#` comment leads
// its line, or trails the arguments.

function argText(row) {
  const k = row.kind;
  if (k === "string" || k === "int" || k === "float" || k === "bool") return row.text ?? "";
  if (k === "null") throw new Error("ssh_config has no null; a null value cannot be written");
  if (k === "sequence" || k === "mapping") throw new Error("a container has no ssh_config spelling here");
  if (k === "alias") throw new Error("an alias must be resolved before it is written as ssh_config");
  throw new Error("a " + k + " is not a value");
}

function spellArgs(v) {
  if (/[\n\r]/.test(v)) throw new Error("arguments with a line break have no ssh_config spelling");
  if (v === "" || /^[ \t]|[ \t]$/.test(v)) return '"' + v + '"';
  return v;
}

function keyText(row) {
  if (row.kind !== "string") throw new Error("a keyword must be a string");
  const t = row.text ?? "";
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(t)) throw new Error("`" + t + "` is not an ssh_config keyword");
  return t;
}

function print(_dialect, t, _options) {
  fig.index(t);
  const w = fig.writer();
  const root = t.byid(0);
  if (root.kind !== "mapping") {
    w.put(argText(root), "\n");
    return w.string();
  }
  let wrote = false;
  const comments = (list, indent) => {
    wrote = w.comments(list, "#", indent) || wrote;
  };
  const keyword = (e, indent) => {
    comments(e.key.leading, indent);
    w.indent(indent).put(keyText(e.key), " ", spellArgs(argText(e.value)));
    for (const c of e.value.trailing) w.put(" # ", c.text);
    w.put("\n");
    wrote = true;
  };
  const block = (word, e) => {
    if (e.value.kind !== "mapping") throw new Error("a `" + word + "` block must be a mapping of keywords");
    if (wrote) w.put("\n");
    comments(e.key.leading, 0);
    if (e.key.kind !== "string" || (e.key.text ?? "") === "") throw new Error("a `" + word + "` block needs its patterns as its key");
    w.put(word, " ", e.key.text);
    for (const c of e.value.trailing) w.put(" # ", c.text);
    w.put("\n");
    wrote = true;
    for (const inner of e.value.items) {
      if (inner.value.kind === "mapping") throw new Error("a block inside a block has no ssh_config spelling");
      keyword(inner, 2);
    }
    comments(e.value.dangling, 2);
  };
  const groupsSeen = [];
  for (const e of root.items) {
    const word = keyText(e.key);
    if (BLOCKS.has(word.toLowerCase())) {
      if (e.value.kind !== "mapping") throw new Error("`" + word + "` must hold its blocks as a mapping");
      groupsSeen.push([word, e]);
      continue;
    }
    keyword(e, 0);
  }
  for (const [word, e] of groupsSeen) {
    comments(e.key.leading, 0);
    for (const b of e.value.items) block(word, b);
    comments(e.value.dangling, 0);
  }
  comments(root.dangling, 0);
  return w.string();
}

// ── the language ──────────────────────────────────────────────────────────

export default {
  name: "js-sshconfig",
  caps: { read: true, edit: true, serialize: true },
  max_mapping_depth: 2,
  syntax: {
    comments: { style: "hash", line: { open: "#" }, trailing: { open: "#" } },
    kv_sep: " ",
    empty_map_literal: null,
    flow_containers: false,
    indent_unit: "    ",
    section_noun: "section",
    // A block header is its group word and the patterns, joined by a
    // space: `Host github`.
    section_header: { open: "", close: "", sep: " " },
  },
  dialects: [{ name: "js-sshconfig", extensions: ["sshconfig"], splice: "raw", empty_doc_seed: "" }],
  samples: ["AddKeysToAgent yes\n\nHost github\n    HostName github.com\n    User git\n    IdentityFile ~/.ssh/id_ed25519\n"],
  renderers: [],
  parse,
  print,
};
