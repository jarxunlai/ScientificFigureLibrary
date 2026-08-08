import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCaptureVersionTools } from "../src/capture-version-tools.ts";
import { CaptureError, CaptureStore, type CaptureResolver } from "../src/capture.ts";
import { VersionedTemplateLibrary } from "../src/versioned-library.ts";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const WEBP = new Uint8Array([
  82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32,
]);
const PUBLIC_RESOLVER: CaptureResolver = async () => [
  { address: "93.184.216.34", family: 4 },
];

function errorCode(expected: string) {
  return (error: unknown) => error instanceof CaptureError && error.code === expected;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function records(value: unknown): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value));
  return value.map(record);
}

async function articleFixture() {
  return fs.readFile(path.join(import.meta.dirname, "fixtures", "wechat-article.html"), "utf8");
}

async function fakeWebFetch(input: string | URL) {
  const url = input.toString();
  if (url.includes("figure.png")) {
    return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  }
  if (url.includes("figure.webp")) {
    return new Response(WEBP, { status: 200, headers: { "content-type": "image/webp" } });
  }
  return new Response(await articleFixture(), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

test("trusted projectDirectory binds project-local Capture once and keeps projects isolated", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-project-capture-"));
  const previousCapture = process.env.FIGURE_CAPTURE_DIR;
  const previousLibrary = process.env.FIGURE_LIBRARY_DIR;
  try {
    delete process.env.FIGURE_CAPTURE_DIR;
    process.env.FIGURE_LIBRARY_DIR = path.join(root, "global-library");
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");
    const projectWithEscapingWisp = path.join(root, "project-escaping-wisp");
    const externalWisp = path.join(root, "external-wisp");
    await Promise.all([
      fs.mkdir(projectA),
      fs.mkdir(projectB),
      fs.mkdir(projectWithEscapingWisp),
      fs.mkdir(externalWisp),
    ]);
    await fs.symlink(
      externalWisp,
      path.join(projectWithEscapingWisp, ".wisp"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const storeA = new CaptureStore(undefined, fakeWebFetch, PUBLIC_RESOLVER);
    assert.equal((await storeA.status()).configured, false);
    await storeA.bindProjectDirectory(projectA);
    await storeA.bindProjectDirectory(path.join(projectA, "."));
    const statusA = await storeA.status();
    assert.equal(statusA.source, "project");
    assert.equal(statusA.projectDirectory, await fs.realpath(projectA));
    assert.equal(
      statusA.root,
      path.join(await fs.realpath(projectA), ".wisp", "figure-captures"),
    );

    const captured = await storeA.captureArticle({
      url: "https://mp.weixin.qq.com/s/project-local",
      operationId: "project-local-a",
    });
    const ignore = await fs.readFile(
      path.join(projectA, ".wisp", "figure-captures", ".gitignore"),
      "utf8",
    );
    assert.match(ignore, /ScientificFigureLibrary project-local Raw Capture/u);
    assert.match(ignore, /^\*$/mu);
    assert.match(ignore, /^!\.gitignore$/mu);
    await assert.rejects(fs.access(path.join(projectA, ".gitignore")), { code: "ENOENT" });
    await assert.rejects(
      storeA.bindProjectDirectory(projectB),
      errorCode("capture_project_mismatch"),
    );

    const restartedA = new CaptureStore(undefined, fakeWebFetch, PUBLIC_RESOLVER);
    await restartedA.bindProjectDirectory(projectA);
    assert.equal((await restartedA.list()).at(0)?.captureId, captured.captureId);

    const storeB = new CaptureStore(undefined, fakeWebFetch, PUBLIC_RESOLVER);
    await storeB.bindProjectDirectory(projectB);
    assert.deepEqual(await storeB.list(), []);
    const capturedB = await storeB.captureArticle({
      url: "https://mp.weixin.qq.com/s/project-local",
      operationId: "project-local-b",
    });
    assert.equal(capturedB.captureId, captured.captureId, "content identity should remain stable");
    assert.equal((await storeB.list()).length, 1);
    assert.equal((await restartedA.list()).length, 1);

    const escapingStore = new CaptureStore(undefined, fakeWebFetch, PUBLIC_RESOLVER);
    await escapingStore.bindProjectDirectory(projectWithEscapingWisp);
    const escapingStatus = await escapingStore.status();
    assert.equal(escapingStatus.available, false);
    assert.match(escapingStatus.reason ?? "", /escapes projectDirectory/iu);

    const constructorRoot = path.join(root, "constructor-capture");
    const constructorStore = new CaptureStore(constructorRoot, fakeWebFetch, PUBLIC_RESOLVER);
    await constructorStore.bindProjectDirectory(projectA);
    assert.equal((await constructorStore.status()).source, "constructor");
    assert.equal((await constructorStore.status()).root, path.resolve(constructorRoot));

    process.env.FIGURE_CAPTURE_DIR = path.join(root, "environment-capture");
    const environmentStore = new CaptureStore(undefined, fakeWebFetch, PUBLIC_RESOLVER);
    await environmentStore.bindProjectDirectory(projectA);
    assert.equal((await environmentStore.status()).source, "environment");
    assert.equal(
      (await environmentStore.status()).root,
      path.resolve(process.env.FIGURE_CAPTURE_DIR),
    );

    let dynamicLibraryRoot = path.join(root, "dynamic-library-a");
    const dynamicCaptureRoot = path.join(root, "dynamic-capture");
    const dynamicStore = new CaptureStore(
      dynamicCaptureRoot,
      fakeWebFetch,
      PUBLIC_RESOLVER,
    ).setLibraryRootProvider(() => dynamicLibraryRoot);
    assert.equal((await dynamicStore.status()).isolated, true);
    dynamicLibraryRoot = dynamicCaptureRoot;
    const changedRuntimeStatus = await dynamicStore.status();
    assert.equal(changedRuntimeStatus.libraryRoot, path.resolve(dynamicCaptureRoot));
    assert.equal(changedRuntimeStatus.isolated, false);
    assert.equal(changedRuntimeStatus.available, false);
  } finally {
    if (previousCapture === undefined) delete process.env.FIGURE_CAPTURE_DIR;
    else process.env.FIGURE_CAPTURE_DIR = previousCapture;
    if (previousLibrary === undefined) delete process.env.FIGURE_LIBRARY_DIR;
    else process.env.FIGURE_LIBRARY_DIR = previousLibrary;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Capture refuses managed subdirectory symlinks without outside writes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-subdir-symlink-"));
  const captureRoot = path.join(root, "capture");
  const libraryRoot = path.join(root, "library");
  const outside = path.join(root, "outside");
  await Promise.all([fs.mkdir(captureRoot), fs.mkdir(libraryRoot), fs.mkdir(outside)]);
  const store = new CaptureStore(captureRoot, fakeWebFetch, PUBLIC_RESOLVER).setLibraryRootProvider(
    () => libraryRoot,
  );
  try {
    try {
      await fs.symlink(outside, path.join(captureRoot, "captures"), "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        t.skip("directory symlinks are not available on this platform");
        return;
      }
      throw error;
    }
    let status = await store.status();
    assert.equal(status.available, false);
    assert.match(status.reason ?? "", /capture_path_unsafe|must be real/iu);
    await assert.rejects(
      store.captureArticle({ url: "https://mp.weixin.qq.com/s/symlink-captures" }),
      errorCode("capture_directory_unavailable"),
    );
    assert.deepEqual(await fs.readdir(outside), []);

    await fs.rm(path.join(captureRoot, "captures"));
    await fs.mkdir(path.join(captureRoot, "captures"));
    await fs.symlink(outside, path.join(captureRoot, "operations"), "dir");
    status = await store.status();
    assert.equal(status.available, false);
    assert.match(status.reason ?? "", /capture_path_unsafe|must be real/iu);
    await assert.rejects(
      store.captureArticle({
        url: "https://mp.weixin.qq.com/s/symlink-operations",
        operationId: "must-not-write-outside",
      }),
      errorCode("capture_directory_unavailable"),
    );
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("annotation_open pages standard MCP images and echoes a validated draft without persistence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-annotation-page-"));
  const previousCapture = process.env.FIGURE_CAPTURE_DIR;
  const previousLibrary = process.env.FIGURE_LIBRARY_DIR;
  let client: Client | undefined;
  let server: McpServer | undefined;
  try {
    delete process.env.FIGURE_CAPTURE_DIR;
    process.env.FIGURE_LIBRARY_DIR = path.join(root, "global-library");
    const projectDirectory = path.join(root, "project");
    await fs.mkdir(projectDirectory);
    const captureWriter = new CaptureStore(undefined, fakeWebFetch, PUBLIC_RESOLVER);
    await captureWriter.bindProjectDirectory(projectDirectory);
    const capture = await captureWriter.captureArticle({
      url: "https://mp.weixin.qq.com/s/annotation-pages",
    });
    assert.equal(capture.visualAssets.length, 2);
    assert.ok(capture.codeBlocks[0]);

    // Simulate a restarted MCP process: the tool call, not constructor state, must rebind it.
    const store = new CaptureStore(undefined, fakeWebFetch, PUBLIC_RESOLVER);
    assert.equal((await store.status()).configured, false);
    server = new McpServer({ name: "capture-annotation-test", version: "0.4.2" });
    const versionedLibrary = new VersionedTemplateLibrary(path.join(root, "global-library"));
    registerCaptureVersionTools({
      server,
      captureStore: store,
      versionedLibrary,
      resourceUri: "ui://capture-annotation-test/index.html",
    });
    client = new Client({ name: "capture-annotation-client", version: "0.4.2" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    for (const name of [
      "figure_capture_open",
      "figure_capture_article",
      "figure_capture_list",
      "figure_capture_get",
      "figure_capture_annotation_open",
      "figure_capture_asset",
      "figure_capture_archive",
      "figure_capture_restore",
      "figure_capture_plan_cleanup",
      "figure_capture_apply_cleanup",
      "figure_library_plan_working_revision",
      "figure_library_apply_working_revision",
    ]) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `missing Capture-dependent tool ${name}`);
      const properties = record(tool.inputSchema).properties;
      assert.ok(
        "projectDirectory" in record(properties),
        `${name} does not expose trusted projectDirectory`,
      );
    }

    const draft = {
      schema: "figure-library.annotation-draft.v1",
      title: "Paged annotation draft",
      assetKind: "plot_template",
      visualAssetIds: capture.visualAssets.map((asset) => asset.assetId),
      primaryVisualAssetId: capture.visualAssets[0]!.assetId,
      multiImageConfirmed: true,
      codeBlockIds: [capture.codeBlocks[0]!.blockId],
      canonicalCodeBlockId: capture.codeBlocks[0]!.blockId,
      contextBlockIds: [capture.context[0]!.blockId],
      figureCodeLinks: [
        {
          visualAssetId: capture.visualAssets[0]!.assetId,
          codeBlockIds: [capture.codeBlocks[0]!.blockId],
          evidence: "Adjacent article text explicitly associates the code and figure.",
        },
      ],
    };
    const first = await client.callTool({
      name: "figure_capture_annotation_open",
      arguments: {
        projectDirectory,
        captureId: capture.captureId,
        page: 1,
        pageSize: 1,
        annotationDraft: draft,
      },
    });
    assert.equal(first.isError, undefined);
    const firstImages = records(record(first).content).filter((block) => block.type === "image");
    assert.equal(firstImages.length, 1);
    assert.equal(firstImages[0]?.mimeType, capture.visualAssets[0]?.mediaType);
    const firstOutput = record(first.structuredContent);
    assert.equal(firstOutput.draftPersisted, false);
    const firstPage = record(firstOutput.imagePage);
    assert.equal(firstPage.page, 1);
    assert.equal(firstPage.pageCount, 2);
    assert.equal(firstPage.nextPage, 2);
    assert.deepEqual(record(firstOutput.annotationDraft), draft);

    const second = await client.callTool({
      name: "figure_capture_annotation_open",
      arguments: {
        projectDirectory,
        captureId: capture.captureId,
        page: 2,
        pageSize: 1,
        annotationDraft: firstOutput.annotationDraft,
      },
    });
    assert.equal(second.isError, undefined);
    assert.equal(
      records(record(second).content).filter((block) => block.type === "image").length,
      1,
    );
    assert.deepEqual(record(record(second.structuredContent).annotationDraft), draft);

    const workingPlanResult = await client.callTool({
      name: "figure_library_plan_working_revision",
      arguments: {
        projectDirectory,
        templateId: "project-capture-working",
        mode: "create",
        captureId: capture.captureId,
        title: "Project Capture Working",
        assetKind: "visual_reference",
        language: "none",
        selection: {
          visualAssetIds: [capture.visualAssets[0]!.assetId],
          primaryVisualAssetId: capture.visualAssets[0]!.assetId,
          codeBlockIds: [],
          contextBlockIds: [capture.context[0]!.blockId],
          figureCodeLinks: [],
        },
      },
    });
    assert.equal(workingPlanResult.isError, undefined);
    const workingPlan = record(record(workingPlanResult.structuredContent).plan);
    const appliedWorking = await client.callTool({
      name: "figure_library_apply_working_revision",
      arguments: {
        projectDirectory,
        planDigest: workingPlan.planDigest,
        operationId: "project-capture-working-apply",
        expectedAction: workingPlan.action,
        expectedTemplateId: workingPlan.templateId,
        expectedSeriesDigest: workingPlan.expectedSeriesDigest,
      },
    });
    assert.equal(appliedWorking.isError, undefined);
    const series = await versionedLibrary.getSeries("project-capture-working");
    assert.ok(series?.workingHead);
    const content = await versionedLibrary.getContent(
      series.templateId,
      series.workingHead.revisionId,
      series.workingHead.contentDigest,
    );
    assert.ok(content);
    assert.equal(
      JSON.stringify(content).includes(projectDirectory),
      false,
      "host projectDirectory leaked into canonical immutable content",
    );

    const captureRootEntries = await fs.readdir(
      path.join(projectDirectory, ".wisp", "figure-captures"),
    );
    assert.deepEqual(captureRootEntries.sort(), [".gitignore", "captures", "operations"]);

    const invalidDraft = await client.callTool({
      name: "figure_capture_annotation_open",
      arguments: {
        projectDirectory,
        captureId: capture.captureId,
        annotationDraft: { visualAssetIds: ["missing-visual"] },
      },
    });
    assert.equal(invalidDraft.isError, true);
    assert.match(
      records(record(invalidDraft).content)
        .map((block) => String(block.text ?? ""))
        .join("\n"),
      /invalid_annotation_draft/iu,
    );
  } finally {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    if (previousCapture === undefined) delete process.env.FIGURE_CAPTURE_DIR;
    else process.env.FIGURE_CAPTURE_DIR = previousCapture;
    if (previousLibrary === undefined) delete process.env.FIGURE_LIBRARY_DIR;
    else process.env.FIGURE_LIBRARY_DIR = previousLibrary;
    await fs.rm(root, { recursive: true, force: true });
  }
});
