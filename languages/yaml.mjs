// YAML, in JavaScript: the twin of fig's compiled `yaml` format, row for
// row, marker for marker, anchor for anchor.
//
// `fig lang check js-yaml --against yaml <files…>` holds this module to
// the compiled parser's node table on every file given, and this module
// is written against `fig lang table -i yaml`, which prints that table.
// What the compiled format accepts is stated in fig's
// `src/languages/yaml/` (`tokenizer.zig`, `parser.zig`, `printer.zig`,
// `editor_helper.zig`), and this follows them function for function —
// the tokenizer's line-by-line indentation structure, the parser's
// container stack and its comment layer, the printer's block style with
// a flow form where a collection fits the width.
//
// The shape, as the compiled parser builds it:
//
//   * a block mapping spans its first key through its last value; a
//     block sequence its first `-` (recorded as each item's `marker`)
//     through its last item; a flow collection its brackets; a `key:
//     value` entry spans the key through the value with the `:` as its
//     `sep` (none for an explicit `? key` entry, whose value `:` is on a
//     line of its own); an empty value is a null spanning nothing after
//     the `:`; a node's span begins at its first property (`&a !t x` is
//     one node);
//   * plain scalars resolve by the 1.2 core schema (`null`, `true`,
//     numbers; everything else a string), or by the 1.1 tag repository
//     for the `js-yaml-1.1` dialect; a quoted or block scalar is a
//     string, decoded; an int or float keeps its lexeme;
//   * a tag is kept verbatim (`!!str`, `!foo`, `!e!bar`) with its span;
//     an anchor its name and span; an alias is a node of its own,
//     naming the anchor, which must be defined earlier;
//   * a comment leads the next key, item or value, trails the value on
//     its line (or the entry, when the value is a block below), or
//     dangles on the root at the end; a comment above a collection
//     leads its first key or item;
//   * a `%TAG` directive is recorded (`directives`) and its handle may
//     be used by a tag; a `%YAML` directive is checked and dropped; a
//     second document is refused.
//
// The refusals are the compiled parser's, by name and — as the compiled
// parser reports none — without a position: `UnexpectedToken`,
// `InvalidIndent`, `TabIndent`, `UnclosedString`, `MultipleDocuments`,
// `DuplicateProperty`, `UndefinedAlias`, `InvalidDirective`,
// `UndefinedTagHandle`, `InvalidTag`, `InvalidAnchor`, `InvalidAlias`,
// `InvalidBlockHeader`, `InvalidUnicodeEscape`.
//
// Every offset is a byte offset: the tokenizer and the parser walk the
// scanner's one-char-per-byte shadow of the input (`sc.bin`), decode in
// that space, and turn a decoded string into text only as it becomes a
// row's `text`.
import * as fig from "fig";

const SP = 32, TAB = 9, NL = 10, CR = 13;
const HASH = 35, COLON = 58, DASH = 45, QUEST = 63, COMMA = 44;
const LBRACK = 91, RBRACK = 93, LBRACE = 123, RBRACE = 125;
const SQ = 39, DQ = 34, PIPE = 124, GT = 62, BANG = 33, AMP = 38, STAR = 42, PCT = 37, DOT = 46;
const BSLASH = 92, LT = 60, PLUS = 43, USCORE = 95;

const at = (s, i) => s.charCodeAt(i);
const isBlank = (c) => c === SP || c === TAB;
const isDigit = (c) => c >= 48 && c <= 57;
const isHex = (c) => isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
const isOctal = (c) => c >= 48 && c <= 55;
const isBinary = (c) => c === 48 || c === 49;
const isFlowIndicator = (c) => c === COMMA || c === LBRACK || c === RBRACK || c === LBRACE || c === RBRACE;

const fail = (name) => fig.fail(name);

// ── the tokenizer ─────────────────────────────────────────────────────────
// `tokenizer.zig`, line by line. Every token is `{kind, s, e}` over
// 0-based offsets; an `indent`/`dedent`/`newline` is structural, the rest
// is content, and `block_scalar` is the raw body of a block scalar.

// The exclusive end of a line's content given the position of its `\n`
// (or the source's end): a trailing `\r` is trimmed.
const trimCr = (src, start, nl) => (nl > start && at(src, nl - 1) === CR ? nl - 1 : nl);

function trimRightSpaces(src, start, e) {
  while (e > start && at(src, e - 1) === SP) e -= 1;
  return e;
}

function whitespaceEnd(src, start, lineEnd) {
  let e = start;
  while (e < lineEnd && isBlank(at(src, e))) e += 1;
  return e;
}

const followedByBlank = (src, i, lineEnd) => i + 1 >= lineEnd || isBlank(at(src, i + 1));

function colonIsIndicator(src, i, lineEnd, flow) {
  if (followedByBlank(src, i, lineEnd)) return true;
  if (!flow) return false;
  const c = at(src, i + 1);
  return c === COMMA || c === RBRACK || c === RBRACE;
}

function scalarEnd(src, start, lineEnd, flow) {
  let e = start;
  while (e < lineEnd) {
    const c = at(src, e);
    if (c === COLON) {
      if (colonIsIndicator(src, e, lineEnd, flow)) break;
    } else if (c === HASH) {
      if (e > start && isBlank(at(src, e - 1))) break;
    } else if (isFlowIndicator(c)) {
      if (flow) break;
    }
    e += 1;
  }
  return e;
}

function tagEnd(src, start, lineEnd) {
  let e = start + 1;
  if (e < lineEnd && at(src, e) === LT) {
    e += 1;
    const verbatimStart = e;
    while (e < lineEnd && at(src, e) !== GT) e += 1;
    if (e >= lineEnd || e === verbatimStart) return null;
    return e + 1;
  }
  while (e < lineEnd) {
    const c = at(src, e);
    if (c === SP || c === TAB || isFlowIndicator(c)) break;
    e += 1;
  }
  return e;
}

function anchorNameEnd(src, start, lineEnd) {
  let e = start;
  while (e < lineEnd) {
    const c = at(src, e);
    if (c === SP || c === TAB || isFlowIndicator(c)) break;
    e += 1;
  }
  return e;
}

function tagSeparated(src, e, lineEnd, flow) {
  if (e >= lineEnd) return true;
  const c = at(src, e);
  if (c === SP || c === TAB) return true;
  if (isFlowIndicator(c)) return flow;
  return false;
}

function blockHeaderEnd(src, start, lineEnd) {
  let i = start + 1;
  let seenChomp = false;
  let seenIndent = false;
  while (i < lineEnd) {
    const c = at(src, i);
    if (c === PLUS || c === DASH) {
      if (seenChomp) return null;
      seenChomp = true;
    } else if (c >= 49 && c <= 57) {
      if (seenIndent) return null;
      seenIndent = true;
    } else {
      break;
    }
    i += 1;
  }
  const indicatorsEnd = i;
  while (i < lineEnd && isBlank(at(src, i))) i += 1;
  if (i < lineEnd) {
    if (at(src, i) !== HASH || i === indicatorsEnd) return null;
  }
  return indicatorsEnd;
}

function explicitIndent(src, start, headerEnd) {
  for (let i = start + 1; i < headerEnd; i++) {
    const c = at(src, i);
    if (c >= 49 && c <= 57) return c - 48;
  }
  return null;
}

const plainContinuationStart = (c) =>
  !(c === HASH || isFlowIndicator(c) || c === SQ || c === DQ || c === AMP || c === STAR || c === BANG ||
    c === PIPE || c === GT || c === 64 || c === 96 || c === PCT);

class Tokenizer {
  constructor(src) {
    this.src = src;
    this.n = src.length;
    this.i = 0;
    this.tokens = [];
    this.pendingBlock = null;
    this.flowDepth = 0;
    this.flowOpenIndent = 0;
    this.flowRoot = false;
  }

  add(kind, s, e) {
    this.tokens.push({ kind, s, e });
  }

  getLine() {
    if (this.i >= this.n) return null;
    const src = this.src;
    const start = this.i;
    const nl = src.indexOf("\n", start);
    const rawEnd = nl === -1 ? this.n : nl;
    this.i = nl === -1 ? this.n : nl + 1;
    const e = trimCr(src, start, rawEnd);
    let contentStart = start;
    while (contentStart < e && at(src, contentStart) === SP) contentStart += 1;
    return { start, contentStart, e, newlineEnd: this.i };
  }

  lineAllWs(line) {
    for (let i = line.contentStart; i < line.e; i++) {
      if (!isBlank(at(this.src, i))) return false;
    }
    return true;
  }

  docMarker(line) {
    const src = this.src;
    const cs = line.contentStart;
    if (line.e - cs < 3) return null;
    const c = at(src, cs);
    if (c !== DASH && c !== DOT) return null;
    if (at(src, cs + 1) !== c || at(src, cs + 2) !== c) return null;
    if (cs + 3 !== line.e && !isBlank(at(src, cs + 3))) return null;
    return c === DASH ? "doc_start" : "doc_end";
  }

  docMarkerAt(pos) {
    const src = this.src;
    if (pos + 3 > this.n) return false;
    const c = at(src, pos);
    if (c !== DASH && c !== DOT) return false;
    if (at(src, pos + 1) !== c || at(src, pos + 2) !== c) return false;
    const after = at(src, pos + 3);
    return pos + 3 >= this.n || after === NL || after === CR || isBlank(after);
  }

  lineIsPropertyOnly(line) {
    if (this.flowDepth > 0) return false;
    const src = this.src;
    let i = line.contentStart;
    let saw = false;
    while (i < line.e) {
      const c = at(src, i);
      if (c === SP || c === TAB) {
        i += 1;
      } else if (c === HASH) {
        return saw;
      } else if (c === AMP) {
        const e = anchorNameEnd(src, i + 1, line.e);
        if (e === i + 1) return false;
        i = e;
        saw = true;
      } else if (c === BANG) {
        const e = tagEnd(src, i, line.e);
        if (e === null) return false;
        i = e;
        saw = true;
      } else {
        return false;
      }
    }
    return saw;
  }

  tabIndentedStructure(line) {
    const src = this.src;
    const cs = line.contentStart;
    if (cs >= line.e || at(src, cs) !== TAB) return false;
    let ws = cs;
    while (ws < line.e && isBlank(at(src, ws))) ws += 1;
    if (ws >= line.e) return false;
    const fc = at(src, ws);
    if (fc === DASH && (ws + 1 >= line.e || isBlank(at(src, ws + 1)))) return true;
    const se = scalarEnd(src, ws, line.e, false);
    return se < line.e && at(src, se) === COLON;
  }

  remainderLine(pos) {
    const src = this.src;
    const nl = src.indexOf("\n", pos);
    const nl0 = nl === -1 ? this.n : nl;
    const newlineEnd = nl === -1 ? this.n : nl + 1;
    return { start: pos, contentStart: pos, e: trimCr(src, pos, nl0), newlineEnd };
  }

  columnOf(pos) {
    let i = pos;
    while (i > 0 && at(this.src, i - 1) !== NL) i -= 1;
    return pos - i;
  }

  precededOnlyByTrivia() {
    for (const t of this.tokens) {
      const k = t.kind;
      if (!(k === "doc_start" || k === "newline" || k === "whitespace" || k === "comment" ||
        k === "tag" || k === "anchor" || k === "directive")) return false;
    }
    return true;
  }

  deferredOwnerIndent() {
    const toks = this.tokens;
    let idx = toks.length;
    while (idx > 0) {
      const k = toks[idx - 1].kind;
      if (k === "whitespace" || k === "newline" || k === "comment" || k === "indent" || k === "dedent" ||
        k === "tag" || k === "anchor") {
        idx -= 1;
      } else if (k === "colon") {
        let j = idx - 1;
        while (j > 0) {
          const kk = toks[j - 1].kind;
          if (kk === "whitespace" || kk === "comment") j -= 1;
          else break;
        }
        if (j === 0) return null;
        return this.columnOf(toks[j - 1].s);
      } else if (k === "dash") {
        return this.columnOf(toks[idx - 1].s);
      } else {
        return null;
      }
    }
    return null;
  }

  jsonKeyColon() {
    if (this.flowDepth === 0) return false;
    const toks = this.tokens;
    let idx = toks.length;
    while (idx > 0) {
      const k = toks[idx - 1].kind;
      if (k === "whitespace" || k === "newline" || k === "comment") idx -= 1;
      else break;
    }
    if (idx === 0) return false;
    const prev = toks[idx - 1];
    if (prev.kind === "flow_seq_end" || prev.kind === "flow_map_end") return true;
    if (prev.kind === "scalar") {
      const c = at(this.src, prev.s);
      return prev.e > prev.s && (c === DQ || c === SQ);
    }
    return false;
  }

  openFlow(line) {
    this.flowOpenIndent = line.contentStart - line.start;
    this.flowRoot = this.precededOnlyByTrivia();
  }

  addScalar(s, e) {
    const te = trimRightSpaces(this.src, s, e);
    if (te > s) this.add("scalar", s, te);
  }

