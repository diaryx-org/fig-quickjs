// HCL, in JavaScript: HashiCorp's configuration language in its native
// syntax — Terraform's `.tf` and `.tfvars`, Packer, Nomad, Consul, Vault
// — read as configuration, which is to say as far as its values are data.
//
// HCL is a language with expressions in it, and fig's tree holds values.
// What is a value is read as one; what is an expression is kept as the
// text it is, tagged, and written back unchanged:
//
//   * an attribute `name = expr` is an entry; a block `type "label" … {
//     body }` is `type` holding `label` holding … holding the body, the
//     way `hcl2json` nests it, with two blocks of one path a sequence of
//     bodies; a body mapping is tagged `!block` and a label level
//     `!labels`, so that a printer tells a block from an attribute whose
//     value is an object;
//   * a string literal with its escapes decoded, a number, `true`,
//     `false`, `null`, a tuple `[…]` and an object `{…}` of such are the
//     values; a heredoc is a string tagged `!heredoc`, its `<<-` indent
//     stripped; a string holding a template, `"${var.x}-${count.index}"`,
//     is kept as written and tagged `!template`;
//   * everything else — a reference, a call, an operator, a conditional,
//     a `for` — is a string over its source text, tagged `!expr`, and
//     `fig convert` to JSON carries the text as `hcl2json` does;
//   * an attribute repeated in a body is refused, as HCL refuses it, and
//     so are a block and an attribute of one name, and two attributes on
//     a line; `#`, `//` and `/* */` comments are kept, and `#` is what is
//     written.
//
// The tree is a section format's: a body with anything in it, a label
// level and a sequence of bodies each hold their header lines — and a
// body its closing `}` line — as *regions*, and the token that names them
// on each header as a *mention*, so the engine knows which lines a
// container owns, never line-splices one, and can rename it. An empty
// body `{}` is a plain mapping over its braces. Spans are byte offsets,
// 0-based, `[start, end)`: a body's is `{` through `}`; the entry over a
// block, a label level or a label runs from the first block's type
// keyword to the last block's `}`, so that what the engine splices after
// it lands after every block it holds; a label or type keyword is its
// token on the first block.
//
// Partial by design, and the tree says where: the generic editor replaces
// an attribute's value, adds an attribute to a body with attributes or
// nested blocks in it (never to an empty `{}`, which is refused), deletes
// one, comments one, and deleting a block is the container op; tuples
// take no item in place; a new block, a new label and a vivified path
// are not spelled, since the engine's header syntax is a `[table]` line;
// and an attribute added to a label level, which HCL has no place for,
// lands after that level's last block, where `terraform validate` will
// refuse it. A value `set` writes is text, quoted; a tuple, an object, a
// quoted string or a heredoc is spliced as written; an expression is not
// something `set` writes. A value a binding hands the editor is printed on
// one line (`options.splice`): an object `{ k = v, … }`, a tuple `[a, b]`.
// The same object `@diaryx/fig`'s `registerLanguage` takes, so it serves
// the browser and Node unchanged.
import * as fig from "fig";
import * as G from "fig/grammar";

// ── lexical pieces ────────────────────────────────────────────────────────

const isIdentStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
const isIdentChar = (c) => isIdentStart(c) || (c >= 48 && c <= 57) || c === 45;
const isDigit = (c) => c >= 48 && c <= 57;
const isHs = (c) => c === 32 || c === 9;
const isEol = (c) => c === 10 || c === 13 || c === undefined;

const trivia = G.trivia({
  space: G.ws1,
  comment: G.choice([
    G.comment("#"),
    G.comment("//"),
    G.comment({ open: "/*", close: "*/", unclosed: "unclosed comment; expected `*/`" }),
  ]),
});

// Spaces, tabs and comments on the current line only.
const inlineTrivia = G.trivia({
  space: G.hs1,
  comment: G.choice([G.comment("#"), G.comment("//"), G.comment({ open: "/*", close: "*/", unclosed: "unclosed comment; expected `*/`" })]),
});

