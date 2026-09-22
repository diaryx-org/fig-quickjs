// The helper wire, in JavaScript: what a format written in JavaScript is
// (`Language`), and one request line to one response line (`handle`).
//
// The contract is fig's helper wire — the newline-delimited JSON a `fig`
// command line speaks to a helper process, documented once on the `helper`
// module of the Rust crate (bindings/rust/fig/src/helper.rs). A `Language`
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
/** How a language refuses its input: the message a caller sees, and the
 *  byte offset it points at, if any. */
export class LanguageError extends Error {
    byteOffset;
    constructor(message, byteOffset) {
        super(message);
        this.name = "LanguageError";
        this.byteOffset = byteOffset;
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
        })),
        samples: lang.samples,
        renderers: lang.renderers ?? [],
    };
}
const RENDERERS = ["value", "entry", "item", "tail", "key"];
const LITERALS = ["null", "bool", "int", "float", "datetime", "string"];
/** One request line to one response line — the helper wire, in
 *  JavaScript. What the wasm module calls for a registered language, and
 *  what {@link serve} runs over stdin and stdout. Never throws: a refusal,
 *  a malformed request and a bug in the language alike come back as
 *  `{"ok":false,"message":…}`. */
export function handle(lang, requestLine) {
    try {
        return JSON.stringify(handleInner(lang, requestLine));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const byteOffset = err instanceof LanguageError ? err.byteOffset : undefined;
        return JSON.stringify(byteOffset === undefined ? { ok: false, message } : { ok: false, message, byte_offset: byteOffset });
    }
}
function handleInner(lang, requestLine) {
    let req;
    try {
        req = JSON.parse(requestLine);
    }
    catch (err) {
        throw new LanguageError(`request is not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof req !== "object" || req === null || typeof req.op !== "string") {
        throw new LanguageError("request has no op");
    }
    switch (req.op) {
        case "describe":
            return { ok: true, description: describe(lang) };
        case "parse": {
            if (typeof req.dialect !== "string" || typeof req.input !== "string") {
                throw new LanguageError("parse: dialect and input are strings");
            }
            const table = lang.parse(req.dialect, req.input);
            const out = { rows: table.rows, regions: table.regions ?? [], mentions: table.mentions ?? [], comments: table.comments ?? [] };
            if (table.directives && table.directives.length > 0) out.directives = table.directives;
            return { ok: true, table: out };
        }
        case "print": {
            if (!lang.print)
                throw new LanguageError(`${lang.name} does not serialize`);
            if (typeof req.dialect !== "string" || typeof req.table !== "object" || req.table === null || !Array.isArray(req.table.rows)) {
                throw new LanguageError("print: dialect is a string and table a node table");
            }
            const o = req.options ?? {};
            const options = {
                pretty: o.pretty ?? true,
                strip_comments: o.strip_comments ?? false,
                indent: o.indent ?? 2,
                width: o.width ?? 80,
                splice: o.splice ?? false,
            };
            return { ok: true, output: lang.print(req.dialect, req.table, options) };
        }
        case "render": {
            if (!lang.render)
                throw new LanguageError(`${lang.name} declares no renderers`);
            if (!RENDERERS.includes(req.which))
                throw new LanguageError(`render: unknown renderer ${JSON.stringify(req.which)}`);
            if (typeof req.dialect !== "string")
                throw new LanguageError("render: dialect is a string");
            // Absent or unknown: a string, which is what a renderer does with any
            // text it cannot type.
            const literal = LITERALS.includes(req.literal) ? req.literal : "string";
            const output = lang.render(req.which, {
                dialect: req.dialect,
                indent: req.indent ?? "",
                key: req.key ?? "",
                value: req.value ?? "",
                literal,
                old_key: req.old_key ?? "",
            });
            return { ok: true, output };
        }
        default:
            throw new LanguageError(`unknown op ${JSON.stringify(req.op)}`);
    }
}
//# sourceMappingURL=wire.js.map