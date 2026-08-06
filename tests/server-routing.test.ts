import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { VersionedTemplateLibrary } from "../src/versioned-library.ts";

const COLLIDING_TEMPLATE_ID = "FigureYa59volcanoV2";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function versionedCandidate(title: string, marker: number) {
  const preview = new Uint8Array([...PNG, marker]);
  return {
    preview,
    candidate: {
      title,
      description: `${title}; canonical collision routing regression marker`,
      tags: ["volcano", "canonical-collision"],
      visualProfile: "volcano plot canonical SFL reference",
      dataProfile: "gene, log2 fold-change, adjusted p value",
      packages: [],
      license: "Published scientific figure reference",
      assetKind: "visual_reference" as const,
      language: "none",
      plotFamily: "volcano",
      codeStatus: "none" as const,
      executionStatus: "not_run" as const,
      primaryPreview: "preview.png",
      provenance: { url: "https://example.test/canonical-sfl" },
      assets: [
        {
          logicalPath: "preview.png",
          role: "visual" as const,
          mediaType: "image/png",
          bytes: preview,
        },
      ],
    },
  };
}

async function publishVersion(
  library: VersionedTemplateLibrary,
  title: string,
  marker: number,
  operationSuffix: string,
) {
  const prepared = versionedCandidate(title, marker);
  const working = await library.planCreateWorking({
    templateId: COLLIDING_TEMPLATE_ID,
    candidate: prepared.candidate,
  });
  assert.equal(working.review.validationErrors.length, 0);
  assert.equal(working.review.blockingGates.length, 0);
  await library.applyCreateWorking(working, `routing-working-${operationSuffix}`);
  const publish = await library.planPublish({ templateId: COLLIDING_TEMPLATE_ID });
  const applied = await library.applyPublish(publish, `routing-publish-${operationSuffix}`);
  return {
    preview: prepared.preview,
    revisionId: applied.revisionId!,
    contentDigest: applied.contentDigest!,
    releaseId: applied.releaseId!,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value));
  return value.map(asRecord);
}

