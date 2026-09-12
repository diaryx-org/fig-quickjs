// ../../../../../../private/tmp/twin/dotenv.ts
import { LanguageError } from "@diaryx/fig/helper";
var encoder = new TextEncoder;
var decoder = new TextDecoder;
var MESSAGES = {
  UnexpectedToken: "unexpected content here; expected `KEY=value` (optionally `export KEY=value`)",
  MissingEquals: "expected `=` after this key; every dotenv line is `KEY=value`",
  BadEscape: "invalid escape in a double-quoted value; supported: \\n \\t \\r \\\\ \\\" — use a single-quoted value for raw text with backslashes",
  UnexpectedCarriageReturn: "a bare `\\r` must be followed by `\\n`; line endings must be `\\n` or `\\r\\n`",
  UnclosedString: "unclosed quoted value; expected a matching `\"`/`'` before the end of the file",
  UnexpectedChar: "not a valid key here; a dotenv key is a bash identifier (`[A-Za-z_][A-Za-z0-9_]*`)",
  TrailingContent: "unexpected content after this quoted value; only a `#` comment may follow it on the same line"
};
var SP = 32;
var TAB = 9;
var NL = 10;
var CR = 13;
var HASH = 35;
var EQ = 61;
var DQ = 34;
var SQ = 39;
var BS = 92;
function isIdentStart(c) {
  return c === 95 || c >= 65 && c <= 90 || c >= 97 && c <= 122;
}
function isIdentChar(c) {
  return isIdentStart(c) || c >= 48 && c <= 57;
}
function parse(_dialect, input) {
  const src = encoder.encode(input);
  const text = (s, e) => decoder.decode(src.subarray(s, e));
  const rows = [{ kind: "mapping", parent: null, span: [0, src.length] }];
  const comments = [];
  const entries = new Map;
  let pendingLeading = [];
  let lastValue = null;
  let i = src.byteLength >= 3 && src[0] === 239 && src[1] === 187 && src[2] === 191 ? 3 : 0;
  const atLineEnd = (at) => at >= src.length || src[at] === NL || src[at] === CR;
  const fail = (message, at) => {
    throw new LanguageError(message, at);
  };
  const skipHs = () => {
    while (i < src.length && (src[i] === SP || src[i] === TAB))
      i++;
  };
  const comment = () => {
    i++;
    const start = i;
    while (!atLineEnd(i))
      i++;
    const body = text(start, i).replace(/^[ \t\r]+|[ \t\r]+$/g, "");
    if (lastValue !== null) {
      comments.push({ node: lastValue, slot: "trailing", style: "line", text: body });
      lastValue = null;
    } else {
      pendingLeading.push(body);
    }
  };
  const newline = () => {
    if (src[i] === CR) {
      if (src[i + 1] !== NL)
        fail(MESSAGES.UnexpectedCarriageReturn, i);
      i += 2;
    } else
      i++;
    lastValue = null;
  };
  const quoted = (q) => {
    const start = i;
    i++;
    const parts = [];
    while (i < src.length) {
      const c = src[i];
      if (c === CR) {
        if (src[i + 1] !== NL)
          fail(MESSAGES.UnexpectedCarriageReturn, i);
        parts.push(NL);
        i += 2;
        continue;
      }
      if (q === DQ && c === BS) {
        const e = src[i + 1];
        if (e === undefined)
          fail(MESSAGES.UnclosedString, start);
        const decoded = e === 110 ? NL : e === 116 ? TAB : e === 114 ? CR : e === BS ? BS : e === DQ ? DQ : null;
        if (decoded === null)
          fail(MESSAGES.BadEscape, i);
        parts.push(decoded);
        i += 2;
        continue;
      }
      if (c === q) {
        i++;
        return [start, i, decoder.decode(Uint8Array.from(parts))];
      }
      parts.push(c);
      i++;
    }
    return fail(MESSAGES.UnclosedString, start);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === NL || c === CR) {
      newline();
      continue;
    }
    if (c === SP || c === TAB) {
      i++;
      continue;
    }
    if (c === HASH) {
      comment();
      continue;
    }
    if (c === EQ)
      fail(MESSAGES.UnexpectedToken, i);
    if (!isIdentStart(c))
      fail(MESSAGES.UnexpectedChar, i);
    let keyStart = i;
    while (i < src.length && isIdentChar(src[i]))
      i++;
    let keyEnd = i;
    if (text(keyStart, keyEnd) === "export") {
      const save = i;
      skipHs();
      if (i > save && i < src.length && isIdentStart(src[i])) {
        keyStart = i;
        while (i < src.length && isIdentChar(src[i]))
          i++;
        keyEnd = i;
      } else
        i = save;
    }
    skipHs();
    if (src[i] !== EQ)
      fail(MESSAGES.MissingEquals, keyStart);
    i++;
    skipHs();
    let vStart, vEnd, value;
    if (src[i] === DQ || src[i] === SQ) {
      [vStart, vEnd, value] = quoted(src[i]);
      skipHs();
      if (src[i] === HASH) {} else if (!atLineEnd(i))
        fail(MESSAGES.TrailingContent, i);
    } else {
      vStart = i;
      let end = i;
      let sawSpace = i > 0 && (src[i - 1] === SP || src[i - 1] === TAB);
      while (i < src.length) {
        const b = src[i];
        if (b === NL || b === CR)
          break;
        if (b === HASH && sawSpace)
          break;
        sawSpace = b === SP || b === TAB;
        i++;
        end = i;
      }
      while (end > vStart && (src[end - 1] === SP || src[end - 1] === TAB))
        end--;
      vEnd = end;
      value = text(vStart, vEnd);
    }
    const key = text(keyStart, keyEnd);
    const existing = entries.get(key);
    if (existing) {
      pendingLeading = [];
      rows[existing.value] = { kind: "string", parent: existing.kv, span: [vStart, vEnd], text: value };
      for (let k = comments.length - 1;k >= 0; k--) {
        if (comments[k].node === existing.value && comments[k].slot === "trailing")
          comments.splice(k, 1);
      }
      lastValue = existing.value;
    } else {
      const kv = rows.length;
      rows.push({ kind: "keyvalue", parent: 0, span: [keyStart, vEnd] });
      const keyRow = rows.length;
      rows.push({ kind: "string", parent: kv, span: [keyStart, keyEnd], text: key });
      for (const c of pendingLeading)
        comments.push({ node: keyRow, slot: "leading", style: "line", text: c });
      pendingLeading = [];
      const valueRow = rows.length;
      rows.push({ kind: "string", parent: kv, span: [vStart, vEnd], text: value });
      entries.set(key, { kv, value: valueRow });
      lastValue = valueRow;
    }
    if (src[i] === HASH)
      comment();
  }
  for (const c of pendingLeading)
    comments.push({ node: 0, slot: "dangling", style: "line", text: c });
  const SLOT = { leading: 0, trailing: 1, dangling: 2 };
  comments.sort((a, b) => a.node - b.node || SLOT[a.slot] - SLOT[b.slot]);
  return { rows, comments };
}
function needsQuoting(v) {
  if (v === "")
    return false;
  if (/^[ \t]|[ \t]$/.test(v))
    return true;
  return /[\n\r"\\#]/.test(v);
}
function writeText(v) {
  if (!needsQuoting(v))
    return v;
  return '"' + v.replace(/[\n\r\t"\\]/g, (c) => ({ "\n": "\\n", "\r": "\\r", "\t": "\\t", '"': "\\\"", "\\": "\\\\" })[c]) + '"';
}
function writeValue(row) {
  switch (row.kind) {
    case "string":
      return writeText(row.text ?? "");
    case "int":
    case "float":
    case "bool":
      return row.text ?? "";
    case "null":
      throw new LanguageError("dotenv has no null; a null value cannot be written");
    case "sequence":
    case "mapping":
      throw new LanguageError("dotenv holds a flat map of strings; a nested value cannot be written");
    case "alias":
      throw new LanguageError("an alias must be resolved before it is written as dotenv");
    default:
      throw new LanguageError(`a ${row.kind} is not a value`);
  }
}
function commentLines(text) {
  return text.split(`
`).map((line) => {
    const t = line.replace(/^[ \t]+|[ \t]+$/g, "");
    return t === "" ? `#
` : `# ${t}
`;
  }).join("");
}
function print(_dialect, t, _options) {
  const rows = t.rows;
  const root = rows[0];
  if (root.kind !== "mapping")
    return writeValue(root);
  const by = (node, slot) => (t.comments ?? []).filter((c) => c.node === node && c.slot === slot);
  let out = "";
  for (let kv = 0;kv < rows.length; kv++) {
    if (rows[kv].parent !== 0 || rows[kv].kind !== "keyvalue")
      continue;
    const children = [];
    for (let j = kv + 1;j < rows.length && children.length < 2; j++)
      if (rows[j].parent === kv)
        children.push(j);
    const [keyRow, valueRow] = children;
    const key = rows[keyRow];
    const value = rows[valueRow];
    if (key.kind !== "string")
      throw new LanguageError("a dotenv key must be a string");
    const name = key.text ?? "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new LanguageError(`\`${name}\` is not a dotenv key; a key is a bash identifier`);
    for (const c of by(keyRow, "leading"))
      out += commentLines(c.text);
    out += `${name}=${writeValue(value)}`;
    const trailing = by(valueRow, "trailing")[0];
    if (trailing)
      out += " #" + (trailing.text === "" ? "" : " " + trailing.text.replace(/\n/g, " "));
    out += `
`;
  }
  for (const c of by(0, "dangling"))
    out += commentLines(c.text);
  return out;
}
var dotenv = {
  name: "js-dotenv",
  caps: { read: true, edit: true, serialize: true },
  max_mapping_depth: 0,
  syntax: {
    comments: { style: "hash", line: { open: "#" }, trailing: { open: "#" } },
    kv_sep: "=",
    empty_map_literal: "{}",
    flow_containers: false
  },
  dialects: [{ name: "js-dotenv", extensions: ["env"], splice: "raw", empty_doc_seed: "" }],
  samples: [`A=1
B="two words"
`, `# top
export C='raw \\n'
D=x # trailing
`],
  parse,
  print
};
export {
  dotenv
};
