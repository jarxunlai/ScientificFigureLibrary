# Scientific Figure Library

Scientific Figure Library is a standard MCP server and MCP App for finding,
importing, and materializing scientific figure references. It is not tied to
Wisp: any stdio MCP host can use it. The included Wisp manifest and Skill are a
thin optional adapter.

ScientificFigureLibrary is the canonical schema, asset, review, and lifecycle
authority. It exposes two searchable template sources and one isolated raw input
store:

- **FigureYa** — 319 searchable modules with local thumbnails and
  commit-pinned archives.
- **ScientificFigureLibrary user store** — immutable, versioned figures and
  plotting code curated by the user, plus readable flat-v1 compatibility entries.
- **Capture store** — raw web-article images, code, and context in a separate
  `FIGURE_CAPTURE_DIR`; Capture payloads never enter ordinary template search.

The host Agent analyzes an uploaded image, a natural-language request, or a data
file. It builds a compact retrieval intent, searches both sources, inspects the
top preview, and decides whether that candidate actually matches before
materializing anything. The catalog score orders retrieval candidates; it is
not a recommendation or visual-similarity score.

For image input, the Agent must first inspect the user's image with the host's
`view_image`, then inspect the top candidate with `figure_library_preview`.
The final recommendation includes an Agent-produced visual pass/reject score
covering chart family, layout, axes/geometry, encodings, and annotations/style,
plus a separate data-compatibility verdict.

## Safety contract

The server copies and extracts reference files but never executes plotting code
or dependency installers. It verifies imported user files with SHA-256 and
verifies FigureYa archives against the pinned catalog.

**Materialization errors are terminal.** `figure_library_materialize` returns a
`STOP:` error that instructs the Agent to report the exact failure and wait for
the user. The Agent must not switch extraction modes, use another downloader,
fetch the complete repository, recreate the template, or generate a
substitute/demo plot. This behavior is covered by the MCP smoke test.

## Build

Requirements: Node.js 22 or newer.

```bash
npm install
npm run check
```

## Use with any stdio MCP client

```json
{
  "mcpServers": {
    "figure-library": {
      "command": "node",
      "args": ["/absolute/path/to/ScientificFigureLibrary/dist/index.js"],
      "env": {
        "FIGURE_LIBRARY_DIR": "/absolute/path/to/my-figure-library",
        "FIGURE_CAPTURE_DIR": "/absolute/path/to/my-figure-captures",
        "FIGURE_GALLERY_DIR": "/optional/path/to/my-personal-gallery",
        "FIGUREYA_SOURCE_PACK_DIR": "/optional/path/to/FigureYaSourcePack"
      }
    }
  }
}
```

`FIGURE_LIBRARY_DIR` defaults to `~/.figure-library`. `FIGURE_CAPTURE_DIR` has
no implicit default: Capture status reports `configured: false` with an explicit
reason while all existing Library and FigureYa functions continue to work. The two configured
roots must not be equal or nested. The server exposes:

- `figure_library_open` — open an empty candidate workbench.
- `figure_library_search` — search FigureYa and/or the user library.
- `figure_library_import` — safely copy a user figure and/or code into the
  library, or validate and import a Figure Transfer Package. Direct-write mode
  remains for v0.2 compatibility; new Agents should use plan/apply.
- `figure_library_plan_import` — validate a direct import, calculate stable
  identity and component-level duplicate evidence, and write nothing.
- `figure_library_apply_import` — revalidate and apply one exact confirmed
  direct-import plan.
- `figure_library_diff` — validate one Transfer Package or Gallery entry and
  return a read-only create/update/unchanged diff.
- `figure_library_upsert` — explicitly apply a stable Transfer Package or
  Gallery create/update.
- `figure_library_sync` — validate or synchronize a Personal Gallery; dry-run
  is the default.
- `figure_library_archive` — logically archive any User Library entry by
  `templateId`, legacy `galleryId`, or adapter-scoped Registry source.
- `figure_library_preview` — return a candidate as MCP image content and,
  optionally, a checked project-local preview path for Agent inspection.
