---
name: second-brain-drop
description: "File one file from the Second Brain's drop/ folder: claim it, extract it locally, save the source under raw/ and the original under raw/originals/, rewrite the wiki around it, or quarantine it with a reason. One file per run; silent when drop/ is empty."
version: 1.0.0
author: Chief Command Center
license: MIT
platforms: [windows, macos, linux]
metadata:
  hermes:
    tags: [second-brain, drop, ingest, raw, wiki]
    category: note-taking
    related_skills: [second-brain, second-brain-writes, obsidian-find]
---

# Drop folder: file one file

`drop/` in the Second Brain `{{vault}}` is the owner's inbox for files. This routine files **exactly one** file per run and rewrites the wiki around it. Read `{{vault}}\{{rules}}` first and follow the `second-brain-writes` gate for every write.

## Hard rules

1. **One file per run.** Never loop over the folder; the next run takes the next file.
2. **Empty is silent.** If there is nothing to file, the final response is exactly `[SILENT]`, with no writes anywhere.
3. **Claim before work.** Move the file into `drop/_processing/` before extracting, so two runs can never take the same file.
4. **Quarantine over guessing.** Anything unclear goes to `drop/needs-review/` with a reason note. Never invent content.
5. **No downloads, no paid services.** Use only what works locally right now. A file that would need a new download (a model, a converter) or a paid service is quarantined with that reason, for the owner to decide.
6. **`raw/` is for outside sources** (documents, articles, photos, recordings, conversations). A document an agent produced (an analysis, a plan, a report) is filed in `wiki/` as a page, not in `raw/`.
7. **Verify before reporting success.**

## Folders

| Path | Role |
| --- | --- |
| `drop/` | Files waiting (only files directly in it) |
| `drop/_processing/` | The one file being filed |
| `drop/needs-review/` | Quarantine, each file with a `<name>.reason.md` |
| `raw/originals/` | Originals after filing, never edited |
| `raw/articles/`, `raw/pdfs/`, `raw/transcripts/`, `raw/images/`, `raw/videos/` | The extracted text, as a source note |

Always ignore `drop/README.md`, names starting with `.`, and anything in the subfolders.

## Procedure

1. **Leftover claim.** If `drop/_processing/` holds a file from an interrupted run, finish that one (it is this run's file), or quarantine it as `stale-claim` if it can't be read.
2. **Pick.** List the files directly in `drop/` (minus the ignored ones). None: final response `[SILENT]`, stop. Otherwise take the oldest by modified time.
3. **Stable?** Note its size and modified time, wait about 10 seconds, check again. Changed: it is still copying, so stop with `[SILENT]` (the next run takes it).
4. **Screen.** Quarantine without extracting when it is larger than 50 MB (`oversize`) or a container: `.zip`, `.7z`, `.rar`, `.tar`, `.gz` (`container`; the owner drops the files one by one).
5. **Claim.** Move it to `drop/_processing/<same name>`. If the move fails (locked), stop with `[SILENT]`.
6. **Extract**, from the claimed path:

   | Kind | How | Source note in |
   | --- | --- | --- |
   | `.md`, `.txt`, `.csv` | `read_file` | `raw/articles/` (a conversation: `raw/transcripts/`) |
   | `.pdf`, `.docx`, `.doc`, `.rtf`, `.odt`, `.epub` | `read_file` (it converts documents to text) | `raw/pdfs/` or `raw/articles/` |
   | `.xlsx`, `.xls`, `.ods`, `.pptx`, `.ppt` | `read_file` | `raw/articles/` |
   | `.png`, `.jpg`, `.jpeg`, `.webp`, `.heic`, `.gif` | `vision_analyze` on the claimed path (describe it and read any text in it) | `raw/images/` |
   | `.url`, `.webloc` (a saved link) | read the address, then `web_extract` | `raw/articles/` |
   | `.eml` | `read_file`: headers and body | `raw/transcripts/` |
   | audio, video | a transcription tool, only if one is available without a download or a paid key | `raw/transcripts/`, `raw/videos/` |

   Quarantine when the extraction is empty or meaningless (`weak-extraction`, e.g. a scanned PDF with no text and no way to read it), the type is unknown (`unsupported-type`), it needs something not available (`needs-download`, `needs-vision`, `needs-transcription`), or it looks like someone's private records (medical, financial, legal) with no sign the owner meant to file them (`possible-sensitive-content`).
7. **Quarantine path.** Move the file to `drop/needs-review/<name>` and write `drop/needs-review/<name>.reason.md`: name, size, kind, reason code, what was tried, and what the owner can do. Add one line to `log.md`. Stop.
8. **File it.**
   1. Read `index.md` and the pages this source will touch.
   2. Move the original to `raw/originals/YYYY-MM-DD - <name>` (on a clash add `-2`, `-3`).
   3. Write the source note `raw/<kind>/YYYY-MM-DD - <Title>.md` from `templates/Source.md`: properties, `## For future agent`, where it came from (original name, the `raw/originals/` path, how it was extracted), then the content as extracted.
   4. **Rewrite the wiki:** the primary page (the entity, project or concept it is about), then fan out: the people, organizations and concepts whose facts it changes, updating their canonical sections (tables, current status), not just appending. One canonical page per subject. Create stubs for new subjects worth a page.
   5. A task or a date in it: a card on the right board plus its task note, together.
   6. `index.md`: the new source line, any new pages, and counts that match the folders.
   7. Today's daily note (`wiki/daily/YYYY-MM-DD.md`): what was filed and every page rewritten, with links. `log.md`: one entry listing every path.
9. **Verify** (blocks the success report):
   - the file is gone from `drop/` and `drop/_processing/`;
   - the original is in `raw/originals/` and the source note in `raw/`;
   - `index.md` lists the source and its counts are true;
   - the daily note and `log.md` list every path.

   Then end with a short summary: what was filed, the pages rewritten, `write-gate: PASS` (or `PARTIAL` and what's missing).

## Pitfalls

- Filing several files in one run, or summarizing a folder: one file, fully filed.
- Writing to the daily note or `log.md` on an empty run.
- Calling `vision_analyze` on the old `drop/` path after the claim moved the file.
- Rewriting only the primary page while concepts and `index.md` keep stale facts.
- Leaving a file in `drop/_processing/`.
