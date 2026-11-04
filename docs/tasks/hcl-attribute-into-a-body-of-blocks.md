---
title: An attribute added to a body of blocks lands under its header
description: Under fig 7, an attribute inserted into an HCL body that holds only nested blocks is spliced on the line after the body's header, unindented, where fig 4 put it after the last block at the body's indent
status: done
created: 2026-10-24
updated: 2026-11-04
part_of: "[Tasks](tasks.md)"
---

# An attribute added to a body of blocks lands under its header

**Status.** Done (2026-11-04), in `hcl.mjs`. No compiled format has a section
closed by its own line, so none needs the engine to learn one. A body with no
attribute of its own records its blocks' mentions as `entry`, which puts them
on the body's lines, and the engine anchors a new attribute after the last and
copies its indent, as it already did after a label level. `structural_indent`
keeps such a block taking attributes of its own: without it the engine treats
the block as a table its parent's lines write. The flag costs one refusal:
`comment_out` writes its marker past a line's leading `>`, so an attribute with
a line opening with `>` (a continuation, a heredoc) cannot be commented out.
Nothing is written, and
`hcl_refuses_to_comment_out_an_attribute_with_a_line_opening_with_a_greater_than`
pins it. An engine that took a new entry before a section's closing line would
need neither.

`hcl.mjs` records each block body as a section: its header line and its
closing `}` line as regions, and the token that names it as a mention. Under
fig 4 those mentions were of the `entry` kind. Under fig 7 an `entry` mention
means a table that its parent's lines write (TOML's `a` in `a.b = 1`), and
the editor's `owns_header_line` counts only `header` mentions. With `entry`
mentions, every insert into a block went through the headerless-table path,
and `set` on a new attribute answered `NotFound`. The port to fig 7 records
a body's mentions as `header`, so an attribute is inserted into the body
again, after its last attribute.

One case came out worse. If a body holds only nested blocks and no attribute
of its own, fig 7 treats it as a section with no entry on its own lines. It
anchors the new entry at the end of the body's header line and copies no
indent, so the attribute is written there:

```hcl
terraform {
required_version = ">= 1.5"
  required_providers {
    ...
  }
}
```

That is valid HCL, but `terraform fmt` would not write it, and fig 4 put the
attribute after `required_providers`, indented. The pinned test is
`hcl_puts_an_attribute_after_the_blocks_of_a_body_with_no_attributes` in
`tests/languages.rs`, ignored until this is done:

```console
$ cargo test --test languages hcl_puts -- --ignored
```

## The choice

The fix might belong in `hcl.mjs`, in how it records a body: for example, a
different mention, or a region shape that leads fig to the line before `}`.
It might belong in fig's engine instead, where a section closed by its own
line could take a new entry before that line, at its children's indent. Which
one is right depends on whether any compiled format needs the second.

## Done when

The pinned test runs unignored and passes, and the comment at the top of
`languages/hcl.mjs` no longer says "under its header line, unindented, for
now".