- `figure_library_source_status` — inspect effective Library, Capture, legacy
  Gallery, and FigureYa paths plus lifecycle/integrity counts.
- `figure_capture_open`, `figure_capture_article`, `figure_capture_list`, and
  `figure_capture_get` — capture and inspect web articles in the isolated
  Capture/Annotation Workbench.
- `figure_capture_asset` — return one raw image as MCP image content; this is the
  fallback when a host does not proxy dynamic `figure-capture://` resources.
- `figure_capture_archive` / `figure_capture_restore` — change raw Capture
  visibility without deleting payloads.
- `figure_capture_plan_cleanup` — report whether a Capture has a self-contained,
  committed template receipt. `figure_capture_apply_cleanup` is intentionally
  disabled in v0.4.0.
- `figure_library_plan_working_revision` /
  `figure_library_apply_working_revision` — create or update one complete,
  immutable Working Revision from an explicitly annotated Figure Unit.
- `figure_library_review_open`, `figure_library_template_history`, and
  `figure_library_diff_revisions` — inspect Published, Working, review state, and
  exact immutable history.
- Separate plan/apply tools update Review Gates, publish the Working Revision,
  discard it, restore a historical Release as Working, and explicitly adopt a
  flat-v1 template into versioned storage.
- `figure_library_audit` — read and verify manifests/files, legacy entries, and
  component-level duplicate evidence without writing.
- `figure_library_reconcile` — dry-run, apply, or roll back an explicitly
  approved logical duplicate archive using a write lock and recovery journal.
- `figure_library_describe` — inspect one exact template.
- `figure_library_materialize` — write one selected reference to a project.

The MCP server does not contain a second model. Agent reasoning stays in the
host: understand input → build retrieval intent → search → view the top
candidate → visually and semantically audit it → materialize only an accepted
template. For attachments, the host makes files available locally and the Agent
passes those paths to `figure_library_import`. For search, the Agent passes
compact descriptions, not raw datasets.

`figure_library_preview` returns standard MCP image content. In Wisp, pass an
absolute project-local `destination` (for example,
`/project/.wisp/figure-library-previews`) and call `view_image` on the returned
path. This keeps visual judgment with the Agent even when the host exposes only
the text portion of an MCP tool result.

## Web Capture and Annotation Workbench

`figure_capture_article` performs an HTTP-first fetch. It stores the original HTML,
article metadata, normalized context, code blocks, images, source URLs, byte counts,
and SHA-256 hashes under `FIGURE_CAPTURE_DIR`. It does not launch Chromium, bypass
a login challenge, or call a model. Login walls, challenges, CAPTCHAs, unsupported
content types, oversized payloads, and failed assets are reported explicitly.
The complete operation has one 90-second deadline shared by DNS resolution,
redirects, response bodies, and the image queue, leaving headroom below Wisp's
120-second tool timeout. Reaching that deadline, or receiving a Host cancellation,
stops the pipeline and records neither a successful Capture nor an operation receipt;
per-image failures that occur before the total deadline remain explicit warnings.

Article metadata, captions, context, and code are untrusted external data, never
instructions. MCP summaries label and bound these snippets. Dynamic resources and
the image-tool fallback expose only stored `visualAssets` whose PNG/JPEG/GIF/WebP
bytes match the declared raster type; raw HTML, code, context, and SVG are not
returned as MCP image content.

Raw Captures are retained by default and remain invisible to
`figure_library_search`. In the Annotation Workbench the user defines one or more
independent Figure Units. Each unit has one primary preview plus original visual
assets; multi-image grouping and canonical executable code require explicit user
selection. Figure-to-code associations are many-to-many and evidence-backed. No
contact sheet or automatic panel crop is generated.

Published scientific figures do not require a copyright-review Gate in this
workflow. The source article, URL, hashes, and transformations remain provenance;
publication does not claim a new redistribution licence. Extracted code remains
`scaffold` / `not_run` until separately inspected and executed outside this server.
The server never executes plotting code.

## Immutable Revisions and Releases

Versioned templates are stored below `FIGURE_LIBRARY_DIR/store/templates`. A stable
`templateId` owns immutable Content Revisions, immutable Review Snapshots, immutable
Releases, and at most one Working Head. The current Published Head remains searchable
while Working is edited. Each save creates a complete new Revision; no Revision
directory is edited in place.