  flowPlainEnd(start) {
    const src = this.src;
    const n = this.n;
    let i = start;
    let lastContent = start;
    while (i < n) {
      const c = at(src, i);
      if (c === NL) {
        if (this.docMarkerAt(i + 1)) break;
        i += 1;
        while (i < n && (at(src, i) === SP || at(src, i) === TAB)) i += 1;
        if (i < n && at(src, i) === HASH) break;
      } else if (isFlowIndicator(c)) {
        break;
      } else if (c === CR) {
        i += 1;
      } else if (c === COLON) {
        const nx = i + 1 < n ? at(src, i + 1) : 0;
        if (nx === 0 || nx === SP || nx === TAB || nx === NL || nx === CR || nx === COMMA || nx === RBRACK || nx === RBRACE) break;
        i += 1;
        lastContent = i;
      } else if (c === HASH) {
        if (i > start && isBlank(at(src, i - 1))) break;
        i += 1;
        lastContent = i;
      } else {
        i += 1;
        if (!isBlank(c)) lastContent = i;
      }
    }
    return lastContent;
  }

  gatherPlainContinuation(line, floor) {
    const src = this.src;
    const n = this.n;
    let probe = line.newlineEnd;
    let result = null;
    while (probe < n) {
      const lineStart = probe;
      const nl = src.indexOf("\n", lineStart);
      const nl0 = nl === -1 ? n : nl;
      const newlineEnd = nl === -1 ? n : nl + 1;
      const e = trimCr(src, lineStart, nl0);
      let spaces = lineStart;
      while (spaces < e && at(src, spaces) === SP) spaces += 1;
      let ws = lineStart;
      while (ws < e && isBlank(at(src, ws))) ws += 1;
      if (ws === e) {
        probe = newlineEnd;
        continue;
      }
      if (floor !== null && spaces - lineStart <= floor) break;
      const fc = at(src, ws);
      if (fc === HASH) break;
      if ((fc === DASH || fc === QUEST || fc === COLON) && (ws + 1 >= e || isBlank(at(src, ws + 1)))) break;
      const se = scalarEnd(src, ws, e, false);
      if (se !== e) {
        if (at(src, se) === HASH) {
          result = {
            contentEnd: trimRightSpaces(src, ws, se),
            lastLine: { start: lineStart, contentStart: spaces, e, newlineEnd },
          };
        }
        break;
      }
      result = {
        contentEnd: trimRightSpaces(src, ws, e),
        lastLine: { start: lineStart, contentStart: spaces, e, newlineEnd },
      };
      probe = newlineEnd;
    }
    if (result) this.i = result.lastLine.newlineEnd;
    return result;
  }

  // A plain scalar from `start`; returns the (possibly advanced) line and
  // the cursor after it.
  handlePlain(start, line) {
    const src = this.src;
    const flow = this.flowDepth > 0;
    if (flow) {
      const fend = this.flowPlainEnd(start);
      if (fend > start) this.add("scalar", start, fend);
      if (fend > line.e) {
        line = this.remainderLine(fend);
        this.i = line.newlineEnd;
      }
      return [line, fend];
    }
    const e = scalarEnd(src, start, line.e, false);
    if (e === line.e && plainContinuationStart(at(src, start))) {
      const indent = line.contentStart - line.start;
      let floor;
      if (this.precededOnlyByTrivia() && start === line.contentStart) floor = null;
      else if (start === line.contentStart) floor = indent > 0 ? indent - 1 : 0;
      else floor = indent;
      const g = this.gatherPlainContinuation(line, floor);
      if (g) {
        this.add("scalar", start, g.contentEnd);
        return [g.lastLine, g.lastLine.e];
      }
    }
    this.addScalar(start, e);
    return [line, e];
  }

  multilineQuotedEnd(start, floor) {
    const src = this.src;
    const n = this.n;
    const double = at(src, start) === DQ;
    let i = start + 1;
    while (i < n) {
      const c = at(src, i);
      if (c === NL) {
        const lineStart = i + 1;
        if (this.docMarkerAt(lineStart)) fail("UnclosedString");
        let spaces = lineStart;
        while (spaces < n && at(src, spaces) === SP) spaces += 1;
        let ws = lineStart;
        while (ws < n && isBlank(at(src, ws))) ws += 1;
        const wc = at(src, ws);
        const blank = ws >= n || wc === NL || wc === CR;
        if (!blank && floor !== null && spaces - lineStart <= floor) fail("InvalidIndent");
        i += 1;
      } else if (double) {
        if (c === BSLASH) {
          if (at(src, i + 1) === NL) i += 1;
          else i += 2;
        } else if (c === DQ) {
          return i + 1;
        } else {
          i += 1;
        }
      } else if (c === SQ) {
        if (at(src, i + 1) === SQ) i += 2;
        else return i + 1;
      } else {
        i += 1;
      }
    }
    fail("UnclosedString");
  }

  flushPendingBlock() {
    const info = this.pendingBlock;
    if (!info) return;
    this.pendingBlock = null;
    this.consumeBlockBody(info);
  }

  consumeBlockBody(info) {
    const src = this.src;
    const n = this.n;
    const bodyStart = this.i;
    let contentIndent = info.explicitIndent !== null ? info.headerIndent + info.explicitIndent : null;
    let maxLeadingBlank = 0;
    let minBlankTab = null;
    let lastEnd = bodyStart;
    while (this.i < n) {
      const lineStart = this.i;
      const nl = src.indexOf("\n", lineStart);
      const nl0 = nl === -1 ? n : nl;
      const newlineEnd = nl === -1 ? n : nl + 1;
      const e = trimCr(src, lineStart, nl0);
      let spaces = lineStart;
      while (spaces < e && at(src, spaces) === SP) spaces += 1;
      let ws = lineStart;
      while (ws < e && isBlank(at(src, ws))) ws += 1;
      const blank = ws === e;
      const indent = spaces - lineStart;
      if (blank) {
        if (contentIndent === null) {
          if (ws > spaces && (info.root || indent > info.headerIndent)) {
            if (maxLeadingBlank > indent) fail("InvalidIndent");
            contentIndent = indent;
          } else {
            if (ws > spaces) {
              const tabCol = spaces - lineStart;
              if (minBlankTab === null || tabCol < minBlankTab) minBlankTab = tabCol;
            }
            if (indent > maxLeadingBlank) maxLeadingBlank = indent;
          }
        }
      } else {
        if (info.root && indent === 0 && this.docMarkerAt(lineStart)) break;
        if (contentIndent !== null) {
          if (indent < contentIndent) break;
        } else {
          if (!info.root && indent <= info.headerIndent) break;
          if (maxLeadingBlank > indent) fail("InvalidIndent");
          if (minBlankTab !== null && minBlankTab < indent) fail("TabIndent");
          contentIndent = indent;
        }
      }
      this.i = newlineEnd;
      lastEnd = newlineEnd;
    }
    if (contentIndent === null && minBlankTab !== null) fail("TabIndent");
    if (lastEnd > bodyStart) this.add("block_scalar", bodyStart, lastEnd);
  }

  tokenizeLineContent(lineIn) {
    const src = this.src;
    let line = lineIn;
    let cursor = line.contentStart;
    let atContentStart = true;
    let blockOwnerIndent = line.contentStart - line.start;
    let nodeStart = line.contentStart;

    while (cursor < line.e) {
      const c = at(src, cursor);
      if (atContentStart && c !== SP && c !== TAB) nodeStart = cursor;
      const flow = this.flowDepth > 0;

      if (c === SP || c === TAB) {
        const e = whitespaceEnd(src, cursor, line.e);
        this.add("whitespace", cursor, e);
        cursor = e;
      } else if (c === HASH) {
        if (cursor === line.contentStart || isBlank(at(src, cursor - 1))) {
          this.add("comment", cursor, line.e);
          return;
        }
        [line, cursor] = this.handlePlain(cursor, line);
        atContentStart = false;
      } else if (c === COLON) {
        if (colonIsIndicator(src, cursor, line.e, flow) || this.jsonKeyColon()) {
          if (!flow && nodeStart >= line.start) blockOwnerIndent = nodeStart - line.start;
          this.add("colon", cursor, cursor + 1);
          cursor += 1;
          atContentStart = true;
        } else {
          [line, cursor] = this.handlePlain(cursor, line);
          atContentStart = false;
        }
      } else if (c === LBRACK || c === LBRACE) {
        if (this.flowDepth === 0) this.openFlow(line);
        this.add(c === LBRACK ? "flow_seq_start" : "flow_map_start", cursor, cursor + 1);
        this.flowDepth += 1;
        cursor += 1;
        atContentStart = false;
      } else if (c === RBRACK || c === RBRACE) {
        this.add(c === RBRACK ? "flow_seq_end" : "flow_map_end", cursor, cursor + 1);
        if (this.flowDepth > 0) this.flowDepth -= 1;
        cursor += 1;
        atContentStart = false;
      } else if (c === COMMA) {
        if (flow) {
          this.add("comma", cursor, cursor + 1);
          cursor += 1;
          atContentStart = false;
        } else {
          [line, cursor] = this.handlePlain(cursor, line);
          atContentStart = false;
        }
      } else if (c === SQ || c === DQ) {
        const floor = this.precededOnlyByTrivia() || cursor === line.contentStart ? null : line.contentStart - line.start;
        const e = this.multilineQuotedEnd(cursor, floor);
        if (e > line.e) {
          this.add("scalar", cursor, e);
          line = this.remainderLine(e);
          this.i = line.newlineEnd;
          cursor = e;
          atContentStart = false;
        } else {
          this.addScalar(cursor, e);
          cursor = e;
          atContentStart = false;
        }
      } else if (c === PIPE || c === GT) {
        if (!flow) {
          const hdrEnd = blockHeaderEnd(src, cursor, line.e);
          if (hdrEnd !== null) {
            const root = this.precededOnlyByTrivia();
            let owner;
            if (cursor === line.contentStart) {
              const d = this.deferredOwnerIndent();
              owner = d !== null ? d : blockOwnerIndent;
            } else {
              owner = blockOwnerIndent;
            }
            this.add("block_header", cursor, hdrEnd);
            let rest = hdrEnd;
            while (rest < line.e && isBlank(at(src, rest))) rest += 1;
            if (rest < line.e && at(src, rest) === HASH) this.add("comment", rest, line.e);
            this.pendingBlock = { headerIndent: owner, explicitIndent: explicitIndent(src, cursor, hdrEnd), root };
            return;
          }
          fail("InvalidBlockHeader");
        }
        [line, cursor] = this.handlePlain(cursor, line);
        atContentStart = false;
      } else if (c === DASH) {
        if (!flow && atContentStart && followedByBlank(src, cursor, line.e)) {
          if (cursor > line.contentStart && at(src, cursor - 1) === TAB) fail("TabIndent");
          blockOwnerIndent = cursor - line.start;
          this.add("dash", cursor, cursor + 1);
          cursor += 1;
          atContentStart = true;
        } else {
          [line, cursor] = this.handlePlain(cursor, line);
          atContentStart = false;
        }
      } else if (c === QUEST) {
        if ((flow || atContentStart) && followedByBlank(src, cursor, line.e)) {
          this.add("explicit_key", cursor, cursor + 1);
          cursor += 1;
        } else {
          [line, cursor] = this.handlePlain(cursor, line);
          atContentStart = false;
        }
      } else if (c === BANG) {
        if (flow || atContentStart) {
          const e = tagEnd(src, cursor, line.e);
          if (e !== null) {
            if (!tagSeparated(src, e, line.e, flow)) fail("InvalidTag");
            this.add("tag", cursor, e);
            cursor = e;
          } else {
            fail("InvalidTag");
          }
        } else {
          [line, cursor] = this.handlePlain(cursor, line);
          atContentStart = false;
        }
      } else if (c === AMP) {
        if (flow || atContentStart) {
          const e = anchorNameEnd(src, cursor + 1, line.e);
          if (e === cursor + 1 || !tagSeparated(src, e, line.e, flow)) fail("InvalidAnchor");
          this.add("anchor", cursor, e);
          cursor = e;
        } else {
          [line, cursor] = this.handlePlain(cursor, line);
          atContentStart = false;
        }
      } else if (c === STAR) {
        if (flow || atContentStart) {
          const e = anchorNameEnd(src, cursor + 1, line.e);
          if (e === cursor + 1 || !tagSeparated(src, e, line.e, flow)) fail("InvalidAlias");
          this.add("alias", cursor, e);
          cursor = e;
          atContentStart = false;
        } else {
          [line, cursor] = this.handlePlain(cursor, line);
          atContentStart = false;
        }
      } else {
        [line, cursor] = this.handlePlain(cursor, line);
        atContentStart = false;
      }
    }

    if (line.start !== lineIn.start && line.newlineEnd > line.e) {
      this.add("newline", line.e, line.newlineEnd);
    }
  }