function ident(sc) {
  if (!isIdentStart(sc.byte())) return null;
  const s = sc.pos;
  sc.advance();
  while (isIdentChar(sc.byte())) sc.advance();
  return [s, sc.pos];
}

// The end of a `"…"` string beginning at the cursor, templates and their
// nested strings walked; answers whether a template occurred.
function scanQuoted(sc) {
  const s = sc.pos;
  sc.advance();
  let depth = 0;
  let template = false;
  for (;;) {
    const c = sc.byte();
    if (c === undefined) fig.fail("unclosed string; expected a closing `\"`", s);
    if (c === 92) {
      sc.advance(2);
      continue;
    }
    if (depth === 0) {
      if (c === 34) {
        sc.advance();
        return template;
      }
      if ((c === 36 || c === 37) && sc.byte(1) === 123) {
        // `$${` and `%%{` are the escapes for the literal sequences.
        if (sc.byte(-1) === c) {
          sc.advance(2);
          continue;
        }
        template = true;
        depth = 1;
        sc.advance(2);
        continue;
      }
      if (c === 10 || c === 13) fig.fail("a string cannot span lines; use a heredoc `<<EOT`", s);
      sc.advance();
      continue;
    }
    // Inside a template: braces nest, a string inside is walked whole.
    if (c === 34) {
      scanQuoted(sc);
      continue;
    }
    if (c === 123 || ((c === 36 || c === 37) && sc.byte(1) === 123)) {
      depth += 1;
      sc.advance(c === 123 ? 1 : 2);
      continue;
    }
    if (c === 125) depth -= 1;
    sc.advance();
  }
}

const ESCAPES = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

function decode(raw, at) {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if ((ch === "$" || ch === "%") && raw[i + 1] === ch && raw[i + 2] === "{") {
      // `$${` and `%%{` spell a literal `${` and `%{`.
      out += ch + "{";
      i += 3;
      continue;
    }
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const n = raw[i + 1];
    if (Object.hasOwn(ESCAPES, n)) {
      out += ESCAPES[n];
      i += 2;
    } else if (n === "u" || n === "U") {
      const len = n === "u" ? 4 : 8;
      const hex = raw.slice(i + 2, i + 2 + len);
      if (!new RegExp("^[0-9A-Fa-f]{" + len + "}$").test(hex)) fig.fail("`\\" + n + "` takes " + len + " hex digits", at);
      out += String.fromCodePoint(parseInt(hex, 16));
      i += 2 + len;
    } else {
      fig.fail("invalid escape `\\" + (n ?? "") + "` in a string", at);
    }
  }
  return out;
}

// A quoted string as a scalar: decoded, or kept as written and tagged
// when it holds a template.
function quoted(sc) {
  if (sc.byte() !== 34) return null;
  const s = sc.pos;
  const template = scanQuoted(sc);
  const inner = sc.slice(s + 1, sc.pos - 1);
  if (template) return fig.scalar("string", [s, sc.pos], inner, { tag: "!template" });
  return fig.scalar("string", [s, sc.pos], decode(inner, s));
}

// `<<EOT` or `<<-EOT`, the lines to a line holding `EOT` alone.
function heredoc(sc) {
  if (!sc.starts("<<")) return null;
  const s = sc.pos;
  sc.advance(2);
  const indented = sc.lit("-") != null;
  const id = ident(sc);
  if (id == null) sc.fail("a heredoc needs a delimiter word after `<<`");
  const word = sc.slice(id[0], id[1]);
  sc.hs();
  if (sc.byte() === 13) sc.advance();
  if (sc.byte() !== 10) sc.fail("a heredoc's delimiter is followed by a line break");
  sc.advance();
  const lines = [];
  for (;;) {
    if (sc.eof()) fig.fail("unclosed heredoc; expected a line holding `" + word + "`", s);
    const ls = sc.pos;
    let nl = sc.bin.indexOf("\n", ls);
    if (nl < 0) nl = sc.n;
    let line = sc.slice(ls, nl);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.replace(/^[ \t]+|[ \t]+$/g, "") === word) {
      sc.pos = nl;
      break;
    }
    lines.push(line);
    sc.pos = nl < sc.n ? nl + 1 : nl;
  }
  let text = lines;
  if (indented) {
    let min = Infinity;
    for (const l of lines) {
      if (l.trim() === "") continue;
      min = Math.min(min, l.length - l.replace(/^[ \t]+/, "").length);
    }
    if (min === Infinity) min = 0;
    text = lines.map((l) => l.slice(Math.min(min, l.length - l.replace(/^[ \t]+/, "").length)));
  }
  return fig.scalar("string", [s, sc.pos], text.join("\n") + (lines.length ? "\n" : ""), { tag: "!heredoc" });
}

