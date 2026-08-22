---
name: hello-vela
description: A worked example of the skill format Vela reads. Use when checking what a valid skill directory looks like, or as the starting point for writing one.
license: Apache-2.0
metadata:
  display-name: Hello, Vela
---

# Hello, Vela

This directory is a skill. It exists so that the format has one real, parsed
example in the repository rather than only a description of one — the reference
this design studied names a skills document in its own README that was never
committed, and a format documented only in prose is a format every reader
implements slightly differently.

## What makes it a skill

A directory whose name matches the frontmatter name, containing a file named
SKILL.md: YAML frontmatter between two triple-dash lines, then Markdown. The
frontmatter above uses every field this reader understands — the two required
ones, an optional license, and one level of nesting under metadata.

## What the three levels cost

The name and the description above are read for every installed skill, so they
are the only text that is always in context. This body is read when the skill is
actually used. Anything in the optional scripts, references and assets
subdirectories is listed by name and read only when something needs that
particular file.

That is why the description is written to say both what the skill does and when
to use it: it is the whole of what a reader knows before deciding to load the
rest.