  tokenize() {
    const src = this.src;
    const indentStack = [{ indent: 0, propOnly: false, seqContent: null }];
    let currentIndent = 0;

    for (;;) {
      const line = this.getLine();
      if (!line) break;
      if (line.contentStart === line.e || this.lineAllWs(line)) continue;

      if (this.flowDepth > 0) {
        if (line.contentStart === line.start) {
          const kind = this.docMarker(line);
          if (kind) {
            const cs = line.contentStart;
            this.add(kind, cs, cs + 3);
            if (line.newlineEnd > line.e) this.add("newline", line.e, line.newlineEnd);
            continue;
          }
        }
        const indent = line.contentStart - line.start;
        const first = at(src, line.contentStart);
        if (!this.flowRoot && first !== RBRACK && first !== RBRACE && indent <= this.flowOpenIndent) fail("InvalidIndent");
        this.tokenizeLineContent(line);
        if (this.i === line.newlineEnd && line.newlineEnd > line.e) this.add("newline", line.e, line.newlineEnd);
        continue;
      }

      if (at(src, line.contentStart) === HASH) {
        this.add("comment", line.contentStart, line.e);
        if (line.newlineEnd > line.e) this.add("newline", line.e, line.newlineEnd);
        continue;
      }

      const indent = line.contentStart - line.start;
      const propOnly = this.lineIsPropertyOnly(line);
      if (indent > currentIndent) {
        indentStack.push({ indent, propOnly, seqContent: null });
        this.add("indent", line.start, line.contentStart);
        currentIndent = indent;
      } else if (indent < currentIndent) {
        while (indent < currentIndent) {
          const popped = indentStack.pop();
          currentIndent = indentStack[indentStack.length - 1].indent;
          if (popped.propOnly && indent > currentIndent) {
            indentStack.push({ indent, propOnly, seqContent: null });
            currentIndent = indent;
            break;
          }
          this.add("dedent", line.contentStart, line.contentStart);
        }
        if (indent !== currentIndent && indent > currentIndent && indentStack[indentStack.length - 1].seqContent === indent) {
          indentStack.push({ indent, propOnly, seqContent: null });
          currentIndent = indent;
        }
        if (indent !== currentIndent) fail("InvalidIndent");
      }

      if (at(src, line.contentStart) === DASH && followedByBlank(src, line.contentStart, line.e)) {
        let c = line.contentStart + 1;
        while (c < line.e && at(src, c) === SP) c += 1;
        if (c < line.e) indentStack[indentStack.length - 1].seqContent = c - line.start;
      }

      if (indent === 0) {
        const kind = this.docMarker(line);
        if (kind) {
          const cs = line.contentStart;
          this.add(kind, cs, cs + 3);
          let rest = cs + 3;
          while (rest < line.e && isBlank(at(src, rest))) rest += 1;
          if (rest < line.e) {
            this.tokenizeLineContent({ start: rest, contentStart: rest, e: line.e, newlineEnd: line.newlineEnd });
          }
          if (this.i === line.newlineEnd) {
            if (line.newlineEnd > line.e) this.add("newline", line.e, line.newlineEnd);
            this.flushPendingBlock();
          }
          continue;
        }
      }

      if (indent === 0 && at(src, line.contentStart) === PCT) {
        this.add("directive", line.contentStart, line.e);
        if (line.newlineEnd > line.e) this.add("newline", line.e, line.newlineEnd);
        continue;
      }

      if (this.tabIndentedStructure(line)) fail("TabIndent");

      this.tokenizeLineContent(line);
      if (this.i === line.newlineEnd) {
        if (line.newlineEnd > line.e) this.add("newline", line.e, line.newlineEnd);
        this.flushPendingBlock();
      }
    }

    while (indentStack.length > 1) {
      indentStack.pop();
      this.add("dedent", this.i, this.i);
    }
    this.add("end_of_file", this.i, this.i);
    return this.tokens;
  }
}

// ── scalars ───────────────────────────────────────────────────────────────
// Decoding and resolution, as `parser.zig` does them, over the byte
// shadow: the folds and escapes of quoted strings, the chomping of block
// scalars, and the plain-scalar schema of each dialect.

const eqlAny = (s, list) => list.includes(s);

// Folds a run of line breaks where `inner[i]` is a newline; returns the
// index past the run. `out` is a list of one-byte strings.
function foldFlowBreak(out, inner, i) {
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last !== " " && last !== "\t") break;
    out.pop();
  }
  i += 1;
  let breaks = 1;
  for (;;) {
    while (i < inner.length && (at(inner, i) === SP || at(inner, i) === TAB)) i += 1;
    if (i < inner.length && at(inner, i) === CR && at(inner, i + 1) === NL) i += 1;
    if (i < inner.length && at(inner, i) === NL) {
      breaks += 1;
      i += 1;
    } else {
      break;
    }
  }
  if (breaks === 1) out.push(" ");
  else for (let k = 0; k < breaks - 1; k++) out.push("\n");
  return i;
}

function foldPlainScalar(source) {
  const out = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = at(source, i);
    if (c === CR && at(source, i + 1) === NL) i += 1;
    else if (c === NL) i = foldFlowBreak(out, source, i);
    else {
      out.push(source[i]);
      i += 1;
    }
  }
  return out.join("");
}

function singleQuoted(source) {
  if (source.length < 2 || at(source, 0) !== SQ || at(source, source.length - 1) !== SQ) fail("UnclosedString");
  const inner = source.slice(1, -1);
  if (!inner.includes("'") && !inner.includes("\n")) return inner;
  const out = [];
  let i = 0;
  const n = inner.length;
  while (i < n) {
    const c = at(inner, i);
    if (c === CR && at(inner, i + 1) === NL) i += 1;
    else if (c === NL) i = foldFlowBreak(out, inner, i);
    else if (c !== SQ) {
      out.push(inner[i]);
      i += 1;
    } else {
      if (at(inner, i + 1) !== SQ) fail("UnexpectedToken");
      out.push("'");
      i += 2;
    }
  }
  return out.join("");
}

// The UTF-8 bytes of a codepoint, as a one-char-per-byte string.
function utf8Of(cp) {
  if ((cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) fail("InvalidUnicodeEscape");
  return fig.binOf(String.fromCodePoint(cp));
}

// `std.fmt.parseInt(u21, …, 16)` of the next `digits` bytes, quirks and
// all: a leading sign and interior `_` separators are accepted there.
function hexEscape(inner, start, digits) {
  if (start + digits > inner.length) fail("UnclosedString");
  let h = inner.slice(start, start + digits);
  let neg = false;
  if (at(h, 0) === PLUS) h = h.slice(1);
  else if (at(h, 0) === DASH) {
    neg = true;
    h = h.slice(1);
  }
  if (h.length === 0 || at(h, 0) === USCORE || at(h, h.length - 1) === USCORE || !/^[0-9a-fA-F_]+$/.test(h)) fail("InvalidUnicodeEscape");
  const v = parseInt(h.replace(/_/g, ""), 16);
  if (v > 0x1fffff || (neg && v !== 0)) fail("InvalidUnicodeEscape");
  return v;
}

const SIMPLE_ESCAPES = new Map([
  [48, "\0"], [97, "\x07"], [98, "\b"], [116, "\t"], [TAB, "\t"], [110, "\n"], [118, "\v"],
  [102, "\f"], [114, "\r"], [101, "\x1b"], [SP, " "], [DQ, '"'], [47, "/"], [BSLASH, "\\"],
]);
const CODEPOINT_ESCAPES = new Map([[78, 0x85], [USCORE, 0xa0], [76, 0x2028], [80, 0x2029]]);

function doubleQuoted(source) {
  if (source.length < 2 || at(source, 0) !== DQ || at(source, source.length - 1) !== DQ) fail("UnclosedString");
  const inner = source.slice(1, -1);
  if (!inner.includes("\\") && !inner.includes("\n")) return inner;
  const out = [];
  let i = 0;
  const n = inner.length;
  while (i < n) {
    const c = at(inner, i);
    if (c === CR && at(inner, i + 1) === NL) i += 1;
    else if (c === NL) i = foldFlowBreak(out, inner, i);
    else if (c !== BSLASH) {
      out.push(inner[i]);
      i += 1;
    } else {
      i += 1;
      if (i >= n) fail("UnclosedString");
      if (at(inner, i) === CR && at(inner, i + 1) === NL) i += 1;
      if (at(inner, i) === NL) {
        i += 1;
        while (i < n && (at(inner, i) === SP || at(inner, i) === TAB)) i += 1;
      } else {
        const e = at(inner, i);
        if (SIMPLE_ESCAPES.has(e)) {
          out.push(SIMPLE_ESCAPES.get(e));
        } else if (CODEPOINT_ESCAPES.has(e)) {
          out.push(utf8Of(CODEPOINT_ESCAPES.get(e)));
        } else if (e === 120) {
          out.push(utf8Of(hexEscape(inner, i + 1, 2)));
          i += 2;
        } else if (e === 117) {
          out.push(utf8Of(hexEscape(inner, i + 1, 4)));
          i += 4;
        } else if (e === 85) {
          out.push(utf8Of(hexEscape(inner, i + 1, 8)));
          i += 8;
        } else {
          fail("UnexpectedToken");
        }
        i += 1;
      }
    }
  }
  return out.join("");
}

// The physical lines of `s`, `\r\n` read as one break; a trailing newline
// yields a final empty line, as the compiled iterator's does.
function linesOf(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  for (;;) {
    const nl = s.indexOf("\n", i);
    const e = nl === -1 ? n : nl;
    let le = e;
    if (le > i && at(s, le - 1) === CR) le -= 1;
    out.push(s.slice(i, le));
    if (nl === -1) break;
    i = nl + 1;
  }
  return out;
}

const isAllWs = (line) => /^[ \t]*$/.test(line);

function dedentLine(line, n) {
  let k = 0;
  while (k < n && k < line.length && at(line, k) === SP) k += 1;
  return line.slice(k);
}

function autodetectIndent(body) {
  for (const line of linesOf(body)) {
    if (!isAllWs(line)) {
      let k = 0;
      while (k < line.length && at(line, k) === SP) k += 1;
      return k;
    }
  }
  return 0;
}

function decodeBlockScalar(header, parentIndent, body) {
  const literal = at(header, 0) === PIPE;
  let chomp = "clip";
  let explicit = null;
  for (let i = 1; i < header.length; i++) {
    const c = at(header, i);
    if (c === DASH) chomp = "strip";
    else if (c === PLUS) chomp = "keep";
    else if (c >= 49 && c <= 57) explicit = c - 48;
  }
  const contentIndent = explicit !== null ? parentIndent + explicit : autodetectIndent(body);
  const endsNl = body.length > 0 && at(body, body.length - 1) === NL;
  const work = endsNl ? body.slice(0, -1) : body;
  const lines = linesOf(work);
  const totalLines = lines.length;
  let lastContent = null;
  lines.forEach((line, idx) => {
    if (!isAllWs(line)) lastContent = idx;
  });
  const out = [];
  if (lastContent !== null) {
    let emitted = false;
    let prevBlank = false;
    let prevMore = false;
    for (let idx = 0; idx < lines.length; idx++) {
      if (idx > lastContent) break;
      const line = lines[idx];
      const blank = isAllWs(line);
      const text = blank ? "" : dedentLine(line, contentIndent);
      const more = text.length > 0 && at(text, 0) === SP;
      if (literal) {
        if (emitted) out.push("\n");
        out.push(text);
      } else if (!emitted) {
        out.push(text);
      } else if (blank) {
        out.push("\n");
      } else {
        if (prevBlank) {
          // the blank line already emitted the break
        } else if (prevMore || more) {
          out.push("\n");
        } else {
          out.push(" ");
        }
        out.push(text);
      }
      emitted = true;
      prevBlank = blank;
      prevMore = more && !blank;
    }
    const trailingBlanks = totalLines - 1 - lastContent;
    const presentBreaks = trailingBlanks + (endsNl ? 1 : 0);
    const keep = chomp === "strip" ? 0 : chomp === "clip" ? Math.min(presentBreaks, 1) : presentBreaks;
    for (let k = 0; k < keep; k++) out.push("\n");
  } else if (chomp === "keep") {
    const presentBreaks = Math.max(totalLines - 1, 0) + (endsNl ? 1 : 0);
    for (let k = 0; k < presentBreaks; k++) out.push("\n");
  }
  return out.join("");
}

function isInfNan(source) {
  let body = source;
  const c = at(source, 0);
  if (c === PLUS || c === DASH) body = source.slice(1);
  if (eqlAny(body, [".inf", ".Inf", ".INF"])) return true;
  return eqlAny(source, [".nan", ".NaN", ".NAN"]);
}

// The 1.2 core schema's numbers: "int", "float" or null.
function classifyNumber(source) {
  const n = source.length;
  if (n === 0) return null;
  if (isInfNan(source)) return "float";
  if (n > 2 && at(source, 0) === 48 && (at(source, 1) === 120 || at(source, 1) === 111)) {
    const hex = at(source, 1) === 120;
    for (let i = 2; i < n; i++) {
      const c = at(source, i);
      if (!(hex ? isHex(c) : isOctal(c))) return null;
    }
    return "int";
  }
  let i = 0;
  const c0 = at(source, 0);
  if (c0 === PLUS || c0 === DASH) i = 1;
  let mantissa = 0;
  while (i < n && isDigit(at(source, i))) {
    i += 1;
    mantissa += 1;
  }
  let float = false;
  if (i < n && at(source, i) === DOT) {
    float = true;
    i += 1;
    while (i < n && isDigit(at(source, i))) {
      i += 1;
      mantissa += 1;
    }
  }
  if (mantissa === 0) return null;
  if (i < n && (at(source, i) === 101 || at(source, i) === 69)) {
    float = true;
    i += 1;
    if (i < n && (at(source, i) === PLUS || at(source, i) === DASH)) i += 1;
    let exp = 0;
    while (i < n && isDigit(at(source, i))) {
      i += 1;
      exp += 1;
    }
    if (exp === 0) return null;
  }
  if (i !== n) return null;
  return float ? "float" : "int";
}

// ── YAML 1.1 resolution ───────────────────────────────────────────────────

function bool11(source) {
  if (eqlAny(source, ["y", "Y", "yes", "Yes", "YES", "true", "True", "TRUE", "on", "On", "ON"])) return true;
  if (eqlAny(source, ["n", "N", "no", "No", "NO", "false", "False", "FALSE", "off", "Off", "OFF"])) return false;
  return null;
}

function digitRun(s, pred) {
  let any = false;
  for (let i = 0; i < s.length; i++) {
    const c = at(s, i);
    if (c !== USCORE) {
      if (!pred(c)) return false;
      any = true;
    }
  }
  return any;
}

function is11Base10Float(s) {
  let i = 0;
  const n = s.length;
  if (i < n && isDigit(at(s, i))) {
    i += 1;
    while (i < n && (isDigit(at(s, i)) || at(s, i) === USCORE)) i += 1;
  }
  if (i >= n || at(s, i) !== DOT) return false;
  i += 1;
  while (i < n && (isDigit(at(s, i)) || at(s, i) === USCORE)) i += 1;
  if (i < n && (at(s, i) === 101 || at(s, i) === 69)) {
    i += 1;
    if (i >= n || (at(s, i) !== PLUS && at(s, i) !== DASH)) return false;
    i += 1;
    let exp = 0;
    while (i < n && isDigit(at(s, i))) {
      i += 1;
      exp += 1;
    }
    if (exp === 0) return false;
  }
  return i === n;
}

function classify11Base60(s) {
  let body = s;
  let float = false;
  const dot = s.indexOf(".");
  if (dot !== -1) {
    float = true;
    for (let i = dot + 1; i < s.length; i++) {
      const c = at(s, i);
      if (!(isDigit(c) || c === USCORE)) return null;
    }
    body = s.slice(0, dot);
  }
  const groups = body.split(":");
  let trailing = 0;
  for (let idx = 0; idx < groups.length; idx++) {
    const g = groups[idx];
    if (g.length === 0) return null;
    if (idx === 0) {
      if (!isDigit(at(g, 0))) return null;
      if (!float && at(g, 0) === 48) return null;
      for (let i = 1; i < g.length; i++) {
        const c = at(g, i);
        if (!(isDigit(c) || c === USCORE)) return null;
      }
    } else {
      if (g.length > 2) return null;
      for (let i = 0; i < g.length; i++) if (!isDigit(at(g, i))) return null;
      if (g.length === 2 && at(g, 0) > 53) return null;
      trailing += 1;
    }
  }
  if (trailing === 0) return null;
  return float ? "float" : "int";
}

function classify11Number(source) {
  if (source.length === 0) return null;
  if (isInfNan(source)) return "float";
  let s = source;
  const c = at(s, 0);
  if (c === PLUS || c === DASH) s = s.slice(1);
  if (s.length === 0) return null;
  if (s.includes(":")) return classify11Base60(s);
  if (s.length >= 2 && at(s, 0) === 48 && (at(s, 1) === 120 || at(s, 1) === 88)) return digitRun(s.slice(2), isHex) ? "int" : null;
  if (s.length >= 2 && at(s, 0) === 48 && (at(s, 1) === 98 || at(s, 1) === 66)) return digitRun(s.slice(2), isBinary) ? "int" : null;
  if (s.includes(".")) return is11Base10Float(s) ? "float" : null;
  if (s.length >= 2 && at(s, 0) === 48) return digitRun(s.slice(1), isOctal) ? "int" : null;
  if (s.length === 1 && at(s, 0) === 48) return "int";
  const first = at(s, 0);
  if (first >= 49 && first <= 57) {
    for (let i = 1; i < s.length; i++) {
      const cc = at(s, i);
      if (!(isDigit(cc) || cc === USCORE)) return null;
    }
    return "int";
  }
  return null;
}

// `util/datetime.zig`'s validator, as the 1.1 timestamp needs it: a date,
// or a date-time with seconds and an optional zone; no time-only and no
// minute precision.
const two = (s, i) => (at(s, i) - 48) * 10 + (at(s, i + 1) - 48);
const bothDigits = (s, i) => i + 1 < s.length && isDigit(at(s, i)) && isDigit(at(s, i + 1));

function validDate(s) {
  if (s.length !== 10 || at(s, 4) !== DASH || at(s, 7) !== DASH) return false;
  if (!(bothDigits(s, 0) && bothDigits(s, 2) && bothDigits(s, 5) && bothDigits(s, 8))) return false;
  const year = two(s, 0) * 100 + two(s, 2);
  const month = two(s, 5);
  const day = two(s, 8);
  if (month < 1 || month > 12) return false;
  let days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) days = 29;
  return day >= 1 && day <= days;
}

