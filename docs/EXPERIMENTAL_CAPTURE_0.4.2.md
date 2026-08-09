# Experimental Capture snapshot (0.4.2)

This branch intentionally preserves the Web Capture, Annotation Workbench,
versioned template lifecycle, global Library locator, and project-pin work that
was developed after `upstream/main` 0.3.0.

It is retained as an experimental implementation for maintainer review rather
than as the proposed default core. No Capture records or user Library payloads
are committed to this repository.

## Preserved capabilities

- HTTP-first article capture with explicit login/challenge/CAPTCHA failures.
- Project-isolated raw Capture storage and provenance.
- Paged Annotation fallback through standard MCP image blocks.
- Immutable content revisions, review snapshots, and releases.
- Plan/apply lifecycle operations with operation receipts and stale-plan checks.
- Global Library binding through a stable `libraryId` and host-specific locator.
- Exact project materialization pins and cross-runtime write locking.
- Archive/restore and read-only Capture cleanup readiness checks.

## Why it remains experimental

Live Wisp testing showed that the Host Agent bridge may expose only text
summaries while hiding `structuredContent` and MCP image blocks. Agents can then
repeat an identical call in an attempt to retrieve information the host will
never expose. Returning many captured images and code blocks also creates a
large, host-dependent MCP surface.

The preferred core direction is therefore direct intake:

1. The user supplies selected image and code files to the Host Agent.
2. The Agent inspects those attachments using native host capabilities.
3. ScientificFigureLibrary validates a proposed Figure Unit and returns a
   terminal plan result.
4. The user confirms before one apply call creates a Working revision.

The standard core should keep raw Capture out of its registered tool surface.
This branch allows maintainers to evaluate the implementation independently and
adopt parts of it later if the host integration trade-offs improve.

## Benefits and limitations

Benefits:

- Preserves source URL, article metadata, hashes, and deterministic extraction
  records.
- Isolates raw web payloads from ordinary template search.
- Supports explicit retention, archive, restore, and future cleanup semantics.

Limitations:

- Web anti-hotlinking, authentication, and dynamic rendering remain outside the
  deterministic server's control.
- Host support for Apps, resources, structured content, and image blocks varies.
- Large multi-asset results are costly and may encourage repeated tool calls.
- Project pins and project-scoped Capture add APIs that are unnecessary for a
  globally shared, cross-project template Library.

## Verification snapshot

At the point this branch was separated, the implementation had passed the
repository test suite and stdio smoke checks and had been packaged as Wisp
version 0.4.2. Those checks establish local build behavior only; they do not
guarantee equivalent capability exposure in every Wisp release or MCP host.

Existing user Capture data must never be deleted or migrated automatically.
In particular, locally created data below `E:\plot\.wisp\figure-captures` is
outside this repository and must remain untouched unless the user explicitly
requests a cleanup operation.
