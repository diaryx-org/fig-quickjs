// The helper wire, in JavaScript: what a format written in JavaScript is
// (`Language`), and one request line to one response line (`handle`).
//
// The contract is fig's helper wire — JSON-RPC 2.0, one message per line,
// which a `fig` command line speaks to a helper process, specified in
// docs/helper-protocol.md. A `Language`
// here is that wire's `description`, with the functions the format is:
// `parse` answers the wire's node table, `print` is handed one back, and
// `render` spells the fragments the editor needs. Field names are the wire's
// own (`max_mapping_depth`, `empty_doc_seed`, `ext_kind`) rather than
// camelCase, on purpose: the object IS the wire document, so what
// `fig lang table <file>` prints is exactly what a `parse` must return, and
// the same object serves a `fig` CLI as a helper process through `serve`
// with no translation.
//
// This module imports nothing from the wasm side — no `ffi`, no module
// bytes — and must stay that way: it is what `@diaryx/fig/helper` resolves
// to, so a helper process loads the wire and its language and nothing else,
// and a runner that embeds a JavaScript engine can vendor this one file and
// have the same `handle` the wasm module calls. `registerLanguage`, which
// needs the module, is in `language.ts`.
/** How a language refuses its input: the message a caller sees, the byte
 *  offset it points at, if any, and, for a printer, which refusal it is —
 *  one of {@link Refusal}'s codes, so fig reports the failure it names. */
export class LanguageError extends Error {
    byteOffset;
    code;
    constructor(message, byteOffset, code) {
        super(message);
        this.name = "LanguageError";
        this.byteOffset = byteOffset;
        this.code = code;
    }
}
/** The reasons a printer gives for refusing a table, as the codes of a
 *  JSON-RPC error (docs/helper-protocol.md). `LanguageError`'s third
 *  argument. */
export const Refusal = {
    NullUnsupported: 1,
    NonStringKey: 2,
    UnrepresentableRoot: 3,
    UnsupportedValue: 4,
    InvalidKey: 5,
    NonFiniteNumber: 6,
    UnresolvedAlias: 7,
    NestingTooDeep: 8,
    UnexpectedNodeKind: 9,
};
/** The code of an error a language raises with no more specific one — a
 *  parse it refuses, a renderer that cannot spell a fragment. JSON-RPC
 *  leaves -32000 to -32099 to the server. */
export const LANGUAGE_REFUSED = -32000;
/** A JSON-RPC error raised while reading a request, before any language
 *  code runs: its code is one JSON-RPC reserves. */
class ProtocolError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** The wire's `description` of `lang`: every declared field, spelled as the
 *  wire spells it. What `handle` answers `describe` with. */
export function describe(lang) {
    return {
        name: lang.name,
        caps: { read: !!lang.caps.read, edit: !!lang.caps.edit, serialize: !!lang.caps.serialize, references: !!lang.caps.references },
        max_mapping_depth: lang.max_mapping_depth ?? null,
        lossless: lang.lossless ?? null,
        syntax: lang.syntax ?? null,
        dialects: lang.dialects.map((d) => ({
            name: d.name,
            extensions: d.extensions ?? [],
            splice: d.splice ?? "literal",
            empty_doc_seed: d.empty_doc_seed ?? null,
            syntax: d.syntax ?? null,
            prints: d.prints ?? null,
        })),
        samples: lang.samples,
        renderers: lang.renderers ?? [],
        split_stream: typeof lang.split_stream === "function",
    };
}
const RENDERERS = ["value", "entry", "item", "tail", "key", "key_name", "string"];
const LITERALS = ["null", "bool", "int", "float", "datetime", "string"];
/** One request line to one response line — the helper wire, JSON-RPC
 *  2.0, in JavaScript. What the wasm module calls for a registered
 *  language, and what {@link serve} runs over stdin and stdout. Never
 *  throws: a refusal, a malformed request and a bug in the language alike
 *  come back as an `error` response carrying the request's id. */