function validTime(s) {
  if (s.length < 5 || at(s, 2) !== COLON) return false;
  if (!(bothDigits(s, 0) && bothDigits(s, 3))) return false;
  if (two(s, 0) > 23 || two(s, 3) > 59) return false;
  if (s.length === 5) return false;
  if (at(s, 5) !== COLON || s.length < 8) return false;
  if (!bothDigits(s, 6) || two(s, 6) > 60) return false;
  if (s.length === 8) return true;
  if (at(s, 8) !== DOT || s.length < 10) return false;
  return /^[0-9]+$/.test(s.slice(9));
}

function validOffset(s) {
  if (s.length !== 6 || at(s, 3) !== COLON) return false;
  if (!(bothDigits(s, 1) && bothDigits(s, 4))) return false;
  return two(s, 1) <= 23 && two(s, 4) <= 59;
}

function classify11Timestamp(raw) {
  if (raw.length < 10) return null;
  if (!validDate(raw.slice(0, 10))) return null;
  if (raw.length === 10) return "local_date";
  const sep = at(raw, 10);
  if (sep !== 84 && sep !== 116 && sep !== SP) return null;
  const rest = raw.slice(11);
  let timeStr = rest;
  let hasOffset = false;
  const lastc = at(rest, rest.length - 1);
  if (rest.length > 0 && (lastc === 90 || lastc === 122)) {
    timeStr = rest.slice(0, -1);
    hasOffset = true;
  } else if (rest.length >= 6 && (at(rest, rest.length - 6) === PLUS || at(rest, rest.length - 6) === DASH) && at(rest, rest.length - 3) === COLON) {
    if (!validOffset(rest.slice(-6))) return null;
    timeStr = rest.slice(0, -6);
    hasOffset = true;
  }
  if (!validTime(timeStr)) return null;
  return hasOffset ? "offset_datetime" : "local_datetime";
}

// ── the parser ────────────────────────────────────────────────────────────
// `parser.zig`: a container stack over the token stream. Nodes are the
// tree nodes of `fig`, given their properties, markers and separators as
// the compiled parser records them, and laid out by `fig.rows`.

const commentText = (raw) => (at(raw, 0) === HASH ? raw.slice(1) : raw).replace(/^[ \t\r]+/, "").replace(/[ \t\r]+$/, "");

function invalidFlowScalar(source) {
  if (source.length === 0) return true;
  const c = at(source, 0);
  if (c === HASH) return true;
  if (!(c === DASH || c === QUEST || c === COLON)) return false;
  if (source.length === 1) return true;
  const c1 = at(source, 1);
  return c1 === SP || c1 === TAB;
}

function invalidPlainStart(source) {
  if (source.length === 0) return false;
  const c = at(source, 0);
  if (c === COMMA) return true;
  if (c === QUEST) return source.length >= 2 && (at(source, 1) === SP || at(source, 1) === TAB);
  return false;
}

const isDirectiveSpace = (c) => c === SP || c === TAB || c === CR;

function skipDirectiveSpace(line, i) {
  while (i < line.length && isDirectiveSpace(at(line, i))) i += 1;
  return i;
}

const isYamlVersion = (s) => /^[0-9]+\.[0-9]+$/.test(s);

function requireDirectiveEnd(line, i) {
  const j = skipDirectiveSpace(line, i);
  if (j < line.length && at(line, j) !== HASH) fail("InvalidDirective");
}

class Parser {
  constructor(src, tokens, version) {
    this.src = src;
    this.tokens = tokens;
    this.index = 0;
    this.version = version;
    this.nodes = [];
    this.anchors = [];
    this.stack = [];
    this.pendingTag = null;
    this.pendingAnchor = null;
    this.containerTag = null;
    this.containerAnchor = null;
    this.tagDirectives = [];
    this.pendingLeading = [];
    this.lastValueId = null;
    this.colonLine = false;
    this.parkingContainer = false;
    this.forceNewContainer = false;
    this.valueOnlyIndents = 0;
    this.root = null;
    this.docStarted = false;
    this.docEnded = false;
    this.onDocStartLine = false;
    this.directivesPending = false;
    this.yamlDirectiveSeen = false;
  }

  peek() {
    return this.tokens[this.index];
  }

  text(tok) {
    return this.src.slice(tok.s, tok.e);
  }

  columnOf(pos) {
    let start = pos;
    while (start > 0 && at(this.src, start - 1) !== NL) start -= 1;
    return pos - start;
  }

  advance() {
    const tok = this.tokens[this.index];
    this.index += 1;
    const k = tok.kind;
    if (k === "comment") this.captureComment(tok);
    else if (k === "newline") {
      this.lastValueId = null;
      this.colonLine = false;
    } else if (k === "colon") this.colonLine = true;
    return tok;
  }

  skipTriviaNoNewline() {
    for (;;) {
      const k = this.peek().kind;
      if (k === "whitespace" || k === "comment") this.advance();
      else return;
    }
  }

  skipFlowTrivia() {
    for (;;) {
      const k = this.peek().kind;
      if (k === "whitespace" || k === "newline" || k === "comment" || k === "indent" || k === "dedent") this.advance();
      else return;
    }
  }

  skipFlowInlineTrivia() {
    for (;;) {
      const k = this.peek().kind;
      if (k === "whitespace" || k === "comment") this.advance();
      else return;
    }
  }

  // ── comments ──

  current() {
    return this.stack[this.stack.length - 1];
  }

  awaitsBlockValue() {
    const c = this.current();
    return c !== undefined && c.kind === "mapping" && c.pendingKey !== null;
  }

  captureComment(tok) {
    const c = { style: "line", text: fig.fromBin(commentText(this.text(tok))) };
    if (this.lastValueId !== null) {
      this.nodes[this.lastValueId].trailing = [c];
      this.lastValueId = null;
    } else if (this.colonLine && this.awaitsBlockValue()) {
      this.current().pendingValueTrailing = c;
    } else {
      this.pendingLeading.push(c);
    }
  }

  claimLeading(id) {
    if (this.pendingLeading.length === 0) return;
    this.nodes[id].leading = this.pendingLeading;
    this.pendingLeading = [];
  }

  claimDangling(id) {
    if (this.pendingLeading.length === 0) return;
    this.nodes[id].dangling = this.pendingLeading;
    this.pendingLeading = [];
  }

  // ── nodes ──

  addNode(kind, s, e, extra) {
    const id = this.nodes.length;
    const n = fig.node(kind, [s, e], extra);
    n.id = id;
    const tag = this.pendingTag;
    const anchor = this.pendingAnchor;
    this.pendingTag = null;
    this.pendingAnchor = null;
    if (tag) {
      if (tag.s < n.span[0]) n.span[0] = tag.s;
      n.tag = tag.text;
      n.tag_span = [tag.s, tag.e];
    }
    if (anchor) {
      if (anchor.s < n.span[0]) n.span[0] = anchor.s;
      n.anchor = anchor.name;
      n.anchor_span = [anchor.s, anchor.e];
      this.anchors.push({ name: anchor.name, node: id });
    }
    this.nodes.push(n);
    if (!this.parkingContainer) this.claimLeading(id);
    return id;
  }

  node(id) {
    return this.nodes[id];
  }

  addNull(s, e) {
    return this.addNode("null", s, e);
  }

  spanOf(id) {
    return this.nodes[id].span;
  }

  // ── properties ──

  validateTagHandle(text) {
    if (text.length < 2) return;
    const c1 = at(text, 1);
    if (c1 === LT || c1 === BANG) return;
    const close = text.indexOf("!", 1);
    if (close === -1) return;
    const handle = text.slice(0, close + 1);
    for (const d of this.tagDirectives) if (d.handle === handle) return;
    fail("UndefinedTagHandle");
  }

  stashTag(text, s, e) {
    this.validateTagHandle(text);
    if (this.pendingTag) {
      if (this.containerTag) fail("DuplicateProperty");
      this.containerTag = this.pendingTag;
      this.pendingTag = null;
    }
    this.pendingTag = { text, s, e };
  }

  stashAnchor(name, s, e) {
    if (this.pendingAnchor) {
      if (this.containerAnchor) fail("DuplicateProperty");
      this.containerAnchor = this.pendingAnchor;
      this.pendingAnchor = null;
    }
    this.pendingAnchor = { name, s, e };
  }

  consumePendingProperties() {
    for (;;) {
      this.skipTriviaNoNewline();
      const t = this.peek();
      if (t.kind === "tag") {
        this.advance();
        this.stashTag(this.text(t), t.s, t.e);
      } else if (t.kind === "anchor") {
        this.advance();
        this.stashAnchor(this.src.slice(t.s + 1, t.e), t.s, t.e);
      } else {
        break;
      }
    }
  }

  pendingPropOnLineOf(pos) {
    const sameLine = (from, to) => from <= to && !this.src.slice(from, to).includes("\n");
    if (this.pendingAnchor && sameLine(this.pendingAnchor.e, pos)) return true;
    if (this.pendingTag && sameLine(this.pendingTag.e, pos)) return true;
    return false;
  }