function number(sc) {
  const s = sc.pos;
  if (sc.byte() === 45) sc.advance();
  if (!isDigit(sc.byte())) {
    sc.pos = s;
    return null;
  }
  while (isDigit(sc.byte())) sc.advance();
  let float = false;
  if (sc.byte() === 46 && isDigit(sc.byte(1))) {
    float = true;
    sc.advance();
    while (isDigit(sc.byte())) sc.advance();
  }
  if ((sc.byte() === 101 || sc.byte() === 69) && (isDigit(sc.byte(1)) || ((sc.byte(1) === 43 || sc.byte(1) === 45) && isDigit(sc.byte(2))))) {
    float = true;
    sc.advance(2);
    while (isDigit(sc.byte())) sc.advance();
  }
  return fig.scalar(float ? "float" : "int", [s, sc.pos], sc.slice(s, sc.pos));
}

// The end of the expression at the cursor: the first line break, `,`
// (in a collection), closing bracket or comment at bracket depth zero,
// strings and heredocs skipped whole. The cursor is left there; the
// answer is the end of the expression's text, trailing space trimmed.
function expressionEnd(sc, inCollection) {
  let depth = 0;
  let end = sc.pos;
  for (;;) {
    const c = sc.byte();
    if (c === undefined) return end;
    if (c === 34) {
      scanQuoted(sc);
      end = sc.pos;
      continue;
    }
    if (c === 60 && sc.byte(1) === 60 && (isIdentStart(sc.byte(2)) || sc.byte(2) === 45)) {
      heredoc(sc);
      end = sc.pos;
      continue;
    }
    if (c === 40 || c === 91 || c === 123) depth += 1;
    else if (c === 41 || c === 93 || c === 125) {
      if (depth === 0) return end;
      depth -= 1;
    } else if (depth === 0) {
      if (c === 10 || c === 13) return end;
      if (c === 44 && inCollection) return end;
      if (c === 35 || (c === 47 && (sc.byte(1) === 47 || sc.byte(1) === 42))) return end;
      // A lone `=` outside brackets is a second attribute on the line.
      if (c === 61 && sc.byte(1) !== 61 && sc.byte(1) !== 62 && ![33, 60, 62, 61].includes(sc.byte(-1))) {
        sc.fail("expected a line break before this `=`; one attribute per line");
      }
    } else if (c === 35 || (c === 47 && sc.byte(1) === 47)) {
      // A line comment inside brackets: to the end of its line.
      while (!isEol(sc.byte())) sc.advance();
      continue;
    } else if (c === 47 && sc.byte(1) === 42) {
      const at = sc.find("*/");
      if (at < 0) sc.fail("unclosed comment; expected `*/`");
      sc.pos = at + 2;
      continue;
    }
    sc.advance();
    if (!isHs(c) && c !== 10 && c !== 13) end = sc.pos;
  }
}

// ── the grammar ───────────────────────────────────────────────────────────

// Whether what follows the value just read ends it: the line, a comment,
// a `,`, a closing bracket, or the input.
function valueEnds(sc, inCollection) {
  const p = sc.pos;
  sc.hs();
  const c = sc.byte();
  const ends =
    isEol(c) ||
    c === 35 ||
    (c === 47 && (sc.byte(1) === 47 || sc.byte(1) === 42)) ||
    c === 93 ||
    c === 125 ||
    c === 41 ||
    (c === 44 && inCollection);
  sc.pos = p;
  return ends;
}