Ordinary search, describe, preview, and materialize resolve only the current
Published Release. A caller may pin an exact historical Published `revisionId` and
`contentDigest`; the two selectors are mandatory as a pair and must match an immutable
Release. Working content is available only through the Review Workbench.
Validation errors and unresolved blocking Gates prevent publication; Warnings are
retained but nonblocking. Gate waiver is not supported in v0.4.0. Approval and
publication are one atomic head switch. Restoring history creates a new Working
candidate and a later new Release; history is never rewound.

Existing `figure-library.template.v1` directories remain readable. Their first
versioned edit requires explicit non-destructive adopt plan/apply. The original
manifest remains untouched in the legacy directory; the migration receipt records
its file name and SHA-256. No startup process silently rewrites the legacy store.

Lifecycle plans are read-only and are held only for the current server session. If
the server restarts before Apply, create and review a fresh plan. Once an Apply has
completed, its public plan digest is bound into the durable operation receipt, so
repeating the same operation ID and expectations can replay the completed result
across a restart. A different digest or expectation is rejected.
Every public lifecycle Apply must echo the reviewed plan's `planDigest`,
`templateId`, and nullable `expectedSeriesDigest` (plus `expectedAction` for a
Working Revision); omitting the expected state is rejected.

Fresh Apply first writes and verifies its immutable objects, then writes a durable
intent containing the exact pre-state, post-state, immutable-object bindings, and
auxiliary receipts, and only then changes the Series pointer. After a crash, public
replay can roll an exact pre-state with complete bound objects forward across a
restart; an exact post-state can backfill missing operation, Capture, or migration
receipts. For compatibility, an older or residual prior intent whose bound objects
are incomplete still requires the same backend plan to finish those objects and is
not rolled forward from the journal alone. A stale write lock is removed
automatically only when its owner record is valid and its PID is confirmed dead;
live or corrupt locks stop writes for manual inspection.

## Stable direct imports

For new direct imports, plan first:

```json
{
  "title": "Our lab volcano plot",
  "description": "Labeled differential-expression volcano plot",
  "tags": ["volcano", "differential expression"],
  "visualProfile": "log2FC x-axis, -log10 FDR y-axis, labeled hits",
  "dataProfile": "gene, log2FC, adjusted p value",
  "sourceKey": "manual:lab-volcano-v1",
  "imagePath": "/project/references/volcano.png",
  "codePaths": ["/project/references/volcano.R"],
  "license": "Internal lab reference"
}
```

`sourceKey` is optional, but recommended for an entry that should be updated in
place. It is a portable logical key: 1–200 lowercase ASCII letters, digits,
dot, underscore, colon, or hyphen. Never use a host path, URL with query data,
token, email, patient identifier, or other secret. Personal Gallery entries
must use `gallery_id` and Gallery sync rather than a direct `sourceKey`.

The plan returns `action`, confirmed title, proposed/existing `templateId`,
component fingerprints, matching templates, and `planDigest`, with
`written: false`. Present these fields, review status, and license to the user.
Only then call `figure_library_apply_import` with the same import fields plus:

```json
{
  "planDigest": "<64-hex plan digest>",
  "expectedAction": "create",
  "expectedTemplateId": "user-direct-<16-hex>",
  "operationId": "lab-volcano-create-1"
}
```

The apply step re-reads files and the User Library. A stale plan is rejected.
An exact create replay is safe. A `duplicate_candidate` requires an explicit
`reuse` or `create_separate` decision and reason; a `source_conflict` requires
an explicit `replace_source` reason. Template IDs never contain the raw
`sourceKey` and do not change when an existing stable source's title changes.

Without `sourceKey`, identity is content-addressed from the complete asset
fingerprint. Metadata can be revised for the same asset, but changing preview
or code intentionally produces a new-source candidate.

Supported visual references are PNG, JPEG, WebP, SVG, and PDF (20 MiB maximum).
Up to 20 R, R Markdown, Quarto, Python, notebook, Julia, MATLAB, Markdown,
TeX, shell, JSON, or YAML files may be imported (5 MiB each, 50 MiB total).
Original absolute paths are never stored in the shareable manifest.