function toolText(value: unknown) {
  const content = asRecord(value).content;
  assert.ok(Array.isArray(content));
  return content
    .map((item) => {
      const record = asRecord(item);
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

test("canonical versioned IDs shadow FigureYa and ordinary routes stay pinned to Published Releases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-server-routing-"));
  const previousLibrary = process.env.FIGURE_LIBRARY_DIR;
  const previousCapture = process.env.FIGURE_CAPTURE_DIR;
  const previousAssets = process.env.FIGUREYA_ASSETS_DIR;
  let client: Client | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    process.env.FIGURE_LIBRARY_DIR = path.join(root, "library");
    delete process.env.FIGURE_CAPTURE_DIR;
    process.env.FIGUREYA_ASSETS_DIR = path.resolve(import.meta.dirname, "..", "assets");

    const library = new VersionedTemplateLibrary();
    const first = await publishVersion(library, "Canonical collision v1", 1, "v1");
    const second = await publishVersion(library, "Canonical collision v2", 2, "v2");

    const workingCandidate = versionedCandidate("Unpublished collision v3", 3);
    const unpublished = await library.planCreateWorking({
      templateId: COLLIDING_TEMPLATE_ID,
      candidate: workingCandidate.candidate,
    });
    await library.applyCreateWorking(unpublished, "routing-working-v3");

    server = await createServer();
    client = new Client({ name: "server-routing-test", version: "0.4.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listedTools = await client.listTools();
    const appCallableTools = [
      "figure_library_open",
      "figure_library_search",
      "figure_capture_open",
      "figure_capture_article",
      "figure_capture_list",
      "figure_capture_get",
      "figure_capture_asset",
      "figure_capture_plan_cleanup",
      "figure_library_review_open",
      "figure_library_template_history",
      "figure_library_diff_revisions",
    ];
    for (const toolName of appCallableTools) {
      const listed = listedTools.tools.find((tool) => tool.name === toolName);
      assert.ok(listed, `missing App-callable tool ${toolName}`);
      assert.deepEqual(
        asRecord(asRecord(listed._meta).ui).visibility,
        ["model", "app"],
        `${toolName} must be explicitly callable by both the Host Agent and MCP App`,
      );
    }

    const searched = await client.callTool({
      name: "figure_library_search",
      arguments: {
        query: `${COLLIDING_TEMPLATE_ID} volcano differential expression canonical collision`,
        sourceIds: ["figureya", "user"],
        limit: 12,
      },
    });
    assert.equal(searched.isError, undefined);
    const searchOutput = asRecord(searched.structuredContent);
    const collisionCandidates = asRecords(searchOutput.candidates).filter(
      (candidate) => candidate.templateId === COLLIDING_TEMPLATE_ID,
    );
    assert.equal(collisionCandidates.length, 1, "same-ID FigureYa candidate was not shadowed");
    assert.deepEqual(
      {
        sourceId: collisionCandidates[0]?.sourceId,
        revisionId: collisionCandidates[0]?.revisionId,
        releaseId: collisionCandidates[0]?.releaseId,
        contentDigest: collisionCandidates[0]?.contentDigest,
        title: collisionCandidates[0]?.title,
      },
      {
        sourceId: "user",
        revisionId: second.revisionId,
        releaseId: second.releaseId,
        contentDigest: second.contentDigest,
        title: "Canonical collision v2",
      },
    );

    const figureYaOnly = await client.callTool({
      name: "figure_library_search",
      arguments: {
        query: COLLIDING_TEMPLATE_ID,
        sourceIds: ["figureya"],
        limit: 12,
      },
    });
    assert.equal(figureYaOnly.isError, undefined);
    assert.equal(
      asRecords(asRecord(figureYaOnly.structuredContent).candidates).some(
        (candidate) => candidate.templateId === COLLIDING_TEMPLATE_ID,
      ),
      false,
      "canonical Series must shadow the colliding FigureYa ID even in a source-filtered search",
    );

    const described = await client.callTool({
      name: "figure_library_describe",
      arguments: { templateId: COLLIDING_TEMPLATE_ID },
    });
    assert.equal(described.isError, undefined);
    assert.deepEqual(
      (() => {
        const output = asRecord(described.structuredContent);
        return {
          sourceId: output.sourceId,
          revisionId: output.revisionId,
          releaseId: output.releaseId,
          contentDigest: output.contentDigest,
          title: output.title,
          historical: output.historical,
        };
      })(),
      {
        sourceId: "user",
        revisionId: second.revisionId,
        releaseId: second.releaseId,
        contentDigest: second.contentDigest,
        title: "Canonical collision v2",
        historical: false,
      },
    );

    const previewed = await client.callTool({
      name: "figure_library_preview",
      arguments: {
        templateId: COLLIDING_TEMPLATE_ID,
        revisionId: second.revisionId,
        contentDigest: second.contentDigest,
      },
    });
    assert.equal(previewed.isError, undefined);
    const previewOutput = asRecord(previewed.structuredContent);
    assert.equal(previewOutput.sourceId, "user");
    assert.equal(previewOutput.releaseId, second.releaseId);
    assert.equal(previewOutput.sha256, hash(second.preview));

    const currentDestination = path.join(root, "current-materialization");
    const materialized = await client.callTool({
      name: "figure_library_materialize",
      arguments: {
        templateId: COLLIDING_TEMPLATE_ID,
        revisionId: second.revisionId,
        contentDigest: second.contentDigest,
        destination: currentDestination,
      },
    });
    assert.equal(materialized.isError, undefined);
    const materializedOutput = asRecord(materialized.structuredContent);
    assert.equal(materializedOutput.sourceId, "user");
    assert.equal(materializedOutput.releaseId, second.releaseId);
    assert.equal(materializedOutput.materializationSource, "versioned-library");

    const historicalDescription = await client.callTool({
      name: "figure_library_describe",
      arguments: {
        templateId: COLLIDING_TEMPLATE_ID,
        revisionId: first.revisionId,
        contentDigest: first.contentDigest,
      },
    });
    assert.equal(historicalDescription.isError, undefined);
    const historicalOutput = asRecord(historicalDescription.structuredContent);
    assert.equal(historicalOutput.releaseId, first.releaseId);
    assert.equal(historicalOutput.title, "Canonical collision v1");
    assert.equal(historicalOutput.historical, true);

    const historicalPreview = await client.callTool({
      name: "figure_library_preview",
      arguments: {
        templateId: COLLIDING_TEMPLATE_ID,
        revisionId: first.revisionId,
        contentDigest: first.contentDigest,
      },
    });
    assert.equal(historicalPreview.isError, undefined);
    assert.equal(asRecord(historicalPreview.structuredContent).sha256, hash(first.preview));

    for (const [name, arguments_] of [
      [
        "figure_library_describe",
        {
          templateId: COLLIDING_TEMPLATE_ID,
          revisionId: unpublished.content.revisionId,
          contentDigest: unpublished.content.contentDigest,
        },
      ],
      [
        "figure_library_preview",
        {
          templateId: COLLIDING_TEMPLATE_ID,
          revisionId: unpublished.content.revisionId,
          contentDigest: unpublished.content.contentDigest,
        },
      ],
      [
        "figure_library_materialize",
        {
          templateId: COLLIDING_TEMPLATE_ID,
          revisionId: unpublished.content.revisionId,
          contentDigest: unpublished.content.contentDigest,
          destination: path.join(root, "must-not-materialize-working"),
        },
      ],
    ] as const) {
      const result = await client.callTool({ name, arguments: arguments_ });
      assert.equal(result.isError, true, `${name} exposed an unpublished Working Revision`);
      assert.match(toolText(result), /not a published release/iu);
    }

    const partialSelector = await client.callTool({
      name: "figure_library_describe",
      arguments: { templateId: COLLIDING_TEMPLATE_ID, revisionId: first.revisionId },
    });
    assert.equal(partialSelector.isError, true);
  } finally {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    if (previousLibrary === undefined) delete process.env.FIGURE_LIBRARY_DIR;
    else process.env.FIGURE_LIBRARY_DIR = previousLibrary;
    if (previousCapture === undefined) delete process.env.FIGURE_CAPTURE_DIR;
    else process.env.FIGURE_CAPTURE_DIR = previousCapture;
    if (previousAssets === undefined) delete process.env.FIGUREYA_ASSETS_DIR;
    else process.env.FIGUREYA_ASSETS_DIR = previousAssets;
    await fs.rm(root, { recursive: true, force: true });
  }
});