let expression;

function tuple(sc, ctx) {
  if (sc.byte() !== 91) return null;
  const s = sc.pos;
  sc.advance();
  const q = fig.sequence([s, s]);
  for (;;) {
    trivia(sc, ctx);
    if (sc.lit("]") != null) break;
    if (sc.eof()) fig.fail("unclosed tuple; expected `]`", s);
    const v = expression(sc, ctx, true);
    q.add(v);
    ctx.flush(v, "leading");
    ctx.last = v;
    trivia(sc, ctx);
    if (sc.lit(",") != null) continue;
    if (sc.byte() !== 93) sc.fail("expected `,` or `]` after this item");
  }
  q.span = [s, sc.pos];
  ctx.flush(q, "dangling");
  ctx.last = q;
  return q;
}

function objectKey(sc) {
  const q = quoted(sc);
  if (q != null) return q;
  const id = ident(sc);
  if (id == null) return null;
  return fig.scalar("string", id, sc.slice(id[0], id[1]));
}

function object(sc, ctx) {
  if (sc.byte() !== 123) return null;
  const s = sc.pos;
  sc.advance();
  const m = fig.mapping([s, s], { duplicates: "error" });
  for (;;) {
    trivia(sc, ctx);
    if (sc.lit("}") != null) break;
    if (sc.eof()) fig.fail("unclosed object; expected `}`", s);
    const k = objectKey(sc);
    if (k == null) return null; // `(expr) = …` and `for`: not an object literal
    ctx.flush(k, "leading");
    ctx.last = k;
    inlineTrivia(sc, ctx);
    const sep = sc.lit("=") ?? sc.lit(":");
    if (sep == null) return null;
    inlineTrivia(sc, ctx);
    const v = expression(sc, ctx, true);
    const e = fig.entry(k, v);
    e.sep = sep;
    m.put(e);
    ctx.last = v;
    inlineTrivia(sc, ctx);
    if (sc.lit(",") != null) continue;
    if (sc.byte() === 125) continue;
    if (!isEol(sc.byte())) sc.fail("expected `,`, a line break or `}` after this attribute");
  }
  m.span = [s, sc.pos];
  ctx.flush(m, "dangling");
  ctx.last = m;
  return m;
}

const KEYWORDS = { true: ["bool", "true"], false: ["bool", "false"], null: ["null", undefined] };

// A literal value, or null where the text at the cursor is not one.
function literal(sc, ctx) {
  const c = sc.byte();
  if (c === 34) return quoted(sc);
  if (c === 60) return heredoc(sc);
  if (c === 91) {
    // `[for …]` is an expression.
    const p = sc.pos;
    sc.advance();
    sc.hs();
    const id = ident(sc);
    sc.pos = p;
    if (id && sc.slice(id[0], id[1]) === "for") return null;
    return tuple(sc, ctx);
  }
  if (c === 123) return object(sc, ctx);
  if (isDigit(c) || (c === 45 && isDigit(sc.byte(1)))) return number(sc);
  const id = ident(sc);
  if (id != null) {
    const word = sc.slice(id[0], id[1]);
    if (Object.hasOwn(KEYWORDS, word)) {
      const [kind, text] = KEYWORDS[word];
      return fig.scalar(kind, id, text);
    }
    sc.pos = id[0];
  }
  return null;
}

// An expression: a literal when it stands alone, else its text.
expression = (sc, ctx, inCollection) => {
  const s = sc.pos;
  const pending = ctx.pending.length;
  const last = ctx.last;
  const lit = literal(sc, ctx);
  if (lit != null && valueEnds(sc, inCollection)) return lit;
  // Not a literal, or a literal with more after it (`1 + 2`, `"a" == x`,
  // `[1][0]`): the whole expression, as written. Comments bound while
  // trying the literal are unbound.
  ctx.pending.length = pending;
  ctx.last = last;
  sc.pos = s;
  const end = expressionEnd(sc, inCollection);
  if (end === s) sc.fail("expected a value here");
  return fig.scalar("string", [s, end], sc.slice(s, end), { tag: "!expr" });
};

