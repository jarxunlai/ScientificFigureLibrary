import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CrossRuntimeWriteLock,
  planLibraryWriteLockRecovery,
} from "../src/cross-runtime-lock.ts";
import {
  ensureLibraryRootMarker,
  planGlobalLibraryBinding,
} from "../src/library-runtime.ts";
import {
  ProjectTemplateLibrary,
  type ProjectTemplateResolvedRevision,
} from "../src/project-library.ts";
import { createServer } from "../src/server.ts";
import { UserTemplateLibrary } from "../src/user-library.ts";
import {
  VersionedTemplateLibrary,
  type VersionedTemplateCandidate,
} from "../src/versioned-library.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const ENVIRONMENT_KEYS = [
  "FIGURE_LIBRARY_DIR",
  "FIGURE_CAPTURE_DIR",
  "FIGURE_GALLERY_DIR",
  "FIGUREYA_ASSETS_DIR",
  "FIGUREYA_SOURCE_PACK_DIR",
  "XDG_CONFIG_HOME",
  "HOME",
] as const;

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function records(value: unknown): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value));
  return value.map(record);
}

function toolText(value: unknown) {
  return records(record(value).content)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function captureEnvironment() {
  return Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof ENVIRONMENT_KEYS)[number],
    string | undefined
  >;
}

