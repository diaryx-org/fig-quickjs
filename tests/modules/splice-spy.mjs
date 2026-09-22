// dotenv, with a `print` that marks what it prints as splice text: a value
// printed with `options.splice` comes back as `S` and the value, so an edit
// through a binding shows what fig asked for. A whole document printed so
// would not reparse, so the registration harness is a check too.
import dotenv from "../../languages/dotenv.mjs";

export default {
  ...dotenv,
  name: "splice-spy",
  dialects: [{ ...dotenv.dialects[0], name: "splice-spy", extensions: ["splice-spy"] }],
  print(dialect, t, options) {
    const out = dotenv.print("js-dotenv", t, options);
    return options.splice === true ? "S" + out : out;
  },
};
