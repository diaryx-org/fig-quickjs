// Run a fig-quickjs module under Node: a loader hook that resolves the
// names the binary serves — `fig`, `fig/grammar`, `fig/xml`, `fig/number`,
// `fig/datetime` — to this
// repository's `js/`. `@diaryx/fig/helper` resolves as any package does, so
// `@diaryx/fig` must be installed (or linked) beside whatever imports it.
//
//   node --import ./scripts/node-imports.mjs my-test.mjs
//
// What the twins' tests prove through QuickJS, this lets `node:test` prove
// through `@diaryx/fig`'s `registerLanguage` and the wasm module: the same
// module, the same tables, in both.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
const JS = ${JSON.stringify(new URL("../js/", import.meta.url).href)};
const MAP = { "fig": "fig.js", "fig/grammar": "grammar.js", "fig/xml": "xml.js", "fig/number": "number.js", "fig/datetime": "datetime.js" };
export async function resolve(specifier, context, next) {
  if (Object.hasOwn(MAP, specifier)) return { url: JS + MAP[specifier], shortCircuit: true };
  return next(specifier, context);
}
`),
  import.meta.url,
);