  holdKeyLineProps() {
    if (!this.pendingPropOnLineOf(this.peek().s)) return {};
    const held = { anchor: this.pendingAnchor, tag: this.pendingTag };
    this.pendingAnchor = null;
    this.pendingTag = null;
    return held;
  }

  releaseKeyLineProps(held) {
    if (held.anchor) this.pendingAnchor = held.anchor;
    if (held.tag) this.pendingTag = held.tag;
  }

  // ── containers ──

  containerById(id) {
    for (const c of this.stack) if (c.id === id) return c;
    throw new Error("no open container " + id);
  }

  currentContainerIndent() {
    if (this.stack.length === 0) return 0;
    return this.columnOf(this.spanOf(this.current().id)[0]);
  }

  openContainer(kind, start) {
    this.parkingContainer = true;
    const extra = kind === "mapping" ? { entries: [] } : { items: [] };
    let id;
    if (this.containerAnchor || this.containerTag) {
      const childAnchor = this.pendingAnchor;
      const childTag = this.pendingTag;
      this.pendingAnchor = this.containerAnchor;
      this.pendingTag = this.containerTag;
      this.containerAnchor = null;
      this.containerTag = null;
      id = this.addNode(kind, start, start, extra);
      this.pendingAnchor = childAnchor;
      this.pendingTag = childTag;
    } else {
      id = this.addNode(kind, start, start, extra);
    }
    this.parkingContainer = false;
    this.stack.push({
      id, kind, firstChild: null, pendingKey: null, pendingValueSpan: 0,
      pendingValueTrailing: null, pendingSequenceItemSpan: null, pendingSequenceItem: false,
      currentMarker: null, pendingSepSpan: null, continuesSequenceItem: false,
      sharesParentIndent: false, explicitAwaitingValue: false, buildingExplicitKey: false,
      explicitKeyCol: 0,
    });
    return id;
  }

  closeContainer(spanEnd) {
    if (this.stack.length === 0) fail("UnexpectedToken");
    const c = this.stack.pop();
    if (c.firstChild === null) this.spanOf(c.id)[1] = spanEnd;
    return c.id;
  }

  ensureContainer(kind) {
    if (!this.forceNewContainer && this.stack.length > 0) {
      const current = this.current();
      if (current.kind === kind) return current.id;
      if (kind === "mapping" && current.kind === "sequence") {
        let hasEnclosingMapping = false;
        for (let i = 0; i < this.stack.length - 1; i++) if (this.stack[i].kind === "mapping") hasEnclosingMapping = true;
        if (!hasEnclosingMapping) fail("UnexpectedToken");
        this.closePendingEmptyValue();
        const id = this.closeContainer(this.spanOf(current.id)[1]);
        this.finishValue(id);
        return this.ensureContainer(kind);
      }
    }
    const sharesParent = kind === "sequence" && !this.forceNewContainer && this.stack.length > 0 && this.current().kind === "mapping";
    this.forceNewContainer = false;
    const id = this.openContainer(kind, this.peek().s);
    if (sharesParent) this.containerById(id).sharesParentIndent = true;
    return id;
  }

  currentAwaitsValue() {
    const c = this.current();
    if (!c) return false;
    if (c.kind === "mapping") return c.pendingKey !== null;
    return c.pendingSequenceItem;
  }

  attachChild(parent, childId) {
    const pnode = this.node(parent.id);
    const child = this.node(childId);
    if (parent.kind === "sequence") pnode.items.push(child);
    else pnode.entries.push(child);
    if (parent.firstChild === null) parent.firstChild = childId;
    pnode.span[1] = child.span[1];
  }

  attachDeferredValue(valueId) {
    if (this.forceNewContainer) {
      this.valueOnlyIndents += 1;
      this.forceNewContainer = false;
    }
    this.finishValue(valueId);
  }

  finishValue(valueId) {
    this.lastValueId = valueId;
    if (this.stack.length === 0) {
      if (this.root !== null) fail("UnexpectedToken");
      this.root = valueId;
      return;
    }
    const parent = this.current();
    if (parent.kind === "sequence") {
      this.attachChild(parent, valueId);
      parent.pendingSequenceItem = false;
      parent.pendingSequenceItemSpan = null;
      if (parent.currentMarker) {
        this.node(valueId).marker = parent.currentMarker;
        parent.currentMarker = null;
      }
      return;
    }
    if (parent.buildingExplicitKey) {
      parent.buildingExplicitKey = false;
      parent.pendingKey = valueId;
      parent.pendingValueSpan = this.spanOf(valueId)[1];
      parent.explicitAwaitingValue = true;
      return;
    }
    const keyId = parent.pendingKey;
    if (keyId === null) fail("UnexpectedToken");
    parent.pendingKey = null;
    parent.explicitAwaitingValue = false;
    if (parent.pendingValueTrailing) {
      this.node(valueId).trailing = [parent.pendingValueTrailing];
      parent.pendingValueTrailing = null;
    }
    const key = this.node(keyId);
    const value = this.node(valueId);
    const prev = this.parkingContainer;
    this.parkingContainer = true;
    const pairId = this.addNode("keyvalue", key.span[0], value.span[1], { key, value });
    this.parkingContainer = prev;
    if (parent.pendingSepSpan) {
      this.node(pairId).sep = parent.pendingSepSpan;
      parent.pendingSepSpan = null;
    }
    this.attachChild(parent, pairId);
  }

  closePendingEmptyValue() {
    const parent = this.current();
    if (!parent) return;
    if (parent.kind === "sequence") {
      if (parent.pendingSequenceItem) {
        const s = parent.pendingSequenceItemSpan ?? 0;
        this.finishValue(this.addNull(s, s));
      }
    } else if (parent.pendingKey !== null) {
      parent.explicitAwaitingValue = false;
      this.finishValue(this.addNull(parent.pendingValueSpan, parent.pendingValueSpan));
    }
  }

  closeSequenceItemContinuation() {
    if (this.forceNewContainer) return;
    while (this.stack.length > 0 && this.current().continuesSequenceItem) {
      this.current().continuesSequenceItem = false;
      this.closePendingEmptyValue();
      const id = this.closeContainer(this.spanOf(this.current().id)[1]);
      this.finishValue(id);
    }
  }

  closeOpenComplexKey() {
    if (this.stack.length < 2) return;
    const parent = this.stack[this.stack.length - 2];
    if (!parent.buildingExplicitKey) return;
    if (this.columnOf(this.peek().s) > parent.explicitKeyCol) return;
    this.current().continuesSequenceItem = false;
    this.closePendingEmptyValue();
    const id = this.closeContainer(this.spanOf(this.current().id)[1]);
    this.finishValue(id);
  }

  clearPendingSequenceItem(sequenceId) {
    const parent = this.containerById(sequenceId);
    parent.pendingSequenceItem = false;
    parent.pendingSequenceItemSpan = null;
  }

  // ── scalars and aliases ──

  // The row kind and text (and extended kind) of a scalar token's bytes.
  scalarKind(source) {
    if (source.length >= 2 && at(source, 0) === SQ) return ["string", fig.fromBin(singleQuoted(source))];
    if (source.length >= 2 && at(source, 0) === DQ) return ["string", fig.fromBin(doubleQuoted(source))];
    if (source.includes("\n")) return ["string", fig.fromBin(foldPlainScalar(source))];
    if (this.version === "1.1") {
      if (eqlAny(source, ["null", "Null", "NULL", "~"])) return ["null", undefined];
      const b = bool11(source);
      if (b !== null) return ["bool", b ? "true" : "false"];
      const num = classify11Number(source);
      if (num) return [num, source];
      const ts = classify11Timestamp(source);
      if (ts) return ["string", source, ts];
      return ["string", fig.fromBin(source)];
    }
    if (eqlAny(source, ["null", "Null", "NULL", "~"])) return ["null", undefined];
    if (eqlAny(source, ["true", "True", "TRUE"])) return ["bool", "true"];
    if (eqlAny(source, ["false", "False", "FALSE"])) return ["bool", "false"];
    const num = classifyNumber(source);
    if (num) return [num, source];
    return ["string", fig.fromBin(source)];
  }

  parseScalar() {
    const t = this.peek();
    if (t.kind !== "scalar") fail("UnexpectedToken");
    this.advance();
    const [kind, text, ext] = this.scalarKind(this.text(t));
    return this.addNode(kind, t.s, t.e, { text, ext_kind: ext });
  }

  parseAlias() {
    if (this.pendingAnchor || this.pendingTag) fail("UnexpectedToken");
    const t = this.advance();
    return this.addNode("alias", t.s, t.e, { text: this.src.slice(t.s + 1, t.e) });
  }

  parseKeyNode() {
    if (this.peek().kind === "alias") return this.parseAlias();
    return this.parseScalar();
  }

  isMappingStart() {
    const t = this.peek();
    if (t.kind === "scalar") {
      if (this.src.slice(t.s, t.e).includes("\n")) return false;
    } else if (t.kind !== "alias") {
      return false;
    }
    let la = this.index + 1;
    while (la < this.tokens.length) {
      const k = this.tokens[la].kind;
      if (k === "whitespace" || k === "comment") la += 1;
      else return k === "colon";
    }
    return false;
  }

  parseBlockScalar() {
    const header = this.advance();
    const headerSource = this.text(header);
    for (;;) {
      const k = this.peek().kind;
      if (k === "whitespace" || k === "comment") this.advance();
      else break;
    }
    if (this.peek().kind === "newline") this.advance();
    const parentIndent = this.currentContainerIndent();
    let spanEnd = header.e;
    let value = "";
    if (this.peek().kind === "block_scalar") {
      const body = this.advance();
      spanEnd = body.e;
      value = decodeBlockScalar(headerSource, parentIndent, this.text(body));
    }
    return this.addNode("string", header.s, spanEnd, { text: fig.fromBin(value) });
  }

  requireValueEnd() {
    while (this.peek().kind === "whitespace") this.advance();
    const k = this.peek().kind;
    if (!(k === "newline" || k === "comment" || k === "dedent" || k === "end_of_file")) fail("UnexpectedToken");
  }

  tabBetween(from, to) {
    if (from > to || to > this.src.length) return false;
    return this.src.slice(from, to).includes("\t");
  }

  // ── flow ──

  parseFlowNode() {
    this.skipFlowTrivia();
    for (;;) {
      const t = this.peek();
      if (t.kind === "tag") {
        this.advance();
        this.stashTag(this.text(t), t.s, t.e);
      } else if (t.kind === "anchor") {
        this.advance();
        this.stashAnchor(this.src.slice(t.s + 1, t.e), t.s, t.e);
      } else {
        break;
      }
      this.skipFlowTrivia();
    }
    const k = this.peek().kind;
    if (this.pendingTag || this.pendingAnchor) {
      if (k === "comma" || k === "colon" || k === "flow_map_end" || k === "flow_seq_end") {
        const a = this.peek().s;
        return this.addNull(a, a);
      }
    }
    if (k === "flow_seq_start") return this.parseFlowSequence();
    if (k === "flow_map_start") return this.parseFlowMapping();
    if (k === "alias") return this.parseAlias();
    if (k === "scalar") {
      if (invalidFlowScalar(this.text(this.peek()))) fail("UnexpectedToken");
      return this.parseScalar();
    }
    fail("UnexpectedToken");
  }

  wrapFlowPair(keyId, valueId) {
    const key = this.node(keyId);
    const value = this.node(valueId);
    const pairId = this.addNode("keyvalue", key.span[0], value.span[1], { key, value });
    return this.addNode("mapping", key.span[0], value.span[1], { entries: [this.node(pairId)] });
  }

  parseFlowSequenceItem() {
    const explicit = this.peek().kind === "explicit_key";
    if (explicit) {
      this.advance();
      this.skipFlowTrivia();
    }
    const k = this.peek().kind;
    let keyId;
    if (k === "colon") {
      keyId = this.addNull(this.peek().s, this.peek().e);
    } else if (k === "comma" || k === "flow_seq_end") {
      if (!explicit) fail("UnexpectedToken");
      keyId = this.addNull(this.peek().s, this.peek().e);
    } else {
      keyId = this.parseFlowNode();
    }
    if (explicit) this.skipFlowTrivia();
    else this.skipFlowInlineTrivia();
    if (this.peek().kind !== "colon") {
      if (!explicit) return keyId;
      const a = this.spanOf(keyId)[1];
      return this.wrapFlowPair(keyId, this.addNull(a, a));
    }
    this.advance();
    this.skipFlowTrivia();
    const vk = this.peek().kind;
    let valueId;
    if (vk === "comma" || vk === "flow_seq_end") {
      const a = this.spanOf(keyId)[1];
      valueId = this.addNull(a, a);
    } else {
      valueId = this.parseFlowNode();
    }
    return this.wrapFlowPair(keyId, valueId);
  }

  parseFlowSequence() {
    const open = this.advance();
    const seqId = this.addNode("sequence", open.s, open.e, { items: [] });
    const seq = this.node(seqId);
    this.skipFlowTrivia();
    while (this.peek().kind !== "flow_seq_end") {
      if (this.peek().kind === "end_of_file") fail("UnexpectedToken");
      const item = this.parseFlowSequenceItem();
      seq.items.push(this.node(item));
      this.skipFlowTrivia();
      const k = this.peek().kind;
      if (k === "comma") {
        this.advance();
        this.skipFlowTrivia();
      } else if (k !== "flow_seq_end") {
        fail("UnexpectedToken");
      }
    }
    const close = this.advance();
    seq.span[1] = close.e;
    return seqId;
  }