function restoreEnvironment(previous: ReturnType<typeof captureEnvironment>) {
  for (const key of ENVIRONMENT_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function startClient(name: string) {
  const server = await createServer();
  const client = new Client({ name, version: "0.4.2" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function candidate(title: string, marker: string): VersionedTemplateCandidate {
  return {
    title,
    description: `${title} MCP project pin integration fixture`,
    tags: ["server-project-tools"],
    visualProfile: "single immutable reference panel",
    dataProfile: "integration fixture",
    packages: [],
    license: "Published scientific figure test fixture",
    assetKind: "visual_reference",
    language: "none",
    plotFamily: "integration-test",
    codeStatus: "none",
    executionStatus: "not_run",
    primaryPreview: "preview.png",
    provenance: { source: "server-project-tools-test", marker },
    assets: [
      {
        logicalPath: "preview.png",
        role: "visual",
        mediaType: "image/png",
        bytes: new Uint8Array([...PNG, marker.length]),
      },
    ],
  };
}

async function publish(
  library: VersionedTemplateLibrary,
  templateId: string,
  title: string,
  marker: string,
) {
  const working = await library.planCreateWorking({
    templateId,
    candidate: candidate(title, marker),
  });
  assert.equal(working.review.validationErrors.length, 0);
  assert.equal(working.review.blockingGates.length, 0);
  await library.applyCreateWorking(working, `working-${marker}`);
  const planned = await library.planPublish({ templateId });
  const applied = await library.applyPublish(planned, `publish-${marker}`);
  assert.ok(applied.revisionId);
  assert.ok(applied.contentDigest);
  assert.ok(applied.releaseId);
  return {
    revisionId: applied.revisionId,
    contentDigest: applied.contentDigest,
    releaseId: applied.releaseId,
  };
}

async function writeRecognizedLegacyTemplate(root: string) {
  const directory = path.join(root, "templates", "legacy-one");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "template.json"),
    `${JSON.stringify(
      {
        schema: "figure-library.template.v1",
        templateId: "legacy-one",
        sourceId: "user",
      },
      null,
      2,
    )}\n`,
  );
}

test("server MCP exposes safe global binding and exact reusable project pins", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-server-project-tools-"));
  const previous = captureEnvironment();
  let connection: Awaited<ReturnType<typeof startClient>> | undefined;
  let globalWriteLock: CrossRuntimeWriteLock | undefined;
  try {
    const home = path.join(root, "home");
    const xdg = path.join(root, "xdg");
    const legacy = path.join(root, "legacy-explicit");
    const canonical = path.join(root, "canonical-library");
    const projectDirectory = path.join(root, "plot-project");
    const otherProjectDirectory = path.join(root, "other-project");
    const locatorPath = path.join(xdg, "scientific-figure-library", "locator.json");
    await Promise.all([
      fs.mkdir(home, { recursive: true }),
      fs.mkdir(projectDirectory, { recursive: true }),
      fs.mkdir(otherProjectDirectory, { recursive: true }),
      writeRecognizedLegacyTemplate(legacy),
    ]);

    delete process.env.FIGURE_LIBRARY_DIR;
    delete process.env.FIGURE_CAPTURE_DIR;
    delete process.env.FIGURE_GALLERY_DIR;
    delete process.env.FIGUREYA_SOURCE_PACK_DIR;
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.FIGUREYA_ASSETS_DIR = path.resolve(import.meta.dirname, "..", "assets");

    connection = await startClient("server-project-tools-main");
    const listed = await connection.client.listTools();
    const expectedAnnotations = new Map<string, Record<string, boolean>>([
      [
        "figure_library_plan_bind_global",
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ],
      [
        "figure_library_apply_bind_global",
        { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ],
      [
        "figure_library_plan_recover_write_lock",
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ],
      [
        "figure_library_apply_recover_write_lock",
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      ],
      [
        "figure_library_project_status",
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ],
      [
        "figure_library_plan_project_use",
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ],
      [
        "figure_library_apply_project_use",
        { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      ],
    ]);
    for (const [name, annotations] of expectedAnnotations) {
      const tool = listed.tools.find((item) => item.name === name);
      assert.ok(tool, `missing MCP tool ${name}`);
      assert.deepEqual(tool.annotations, annotations, `${name} annotations changed`);
    }
    const bindTool = listed.tools.find((item) => item.name === "figure_library_plan_bind_global");
    assert.ok(bindTool);
    const bindProperties = record(record(bindTool.inputSchema).properties);
    assert.ok("legacySourceDirectory" in bindProperties, "copy_legacy source is not public MCP input");

    const before = await connection.client.callTool({
      name: "figure_library_source_status",
      arguments: {},
    });
    assert.equal(before.isError, undefined);
    const beforeStatus = record(before.structuredContent);
    assert.equal(beforeStatus.libraryDirectorySource, "legacy-default");
    assert.equal(beforeStatus.libraryWritesEnabled, false);
    assert.equal(beforeStatus.libraryId, undefined);
    assert.equal(record(beforeStatus.writeLock).exists, false);

    const plannedBinding = await connection.client.callTool({
      name: "figure_library_plan_bind_global",
      arguments: {
        libraryDirectory: canonical,
        migrationMode: "copy_legacy",
        legacySourceDirectory: legacy,
      },
    });
    assert.equal(plannedBinding.isError, undefined, toolText(plannedBinding));
    const bindingPlan = record(record(plannedBinding.structuredContent).plan);
    assert.equal(bindingPlan.libraryDirectory, path.resolve(canonical));
    assert.equal(bindingPlan.locatorPath, path.resolve(locatorPath));
    const migration = record(bindingPlan.migration);
    assert.equal(migration.mode, "copy_legacy");
    assert.equal(migration.sourceDirectory, path.resolve(legacy));
    assert.ok(records(migration.sourceInventory).some((item) => item.relativePath === "templates/legacy-one/template.json"));

    const tamperedPlan = structuredClone(bindingPlan);
    record(tamperedPlan.migration).sourceDirectory = path.join(root, "attacker-selected-source");
    const rejectedTamper = await connection.client.callTool({
      name: "figure_library_apply_bind_global",
      arguments: {
        plan: tamperedPlan,
        planDigest: bindingPlan.planDigest,
        operationId: "bind-tampered",
      },
    });
    assert.equal(rejectedTamper.isError, true);
    assert.match(toolText(rejectedTamper), /invalid global library binding plan/iu);
    await assert.rejects(fs.access(locatorPath), { code: "ENOENT" });

    const appliedBinding = await connection.client.callTool({
      name: "figure_library_apply_bind_global",
      arguments: {
        plan: bindingPlan,
        planDigest: bindingPlan.planDigest,
        operationId: "bind-canonical",
      },
    });
    assert.equal(appliedBinding.isError, undefined, toolText(appliedBinding));
    const bindingResult = record(record(appliedBinding.structuredContent).result);
    assert.equal(bindingResult.idempotentReplay, false);
    assert.equal(bindingResult.migrationMode, "copy_legacy");
    assert.equal(
      await fs.readFile(path.join(canonical, "templates", "legacy-one", "template.json"), "utf8"),
      await fs.readFile(path.join(legacy, "templates", "legacy-one", "template.json"), "utf8"),
    );

    const replayedBinding = await connection.client.callTool({
      name: "figure_library_apply_bind_global",
      arguments: {
        plan: bindingPlan,
        planDigest: bindingPlan.planDigest,
        operationId: "bind-canonical",
      },
    });
    assert.equal(replayedBinding.isError, undefined, toolText(replayedBinding));
    assert.equal(
      record(record(replayedBinding.structuredContent).result).idempotentReplay,
      true,
    );

    const after = await connection.client.callTool({
      name: "figure_library_source_status",
      arguments: { projectDirectory },
    });
    assert.equal(after.isError, undefined, toolText(after));
    const afterStatus = record(after.structuredContent);
    assert.equal(afterStatus.libraryDirectory, path.resolve(canonical));
    assert.equal(afterStatus.libraryDirectorySource, "locator");
    assert.equal(afterStatus.libraryId, bindingResult.libraryId);
    assert.equal(afterStatus.locatorConfigRevision, 1);
    assert.equal(afterStatus.libraryWritesEnabled, true);
    assert.equal(record(afterStatus.writeLock).directory, path.join(path.resolve(canonical), ".write-lock"));
    assert.equal(record(afterStatus.writeLock).exists, false);
    const captureStatus = record(afterStatus.captureStatus);
    assert.equal(captureStatus.source, "project");
    assert.equal(captureStatus.root, path.join(path.resolve(projectDirectory), ".wisp", "figure-captures"));

    const foreignLocatorPath = path.join(root, "foreign-config", "locator.json");
    const foreignBindingPlan = await planGlobalLibraryBinding({
      libraryDirectory: path.join(root, "foreign-binding-target"),
      locatorPath: foreignLocatorPath,
    });
    const rejectedForeignBinding = await connection.client.callTool({
      name: "figure_library_apply_bind_global",
      arguments: {
        plan: foreignBindingPlan,
        planDigest: foreignBindingPlan.planDigest,
        operationId: "foreign-locator-binding",
      },
    });
    assert.equal(rejectedForeignBinding.isError, true);
    assert.match(toolText(rejectedForeignBinding), /locatorPath does not match this runtime/iu);
    await assert.rejects(fs.access(foreignLocatorPath), { code: "ENOENT" });

    const foreignRecoveryRoot = path.join(root, "foreign-recovery-library");
    const foreignMarker = await ensureLibraryRootMarker(foreignRecoveryRoot);
    const foreignWriteLock = new CrossRuntimeWriteLock({
      root: foreignRecoveryRoot,
      libraryId: foreignMarker.value.libraryId,
      operation: "foreign-recovery-owner",
      heartbeatIntervalMs: 60_000,
    });
    await foreignWriteLock.acquire();
    try {
      const foreignRecoveryPlan = await planLibraryWriteLockRecovery({
        libraryRoot: foreignRecoveryRoot,
        libraryId: foreignMarker.value.libraryId,
        reason: "valid foreign recovery plan must not cross the current Library boundary",
      });
      const rejectedForeignRecovery = await connection.client.callTool({
        name: "figure_library_apply_recover_write_lock",
        arguments: {
          plan: foreignRecoveryPlan,
          planDigest: foreignRecoveryPlan.planDigest,
          operationId: "foreign-recovery-apply",
        },
      });
      assert.equal(rejectedForeignRecovery.isError, true);
      assert.match(toolText(rejectedForeignRecovery), /does not match the current canonical Library/iu);
    } finally {
      await foreignWriteLock.release();
    }

    const mismatch = await connection.client.callTool({
      name: "figure_library_source_status",
      arguments: { projectDirectory: otherProjectDirectory },
    });
    assert.equal(mismatch.isError, true);
    assert.match(toolText(mismatch), /Figure Library source status failed.*capture_project_mismatch/isu);

    const previewPath = path.join(root, "flat-preview.png");
    const codePath = path.join(root, "flat-plot.R");
    await fs.writeFile(previewPath, PNG);
    await fs.writeFile(codePath, "plot(1)\n");
    const flatLibrary = new UserTemplateLibrary(canonical);
    const flat = await flatLibrary.importTemplate({
      title: "Flat approved MCP resolver fixture",
      description: "Approved flat template used to cover the combined project resolver.",
      tags: ["flat", "server-project-tools"],
      visualProfile: "single panel",
      dataProfile: "numeric vector",
      packages: [],
      imagePath: previewPath,
      codePaths: [codePath],
    });

    const versioned = new VersionedTemplateLibrary(canonical);
    const templateId = "server-project-versioned";
    const versionOne = await publish(versioned, templateId, "Server project v1", "v1");

    const plannedUse = await connection.client.callTool({
      name: "figure_library_plan_project_use",
      arguments: { projectDirectory, templateId },
    });
    assert.equal(plannedUse.isError, undefined, toolText(plannedUse));
    const usePlan = record(record(plannedUse.structuredContent).plan);
    assert.equal(usePlan.action, "create");
    assert.equal(record(usePlan.desired).revisionId, versionOne.revisionId);
    assert.equal(record(usePlan.desired).contentDigest, versionOne.contentDigest);

    const appliedUse = await connection.client.callTool({
      name: "figure_library_apply_project_use",
      arguments: {
        projectDirectory,
        plan: usePlan,
        planDigest: usePlan.planDigest,
        expectedAction: usePlan.action,
        expectedProjectLockDigest: usePlan.expectedProjectLockDigest,
        operationId: "project-use-versioned-v1",
      },
    });
    assert.equal(appliedUse.isError, undefined, toolText(appliedUse));
    const appliedUseResult = record(record(appliedUse.structuredContent).result);
    assert.equal(appliedUseResult.action, "create");
    assert.equal(appliedUseResult.reused, false);
    assert.equal(appliedUseResult.idempotentReplay, false);

    const plannedFlat = await connection.client.callTool({
      name: "figure_library_plan_project_use",
      arguments: { projectDirectory, templateId: flat.template.templateId },
    });
    assert.equal(plannedFlat.isError, undefined, toolText(plannedFlat));
    const flatPlan = record(record(plannedFlat.structuredContent).plan);
    assert.equal(flatPlan.action, "create");
    assert.equal(record(flatPlan.desired).revisionId, "flat-v1");
    const appliedFlat = await connection.client.callTool({
      name: "figure_library_apply_project_use",
      arguments: {
        projectDirectory,
        plan: flatPlan,
        planDigest: flatPlan.planDigest,
        expectedAction: flatPlan.action,
        expectedProjectLockDigest: flatPlan.expectedProjectLockDigest,
        operationId: "project-use-flat-v1",
      },
    });
    assert.equal(appliedFlat.isError, undefined, toolText(appliedFlat));

    const plannedFigureYa = await connection.client.callTool({
      name: "figure_library_plan_project_use",
      arguments: {
        projectDirectory,
        templateId: "FigureYa000ContributionTemplate",
        allowNetwork: false,
      },
    });
    assert.equal(plannedFigureYa.isError, undefined, toolText(plannedFigureYa));
    const figureYaPlan = record(record(plannedFigureYa.structuredContent).plan);
    assert.equal(figureYaPlan.action, "create");
    assert.match(String(record(figureYaPlan.desired).revisionId), /^figureya-template-/u);
    const plannedFullFigureYa = await connection.client.callTool({
      name: "figure_library_plan_project_use",
      arguments: {
        projectDirectory,
        templateId: "FigureYa000ContributionTemplate",
        mode: "full",
        allowNetwork: false,
      },
    });
    assert.equal(plannedFullFigureYa.isError, undefined, toolText(plannedFullFigureYa));
    const fullFigureYaPlan = record(record(plannedFullFigureYa.structuredContent).plan);
    assert.match(String(record(fullFigureYaPlan.desired).revisionId), /^figureya-full-/u);
    assert.notEqual(
      record(fullFigureYaPlan.desired).contentDigest,
      record(figureYaPlan.desired).contentDigest,
      "FigureYa template/full materializations must have different exact identities",
    );

    // Seed an integrity-valid full-mode pin through a deterministic test resolver. The public
    // server status call below must preserve that mode instead of comparing it to template mode.
    const fullDesiredRecord = record(fullFigureYaPlan.desired);
    const fullDesired: ProjectTemplateResolvedRevision = {
      templateId: String(fullDesiredRecord.templateId),
      revisionId: String(fullDesiredRecord.revisionId),
      contentDigest: String(fullDesiredRecord.contentDigest),
    };
    const fullModeFixture = new ProjectTemplateLibrary(projectDirectory, {
      libraryId: String(bindingResult.libraryId),
      async resolveExact(selection) {
        assert.deepEqual(selection, fullDesired);
        return fullDesired;
      },
      async resolvePublished(_templateId, currentSelection) {
        assert.deepEqual(currentSelection, fullDesired);
        return fullDesired;
      },
      async materialize(_revision, destination) {
        await fs.mkdir(destination, { recursive: true });
        await fs.writeFile(path.join(destination, "full-mode-fixture.txt"), "full mode\n");
      },
    });
    const fixturePlan = await fullModeFixture.planUse(fullDesired);
    assert.equal(fixturePlan.action, "create");
    await fullModeFixture.applyUse(fixturePlan, "seed-full-mode-status");
    const fullStatusCall = await connection.client.callTool({
      name: "figure_library_project_status",
      arguments: { projectDirectory },
    });
    assert.equal(fullStatusCall.isError, undefined, toolText(fullStatusCall));
    const fullStatus = records(record(record(fullStatusCall.structuredContent).status).templates).find(
      (item) => item.templateId === fullDesired.templateId,
    );
    assert.ok(fullStatus);
    assert.equal(fullStatus.updateAvailable, false);
    assert.equal(record(fullStatus.active).revisionId, fullDesired.revisionId);
    assert.equal(record(fullStatus.available).revisionId, fullDesired.revisionId);

    const projectLockFile = path.join(
      projectDirectory,
      ".wisp",
      "figure-library",
      "project.lock.json",
    );
    const projectLockBeforeReuse = await fs.readFile(projectLockFile, "utf8");
    const parsedProjectLock = JSON.parse(projectLockBeforeReuse) as unknown;
    assert.equal(projectLockBeforeReuse.includes(path.resolve(projectDirectory)), false);
    assert.equal(projectLockBeforeReuse.includes(path.resolve(canonical)), false);
    assert.equal(record(parsedProjectLock).sourceLibraryId, bindingResult.libraryId);
    assert.equal(records(record(parsedProjectLock).templates).length, 3);

    const plannedReuse = await connection.client.callTool({
      name: "figure_library_plan_project_use",
      arguments: {
        projectDirectory,
        templateId,
        revisionId: versionOne.revisionId,
        contentDigest: versionOne.contentDigest,
      },
    });
    assert.equal(plannedReuse.isError, undefined, toolText(plannedReuse));
    const reusePlan = record(record(plannedReuse.structuredContent).plan);
    assert.equal(reusePlan.action, "reuse");
    const reused = await connection.client.callTool({
      name: "figure_library_apply_project_use",
      arguments: {
        projectDirectory,
        plan: reusePlan,
        planDigest: reusePlan.planDigest,
        expectedAction: reusePlan.action,
        expectedProjectLockDigest: reusePlan.expectedProjectLockDigest,
        operationId: "project-reuse-versioned-v1",
      },
    });
    assert.equal(reused.isError, undefined, toolText(reused));
    assert.equal(record(record(reused.structuredContent).result).reused, true);
    assert.equal(await fs.readFile(projectLockFile, "utf8"), projectLockBeforeReuse);

    const versionTwo = await publish(versioned, templateId, "Server project v2", "v2");
    const updateStatusCall = await connection.client.callTool({
      name: "figure_library_project_status",
      arguments: { projectDirectory },
    });
    assert.equal(updateStatusCall.isError, undefined, toolText(updateStatusCall));
    const updateStatus = record(record(updateStatusCall.structuredContent).status);
    assert.equal(updateStatus.status, "ready");
    const versionedStatus = records(updateStatus.templates).find(
      (item) => item.templateId === templateId,
    );
    assert.ok(versionedStatus);
    assert.equal(versionedStatus.updateAvailable, true);
    assert.equal(record(versionedStatus.active).revisionId, versionOne.revisionId);
    assert.equal(record(versionedStatus.available).revisionId, versionTwo.revisionId);
    assert.equal(await fs.readFile(projectLockFile, "utf8"), projectLockBeforeReuse);

    const plannedUpdate = await connection.client.callTool({
      name: "figure_library_plan_project_use",
      arguments: { projectDirectory, templateId },
    });
    assert.equal(plannedUpdate.isError, undefined, toolText(plannedUpdate));
    const updatePlan = record(record(plannedUpdate.structuredContent).plan);
    assert.equal(updatePlan.action, "update");
    assert.equal(record(updatePlan.desired).revisionId, versionTwo.revisionId);
    assert.equal(
      await fs.readFile(projectLockFile, "utf8"),
      projectLockBeforeReuse,
      "planning a newer Published revision silently changed the active project pin",
    );

    globalWriteLock = new CrossRuntimeWriteLock({
      root: canonical,
      libraryId: String(bindingResult.libraryId),
      operation: "source-status-observation",
      heartbeatIntervalMs: 60_000,
    });
    await globalWriteLock.acquire();
    const lockedStatusCall = await connection.client.callTool({
      name: "figure_library_source_status",
      arguments: { projectDirectory },
    });
    assert.equal(lockedStatusCall.isError, undefined, toolText(lockedStatusCall));
    const lockedStatus = record(record(lockedStatusCall.structuredContent).writeLock);
    assert.equal(lockedStatus.exists, true);
    assert.equal(lockedStatus.ownerValid, true);
    assert.equal(record(lockedStatus.owner).operation, "source-status-observation");
    await globalWriteLock.release();
    globalWriteLock = undefined;

    const projectWriteLock = path.join(projectDirectory, ".wisp", "figure-library", "locks", "write");
    await fs.mkdir(projectWriteLock, { recursive: true });
    await fs.writeFile(
      path.join(projectWriteLock, "owner.json"),
      `${JSON.stringify({
        operationId: "project-owner-observation",
        token: "test-owner-token",
        pid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    const projectLockedStatusCall = await connection.client.callTool({
      name: "figure_library_project_status",
      arguments: { projectDirectory },
    });
    assert.equal(projectLockedStatusCall.isError, undefined, toolText(projectLockedStatusCall));
    const projectWriteStatus = record(record(projectLockedStatusCall.structuredContent).writeLock);
    assert.equal(projectWriteStatus.format, "project-template-write-lock.v1");
    assert.equal(projectWriteStatus.exists, true);
    assert.equal(projectWriteStatus.ownerValid, true);
    assert.equal(record(projectWriteStatus.owner).operationId, "project-owner-observation");
    assert.equal("token" in record(projectWriteStatus.owner), false, "project lock token leaked");
    await fs.rm(projectWriteLock, { recursive: true, force: true });
  } finally {
    await globalWriteLock?.release().catch(() => undefined);
    await connection?.client.close().catch(() => undefined);
    await connection?.server.close().catch(() => undefined);
    restoreEnvironment(previous);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("environment override permits in-place binding but blocks a different locator target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-server-env-override-"));
  const previous = captureEnvironment();
  let connection: Awaited<ReturnType<typeof startClient>> | undefined;
  try {
    const overrideRoot = path.join(root, "environment-library");
    const targetRoot = path.join(root, "locator-target");
    const projectDirectory = path.join(root, "project");
    const xdg = path.join(root, "xdg");
    const locatorPath = path.join(xdg, "scientific-figure-library", "locator.json");
    await fs.mkdir(projectDirectory, { recursive: true });
    process.env.FIGURE_LIBRARY_DIR = overrideRoot;
    delete process.env.FIGURE_CAPTURE_DIR;
    delete process.env.FIGURE_GALLERY_DIR;
    delete process.env.FIGUREYA_SOURCE_PACK_DIR;
    process.env.HOME = path.join(root, "home");
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.FIGUREYA_ASSETS_DIR = path.resolve(import.meta.dirname, "..", "assets");

    connection = await startClient("server-project-tools-env-override");
    const statusCall = await connection.client.callTool({
      name: "figure_library_source_status",
      arguments: {},
    });
    assert.equal(statusCall.isError, undefined, toolText(statusCall));
    const status = record(statusCall.structuredContent);
    assert.equal(status.libraryDirectorySource, "FIGURE_LIBRARY_DIR");
    assert.equal(status.libraryDirectory, path.resolve(overrideRoot));
    assert.equal(status.libraryId, undefined);
    assert.equal(record(status.writeLock).directory, path.join(path.resolve(overrideRoot), ".write-lock"));

    const blockedPlan = await connection.client.callTool({
      name: "figure_library_plan_bind_global",
      arguments: { libraryDirectory: targetRoot },
    });
    assert.equal(blockedPlan.isError, true);
    assert.match(toolText(blockedPlan), /binding_blocked_by_environment_override.*FIGURE_LIBRARY_DIR/isu);
    await assert.rejects(fs.access(locatorPath), { code: "ENOENT" });

    const canonicalPlan = await planGlobalLibraryBinding({
      libraryDirectory: targetRoot,
      locatorPath,
    });
    const blockedApply = await connection.client.callTool({
      name: "figure_library_apply_bind_global",
      arguments: {
        plan: canonicalPlan,
        planDigest: canonicalPlan.planDigest,
        operationId: "blocked-bind-apply",
      },
    });
    assert.equal(blockedApply.isError, true);
    assert.match(toolText(blockedApply), /binding_blocked_by_environment_override.*FIGURE_LIBRARY_DIR/isu);
    await assert.rejects(fs.access(locatorPath), { code: "ENOENT" });

    const lockDirectory = path.join(projectDirectory, ".wisp", "figure-library", "locks", "write");
    await fs.mkdir(lockDirectory, { recursive: true });
    await fs.writeFile(
      path.join(lockDirectory, "owner.json"),
      `${JSON.stringify({
        operationId: "read-only-status-owner",
        token: "read-only-token",
        pid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    const projectStatusCall = await connection.client.callTool({
      name: "figure_library_project_status",
      arguments: { projectDirectory },
    });
    assert.equal(projectStatusCall.isError, undefined, toolText(projectStatusCall));
    assert.equal(record(record(projectStatusCall.structuredContent).status).status, "missing");
    const projectWriteLock = record(record(projectStatusCall.structuredContent).writeLock);
    assert.equal(projectWriteLock.format, "project-template-write-lock.v1");
    assert.equal(projectWriteLock.ownerValid, true);

    const blockedProjectPlan = await connection.client.callTool({
      name: "figure_library_plan_project_use",
      arguments: {
        projectDirectory,
        templateId: "FigureYa000ContributionTemplate",
        allowNetwork: false,
      },
    });
    assert.equal(blockedProjectPlan.isError, true);
    assert.match(toolText(blockedProjectPlan), /library_not_bound.*stable canonical libraryId/isu);

    const fakePlanDigest = "a".repeat(64);
    const blockedProjectApply = await connection.client.callTool({
      name: "figure_library_apply_project_use",
      arguments: {
        projectDirectory,
        plan: {
          planDigest: fakePlanDigest,
          action: "create",
          expectedProjectLockDigest: null,
        },
        planDigest: fakePlanDigest,
        expectedAction: "create",
        expectedProjectLockDigest: null,
        operationId: "blocked-project-apply",
      },
    });
    assert.equal(blockedProjectApply.isError, true);
    assert.match(toolText(blockedProjectApply), /library_not_bound.*stable canonical libraryId/isu);

    const inPlacePlanCall = await connection.client.callTool({
      name: "figure_library_plan_bind_global",
      arguments: { libraryDirectory: overrideRoot },
    });
    assert.equal(inPlacePlanCall.isError, undefined, toolText(inPlacePlanCall));
    const inPlacePlan = record(record(inPlacePlanCall.structuredContent).plan);
    assert.equal(inPlacePlan.libraryDirectory, path.resolve(overrideRoot));
    const inPlaceApply = await connection.client.callTool({
      name: "figure_library_apply_bind_global",
      arguments: {
        plan: inPlacePlan,
        planDigest: inPlacePlan.planDigest,
        operationId: "bind-environment-root-in-place",
      },
    });
    assert.equal(inPlaceApply.isError, undefined, toolText(inPlaceApply));
    const inPlaceOutput = record(inPlaceApply.structuredContent);
    const inPlaceResult = record(inPlaceOutput.result);
    assert.equal(record(inPlaceOutput.effective).directorySource, "FIGURE_LIBRARY_DIR");
    assert.equal(record(inPlaceOutput.effective).libraryId, inPlaceResult.libraryId);
    assert.equal(
      record(JSON.parse(await fs.readFile(locatorPath, "utf8")) as unknown).libraryId,
      inPlaceResult.libraryId,
    );

    const boundStatusCall = await connection.client.callTool({
      name: "figure_library_source_status",
      arguments: {},
    });
    assert.equal(boundStatusCall.isError, undefined, toolText(boundStatusCall));
    const boundStatus = record(boundStatusCall.structuredContent);
    assert.equal(boundStatus.libraryDirectorySource, "FIGURE_LIBRARY_DIR");
    assert.equal(boundStatus.libraryId, inPlaceResult.libraryId);

    const boundProjectPlan = await connection.client.callTool({
      name: "figure_library_plan_project_use",
      arguments: {
        projectDirectory,
        templateId: "FigureYa000ContributionTemplate",
        allowNetwork: false,
      },
    });
    assert.equal(boundProjectPlan.isError, undefined, toolText(boundProjectPlan));
    assert.match(
      String(record(record(record(boundProjectPlan.structuredContent).plan).desired).revisionId),
      /^figureya-template-/u,
    );
  } finally {
    await connection?.client.close().catch(() => undefined);
    await connection?.server.close().catch(() => undefined);
    restoreEnvironment(previous);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("locator rebinding immediately switches search and status and invalidates an old lifecycle plan", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-server-dynamic-rebind-"));
  const previous = captureEnvironment();
  let connection: Awaited<ReturnType<typeof startClient>> | undefined;
  try {
    const home = path.join(root, "home");
    const xdg = path.join(root, "xdg");
    const firstRoot = path.join(root, "canonical-a");
    const secondRoot = path.join(root, "canonical-b");
    await fs.mkdir(home, { recursive: true });
    delete process.env.FIGURE_LIBRARY_DIR;
    delete process.env.FIGURE_CAPTURE_DIR;
    delete process.env.FIGURE_GALLERY_DIR;
    delete process.env.FIGUREYA_SOURCE_PACK_DIR;
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.FIGUREYA_ASSETS_DIR = path.resolve(import.meta.dirname, "..", "assets");

    connection = await startClient("server-project-tools-dynamic-rebind");
    const bind = async (libraryDirectory: string, operationId: string) => {
      const planned = await connection!.client.callTool({
        name: "figure_library_plan_bind_global",
        arguments: { libraryDirectory },
      });
      assert.equal(planned.isError, undefined, toolText(planned));
      const plan = record(record(planned.structuredContent).plan);
      const applied = await connection!.client.callTool({
        name: "figure_library_apply_bind_global",
        arguments: { plan, planDigest: plan.planDigest, operationId },
      });
      assert.equal(applied.isError, undefined, toolText(applied));
      return record(record(applied.structuredContent).result);
    };

    const firstBinding = await bind(firstRoot, "dynamic-bind-a");
    const firstPreview = path.join(root, "first-preview.png");
    await fs.writeFile(firstPreview, PNG);
    const firstLibrary = new UserTemplateLibrary(firstRoot);
    const firstTemplate = await firstLibrary.importTemplate({
      title: "Dynamic Alpha Only Template",
      description: "alpha-root-only-dynamic-search-marker",
      tags: ["dynamic-alpha-only"],
      imagePath: firstPreview,
    });

    const alphaSearch = await connection.client.callTool({
      name: "figure_library_search",
      arguments: {
        query: "alpha-root-only-dynamic-search-marker",
        sourceIds: ["user"],
        limit: 6,
      },
    });
    assert.equal(alphaSearch.isError, undefined, toolText(alphaSearch));
    assert.ok(
      records(record(alphaSearch.structuredContent).candidates).some(
        (item) => item.templateId === firstTemplate.template.templateId,
      ),
    );

    const pendingImage = path.join(root, "pending-preview.png");
    await fs.writeFile(pendingImage, new Uint8Array([...PNG, 17]));
    const pendingInput = {
      title: "Pending plan from canonical alpha",
      description: "Must become stale after the locator changes to canonical beta.",
      tags: ["stale-after-rebind"],
      imagePath: pendingImage,
      sourceKey: "dynamic-rebind-pending",
    };
    const oldPlanCall = await connection.client.callTool({
      name: "figure_library_plan_import",
      arguments: pendingInput,
    });
    assert.equal(oldPlanCall.isError, undefined, toolText(oldPlanCall));
    const oldPlan = record(oldPlanCall.structuredContent);
    assert.equal(record(oldPlan.libraryContext).libraryId, firstBinding.libraryId);
    assert.equal(record(oldPlan.libraryContext).configRevision, 1);
    assert.equal(oldPlan.action, "create");

    const secondBinding = await bind(secondRoot, "dynamic-bind-b");
    assert.notEqual(secondBinding.libraryId, firstBinding.libraryId);
    const statusCall = await connection.client.callTool({
      name: "figure_library_source_status",
      arguments: {},
    });
    assert.equal(statusCall.isError, undefined, toolText(statusCall));
    const status = record(statusCall.structuredContent);
    assert.equal(status.libraryDirectory, path.resolve(secondRoot));
    assert.equal(status.libraryDirectorySource, "locator");
    assert.equal(status.libraryId, secondBinding.libraryId);
    assert.equal(status.locatorConfigRevision, 2);

    const alphaAfterRebind = await connection.client.callTool({
      name: "figure_library_search",
      arguments: {
        query: "alpha-root-only-dynamic-search-marker",
        sourceIds: ["user"],
        limit: 6,
      },
    });
    assert.equal(alphaAfterRebind.isError, undefined, toolText(alphaAfterRebind));
    assert.equal(
      records(record(alphaAfterRebind.structuredContent).candidates).some(
        (item) => item.templateId === firstTemplate.template.templateId,
      ),
      false,
      "ordinary search retained the previous locator root",
    );

    const secondPreview = path.join(root, "second-preview.png");
    await fs.writeFile(secondPreview, new Uint8Array([...PNG, 23]));
    const secondLibrary = new UserTemplateLibrary(secondRoot);
    const secondTemplate = await secondLibrary.importTemplate({
      title: "Dynamic Beta Only Template",
      description: "beta-root-only-dynamic-search-marker",
      tags: ["dynamic-beta-only"],
      imagePath: secondPreview,
    });
    const betaSearch = await connection.client.callTool({
      name: "figure_library_search",
      arguments: {
        query: "beta-root-only-dynamic-search-marker",
        sourceIds: ["user"],
        limit: 6,
      },
    });
    assert.equal(betaSearch.isError, undefined, toolText(betaSearch));
    assert.ok(
      records(record(betaSearch.structuredContent).candidates).some(
        (item) => item.templateId === secondTemplate.template.templateId,
      ),
    );

    const staleApply = await connection.client.callTool({
      name: "figure_library_apply_import",
      arguments: {
        ...pendingInput,
        planDigest: oldPlan.planDigest,
        expectedAction: oldPlan.action,
        expectedTemplateId: oldPlan.proposedTemplateId,
        operationId: "old-plan-after-dynamic-rebind",
      },
    });
    assert.equal(staleApply.isError, true);
    assert.match(toolText(staleApply), /stale import plan|library context/iu);
    assert.equal(await secondLibrary.get(String(oldPlan.proposedTemplateId)), undefined);
  } finally {
    await connection?.client.close().catch(() => undefined);
    await connection?.server.close().catch(() => undefined);
    restoreEnvironment(previous);
    await fs.rm(root, { recursive: true, force: true });
  }
});