// ── bodies and blocks ─────────────────────────────────────────────────────

class Parser {
  constructor(sc) {
    this.sc = sc;
    this.ctx = G.context(sc);
    this.S = G.sections(sc.bin);
  }

  fail(message, at) {
    fig.fail(message, at ?? this.sc.pos);
  }

  // A body's entries into `m`, up to `}` when `closed`, else the input's end.
  body(m, closed, open) {
    const { sc, ctx } = this;
    for (;;) {
      trivia(sc, ctx);
      if (closed) {
        if (sc.byte() === 125) return;
        if (sc.eof()) this.fail("unclosed block; expected `}`", open);
      } else if (sc.eof()) {
        return;
      }
      const id = ident(sc);
      if (id == null) this.fail("expected an attribute `name = value` or a block `type { … }` here");
      const key = fig.scalar("string", id, sc.slice(id[0], id[1]));
      sc.hs();
      if (sc.byte() === 61 && sc.byte(1) !== 61) {
        ctx.flush(key, "leading");
        const sep = [sc.pos, sc.pos + 1];
        sc.advance();
        sc.hs();
        const v = expression(sc, ctx, false);
        const e = fig.entry(key, v);
        e.sep = sep;
        this.putAttribute(m, e);
        ctx.last = v;
        inlineTrivia(sc, ctx);
        if (!isEol(sc.byte()) && sc.byte() !== 125) sc.fail("expected a line break after this attribute");
        continue;
      }
      // The comments above a block lead its body, whichever entry the
      // body lands in — a second block of a path has no key of its own.
      const lead = ctx.pending;
      ctx.pending = [];
      this.block(m, key, lead);
    }
  }

  putAttribute(m, e) {
    const existing = m.byKey.get(e.key.text);
    if (existing) {
      const what = existing.value.tag === "!block" || existing.value.tag === "!labels" || existing.value.kind === "sequence" ? "a block" : "an attribute";
      this.fail("`" + e.key.text + "` is already " + what + " in this body; an attribute cannot repeat", e.key.span[0]);
    }
    m.put(e);
  }

  // `type label* { body }` into `m`: each label a level, the body at the
  // end, `lead` the comments above it.
  block(m, typeKey, lead) {
    const { sc, ctx, S } = this;
    const start = typeKey.span[0];
    const labels = [];
    for (;;) {
      sc.hs();
      const c = sc.byte();
      if (c === 34) {
        labels.push(quoted(sc));
        continue;
      }
      const id = ident(sc);
      if (id != null) {
        labels.push(fig.scalar("string", id, sc.slice(id[0], id[1])));
        continue;
      }
      break;
    }
    if (sc.byte() !== 123) sc.fail("expected `{` to open the block `" + typeKey.text + "`, or `=` for an attribute");
    for (const l of labels) if (l.tag) this.fail("a block label cannot hold a template", l.span[0]);
    const open = sc.pos;
    sc.advance();
    const body = fig.mapping([open, open], { duplicates: "error" });
    body.tag = "!block";
    for (const c of lead) body.comment("leading", c.text, c.style);
    ctx.last = null;
    this.body(body, true, open);
    const close = sc.pos;
    sc.advance();
    body.span = [open, sc.pos];
    ctx.flush(body, "dangling");
    ctx.last = body;
    const end = sc.pos;
    inlineTrivia(sc, ctx);
    if (!isEol(sc.byte()) && sc.byte() !== 125) sc.fail("expected a line break after this block");
    // Nesting: each label is a level; the body hangs under the last. The
    // entry over every level now runs to this block's end.
    let parent = m;
    let parentKey = typeKey;
    for (const label of labels) {
      parent = this.level(parent, parentKey, start);
      parent.entry.span[1] = end;
      parentKey = label;
    }
    this.place(parent, parentKey, body, start, end, close, labels.length ? labels[labels.length - 1] : typeKey);
  }