  parseFlowMapping() {
    const open = this.advance();
    const mapId = this.addNode("mapping", open.s, open.e, { entries: [] });
    const map = this.node(mapId);
    this.skipFlowTrivia();
    while (this.peek().kind !== "flow_map_end") {
      if (this.peek().kind === "end_of_file") fail("UnexpectedToken");
      if (this.peek().kind === "explicit_key") {
        this.advance();
        this.skipFlowTrivia();
      }
      const k = this.peek().kind;
      let keyId;
      if (k === "colon" || k === "comma" || k === "flow_map_end") keyId = this.addNull(this.peek().s, this.peek().e);
      else keyId = this.parseFlowNode();
      this.skipFlowTrivia();
      let valueId;
      if (this.peek().kind === "colon") {
        this.advance();
        this.skipFlowTrivia();
        const vk = this.peek().kind;
        if (vk === "comma" || vk === "flow_map_end") {
          const a = this.spanOf(keyId)[1];
          valueId = this.addNull(a, a);
        } else {
          valueId = this.parseFlowNode();
        }
      } else {
        const a = this.spanOf(keyId)[1];
        valueId = this.addNull(a, a);
      }
      const key = this.node(keyId);
      const value = this.node(valueId);
      const pairId = this.addNode("keyvalue", key.span[0], value.span[1], { key, value });
      map.entries.push(this.node(pairId));
      this.skipFlowTrivia();
      const nk = this.peek().kind;
      if (nk === "comma") {
        this.advance();
        this.skipFlowTrivia();
      } else if (nk !== "flow_map_end") {
        fail("UnexpectedToken");
      }
    }
    const close = this.advance();
    map.span[1] = close.e;
    return mapId;
  }

  // ── block entries ──

  parseMappingValue(allowCompact) {
    this.skipTriviaNoNewline();
    this.consumePendingProperties();
    const k = this.peek().kind;
    if (k === "scalar") {
      if (allowCompact && this.isMappingStart()) {
        if (this.tabBetween(this.current().pendingValueSpan, this.peek().s)) fail("UnexpectedToken");
        const childId = this.openContainer("mapping", this.peek().s);
        this.parseMappingEntry();
        const id = this.closeContainer(this.spanOf(childId)[1]);
        this.finishValue(id);
      } else {
        const valueId = this.parseScalar();
        this.finishValue(valueId);
        this.requireValueEnd();
      }
    } else if (k === "dash") {
      if (!allowCompact) fail("UnexpectedToken");
      const seqId = this.openContainer("sequence", this.peek().s);
      this.containerById(seqId).continuesSequenceItem = true;
      this.parseSequenceEntry();
    } else if (k === "block_header") {
      this.finishValue(this.parseBlockScalar());
    } else if (k === "alias") {
      this.finishValue(this.parseAlias());
      this.requireValueEnd();
    } else if (k === "flow_seq_start" || k === "flow_map_start") {
      this.finishValue(this.parseFlowNode());
      this.requireValueEnd();
    } else if (k === "newline" || k === "dedent" || k === "end_of_file") {
      // deferred
    } else {
      fail("UnexpectedToken");
    }
  }

  parseMappingEntry() {
    const held = this.holdKeyLineProps();
    const mappingId = this.ensureContainer("mapping");
    this.closePendingEmptyValue();
    this.releaseKeyLineProps(held);
    const keyId = this.parseKeyNode();
    this.skipTriviaNoNewline();
    if (this.peek().kind !== "colon") fail("UnexpectedToken");
    const colon = this.advance();
    const parent = this.containerById(mappingId);
    parent.pendingKey = keyId;
    parent.pendingValueSpan = colon.e;
    parent.pendingSepSpan = [colon.s, colon.e];
    this.parseMappingValue(false);
  }

  parseEmptyKeyEntry() {
    const mappingId = this.ensureContainer("mapping");
    this.closePendingEmptyValue();
    const colon = this.advance();
    const keyId = this.addNull(colon.s, colon.s);
    const parent = this.containerById(mappingId);
    parent.pendingKey = keyId;
    parent.pendingValueSpan = colon.e;
    parent.pendingSepSpan = [colon.s, colon.e];
    this.parseMappingValue(false);
  }

  parseExplicitKey() {
    const marker = this.advance();
    const mappingId = this.ensureContainer("mapping");
    this.closePendingEmptyValue();
    this.skipTriviaNoNewline();
    this.consumePendingProperties();
    const m = this.containerById(mappingId);
    if (this.peek().kind === "newline") {
      m.buildingExplicitKey = true;
      m.explicitKeyCol = this.columnOf(marker.s);
      return;
    }
    const k = this.peek().kind;
    let keyId;
    if (k === "scalar") {
      if (this.isMappingStart()) {
        if (this.tabBetween(marker.e, this.peek().s)) fail("UnexpectedToken");
        m.buildingExplicitKey = true;
        m.explicitKeyCol = this.columnOf(marker.s);
        const keyMapId = this.openContainer("mapping", this.peek().s);
        this.containerById(keyMapId).continuesSequenceItem = true;
        this.parseMappingEntry();
        return;
      }
      keyId = this.parseScalar();
    } else if (k === "flow_seq_start" || k === "flow_map_start") {
      const nodeId = this.parseFlowNode();
      this.skipTriviaNoNewline();
      if (this.peek().kind === "colon") {
        m.buildingExplicitKey = true;
        m.explicitKeyCol = this.columnOf(marker.s);
        const keyMapId = this.openContainer("mapping", this.spanOf(nodeId)[0]);
        this.containerById(keyMapId).continuesSequenceItem = true;
        const colon = this.advance();
        const km = this.containerById(keyMapId);
        km.pendingKey = nodeId;
        km.pendingValueSpan = colon.e;
        km.pendingSepSpan = [colon.s, colon.e];
        this.parseMappingValue(false);
        return;
      }
      keyId = nodeId;
    } else if (k === "block_header") {
      keyId = this.parseBlockScalar();
    } else if (k === "alias") {
      keyId = this.parseAlias();
    } else if (k === "dash") {
      m.buildingExplicitKey = true;
      m.explicitKeyCol = this.columnOf(marker.s);
      const seqId = this.openContainer("sequence", this.peek().s);
      this.containerById(seqId).continuesSequenceItem = true;
      this.parseSequenceEntry();
      return;
    } else if (k === "colon") {
      m.buildingExplicitKey = true;
      m.explicitKeyCol = this.columnOf(marker.s);
      const keyMapId = this.openContainer("mapping", this.peek().s);
      this.containerById(keyMapId).continuesSequenceItem = true;
      this.parseEmptyKeyEntry();
      return;
    } else if (k === "newline" || k === "dedent" || k === "end_of_file") {
      keyId = this.addNull(marker.e, marker.e);
    } else {
      fail("UnexpectedToken");
    }
    const parent = this.containerById(mappingId);
    parent.pendingKey = keyId;
    parent.pendingValueSpan = this.spanOf(keyId)[1];
    parent.pendingSepSpan = null;
    parent.explicitAwaitingValue = true;
  }

  parseSequenceEntry() {
    const dash = this.advance();
    const sequenceId = this.ensureContainer("sequence");
    if (this.current().id === sequenceId) this.closePendingEmptyValue();
    this.clearPendingSequenceItem(sequenceId);
    this.containerById(sequenceId).currentMarker = [dash.s, dash.e];
    this.skipTriviaNoNewline();
    this.consumePendingProperties();
    const k = this.peek().kind;
    if (k === "newline" || k === "dedent" || k === "end_of_file") {
      this.current().pendingSequenceItem = true;
      this.current().pendingSequenceItemSpan = dash.e;
    } else if (k === "scalar") {
      if (this.isMappingStart()) {
        const held = this.holdKeyLineProps();
        const mappingId = this.openContainer("mapping", this.peek().s);
        this.containerById(mappingId).continuesSequenceItem = true;
        this.releaseKeyLineProps(held);
        this.parseMappingEntry();
      } else {
        this.finishValue(this.parseScalar());
      }
    } else if (k === "block_header") {
      this.finishValue(this.parseBlockScalar());
    } else if (k === "alias") {
      if (this.isMappingStart()) {
        const mappingId = this.openContainer("mapping", this.peek().s);
        this.containerById(mappingId).continuesSequenceItem = true;
        this.parseMappingEntry();
      } else {
        this.finishValue(this.parseAlias());
      }
    } else if (k === "flow_seq_start" || k === "flow_map_start") {
      this.finishValue(this.parseFlowNode());
    } else if (k === "explicit_key") {
      const mappingId = this.openContainer("mapping", this.peek().s);
      this.containerById(mappingId).continuesSequenceItem = true;
      this.parseExplicitKey();
    } else if (k === "colon") {
      const mappingId = this.openContainer("mapping", this.peek().s);
      this.containerById(mappingId).continuesSequenceItem = true;
      this.parseEmptyKeyEntry();
    } else if (k === "dash") {
      const innerId = this.openContainer("sequence", this.peek().s);
      this.containerById(innerId).continuesSequenceItem = true;
      this.parseSequenceEntry();
    } else {
      fail("UnexpectedToken");
    }
  }

  // ── directives ──

  parseDirective(line) {
    let i = 1;
    const nameStart = i;
    while (i < line.length && !isDirectiveSpace(at(line, i))) i += 1;
    const name = line.slice(nameStart, i);
    if (name.length === 0) fail("InvalidDirective");
    if (name === "YAML") {
      if (this.yamlDirectiveSeen) fail("InvalidDirective");
      this.yamlDirectiveSeen = true;
      i = skipDirectiveSpace(line, i);
      const verStart = i;
      while (i < line.length && !isDirectiveSpace(at(line, i))) i += 1;
      if (!isYamlVersion(line.slice(verStart, i))) fail("InvalidDirective");
      requireDirectiveEnd(line, i);
    } else if (name === "TAG") {
      i = skipDirectiveSpace(line, i);
      const handleStart = i;
      while (i < line.length && !isDirectiveSpace(at(line, i))) i += 1;
      const handle = line.slice(handleStart, i);
      if (handle.length === 0) fail("InvalidDirective");
      i = skipDirectiveSpace(line, i);
      const prefixStart = i;
      while (i < line.length && !isDirectiveSpace(at(line, i))) i += 1;
      if (i === prefixStart) fail("InvalidDirective");
      requireDirectiveEnd(line, i);
      this.tagDirectives.push({ handle, prefix: line.slice(prefixStart, i) });
    }
  }

  // ── the main loop ──

  resolveAliasesOrFail() {
    for (let id = 0; id < this.nodes.length; id++) {
      const n = this.nodes[id];
      if (n.kind !== "alias") continue;
      let found = false;
      for (const a of this.anchors) {
        if (a.node >= id) break;
        if (a.name === n.text) found = true;
      }
      if (!found) fail("UndefinedAlias");
    }
  }

