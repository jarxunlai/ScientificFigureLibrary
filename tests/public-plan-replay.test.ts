import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { VersionedTemplateLibrary } from "../src/versioned-library.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function toolText(value: unknown) {
  const content = record(value).content;
  assert.ok(Array.isArray(content));
  return content
    .map((item) => {
      const block = record(item);
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("\n");
}

function candidate(title: string, marker: string) {
  return {
    title,
    description: `${title} public lifecycle replay fixture`,
    tags: ["public-plan-replay"],
    visualProfile: "single test image",
    dataProfile: "fixture only",
    packages: [],
    license: "Test fixture",
    assetKind: "visual_reference" as const,
    language: "none",
    codeStatus: "none" as const,
    executionStatus: "not_run" as const,
    primaryPreview: "preview.png",
    provenance: { marker },
    assets: [
      {
        logicalPath: "preview.png",
        role: "visual" as const,
        mediaType: "image/png",
        text: `not-an-executable-image-${marker}`,
      },
    ],
  };
}

async function startClient() {
  const server = await createServer();
  const client = new Client({ name: "public-plan-replay-test", version: "0.4.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("completed public lifecycle Apply replays after restart while an un-applied plan requires replanning", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-public-plan-replay-"));
  const previousLibrary = process.env.FIGURE_LIBRARY_DIR;
  const previousCapture = process.env.FIGURE_CAPTURE_DIR;
  const previousAssets = process.env.FIGUREYA_ASSETS_DIR;
  const templateId = "public-plan-replay-template";
  let connection: Awaited<ReturnType<typeof startClient>> | undefined;
  try {
    process.env.FIGURE_LIBRARY_DIR = path.join(root, "library");
    delete process.env.FIGURE_CAPTURE_DIR;
    process.env.FIGUREYA_ASSETS_DIR = path.resolve(import.meta.dirname, "..", "assets");

    const library = new VersionedTemplateLibrary();
    const workingV1 = await library.planCreateWorking({
      templateId,
      candidate: candidate("Public plan v1", "v1"),
    });
    await library.applyCreateWorking(workingV1, "seed-working-v1");

    connection = await startClient();
    const plannedV1 = await connection.client.callTool({
      name: "figure_library_plan_publish_working_revision",
      arguments: { templateId },
    });
    assert.equal(plannedV1.isError, undefined);
    const publicPlanV1 = record(record(plannedV1.structuredContent).plan);
    assert.equal(publicPlanV1.action, "publish");
    assert.match(String(publicPlanV1.planDigest), /^[a-f0-9]{64}$/u);
    const applyV1Arguments = {
      planDigest: String(publicPlanV1.planDigest),
      operationId: "public-publish-v1",
      expectedTemplateId: templateId,
      expectedSeriesDigest: publicPlanV1.expectedSeriesDigest,
    };
    const appliedV1 = await connection.client.callTool({
      name: "figure_library_apply_publish_working_revision",
      arguments: applyV1Arguments,
    });
    assert.equal(appliedV1.isError, undefined);
    assert.equal(record(record(appliedV1.structuredContent).result).idempotentReplay, false);
    await connection.client.close();
    await connection.server.close();
    connection = undefined;

    connection = await startClient();
    const replayedV1 = await connection.client.callTool({
      name: "figure_library_apply_publish_working_revision",
      arguments: applyV1Arguments,
    });
    assert.equal(replayedV1.isError, undefined);
    assert.equal(record(record(replayedV1.structuredContent).result).idempotentReplay, true);

    const wrongDigestReplay = await connection.client.callTool({
      name: "figure_library_apply_publish_working_revision",
      arguments: { ...applyV1Arguments, planDigest: "0".repeat(64) },
    });
    assert.equal(wrongDigestReplay.isError, true);
    assert.match(toolText(wrongDigestReplay), /different public plan/iu);

    const workingV2 = await library.planCreateWorking({
      templateId,
      candidate: candidate("Public plan v2", "v2"),
    });
    await library.applyCreateWorking(workingV2, "seed-working-v2");
    const plannedV2 = await connection.client.callTool({
      name: "figure_library_plan_publish_working_revision",
      arguments: { templateId },
    });
    assert.equal(plannedV2.isError, undefined);
    const publicPlanV2 = record(record(plannedV2.structuredContent).plan);
    const applyV2Arguments = {
      planDigest: String(publicPlanV2.planDigest),
      operationId: "public-publish-v2-not-applied",
      expectedTemplateId: templateId,
      expectedSeriesDigest: publicPlanV2.expectedSeriesDigest,
    };
    await connection.client.close();
    await connection.server.close();
    connection = undefined;

    connection = await startClient();
    const unavailableV2 = await connection.client.callTool({
      name: "figure_library_apply_publish_working_revision",
      arguments: applyV2Arguments,
    });
    assert.equal(unavailableV2.isError, true);
    assert.match(toolText(unavailableV2), /plan_not_available.*restarted/isu);
  } finally {
    await connection?.client.close().catch(() => undefined);
    await connection?.server.close().catch(() => undefined);
    if (previousLibrary === undefined) delete process.env.FIGURE_LIBRARY_DIR;
    else process.env.FIGURE_LIBRARY_DIR = previousLibrary;
    if (previousCapture === undefined) delete process.env.FIGURE_CAPTURE_DIR;
    else process.env.FIGURE_CAPTURE_DIR = previousCapture;
    if (previousAssets === undefined) delete process.env.FIGUREYA_ASSETS_DIR;
    else process.env.FIGUREYA_ASSETS_DIR = previousAssets;
    await fs.rm(root, { recursive: true, force: true });
  }
});