  // The label level `key` names under `parent`, made or re-entered: a
  // section holding this header line as a region and `key` as a mention.
  level(parent, key, lineAt) {
    const { S } = this;
    const existing = parent.byKey.get(key.text);
    if (existing) {
      const v = existing.value;
      if (v.tag !== "!labels") this.fail("`" + key.text + "` is already " + (v.tag === "!block" || v.kind === "sequence" ? "a block with fewer labels" : "an attribute") + " here", key.span[0]);
      S.reopen(v, key.span, "entry");
      return v;
    }
    const level = fig.mapping(key.span, { duplicates: "error" });
    level.tag = "!labels";
    const entry = fig.entry(key, level, [lineAt, lineAt]);
    level.entry = entry;
    return S.open(parent, entry, "entry");
  }

  // The body under its last name: a new entry, or a sequence with the
  // body a block of the same path already there.
  place(parent, key, body, start, end, close, mention) {
    const { S } = this;
    const nonEmpty = body.entries.length > 0;
    // Where this block is, kept on the body for the sequence a second
    // block of the path makes.
    body.header = { start, close, mention: mention.span };
    // The mentions are of the `entry` kind: a block's header line is the
    // line its entry is written on, and what the engine splices into the
    // parent goes after the block, not before it.
    const section = (node, h) => {
      S.region(node, h.start);
      S.region(node, h.close);
      S.mention(node, h.mention, "entry");
    };
    const existing = parent.byKey.get(key.text);
    if (existing) {
      const v = existing.value;
      if (v.kind === "sequence") {
        v.add(body);
        existing.span[1] = end;
        section(v, body.header);
      } else if (v.tag === "!block") {
        const q = fig.sequence(v.span.slice());
        q.add(v);
        q.add(body);
        existing.value = q;
        existing.span[1] = end;
        section(q, v.header);
        section(q, body.header);
      } else {
        this.fail("`" + key.text + "` is already " + (v.tag === "!labels" ? "a block with more labels" : "an attribute") + " here", key.span[0]);
      }
      if (nonEmpty) section(body, body.header);
      return;
    }
    parent.put(fig.entry(key, body, [start, end]));
    if (nonEmpty) section(body, body.header);
  }
}

function parse(_dialect, input) {
  const sc = fig.scanner(input);
  if (sc.bytes[0] === 0xef && sc.bytes[1] === 0xbb && sc.bytes[2] === 0xbf) sc.pos = 3;
  const p = new Parser(sc);
  const root = fig.mapping([0, sc.n], { duplicates: "error" });
  p.body(root, false);
  p.ctx.flush(root, "dangling");
  return fig.rows(root);
}

// ── the printer ───────────────────────────────────────────────────────────
// `terraform fmt`'s shape: two-space indentation, `name = value`, a block
// as `type "label" {` … `}` with a blank line between blocks, a tuple on
// one line when it is short and its items scalars, an object one entry
// per line. A string is quoted with its escapes; a `!template` and an
// `!expr` are written as they were read; a `!heredoc` as `<<-EOT`.
// Comments are `#` lines, a trailing one after its value.