  parse() {
    for (;;) {
      this.skipTriviaNoNewline();
      const k = this.peek().kind;
      if (this.valueOnlyIndents > 0 && !(k === "newline" || k === "dedent" || k === "end_of_file")) fail("UnexpectedToken");
      if (this.directivesPending && !(k === "directive" || k === "newline" || k === "doc_start")) fail("InvalidDirective");
      if (k === "indent") {
        if (this.stack.length > 0 && this.current().continuesSequenceItem) {
          if (this.columnOf(this.peek().e) > this.currentContainerIndent()) this.forceNewContainer = true;
          else this.current().continuesSequenceItem = false;
        } else {
          this.forceNewContainer = true;
        }
        this.advance();
      } else if (k === "dedent") {
        if (this.valueOnlyIndents > 0) {
          this.valueOnlyIndents -= 1;
          this.advance();
        } else if (this.forceNewContainer && (this.pendingAnchor || this.pendingTag)) {
          this.forceNewContainer = false;
          this.advance();
        } else {
          this.closePendingEmptyValue();
          const dedent = this.advance();
          const dedentCol = this.columnOf(dedent.s);
          for (;;) {
            let closeParentToo = this.stack.length > 0 && (this.current().sharesParentIndent || this.current().continuesSequenceItem);
            if (!closeParentToo && this.stack.length >= 2) {
              const parent = this.stack[this.stack.length - 2];
              if (parent.buildingExplicitKey && dedentCol < parent.explicitKeyCol) closeParentToo = true;
            }
            const id = this.closeContainer(dedent.e);
            this.finishValue(id);
            if (!closeParentToo) break;
            this.closePendingEmptyValue();
          }
          if (this.stack.length > 0) {
            const c = this.current();
            if (c.continuesSequenceItem && c.kind === "mapping" && this.columnOf(this.spanOf(c.id)[0]) === dedentCol) c.continuesSequenceItem = false;
          }
        }
      } else if (k === "newline") {
        this.onDocStartLine = false;
        this.advance();
      } else if (k === "doc_start") {
        if (this.docStarted || this.nodes.length > 0) fail("MultipleDocuments");
        this.docStarted = true;
        this.onDocStartLine = true;
        this.directivesPending = false;
        this.advance();
      } else if (k === "directive") {
        if (this.docStarted || this.docEnded || this.root !== null || this.nodes.length > 0 || this.stack.length > 0) fail("InvalidDirective");
        const tok = this.advance();
        this.parseDirective(this.text(tok));
        this.directivesPending = true;
      } else if (k === "doc_end") {
        this.docEnded = true;
        this.advance();
      } else if (k === "dash") {
        if (this.docEnded) fail("MultipleDocuments");
        if (this.onDocStartLine) fail("UnexpectedToken");
        if (this.pendingPropOnLineOf(this.peek().s)) fail("UnexpectedToken");
        this.closeSequenceItemContinuation();
        this.parseSequenceEntry();
      } else if (k === "explicit_key") {
        if (this.docEnded) fail("MultipleDocuments");
        this.closeSequenceItemContinuation();
        this.parseExplicitKey();
      } else if (k === "colon") {
        if (this.docEnded) fail("MultipleDocuments");
        this.closeOpenComplexKey();
        if (this.stack.length > 0 && this.current().buildingExplicitKey) {
          const nullKey = this.addNull(this.peek().s, this.peek().s);
          const m = this.current();
          m.buildingExplicitKey = false;
          m.pendingKey = nullKey;
          m.explicitAwaitingValue = true;
        }
        if (this.stack.length > 0 && this.current().explicitAwaitingValue) {
          const colon = this.advance();
          this.current().explicitAwaitingValue = false;
          this.current().pendingValueSpan = colon.e;
          this.current().pendingSepSpan = [colon.s, colon.e];
          this.parseMappingValue(true);
        } else {
          this.closeSequenceItemContinuation();
          this.parseEmptyKeyEntry();
        }
      } else if (k === "scalar") {
        if (this.docEnded) fail("MultipleDocuments");
        this.closeSequenceItemContinuation();
        if (this.isMappingStart()) {
          if (this.onDocStartLine) fail("UnexpectedToken");
          this.parseMappingEntry();
        } else if (this.stack.length === 0 && this.root === null) {
          if (invalidPlainStart(this.text(this.peek()))) fail("UnexpectedToken");
          this.finishValue(this.parseScalar());
        } else if (this.forceNewContainer && this.currentAwaitsValue()) {
          this.attachDeferredValue(this.parseScalar());
        } else {
          fail("UnexpectedToken");
        }
      } else if (k === "alias") {
        if (this.docEnded) fail("MultipleDocuments");
        this.closeSequenceItemContinuation();
        if (this.isMappingStart()) this.parseMappingEntry();
        else if (this.stack.length === 0 && this.root === null) this.finishValue(this.parseAlias());
        else if (this.forceNewContainer && this.currentAwaitsValue()) this.attachDeferredValue(this.parseAlias());
        else fail("UnexpectedToken");
      } else if (k === "block_header") {
        if (this.docEnded) fail("MultipleDocuments");
        this.closeSequenceItemContinuation();
        if (this.stack.length === 0 && this.root === null) this.finishValue(this.parseBlockScalar());
        else if (this.forceNewContainer && this.currentAwaitsValue()) this.attachDeferredValue(this.parseBlockScalar());
        else fail("UnexpectedToken");
      } else if (k === "flow_seq_start" || k === "flow_map_start") {
        if (this.docEnded) fail("MultipleDocuments");
        this.closeSequenceItemContinuation();
        const nodeId = this.parseFlowNode();
        this.skipTriviaNoNewline();
        if (this.peek().kind === "colon") {
          const span = this.spanOf(nodeId);
          if (this.src.slice(span[0], span[1]).includes("\n")) fail("UnexpectedToken");
          const mappingId = this.ensureContainer("mapping");
          this.closePendingEmptyValue();
          const colon = this.advance();
          const parent = this.containerById(mappingId);
          parent.pendingKey = nodeId;
          parent.pendingValueSpan = colon.e;
          parent.pendingSepSpan = [colon.s, colon.e];
          this.parseMappingValue(false);
        } else {
          this.attachDeferredValue(nodeId);
        }
      } else if (k === "tag" || k === "anchor") {
        if (this.docEnded) fail("MultipleDocuments");
        const inContainer = this.stack.length > 0;
        this.consumePendingProperties();
        if (inContainer) {
          const nk = this.peek().kind;
          if (nk === "newline" || nk === "dedent" || nk === "end_of_file") {
            if (!(this.forceNewContainer && this.currentAwaitsValue())) fail("UnexpectedToken");
          }
        }
      } else if (k === "end_of_file") {
        break;
      } else {
        fail("UnexpectedToken");
      }
    }

    while (this.stack.length > 0) {
      this.closePendingEmptyValue();
      const id = this.closeContainer(this.peek().e);
      this.finishValue(id);
    }
    if (this.containerAnchor || this.containerTag) fail("DuplicateProperty");
    this.resolveAliasesOrFail();
    let root = this.root;
    if (root === null) root = this.addNull(this.peek().s, this.peek().e);
    this.claimDangling(root);
    return this.node(root);
  }
}

function parse(dialect, input) {
  const version = dialect === "js-yaml-1.1" ? "1.1" : "1.2";
  const sc = fig.scanner(input);
  const bin = sc.bin;
  const tokens = new Tokenizer(bin).tokenize();
  const p = new Parser(bin, tokens, version);
  const root = p.parse();
  // An anchor's name, an alias's and a tag's spelling were kept as bytes
  // for the alias check; the rows carry them as text.
  for (const n of p.nodes) {
    if (n.anchor !== undefined) n.anchor = fig.fromBin(n.anchor);
    if (n.tag !== undefined) n.tag = fig.fromBin(n.tag);
    if (n.kind === "alias") n.text = fig.fromBin(n.text);
  }
  const t = fig.rows(root);
  for (const d of p.tagDirectives) t.directive(fig.fromBin(d.handle), fig.fromBin(d.prefix));
  return t;
}

// ── the printer ───────────────────────────────────────────────────────────
// `printer.zig`: block style, two-space indentation whatever the options
// say, a flow form for a collection value that fits `width` and carries
// nothing flow cannot spell, a `|` block for a multi-line string, and a
// scalar quoted exactly when the plain form would read back as something
// else. Widths are byte widths, as the compiled printer measures them.

const YAML_SPELLING = { hex: true, octal: true, leading_zero: true, bare_dot: true, plus: true };

function spellable(raw, sp) {
  let body = raw;
  const first = raw[0];
  if (first === "+" || first === "-") {
    if (first === "+" && !sp.plus) return false;
    body = raw.slice(1);
  }
  if (body === "") return false;
  if (!sp.underscores && body.includes("_")) return false;
  if (body.length >= 2 && body[0] === "0") {
    const r = body[1].toLowerCase();
    if (r === "x") return sp.hex === true;
    if (r === "o") return sp.octal === true;
    if (r === "b") return sp.binary === true;
  }
  if (!sp.bare_dot && (body[0] === "." || body[body.length - 1] === ".")) return false;
  if (!sp.leading_zero) {
    const m = body.search(/[.eE]/);
    const intEnd = m === -1 ? body.length : m;
    if (intEnd > 1 && body[0] === "0") return false;
  }
  return true;
}

function canonicalNumber(raw) {
  let out = "";
  let s = raw;
  if (s[0] === "-") {
    out = "-";
    s = s.slice(1);
  } else if (s[0] === "+") {
    s = s.slice(1);
  }
  if (s.length >= 2 && s[0] === "0" && /[xob]/.test(s[1].toLowerCase())) {
    const base = { x: 16, o: 8, b: 2 }[s[1].toLowerCase()];
    const digits = s.slice(2).replace(/_/g, "");
    const valid = digits !== "" && { 16: /^[0-9a-fA-F]+$/, 8: /^[0-7]+$/, 2: /^[01]+$/ }[base].test(digits);
    if (valid) {
      let v = 0n;
      for (const ch of digits) v = v * BigInt(base) + BigInt(parseInt(ch, 16));
      return out + v.toString();
    }
    return out + s;
  }
  const eIdx = s.search(/[eE]/);
  const mantissa = eIdx === -1 ? s : s.slice(0, eIdx);
  const exponent = eIdx === -1 ? "" : s.slice(eIdx);
  const dot = mantissa.indexOf(".");
  const intPart = dot === -1 ? mantissa : mantissa.slice(0, dot);
  const intDigits = intPart.replace(/_/g, "").replace(/^0+/, "");
  out += intDigits === "" ? "0" : intDigits;
  if (dot !== -1) {
    const frac = mantissa.slice(dot + 1).replace(/_/g, "");
    out += "." + (frac === "" ? "0" : frac);
  }
  out += exponent.replace(/_/g, "");
  return out;
}

const numberText = (raw) => (spellable(raw, YAML_SPELLING) ? raw : canonicalNumber(raw));

// `std.fmt.parseInt(i64|u64, s, 10)` would accept `s`.
function zigParseInt(s) {
  let body = s;
  let neg = false;
  if (s[0] === "+") body = s.slice(1);
  else if (s[0] === "-") {
    neg = true;
    body = s.slice(1);
  }
  if (body.length === 0) return false;
  if (body[0] === "_" || body[body.length - 1] === "_") return false;
  if (!/^[0-9_]+$/.test(body)) return false;
  const d = body.replace(/_/g, "").replace(/^0+/, "");
  if (d === "") return true;
  const limit = neg ? "9223372036854775808" : "18446744073709551615";
  if (d.length !== limit.length) return d.length < limit.length;
  return d <= limit;
}

function validUnderscores(body, isd) {
  const n = body.length;
  for (let i = 0; i < n; i++) {
    if (at(body, i) === USCORE) {
      if (i === 0 || i + 1 === n) return false;
      if (!isd(at(body, i - 1)) || !isd(at(body, i + 1))) return false;
      i += 1;
    }
  }
  return true;
}

// `std.fmt.parseFloat(f64, s)` would accept `s` (its `inf`/`nan` forms
// are excluded by the caller).
function zigParseFloat(s) {
  let i = 0;
  if (s[0] === "+" || s[0] === "-") i = 1;
  if (i >= s.length) return false;
  const rest = s.slice(i);
  let base = 10;
  let expc = 101;
  let body = rest;
  if (rest.length >= 2 && rest[0] === "0" && (rest[1] === "x" || rest[1] === "X")) {
    base = 16;
    expc = 112;
    body = rest.slice(2);
  }
  const isd = base === 16 ? isHex : isDigit;
  let j = 0;
  const n = body.length;
  let ndigits = 0;
  let underscores = 0;
  const scanDigits = () => {
    while (j < n) {
      const ch = at(body, j);
      if (isd(ch)) {
        j += 1;
        ndigits += 1;
      } else if (ch === USCORE) {
        j += 1;
        underscores += 1;
      } else {
        break;
      }
    }
  };
  scanDigits();
  if (j < n && at(body, j) === DOT) {
    j += 1;
    scanDigits();
  }
  if (ndigits === 0) return false;
  if (j < n && (at(body, j) | 0x20) === expc) {
    j += 1;
    if (j < n && (at(body, j) === PLUS || at(body, j) === DASH)) j += 1;
    if (!(j < n && isDigit(at(body, j)))) return false;
    while (j < n) {
      const ch = at(body, j);
      if (isDigit(ch)) j += 1;
      else if (ch === USCORE) {
        j += 1;
        underscores += 1;
      } else break;
    }
  }
  if (j !== n) return false;
  if (underscores > 0 && !validUnderscores(body, isd)) return false;
  return true;
}

const containsCi = (hay, needle) => hay.toLowerCase().includes(needle);

function looksNumeric(s) {
  if (containsCi(s, "inf") || containsCi(s, "nan")) return false;
  return zigParseInt(s) || zigParseFloat(s);
}

const NON_STRING_KEYWORDS = [
  "null", "Null", "NULL", "~", "true", "True", "TRUE", "false", "False", "FALSE",
  ".inf", ".Inf", ".INF", "-.inf", "-.Inf", "-.INF", "+.inf", ".nan", ".NaN", ".NAN",
];

const resolvesToNonString = (s) => NON_STRING_KEYWORDS.includes(s) || looksNumeric(s);

// eslint-disable-next-line no-control-regex
const hasControlChar = (s) => /[\x00-\x1f\x7f]/.test(s);

function needsQuoting(s) {
  if (s.length === 0) return true;
  if (resolvesToNonString(s)) return true;
  if (s[0] === " " || s[s.length - 1] === " ") return true;
  const c = s[0];
  if ("!&*?|>%@`\"'#,[]{}".includes(c)) return true;
  if ((c === "-" || c === ":") && (s.length === 1 || s[1] === " ")) return true;
  if (s.includes(": ")) return true;
  if (s[s.length - 1] === ":") return true;
  if (s.includes(" #")) return true;
  return false;
}

const containsFlowIndicator = (s) => /[,[\]{}]/.test(s);

const singleQuotedText = (s) => "'" + s.replace(/'/g, "''") + "'";

function doubleQuotedText(s) {
  // eslint-disable-next-line no-control-regex
  return '"' + s.replace(/[\x00-\x1f\x7f"\\]/g, (ch) => {
    if (ch === '"') return '\\"';
    if (ch === "\\") return "\\\\";
    if (ch === "\n") return "\\n";
    if (ch === "\t") return "\\t";
    if (ch === "\r") return "\\r";
    return "\\x" + ch.charCodeAt(0).toString(16).padStart(2, "0");
  }) + '"';
}

function scalarText(raw) {
  if (hasControlChar(raw)) return doubleQuotedText(raw);
  if (needsQuoting(raw)) return singleQuotedText(raw);
  return raw;
}

function flowScalarText(raw) {
  if (!hasControlChar(raw) && !needsQuoting(raw) && containsFlowIndicator(raw)) return singleQuotedText(raw);
  return scalarText(raw);
}

function blockScalarOk(s) {
  if (!s.includes("\n")) return false;
  if (s.endsWith("\n\n")) return false;
  const body = s.endsWith("\n") ? s.slice(0, -1) : s;
  let firstContent = true;
  for (const line of body.split("\n")) {
    if (line.length === 0) continue;
    if (firstContent && (line[0] === " " || line[0] === "\t")) return false;
    firstContent = false;
    const cl = line[line.length - 1];
    if (cl === " " || cl === "\t") return false;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(line)) return false;
  }
  return true;
}