## Figure Transfer Package v1

`figure_library_import` accepts `packagePath` instead of the direct-import
fields. A v1 package is a ZIP containing exactly `manifest.json` and one figure
at the archive root:

```text
figure-transfer-package.zip
├── manifest.json
└── figure.png
```

The interoperable manifest contract is:

```json
{
  "schema": "figure-transfer-package.v1",
  "version": 1,
  "producer": { "name": "CiteBox", "version": "0.31.0" },
  "exportedAt": "2026-08-01T01:02:03Z",
  "source": {
    "sourceId": "paper-42",
    "figureId": "7",
    "parentFigureId": null,
    "figureLabel": "Fig 2",
    "subfigureLabels": ["a", "b"],
    "caption": "Original figure caption",
    "page": 12,
    "paper": {
      "title": "Paper title",
      "authors": ["First Author"],
      "year": 2026,
      "journal": "Journal name",
      "doi": "10.1234/example",
      "url": "https://example.org/paper"
    },
    "license": {
      "scope": "article figure",
      "text": "CC BY 4.0"
    }
  },
  "figure": {
    "file": "figure.png",
    "mediaType": "image/png",
    "bytes": 12345,
    "sha256": "<64 lowercase-or-uppercase hex characters>"
  }
}
```

Unknown or unavailable provenance values must be represented explicitly with
an empty string, empty array, `null`, or `"unknown"` according to the field
type. IDs may be strings or non-negative integers. The importer rejects an
unsupported schema/version, unsafe or extra archive paths, oversized content,
extension/media-type/signature mismatch, byte-count mismatch, and SHA-256
mismatch. It stores the original manifest as read-only metadata and never
executes package content.

A Transfer Package enters the User Library as a `draft` `visual_reference`, so
default search does not present uncurated paper figures. Its stable producer +
source + figure identity makes repeated imports idempotent. If its content
changes, inspect it with `figure_library_diff`, then explicitly apply it with
`figure_library_upsert`.

## Personal Gallery v1

Personal Gallery v1 remains a compatibility import/export and R-editing format.
ScientificFigureLibrary is authoritative: Gallery sync may populate flat-v1
compatibility entries but must not overwrite a canonical versioned Published or
Working Revision. A Gallery root contains entries like:

```text
gallery/lab-volcano/
├── figure.yml
├── preview.png
├── description.md
├── source/
│   └── provenance.yml
└── code/
    ├── example.R
    ├── data_schema.yml
    └── example.csv
```

`figure.yml` uses this schema:

```yaml
schema: figure-library.gallery-entry.v1
gallery_id: lab-volcano
title: Lab volcano plot
tags: [volcano, differential expression]
visual_profile: log2FC x-axis, -log10 FDR y-axis, labeled hits
data_profile: gene, log2FC, adjusted p value
packages: [ggplot2]
license: Internal lab reference
asset_kind: plot_template       # plot_template | visual_reference
language: R
plot_family: volcano
review_status: approved         # draft | approved | archived
code_status: reviewed           # none | scaffold | reviewed
preview: preview.png             # optional default
description_file: description.md # optional default
provenance_file: source/provenance.yml # optional default
source_commit: 0123456789abcdef  # optional; sync can also supply it
content_hash: <optional computed SHA-256>
```

`provenance.yml` may contain `producer`, `producer_version`, `exported_at`,
`source_id`, `figure_id`, `parent_figure_id`, `figure_label`,
`subfigure_labels`, `caption`, `paper_title`, `authors`, `year`, `journal`,
`doi`, `page`, `url`, `license_scope`, and `rights`. The original description
and provenance files are retained in the snapshot. Gallery code/data files may
be R, R Markdown, Quarto, Python, notebook, Julia, MATLAB, shell, Markdown,
TeX, JSON, YAML, CSV, TSV, or text files; none are executed.