function spellString(s) {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  // A literal `${` or `%{` is spelled `$${`, `%%{`.
  return out.replace(/[$%]\{/g, (m) => m[0] + m) + '"';
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const spellKey = (s) => (IDENT.test(s) ? s : spellString(s));

function isBlock(row) {
  return (row.kind === "mapping" && (row.tag === "!block" || row.tag === "!labels")) || (row.kind === "sequence" && row.items.length > 0 && row.items.every((i) => i.kind === "mapping" && i.tag === "!block"));
}

function writeComments(w, list, depth) {
  return w.comments(list, "#", depth);
}

function trailing(w, row) {
  for (const c of row.trailing) w.put(" # ", c.text);
}

function writeValue(w, row, depth) {
  const k = row.kind;
  if (k === "string") {
    if (row.tag === "!expr" || row.tag === "!template") w.put(row.tag === "!template" ? '"' + row.text + '"' : row.text);
    else if (row.tag === "!heredoc") {
      w.put("<<-EOT\n");
      const body = row.text.endsWith("\n") ? row.text.slice(0, -1) : row.text;
      for (const line of body.split("\n")) w.put(line === "" ? "" : "  ".repeat(depth + 1) + line, "\n");
      w.put("  ".repeat(depth), "EOT");
    } else w.put(spellString(row.text ?? ""));
  } else if (k === "int" || k === "float" || k === "bool") {
    w.put(row.text);
  } else if (k === "null") {
    w.put("null");
  } else if (k === "alias") {
    throw new Error("an alias must be resolved before it is written as HCL");
  } else if (k === "sequence") {
    if (row.items.length === 0) return w.put("[]");
    const flat = row.items.every((i) => fig.isScalar(i.kind) && i.tag !== "!heredoc" && i.leading.length === 0 && i.trailing.length === 0);
    if (flat) {
      const parts = [];
      const probe = fig.writer();
      for (const i of row.items) {
        writeValue(probe, i, depth);
        parts.push(probe.string());
        probe.parts.length = 0;
      }
      const line = "[" + parts.join(", ") + "]";
      if (line.length + depth * 2 <= 80) return w.put(line);
    }
    w.put("[\n");
    for (const i of row.items) {
      writeComments(w, i.leading, depth + 1);
      w.put("  ".repeat(depth + 1));
      writeValue(w, i, depth + 1);
      w.put(",");
      trailing(w, i);
      w.put("\n");
    }
    writeComments(w, row.dangling, depth + 1);
    w.put("  ".repeat(depth), "]");
  } else if (k === "mapping") {
    if (row.items.length === 0) return w.put("{}");
    w.put("{\n");
    writeBody(w, row, depth + 1);
    w.put("  ".repeat(depth), "}");
  } else {
    throw new Error("a " + k + " is not a value");
  }
}

// A blank line before a block, unless one is there.
function blank(w) {
  if (w.parts.length > 0 && !w.parts.slice(-2).join("").endsWith("\n\n")) w.put("\n");
}

// `type "label" … {` body `}` for every block under `key`; `comments`
// are the ones met on the way down, written above the first block.
function writeBlocks(w, labels, row, depth, comments) {
  if (row.kind === "sequence") {
    row.items.forEach((item, i) => writeBlocks(w, labels, item, depth, i === 0 ? comments : []));
    return;
  }
  if (row.tag === "!labels") {
    row.items.forEach((e, i) => writeBlocks(w, [...labels, e.key.text ?? ""], e.value, depth, [...(i === 0 ? comments : []), ...e.key.leading]));
    return;
  }
  blank(w);
  writeComments(w, [...comments, ...row.leading], depth);
  w.put("  ".repeat(depth), spellKey(labels[0]));
  for (const l of labels.slice(1)) w.put(" ", spellString(l));
  if (row.items.length === 0 && row.dangling.length === 0) {
    w.put(" {}");
  } else {
    w.put(" {\n");
    writeBody(w, row, depth + 1);
    w.put("  ".repeat(depth), "}");
  }
  trailing(w, row);
  w.put("\n");
}

// Whether a value is written on one line, so that the `=` of a run of
// such attributes can be aligned as `terraform fmt` aligns them.
function oneLine(row) {
  if (fig.isScalar(row.kind)) return row.tag !== "!heredoc" && !(row.tag === "!expr" && row.text.includes("\n"));
  if (row.kind === "sequence") return row.items.length === 0 || (row.items.every((i) => fig.isScalar(i.kind) && i.leading.length === 0 && i.trailing.length === 0) && row.items.every((i) => oneLine(i)));
  return row.kind === "mapping" && row.items.length === 0;
}

function writeBody(w, m, depth) {
  const attrs = m.items.filter((e) => !isBlock(e.value));
  const blocks = m.items.filter((e) => isBlock(e.value));
  // A run of one-line attributes aligns its `=`; a multi-line value ends
  // the run.
  let width = 0;
  attrs.forEach((e, i) => {
    if (e.key.kind !== "string") throw new Error("an attribute name must be a string");
    if (i === 0 || !oneLine(attrs[i - 1].value) || !oneLine(e.value)) {
      width = 0;
      for (let j = i; j < attrs.length && oneLine(attrs[j].value); j++) width = Math.max(width, spellKey(attrs[j].key.text ?? "").length);
    }
    writeComments(w, e.key.leading, depth);
    const name = spellKey(e.key.text ?? "");
    w.put("  ".repeat(depth), name, " ".repeat(oneLine(e.value) ? width - name.length : 0), " = ");
    writeValue(w, e.value, depth);
    trailing(w, e.value);
    w.put("\n");
  });
  for (const e of blocks) {
    if (e.key.kind !== "string") throw new Error("a block type must be a string");
    writeBlocks(w, [e.key.text ?? ""], e.value, depth, e.key.leading);
  }
  writeComments(w, m.dangling, depth);
}

// A value on one line: an object `{ k = v, … }`, a tuple `[a, b]`, a
// scalar as `writeValue` spells it. Splice text is this, whatever the
// width: the dialect splices raw, and a raw splice takes no line break.
function inlineValue(row) {
  if (row.kind === "mapping") {
    if (row.items.length === 0) return "{}";
    const entries = row.items.map((e) => {
      if (e.key.kind !== "string") throw new Error("an attribute name must be a string");
      return spellKey(e.key.text ?? "") + " = " + inlineValue(e.value);
    });
    return "{ " + entries.join(", ") + " }";
  }
  if (row.kind === "sequence") return "[" + row.items.map(inlineValue).join(", ") + "]";
  const w = fig.writer();
  writeValue(w, row, 0);
  return w.string();
}

function print(_dialect, t, options) {
  fig.index(t);
  const root = t.byid(0);
  const w = fig.writer();
  // Splice text: the value as it stands after `name = `, where a
  // document's root mapping is a body with no braces.
  if (options?.splice) return inlineValue(root);
  if (root.kind !== "mapping") {
    // A fragment: the value as it stands in an attribute.
    writeValue(w, root, 0);
    return w.string();
  }
  writeComments(w, root.leading, 0);
  writeBody(w, root, 0);
  return w.string();
}

// ── the renderers ─────────────────────────────────────────────────────────
// A value the CLI hands the editor is text: a number, a boolean or `null`
// by fig's own literal rules is written bare; a tuple, an object, a
// quoted string or a heredoc is spliced as written; anything else is a
// string, quoted.

function render(which, args) {
  if (which !== "value") throw new Error("no renderer `" + which + "`");
  const t = args.value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (args.literal === "int" || args.literal === "float" || args.literal === "bool" || args.literal === "null") return t;
  if (t[0] === "[" || t[0] === "{" || t[0] === '"' || t.startsWith("<<")) return t;
  return spellString(t);
}

// ── the language ──────────────────────────────────────────────────────────

export default {
  name: "js-hcl",
  caps: { read: true, edit: true, serialize: true },
  syntax: {
    comments: { style: "hash", line: { open: "#" }, trailing: { open: "#" } },
    kv_sep: " = ",
    // A block body's `{` is not a flow container — its attributes are
    // one per line, no commas — so every container is edited by line;
    // a tuple takes no item that way, and an object `{}` is not a body
    // to vivify a block with.
    empty_map_literal: null,
    flow_containers: false,
    block_seq_editable: false,
    indent_unit: "  ",
    section_noun: "container",
  },
  dialects: [{ name: "js-hcl", extensions: ["hcl", "tf", "tfvars"], splice: "raw", empty_doc_seed: "" }],
  samples: [
    'region = "us-east-1"\n\nresource "aws_instance" "web" {\n  ami           = "ami-123"\n  instance_type = var.type # size\n  tags = {\n    Name = "web"\n  }\n\n  lifecycle {\n    create_before_destroy = true\n  }\n}\n',
  ],
  renderers: ["value"],
  parse,
  print,
  render,
};