function tagHandleOf(text) {
  if (text.length === 0 || text[0] !== "!") return null;
  if (text.length > 1 && text[1] === "<") return null;
  const close = text.indexOf("!", 1);
  if (close === -1) return text.slice(0, 1);
  return text.slice(0, close + 1);
}

const hasProps = (row) => row.anchor !== undefined || row.tag !== undefined;
const commentsEmpty = (row) => row.leading.length === 0 && row.trailing.length === 0 && row.dangling.length === 0;
const leadingAnchor = (row) => (row.kind === "keyvalue" ? row.key : row);
const seqItemLeadAnchor = (item) => (item.kind === "mapping" && item.items.length > 0 ? item.items[0].key : item);
const isScalarKind = (k) => k === "null" || k === "bool" || k === "int" || k === "float";

class Printer {
  constructor(t, width) {
    this.t = t;
    this.out = [];
    this.width = width;
  }

  put(...parts) {
    for (const p of parts) this.out.push(p);
  }

  indent(depth) {
    if (depth > 0) this.out.push("  ".repeat(depth));
  }

  // The byte width of what `fn` writes.
  measure(fn, ...args) {
    const saved = this.out;
    this.out = [];
    fn.apply(this, args);
    const w = fig.byteLength(this.out.join(""));
    this.out = saved;
    return w;
  }

  hashLine(text) {
    this.put("#");
    if (text.length !== 0) this.put(" ", text);
  }

  commentLines(list, depth) {
    for (const c of list) {
      for (const line of c.text.split("\n")) {
        this.indent(depth);
        this.hashLine(line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, ""));
        this.put("\n");
      }
    }
  }

  leadingComments(row, depth) {
    this.commentLines(row.leading, depth);
  }

  danglingComments(row, depth) {
    this.commentLines(row.dangling, depth);
  }

  trailingComment(row) {
    const c = row.trailing[0];
    if (!c) return;
    this.put(" #");
    if (c.text.length !== 0) this.put(" ", c.text.replace(/\n/g, " "));
  }

  props(row) {
    if (row.anchor !== undefined) this.put("&", row.anchor, " ");
    if (row.tag !== undefined) this.put(row.tag, " ");
  }

  propsOwnLine(row) {
    let wrote = false;
    if (row.anchor !== undefined) {
      this.put("&", row.anchor);
      wrote = true;
    }
    if (row.tag !== undefined) {
      if (wrote) this.put(" ");
      this.put(row.tag);
    }
    this.put("\n");
  }

  propsAfterColon(row) {
    if (row.anchor !== undefined) this.put(" &", row.anchor);
    if (row.tag !== undefined) this.put(" ", row.tag);
  }

  scalarKey(row) {
    const k = row.kind;
    if (row.ext_kind !== undefined) this.put(row.ext_kind === "enum_literal" ? scalarText(row.text) : row.text);
    else if (k === "string") this.put(scalarText(row.text));
    else if (k === "null") this.put("null");
    else if (k === "bool") this.put(row.text);
    else if (k === "int" || k === "float") this.put(numberText(row.text));
    else if (k === "alias") this.put("*", row.text, " ");
  }

  keyLead(row) {
    this.props(row);
    this.scalarKey(row);
  }

  keyCols(row) {
    return this.measure(this.keyLead, row);
  }

  flowEligible(row) {
    if (!commentsEmpty(row)) return false;
    if (hasProps(row)) return false;
    const k = row.kind;
    if (row.ext_kind !== undefined) return false;
    if (isScalarKind(k)) return true;
    if (k === "string") return !row.text.includes("\n");
    if (k === "alias" || k === "keyvalue") return false;
    if (k === "sequence") {
      for (const el of row.items) {
        if (el.kind === "mapping") return false;
        if (!this.flowEligible(el)) return false;
      }
      return true;
    }
    for (const kv of row.items) {
      if (!commentsEmpty(kv)) return false;
      if (!commentsEmpty(kv.key)) return false;
      const kk = kv.key.kind;
      if (kv.key.ext_kind !== undefined) return false;
      if (kk === "string") {
        if (kv.key.text.includes("\n")) return false;
      } else if (!isScalarKind(kk)) {
        return false;
      }
      if (kv.value.kind === "mapping") return false;
      if (!this.flowEligible(kv.value)) return false;
    }
    return true;
  }

  flow(row) {
    const k = row.kind;
    if (k === "null") this.put("null");
    else if (k === "bool") this.put(row.text);
    else if (k === "int" || k === "float") this.put(numberText(row.text));
    else if (k === "string") this.put(flowScalarText(row.text));
    else if (k === "sequence") {
      if (row.items.length === 0) {
        this.put("[]");
        return;
      }
      this.put("[");
      row.items.forEach((el, i) => {
        if (i > 0) this.put(", ");
        this.flow(el);
      });
      this.put("]");
    } else if (k === "mapping") {
      if (row.items.length === 0) {
        this.put("{}");
        return;
      }
      this.put("{ ");
      row.items.forEach((kv, i) => {
        if (i > 0) this.put(", ");
        if (kv.key.kind === "string") this.put(flowScalarText(kv.key.text));
        else this.scalarKey(kv.key);
        this.put(": ");
        this.flow(kv.value);
      });
      this.put(" }");
    }
  }

  flowFits(row, prefix) {
    if (!this.flowEligible(row)) return false;
    return prefix + this.measure(this.flow, row) <= this.width;
  }

  inlineValue(row) {
    this.props(row);
    const k = row.kind;
    if (row.ext_kind !== undefined) this.put(row.ext_kind === "enum_literal" ? scalarText(row.text) : row.text);
    else if (k === "null") this.put("null");
    else if (k === "bool") this.put(row.text);
    else if (k === "int" || k === "float") this.put(numberText(row.text));
    else if (k === "string") this.put(scalarText(row.text));
    else if (k === "sequence") this.put(row.items.length === 0 ? "[]" : "[...]");
    else if (k === "mapping") this.put(row.items.length === 0 ? "{}" : "{...}");
    else if (k === "alias") this.put("*", row.text);
  }

  blockScalar(s, indent) {
    const clip = s.endsWith("\n");
    this.put(clip ? "|\n" : "|-\n");
    const body = clip ? s.slice(0, -1) : s;
    for (const line of body.split("\n")) {
      if (line.length === 0) this.put("\n");
      else {
        this.indent(indent);
        this.put(line, "\n");
      }
    }
  }

  tryBlockStringValue(row, indent) {
    if (row.kind !== "string" || row.ext_kind !== undefined) return false;
    if (!blockScalarOk(row.text)) return false;
    this.props(row);
    this.blockScalar(row.text, indent);
    return true;
  }

  explicitKey(key, depth) {
    if (this.flowFits(key, 2 * depth + 2)) {
      this.put("? ");
      this.flow(key);
      this.put("\n");
    } else {
      this.put("?");
      this.propsAfterColon(key);
      this.put("\n");
      this.node(key, depth + 1);
    }
    this.indent(depth);
  }

  keyValue(kv, depth, skipIndent) {
    const value = kv.value;
    if (!skipIndent) this.indent(depth);
    let valuePrefix;
    const kk = kv.key.kind;
    if (kk === "sequence" || kk === "mapping") {
      this.explicitKey(kv.key, depth);
      valuePrefix = 2 * depth + 2;
    } else {
      this.keyLead(kv.key);
      valuePrefix = 2 * depth + this.keyCols(kv.key) + 2;
    }
    const vk = value.kind;
    if (vk === "mapping" || vk === "sequence") {
      if (value.items.length > 0 && this.flowFits(value, valuePrefix)) {
        this.put(": ");
        this.flow(value);
        this.put("\n");
        return;
      }
      this.put(":");
      this.propsAfterColon(value);
      if (value.items.length === 0) {
        this.put(vk === "mapping" ? " {}\n" : " []\n");
      } else {
        this.trailingComment(value);
        this.put("\n");
        if (vk === "mapping") this.mapping(value, depth + 1);
        else this.sequence(value, depth);
      }
    } else {
      this.put(": ");
      if (!this.tryBlockStringValue(value, depth + 1)) {
        this.inlineValue(value);
        this.trailingComment(value);
        this.put("\n");
      }
    }
  }

  mapping(row, depth) {
    if (row.items.length === 0) {
      this.put("{}\n");
      return;
    }
    for (const kv of row.items) {
      this.leadingComments(leadingAnchor(kv), depth);
      this.keyValue(kv, depth, false);
    }
  }

  sequenceMapping(row, depth) {
    this.keyValue(row.items[0], depth + 1, true);
    for (let i = 1; i < row.items.length; i++) {
      const kv = row.items[i];
      this.leadingComments(leadingAnchor(kv), depth + 1);
      this.keyValue(kv, depth + 1, false);
    }
  }

  sequence(row, depth) {
    if (row.items.length === 0) {
      this.put("[]\n");
      return;
    }
    for (const item of row.items) {
      this.leadingComments(seqItemLeadAnchor(item), depth);
      this.indent(depth);
      const k = item.kind;
      if (k === "mapping") {
        this.put("- ");
        if (item.items.length > 0) {
          if (hasProps(item)) {
            this.propsOwnLine(item);
            this.mapping(item, depth + 1);
          } else {
            this.sequenceMapping(item, depth);
          }
        } else {
          this.props(item);
          this.put("{}\n");
        }
      } else if (k === "sequence") {
        if (item.items.length === 0) {
          this.put("- ");
          this.props(item);
          this.put("[]\n");
        } else if (hasProps(item)) {
          this.put("- ");
          this.propsOwnLine(item);
          this.sequence(item, depth + 1);
        } else {
          this.put("-\n");
          this.sequence(item, depth + 1);
        }
      } else {
        this.put("- ");
        if (!this.tryBlockStringValue(item, depth + 1)) {
          this.inlineValue(item);
          this.trailingComment(item);
          this.put("\n");
        }
      }
    }
  }

  node(row, depth) {
    const k = row.kind;
    if (row.ext_kind !== undefined) {
      this.put(row.ext_kind === "enum_literal" ? scalarText(row.text) : row.text, "\n");
    } else if (k === "null") this.put("null\n");
    else if (k === "bool") this.put(row.text, "\n");
    else if (k === "int" || k === "float") this.put(numberText(row.text), "\n");
    else if (k === "string") this.put(scalarText(row.text), "\n");
    else if (k === "sequence") this.sequence(row, depth);
    else if (k === "mapping") this.mapping(row, depth);
    else if (k === "keyvalue") this.keyValue(row, depth, false);
    else if (k === "alias") this.put("*", row.text, "\n");
  }

  rootNode(root) {
    if (!hasProps(root)) return this.node(root, 0);
    if ((root.kind === "sequence" || root.kind === "mapping") && root.items.length > 0) {
      this.propsOwnLine(root);
      if (root.kind === "sequence") this.sequence(root, 0);
      else this.mapping(root, 0);
      return;
    }
    this.props(root);
    this.node(root, 0);
  }

  handleIsUsed(handle) {
    for (const row of this.t.rows) {
      if (row.tag !== undefined && tagHandleOf(row.tag) === handle) return true;
    }
    return false;
  }

  directives() {
    let wrote = false;
    for (const d of this.t.directives) {
      if (this.handleIsUsed(d.handle)) {
        this.put("%TAG ", d.handle, " ", d.prefix, "\n");
        wrote = true;
      }
    }
    if (wrote) this.put("---\n");
  }
}

function print(_dialect, t, options) {
  fig.index(t);
  const pr = new Printer(t, options?.width ?? 80);
  const root = t.rows[0];
  pr.leadingComments(leadingAnchor(root), 0);
  pr.directives();
  pr.rootNode(root);
  pr.danglingComments(root, 0);
  return pr.out.join("");
}

export default {
  name: "js-yaml",
  caps: { read: true, edit: true, serialize: true, references: true },
  // The core schema has a `null` and none of the extended scalars.
  lossless: { null: true },
  syntax: {
    comments: { style: "hash", line: { open: "#" }, trailing: { open: "#" } },
    merge_key: "<<",
    kv_sep: ": ",
    empty_map_literal: "",
    single_line_block_mapping: true,
  },
  // The compiled format owns `.yaml`/`.yml`, and a compiled format's
  // extension wins, so this is reached by `--lang js-yaml`. The 1.1
  // dialect differs only in how a plain scalar resolves; the compiled
  // format selects it with `--spec 1.1`, which a runtime dialect has no
  // row for, so it is a second dialect, reached by name.
  dialects: [
    { name: "js-yaml", extensions: ["yaml", "yml"], splice: "literal", empty_doc_seed: "" },
    { name: "js-yaml-1.1", extensions: [], splice: "literal", empty_doc_seed: "" },
  ],
  samples: ["a: 1\nb:\n  - x\n  - y\nc:\n  d: true\n", "{a: 1, b: [2, 3]}\n"],
  renderers: [],
  parse,
  print,
};
