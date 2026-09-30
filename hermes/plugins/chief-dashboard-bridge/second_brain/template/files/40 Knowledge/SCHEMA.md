# Wiki Schema

This folder is the chief's knowledge wiki (the "LLM wiki" pattern): the owner curates sources, the chief summarizes, cross-references and keeps it consistent. Structure: `raw/` holds immutable sources; `entities/`, `concepts/`, `comparisons/` and `queries/` hold the chief's pages; `index.md` lists every page; `log.md` records every change.

## Domain

Everything the owner wants to understand and remember: their work, interests and decisions. Refine this line when the focus becomes clearer.

## Conventions

- File names: lowercase, hyphens, no spaces (for example `solar-panels.md`).
- Every page starts with YAML frontmatter (below).
- Use `[[wikilinks]]` between pages; at least two outbound links per page.
- Bump `updated` whenever a page changes.
- Add every new page to `index.md` under its section.
- Append every action to `log.md`.
- On pages that synthesize three or more sources, end a paragraph with `^[raw/articles/source-file.md]` when its claim comes from that source.

## Frontmatter

```yaml
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: entity | concept | comparison | query | summary
tags: [from the taxonomy below]
sources: [raw/articles/source-name.md]
confidence: high | medium | low
---
```

Raw sources get their own small block:

```yaml
---
source_url: https://example.com/article
ingested: YYYY-MM-DD
sha256: <hex digest of the body>
---
```

## Tag taxonomy

Add a tag here before using it.

- Kinds: person, organization, place, product, idea, method
- Life: home, health, money, work, learning
- Meta: comparison, decision, timeline, open-question

## Page thresholds

- Create a page when something appears in two sources, or is central to one.
- Add to an existing page when a source mentions something already covered.
- Split a page past about 200 lines.
- Archive a superseded page to `90 Archive/` and remove it from the index.
