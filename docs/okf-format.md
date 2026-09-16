---
type: Reference
title: The OKF documentation format
description: How docs/ pages here are structured with Open Knowledge Format frontmatter, the fields this repo validates, and the authoritative spec to defer to.
tags: [docs, okf, conventions]
---

# The OKF documentation format

Everything under `docs/` follows Google's **Open Knowledge Format (OKF)** — a
convention for knowledge pages that are equally legible to humans and to agents:
a markdown file whose body is prose and whose leading YAML frontmatter carries
structured metadata, with pages linked to one another by ordinary markdown
links. The frontmatter is what lets an agent filter and rank pages by `type` /
`tags` and traverse the link graph without a translation layer.

> **Authoritative reference.** This page describes how we _apply_ OKF here. For
> any question about the format itself — field semantics, new field families,
> edge cases — defer to the upstream specification, which is the single source of
> truth:
>
> **<https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md>**
>
> We target **OKF v0.2**. Where this page and the spec disagree, the spec wins;
> open a PR to correct this page.

## Content pages

Every page that documents a piece of this repo is a "content page" and carries
frontmatter delimited by `---` fences at the very top of the file:

```yaml
---
type: Reference # required
title: What merge-safety is # required here
description: One specific sentence — the search surface an agent matches on. # required here
resource: src/index.ts # required for every non-Design, non-Reference type; a repo-relative path that exists
tags: [merge-safety, ci] # optional
---
```

This repo runs the **code-documentation flavour** of the `okf` check (the same
one `ai-tools` uses), so it is stricter than the open OKF spec in two ways:

- **`type`** is required and constrained to a curated vocabulary — **`Skill`**,
  **`Script`**, **`Library`**, **`Design`**, plus **`Reference`** for concept /
  guide pages like this one.
- **`resource`** — a repo-relative path that must **exist on disk** — is
  **required on every non-`Design`, non-`Reference` page**, binding each doc to
  the code it describes. `Design` and `Reference` pages are exempt (they document
  an intent or a convention, not one source file). The current doc pages are all
  `Reference` — they document concepts and conventions rather than individual
  source files.

The curated `type` vocabulary and the resource-exempt types are configured in
[`.repo-hygiene.yml`](../.repo-hygiene.yml) under `checks.okf`; adjust them there
if the repo grows a new kind of page.

## Index pages

Each directory in the bundle carries an **`index.md`** that links its content
pages and its sub-directory indexes. Per the spec, `index.md` files carry **no
frontmatter**, with one exception: the bundle-root [`docs/index.md`](index.md)
may carry a single `okf_version` key and nothing else. The tree must be fully
navigable — every content page reachable by following links from `docs/index.md`
down. Both conventions are enforced by the `okf-index` check.

## Enforcement

Conformance is gated by this repo's **Repo Hygiene** workflow, which runs the
`okf` (frontmatter) and `okf-index` (navigability) checks from
[`@rmartz/repo-hygiene`](https://github.com/rmartz/repo-hygiene) against our
`docs/` tree. Run the same checks locally against a built or installed CLI:

```bash
ai-repo-hygiene okf okf-index --check --config .repo-hygiene.yml
```
