# Changelog

What has changed in fig-quickjs, release by release, for someone deciding
whether to move to a newer one.

Two halves, written two different ways.

The bulleted groups below — **Added**, **Fixed**, **Changed**, and a
**Behavioural changes** section under them — are **generated** from the commit
log by `dx changelog --write`, which reads one shared `cliff.toml` — the same
file, and the same style, in every repository here. Anything inside a
`git-cliff:begin` / `git-cliff:end` pair is rewritten on every run, so an edit
made there is an edit thrown away.

Everything else is handwritten and stays: this prose, and any intro a release
needs under its own heading, below the end marker where regeneration cannot
reach it.

**Behavioural changes** are collected from `Behavioural-change:` trailers on the
commits themselves, not from their subjects — because "would a reader who
upgrades without editing a line of their own code observe a difference" is a
judgment about the change that no subject can carry. Write one trailer per
observable difference, as prose someone can act on.

Two kinds of change here deserve a trailer that would not obviously need one
elsewhere:

- **Anything that changes the table a shipped module produces.** A twin is
  held to its compiled sibling row for row, so a span that moves in
  `dotenv.mjs` is a span that moves for whoever reads it through `fig`, even
  when the compiled format moved first and the module is only following.
- **Anything that changes what the served modules do** — `fig`,
  `fig/grammar`, `fig/xml`: a field a row gains, an id that renumbers, a
  helper that starts trimming. Every module ever written runs against them.

## Unreleased

<!-- git-cliff:begin — generated; edits here are overwritten -->

### Added

- fig-quickjs, a fig format written in JavaScript, at parity with fig-lua ([`9984c36`](https://github.com/diaryx-org/fig-quickjs/commit/9984c36ee060ced4e7703c909e3d3757bf743d1f))
- json.mjs, the twin of fig's compiled json format ([`498514e`](https://github.com/diaryx-org/fig-quickjs/commit/498514ec631e1dcc3fa209248e4f7a7bbda72f32))
- toml.mjs, the twin of fig's compiled toml format ([`88d27a1`](https://github.com/diaryx-org/fig-quickjs/commit/88d27a166744c3f52152cbed490a479f134b5661))
- ini.mjs, the twin of fig's compiled ini format ([`d27a961`](https://github.com/diaryx-org/fig-quickjs/commit/d27a961a7dfcb44d79d72fc2e109663ffaf6b45c))

### Fixed

- **engine** — give QuickJS a 16 MB stack, on a thread with twice that ([`e7d331b`](https://github.com/diaryx-org/fig-quickjs/commit/e7d331b2e6b05c4f8f5504b885da39b7cbb13200))

### Uncategorised — triage before release

- Initial commit ([`4776d26`](https://github.com/diaryx-org/fig-quickjs/commit/4776d261e2d3d0f7b69d71f7e46d071e296cc8a7))

### Behavioural changes

- a module whose parse recursed past ~256 KB of stack
used to be refused with "Maximum call stack size exceeded"; it now
parses, up to 16 MB.

<!-- git-cliff:end -->