export function handle(lang, requestLine) {
    let id = null;
    try {
        let req;
        try {
            req = JSON.parse(requestLine);
        }
        catch (err) {
            throw new ProtocolError(-32700, `request is not JSON: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (typeof req !== "object" || req === null || Array.isArray(req))
            throw new ProtocolError(-32600, "a request is one JSON object");
        const r = req;
        if (typeof r.id === "number" || typeof r.id === "string")
            id = r.id;
        if (r.jsonrpc !== "2.0")
            throw new ProtocolError(-32600, 'a request carries "jsonrpc":"2.0"');
        if (typeof r.method !== "string")
            throw new ProtocolError(-32600, "a request names its method");
        if (r.params !== undefined && (typeof r.params !== "object" || r.params === null || Array.isArray(r.params))) {
            throw new ProtocolError(-32602, "params is an object");
        }
        const result = answer(lang, { method: r.method, params: r.params ?? {} });
        return JSON.stringify({ jsonrpc: "2.0", id, result });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        let code = LANGUAGE_REFUSED;
        let data;
        if (err instanceof ProtocolError)
            code = err.code;
        else if (err instanceof LanguageError) {
            if (err.code !== undefined)
                code = err.code;
            if (err.byteOffset !== undefined)
                data = { byte_offset: err.byteOffset };
        }
        const error = data === undefined ? { code, message } : { code, message, data };
        return JSON.stringify({ jsonrpc: "2.0", id, error });
    }
}
function invalidParams(message) {
    throw new ProtocolError(-32602, message);
}
function answer(lang, req) {
    switch (req.method) {
        case "describe":
            return describe(lang);
        case "parse": {
            const p = req.params;
            if (typeof p.dialect !== "string" || typeof p.input !== "string")
                invalidParams("parse: dialect and input are strings");
            const table = lang.parse(p.dialect, p.input);
            const out = { rows: table.rows, regions: table.regions ?? [], mentions: table.mentions ?? [], comments: table.comments ?? [] };
            if (table.directives && table.directives.length > 0)
                out.directives = table.directives;
            return out;
        }
        case "print": {
            const p = req.params;
            if (!lang.print)
                throw new ProtocolError(-32601, `${lang.name} does not serialize`);
            if (typeof p.dialect !== "string" || typeof p.table !== "object" || p.table === null || !Array.isArray(p.table.rows)) {
                invalidParams("print: dialect is a string and table a node table");
            }
            const o = p.options ?? {};
            const options = {
                pretty: o.pretty ?? true,
                strip_comments: o.strip_comments ?? false,
                indent: o.indent ?? 2,
                width: o.width ?? 80,
                splice: o.splice ?? false,
                flow: o.flow ?? false,
            };
            return lang.print(p.dialect, p.table, options);
        }
        case "split_stream": {
            const p = req.params;
            if (!lang.split_stream)
                throw new ProtocolError(-32601, `${lang.name} has no multi-document streams`);
            if (typeof p.dialect !== "string" || typeof p.input !== "string")
                invalidParams("split_stream: dialect and input are strings");
            return lang.split_stream(p.dialect, p.input);
        }
        case "render": {
            const p = req.params;
            if (!lang.render)
                throw new ProtocolError(-32601, `${lang.name} declares no renderers`);
            if (!RENDERERS.includes(p.which))
                invalidParams(`render: unknown renderer ${JSON.stringify(p.which)}`);
            if (typeof p.dialect !== "string")
                invalidParams("render: dialect is a string");
            // Absent or unknown: a string, which is what a renderer does with any
            // text it cannot type.
            const literal = LITERALS.includes(p.literal) ? p.literal : "string";
            return lang.render(p.which, {
                dialect: p.dialect,
                indent: p.indent ?? "",
                key: p.key ?? "",
                value: p.value ?? "",
                literal,
                old_key: p.old_key ?? "",
                parent_key: p.parent_key ?? "",
                parent_tag: p.parent_tag ?? "",
                old_value: p.old_value ?? "",
            });
        }
        default:
            throw new ProtocolError(-32601, `unknown method ${JSON.stringify(req.method)}`);
    }
}