The importer computes `content_hash` from normalized searchable metadata,
provenance, and every stored file descriptor (`file`, bytes, SHA-256, and role),
with object keys and set-like tags/packages sorted; `content_hash` itself and
`source_commit` are excluded. If `content_hash` is present in `figure.yml`, it
must match. Stable `gallery_id` maps to one stable template ID and registry
record containing `gallery_id`, `template_id`, `content_hash`, and
`source_commit`.

Preview a complete sync without writing:

```json
{
  "galleryDirectory": "/absolute/path/to/gallery-repository",
  "dryRun": true,
  "sourceCommit": "0123456789abcdef"
}
```

Set `dryRun` to `false` only after reviewing the returned per-field diffs.
Sync imports approved entries, skips drafts, and treats `archived` as a logical
archive rather than a deletion. Missing entries are never deleted implicitly.
Ordinary search includes approved/current Published entries only. Draft, Working,
and archived entries are accessed through review/audit tools, never by widening
the ordinary search filter. Search and sync also accept `assetKind`, `language`,
`plotFamily`, and `codeStatus` filters.

## Identity, management, audit, and reconcile

Every new Registry entry records an adapter-scoped logical source and versioned
component fingerprints for preview, executable code, data, metadata, and the
full asset. Component overlap is duplicate evidence only: equal previews or
similar titles never trigger an automatic merge.

`registry.contentHash` remains the v0.2-compatible normalized **source snapshot
hash**. It is not the byte hash of the current `template.json`: local lifecycle
operations such as archive change review state without redefining the imported
source. Audit therefore calculates separate `manifestSha256` and
`verifiedFileSetDigest` values from the current manifest and verified files.

Search and describe return a `management` object. Use its `templateId` as the
normal lifecycle reference. `registrySourceId` is deliberately distinct from the
top-level search source (`figureya` or `user`). For flat-v1 compatibility entries,
Gallery sync can still propose a source-snapshot update. Once a canonical Series
exists for the same template ID, its Published and Working Heads take precedence
and Gallery sync must not replace them.

Audit before any legacy cleanup:

```json
{
  "scope": "all",
  "includeArchived": true
}
```

Audit reports unreadable/invalid entries instead of silently omitting them,
verifies every declared file, marks Registry-less legacy direct templates, and
returns a duplicate evidence graph plus a deterministic **recommendation only**
for the canonical ID.

`figure_library_reconcile` defaults to `mode: "dry-run"`. Its `expectedState`
must copy the exact `manifestSha256`, `verifiedFileSetDigest`, and review status
from the reviewed audit. Apply only after backing up the complete User Library
and approving the exact canonical/duplicate IDs, hashes, and reason. Apply:

- acquires the same User Library write lock as import/upsert/sync/archive;
- archives only the named duplicate manifests;
- retains every directory and reference file;
- records a recovery journal and append-only alias ledger;
- refuses stale state and incomplete prior transactions.

Rollback uses the same `reconcileId` and refuses to overwrite any later
manifest change. Never manually delete a lock, transaction directory, template
directory, or migration ledger until the interrupted state has been inspected.
If a dead process leaves `prepared`, `committing`, or `rolling-back`, first
verify that its recorded lock owner is no longer running and inspect the
journal. After the stale lock is deliberately cleared, rollback with the exact
same reconcile ID/canonical/duplicate IDs. Recovery accepts only manifests that
still equal that journal's before/after hashes and removes only a matching
partial apply ledger.

## Distribution

The standalone npm tarball contains the server, App, FigureYa search catalog,
and thumbnails, but not the large archive collection:

```bash
npm run package:npm
npm install --global ./release/scientific-figure-library-0.4.0.tgz
```

Use `scientific-figure-library` as the MCP command after installation.

For Wisp:

```bash
npm run package:wisp
```

Install `release/scientific-figure-library-wisp-0.4.0.zip` from Wisp
**Settings → Plugins**, enable it for a project, and start a fresh session.

The Wisp desktop process must resolve **Node.js 22 or newer** from its own
`PATH`; a Node installation visible only inside WSL is not automatically visible
to a Windows Wisp process. Verify `node --version` from the same Windows account
before loading the plugin. The ZIP does not bundle Node, Chromium, or Playwright.

