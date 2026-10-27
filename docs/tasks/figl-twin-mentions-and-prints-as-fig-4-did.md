---
title: fig.mjs mentions and prints figl as fig 4 did
description: fig-quickjs builds against fig 7, and fig.mjs reads every figl fixture to the compiled tree, but its node table lacks the mentions fig 6 added and its printer writes fig 4's flow objects and multi-line string comments
status: done
created: 2026-10-24
updated: 2026-10-27
part_of: "[Tasks](tasks.md)"
---

# fig.mjs mentions and prints figl as fig 4 did

**Status.** Done (2026-10-27). `fig.mjs` is fig's own figl twin
(`bindings/typescript/js/figl.js`) as it stands on fig's `main`, carried
over with this repository's module names and dialect, so it takes all three
changes below and the ones made beside them: an inline container the editor
asks for (`options.flow`) is spelled `{x=1 y=2}` as the compiled format
spells it. Both lists are gone from `tests/twins.rs`,
`fig_edits_as_the_compiled_format_does` runs, and
`fig_refuses_what_the_compiled_format_refuses` holds `fig.mjs` to spec 2.0's
malformed flow objects.

fig-quickjs moved from fig 4 to fig 7, and the other twins were brought
level with fig 7's compiled languages. `fig.mjs` was not. It reads each
figl fixture to the same tree and the same values as the compiled figl,
but it is missing three changes made to figl since fig 4.

- **Mentions.** fig's `ecc6d1da` (*a key that re-opens a container mid-path
  is a mention of it*) and `07b3b1b5` (*a mention can say where a sequence
  item's path is written*) give the table an `entry` or `header` mention for
  every key that re-opens a block container, and `index` and `append`
  mentions on sequence elements. `fig.mjs` records a container's creating key
  and its header re-entries, all as `entry`.
- **Compact flow objects.** fig's `acd87014` (figl spec 2.0) reads an
  `=`-spelled flow object as whitespace-separated pairs with one-token
  values and dotted keys (`{a.b=1 c=2}`), and prints one as `{x=1 y=2}`.
  `fig.mjs` reads and prints fig 4's `{ x = 1, y = 2 }`.
- **A multi-line string's comment.** fig's `8a1c8e48` prints a `'''` or
  `"""` string's trailing comment on its opener line (`x = ''' # note`).
  `fig.mjs` prints it after the closing quotes.

fig-lua's `fig.lua` has the same gap, filed there under the same name.

## Repro

```console
$ cargo test --test twins fig_edits -- --ignored
$ fig lang table -i figl tests/fixtures/fig/dotted-keys.figl   # fig 7: 11 mentions
```

`fig.mjs` gives `dotted-keys.figl` 7 mentions, where fig 7 gives 11, and
prints `fresh = { deep = { key = 1 } }` where fig 7 prints
`fresh = {deep={key=1}}`.

## Done when

`FIGL_TABLES_AHEAD` and `FIGL_PRINTS_AHEAD` in `tests/twins.rs` are empty
and gone, `fig_edits_as_the_compiled_format_does` runs unignored, and
`fig.mjs` refuses spec 2.0's malformed flow objects (`FigFlowMissingEquals`
and the rest) wherever the compiled figl does.