Before the first Capture test, configure distinct absolute
`FIGURE_LIBRARY_DIR` and `FIGURE_CAPTURE_DIR` values in the Wisp MCP server
environment. When Wisp runs the plugin with Windows Node, use Windows-native
paths, for example `E:\ScientificFigureLibraryData` and
`E:\ScientificFigureCaptures`, not `/mnt/e/...`. The roots must be different,
must not contain one another, and the Capture root must not be a symlink or
junction into the Library. If Wisp is deliberately bridged to WSL Node, use two
distinct Linux absolute paths instead. Then use this local acceptance sequence:

1. `figure_library_source_status` reports both path sources, writable status, and
   `isolated: true`.
2. Capture a real WeChat article, inspect its images/code/context in the full-screen
   Annotation Workbench, and confirm that ordinary search contains no raw Capture.
3. Archive and restore that Capture, verify payloads remain present, and confirm an
   archived Capture cannot create a Working Revision until it is restored.
4. Create a Working Figure Unit, inspect Published/Working/Diff and all review
   errors/Gates/Warnings, then publish only when no blocking item remains.
   Test both an evidence-backed canonical code selection and a code-free
   `visual_reference`.
5. While editing an approved template, verify that its prior Published Revision
   remains the ordinary search result. After publication, pin and preview/materialize
   the historical Revision with `revisionId` and `contentDigest` supplied together;
   a partial selector must fail.
6. Restore a historical Release as a new Working candidate and verify that history
   was extended rather than rewound.
7. Confirm cleanup readiness changes only after a self-contained Revision receipt,
   and that cleanup Apply still returns `cleanup_not_enabled` without deleting data.
8. Confirm dynamic Capture resources and the `figure_capture_asset` image-tool
   fallback. Record any Wisp proxy limitation or HTTP challenge verbatim.

A successful build or stdio smoke test does not prove Wisp integration. Treat the
ZIP as awaiting local Wisp acceptance until this checklist is completed.

## FigureYa Source Pack

The core plugin and the optional Source Pack are deliberately separate. A
Source Pack is an ordinary directory containing the existing per-module ZIPs
from FigureYa-compressed:

```text
FigureYaSourcePack/
├── FigureYa59volcanoV2.zip
└── archives/
    └── FigureYa9heatmap.zip
```

Pass this directory as `sourcePackDir` or set
`FIGUREYA_SOURCE_PACK_DIR`. Resolution order is:

1. Local Source Pack.
2. Bases configured in `FIGUREYA_ARCHIVE_BASE_URLS`.
3. The commit-pinned FigureYa-compressed archive on GitHub.

The complete pinned archive collection is roughly 3 GiB, so it is not embedded
in either plugin package. It can be copied by USB/shared storage or split into
small transport packs:

```bash
npm run package:source-pack -- \
  --source /path/to/FigureYa-compressed \
  --name volcano \
  --modules FigureYa59volcanoV2
```

The helper verifies every selected ZIP and caps one transport pack at 200 MiB.
Extract the resulting
`release/figure-library-source-pack-volcano-0.4.0.zip` before use.

## Materialized layouts

FigureYa template:

```text
<destination>/<template-id>/
├── upstream/
├── TEMPLATE.md
└── template.lock.json
```

User template:

```text
<destination>/<template-id>/
├── reference/
│   ├── preview.*
│   └── code/
├── TEMPLATE.md
└── template.lock.json
```

An existing target is never overwritten. Keep `upstream/` or `reference/`
unchanged and adapt plotting code in a separate file.

## Catalog development

The repository includes a generated FigureYa catalog. To regenerate it from
local checkouts:

```bash
git -C /path/to/FigureYa-compressed ls-tree --name-only HEAD |
  npm run catalog -- \
    --source /path/to/FigureYa \
    --figureya-commit <figureya-commit> \
    --compressed-commit <compressed-repo-commit> \
    --compressed-tree /path/to/compressed-github-tree.json
```

## License

Project code is MIT licensed. FigureYa-derived catalog data, thumbnails, and
downloaded templates remain CC BY-NC-SA 4.0. User-imported material keeps the
license supplied at import. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
