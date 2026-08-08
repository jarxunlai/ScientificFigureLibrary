import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PROJECT_TEMPLATE_LOCK_SCHEMA,
  ProjectTemplateLibrary,
  createVersionedLibraryProjectSource,
  type ProjectTemplateResolvedRevision,
  type ProjectTemplateSelection,
  type ProjectTemplateSourceResolver,
} from "../src/project-library.ts";
import {
  VersionedTemplateLibrary,
  type VersionedTemplateCandidate,
} from "../src/versioned-library.ts";

function hash(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function revision(templateId: string, name: string): ProjectTemplateResolvedRevision {
  return {
    templateId,
    revisionId: `rev-${name}`,
    contentDigest: hash(`${templateId}:${name}`),
    releaseId: `release-${name}`,
    publishedAt: `2026-08-${name === "v1" ? "01" : "02"}T00:00:00.000Z`,
  };
}

class FakeSource implements ProjectTemplateSourceResolver {
  readonly libraryId: string;
  readonly revisions = new Map<string, ProjectTemplateResolvedRevision>();
  readonly published = new Map<string, ProjectTemplateResolvedRevision>();
  readonly materializations = new Map<string, number>();

  constructor(libraryId: string) {
    this.libraryId = libraryId;
  }

  add(value: ProjectTemplateResolvedRevision, published = true) {
    this.revisions.set(this.key(value), value);
    if (published) this.published.set(value.templateId, value);
  }

  private key(value: ProjectTemplateSelection) {
    return `${value.templateId}\0${value.revisionId}\0${value.contentDigest}`;
  }

  async resolveExact(selection: ProjectTemplateSelection) {
    const found = this.revisions.get(this.key(selection));
    if (!found) throw new Error("not an exact published revision");
    return { ...found };
  }

  async resolvePublished(templateId: string) {
    const found = this.published.get(templateId);
    return found ? { ...found } : undefined;
  }

  async materialize(value: ProjectTemplateResolvedRevision, destination: string) {
    const key = this.key(value);
    this.materializations.set(key, (this.materializations.get(key) ?? 0) + 1);
    await fs.mkdir(path.join(destination, "reference", "code"), { recursive: true });
    await fs.writeFile(
      path.join(destination, "reference", "code", "plot.R"),
      `# ${value.templateId}/${value.revisionId}/${value.contentDigest}\n`,
    );
    await fs.writeFile(
      path.join(destination, "template.lock.json"),
      `${JSON.stringify({
        schema: "test.template-lock.v1",
        templateId: value.templateId,
        revisionId: value.revisionId,
        contentDigest: value.contentDigest,
      })}\n`,
    );
  }
}

async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "figure-project-library-"));
  const project = path.join(parent, "project");
  await fs.mkdir(project);
  const source = new FakeSource("library-test-001");
  const library = new ProjectTemplateLibrary(project, source);
  return { parent, project, source, library };
}

test("project template create uses a fixed protected layout and exact immutable snapshot", async () => {
  const { parent, project, source, library } = await fixture();
  const v1 = revision("volcano-template", "v1");
  source.add(v1);
  try {
    const before = await library.status();
    assert.equal(before.status, "missing");
    assert.equal(before.projectLockDigest, null);
    assert.equal(await fs.stat(project).then(() => true), true);
    await assert.rejects(fs.access(path.join(project, ".wisp")), /ENOENT/u);

    const plan = await library.planUse(v1);
    assert.equal(plan.action, "create");
    assert.equal(plan.expectedProjectLockDigest, null);
    assert.equal(plan.expectedSnapshotIntegrity, "absent");
    await assert.rejects(fs.access(path.join(project, ".wisp")), /ENOENT/u);

    const applied = await library.applyUse(plan, "project-create-v1");
    assert.equal(applied.action, "create");
    assert.equal(applied.reused, false);
    assert.equal(applied.idempotentReplay, false);
    assert.equal(path.dirname(path.dirname(applied.target)), path.join(project, ".wisp", "figure-library", "templates"));
    assert.equal(
      await fs.readFile(path.join(applied.target, "reference", "code", "plot.R"), "utf8"),
      `# ${v1.templateId}/${v1.revisionId}/${v1.contentDigest}\n`,
    );

    const ignore = await fs.readFile(
      path.join(project, ".wisp", "figure-library", ".gitignore"),
      "utf8",
    );
    assert.equal(ignore, "/templates/\n/previews/\n/locks/\n/quarantine/\n");
    assert.doesNotMatch(ignore, /project\.lock/u);

    const rawLock = await fs.readFile(
      path.join(project, ".wisp", "figure-library", "project.lock.json"),
      "utf8",
    );
    assert.doesNotMatch(rawLock, new RegExp(parent.replaceAll("\\", "\\\\"), "u"));
    const lock = JSON.parse(rawLock) as {
      schema: string;
      sourceLibraryId: string;
      templates: Array<{ active: ProjectTemplateSelection; snapshots: unknown[] }>;
    };
    assert.equal(lock.schema, PROJECT_TEMPLATE_LOCK_SCHEMA);
    assert.equal(lock.sourceLibraryId, source.libraryId);
    assert.deepEqual(lock.templates[0]?.active, {
      templateId: v1.templateId,
      revisionId: v1.revisionId,
      contentDigest: v1.contentDigest,
    });
    assert.equal(lock.templates[0]?.snapshots.length, 1);

    const after = await library.status();
    assert.equal(after.status, "ready");
    assert.equal(after.templates[0]?.status, "ready");
    assert.equal(after.templates[0]?.snapshots[0]?.integrity, "ready");
    assert.equal(after.templates[0]?.updateAvailable, false);
    assert.match(after.projectLockDigest!, /^[a-f0-9]{64}$/u);

    const replay = await library.applyUse(plan, "project-create-v1");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.projectLockDigest, applied.projectLockDigest);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("same exact active pin is reused with zero writes", async () => {
  const { parent, source, library } = await fixture();
  const v1 = revision("reuse-template", "v1");
  source.add(v1);
  try {
    await library.applyUse(await library.planUse(v1), "create-reuse-template");
    const lockFile = path.join(library.root, "project.lock.json");
    const before = await fs.readFile(lockFile, "utf8");
    const beforeStat = await fs.stat(lockFile);
    const operationDirectory = path.join(library.locksDirectory, "operations");
    const beforeOperations = (await fs.readdir(operationDirectory)).sort();

    const reusePlan = await library.planUse(v1);
    assert.equal(reusePlan.action, "reuse");
    const result = await library.applyUse(reusePlan, "zero-write-reuse");
    assert.equal(result.action, "reuse");
    assert.equal(result.reused, true);
    assert.equal(await fs.readFile(lockFile, "utf8"), before);
    assert.equal((await fs.stat(lockFile)).mtimeMs, beforeStat.mtimeMs);
    assert.deepEqual((await fs.readdir(operationDirectory)).sort(), beforeOperations);
    assert.equal(source.materializations.get(source["key"](v1)), 1);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("a reviewed project-use plan cannot be applied to a different project", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "figure-project-plan-scope-"));
  const projectA = path.join(parent, "project-a");
  const projectB = path.join(parent, "project-b");
  await Promise.all([fs.mkdir(projectA), fs.mkdir(projectB)]);
  const source = new FakeSource("library-project-scope-001");
  const selected = revision("project-scoped-template", "v1");
  source.add(selected);
  const libraryA = new ProjectTemplateLibrary(projectA, source);
  const libraryB = new ProjectTemplateLibrary(projectB, source);
  try {
    const planForA = await libraryA.planUse(selected);
    assert.notEqual(libraryA.projectDirectoryDigest, libraryB.projectDirectoryDigest);
    await assert.rejects(
      libraryB.applyUse(planForA, "wrong-project-apply"),
      /projectDirectory does not match the reviewed project use plan/u,
    );
    await assert.rejects(
      fs.access(path.join(projectB, ".wisp")),
      /ENOENT/u,
      "a cross-project Apply rejection must happen before any project-local write",
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("project status and Apply refuse a .wisp symlink escape without outside writes", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "figure-project-symlink-escape-"));
  const project = path.join(parent, "project");
  const outside = path.join(parent, "outside");
  await Promise.all([fs.mkdir(project), fs.mkdir(outside)]);
  const source = new FakeSource("library-symlink-scope-001");
  const selected = revision("symlink-scoped-template", "v1");
  source.add(selected);
  const library = new ProjectTemplateLibrary(project, source);
  try {
    const plan = await library.planUse(selected);
    try {
      await fs.symlink(outside, path.join(project, ".wisp"), "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        t.skip("directory symlinks are not available on this platform");
        return;
      }
      throw error;
    }

    const status = await library.status();
    assert.equal(status.status, "modified");
    assert.match(status.issues.join("\n"), /project_path_unsafe/u);
    await assert.rejects(
      library.applyUse(plan, "reject-symlink-escape"),
      /project_path_unsafe/u,
    );
    assert.deepEqual(
      await fs.readdir(outside),
      [],
      "status and Apply must not follow the project-local symlink",
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("project status and zero-write reuse refuse a templates symlink", async (t) => {
  const { parent, project, source, library } = await fixture();
  const outside = path.join(parent, "outside-templates");
  const selected = revision("templates-symlink-template", "v1");
  source.add(selected);
  await fs.mkdir(outside);
  try {
    await library.applyUse(await library.planUse(selected), "seed-templates-symlink");
    const reusePlan = await library.planUse(selected);
    assert.equal(reusePlan.action, "reuse");
    await fs.rename(library.templatesDirectory, `${library.templatesDirectory}-retained`);
    try {
      await fs.symlink(outside, library.templatesDirectory, "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        t.skip("directory symlinks are not available on this platform");
        return;
      }
      throw error;
    }
    const status = await library.status();
    assert.equal(status.status, "modified");
    assert.match(status.issues.join("\n"), /project_path_unsafe/u);
    await assert.rejects(
      library.applyUse(reusePlan, "reject-templates-symlink"),
      /project_path_unsafe/u,
    );
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("project metadata symlinks are rejected without following dangling targets", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "figure-project-metadata-symlink-"));
  const project = path.join(parent, "project");
  const outside = path.join(parent, "outside");
  await Promise.all([fs.mkdir(project), fs.mkdir(outside)]);
  const source = new FakeSource("library-metadata-symlink-001");
  const selected = revision("metadata-symlink-template", "v1");
  source.add(selected);
  const library = new ProjectTemplateLibrary(project, source);
  const plan = await library.planUse(selected);
  const root = path.join(project, ".wisp", "figure-library");
  await fs.mkdir(root, { recursive: true });
  const outsideIgnore = path.join(outside, "must-not-be-created.gitignore");
  try {
    await fs.symlink(outsideIgnore, path.join(root, ".gitignore"), "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("file symlinks are not available on this platform");
      await fs.rm(parent, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  try {
    await assert.rejects(
      library.applyUse(plan, "reject-gitignore-symlink"),
      /project_path_unsafe/u,
    );
    await assert.rejects(fs.access(outsideIgnore), /ENOENT/u);

    await fs.rm(path.join(root, ".gitignore"));
    const outsideLock = path.join(outside, "must-not-be-read-project-lock.json");
    await fs.symlink(outsideLock, path.join(root, "project.lock.json"), "file");
    const status = await library.status();
    assert.equal(status.status, "modified");
    assert.match(status.issues.join("\n"), /project_path_unsafe/u);
    await assert.rejects(fs.access(outsideLock), /ENOENT/u);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("multiple templates retain histories while update and activate switch one active revision", async () => {
  const { parent, source, library } = await fixture();
  const firstV1 = revision("first-template", "v1");
  const firstV2 = revision("first-template", "v2");
  const secondV1 = revision("second-template", "v1");
  source.add(firstV1);
  source.add(firstV2);
  source.published.set(firstV1.templateId, firstV1);
  source.add(secondV1);
  try {
    await library.applyUse(await library.planUse(firstV1), "create-first-v1");
    await library.applyUse(await library.planUse(secondV1), "create-second-v1");
    let status = await library.status();
    assert.deepEqual(status.templates.map((item) => item.templateId), ["first-template", "second-template"]);

    source.published.set(firstV1.templateId, firstV2);
    status = await library.status();
    const firstUpdate = status.templates.find((item) => item.templateId === firstV1.templateId);
    assert.equal(firstUpdate?.updateAvailable, true);
    assert.equal(firstUpdate?.available?.revisionId, firstV2.revisionId);

    const update = await library.planUse(firstV2);
    assert.equal(update.action, "update");
    await library.applyUse(update, "update-first-v2");
    status = await library.status();
    let first = status.templates.find((item) => item.templateId === firstV1.templateId)!;
    assert.equal(first.active.revisionId, firstV2.revisionId);
    assert.equal(first.snapshots.length, 2);
    assert.ok(first.snapshots.every((snapshot) => snapshot.integrity === "ready"));

    const activate = await library.planUse(firstV1);
    assert.equal(activate.action, "activate");
    await library.applyUse(activate, "activate-first-v1");
    first = (await library.status()).templates.find(
      (item) => item.templateId === firstV1.templateId,
    )!;
    assert.equal(first.active.revisionId, firstV1.revisionId);
    assert.equal(first.snapshots.length, 2);
    assert.equal(source.materializations.get(source["key"](firstV1)), 1);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("modified snapshots are reported and repair quarantines instead of deleting", async () => {
  const { parent, source, library } = await fixture();
  const v1 = revision("repair-template", "v1");
  source.add(v1);
  try {
    const created = await library.applyUse(await library.planUse(v1), "repair-seed");
    const codeFile = path.join(created.target, "reference", "code", "plot.R");
    await fs.chmod(codeFile, 0o644);
    await fs.writeFile(codeFile, "locally modified\n");
    let status = await library.status();
    assert.equal(status.status, "modified");
    assert.equal(status.templates[0]?.snapshots[0]?.integrity, "modified");

    const repair = await library.planUse(v1);
    assert.equal(repair.action, "repair");
    const repaired = await library.applyUse(repair, "repair-apply");
    assert.equal(repaired.action, "repair");
    assert.equal((await library.status()).status, "ready");
    assert.equal(
      await fs.readFile(path.join(repaired.target, "reference", "code", "plot.R"), "utf8"),
      `# ${v1.templateId}/${v1.revisionId}/${v1.contentDigest}\n`,
    );
    const quarantined = await fs.readdir(
      path.join(library.quarantineDirectory, v1.templateId),
      { withFileTypes: true },
    );
    assert.equal(quarantined.length, 1);
    assert.ok(quarantined[0]?.isDirectory());
    assert.equal(
      await fs.readFile(
        path.join(
          library.quarantineDirectory,
          v1.templateId,
          quarantined[0]!.name,
          "reference",
          "code",
          "plot.R",
        ),
        "utf8",
      ),
      "locally modified\n",
    );
    assert.equal(source.materializations.get(source["key"](v1)), 2);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("stale plans, operation collisions, source mismatch, and local write lock fail closed", async () => {
  const { parent, project, source, library } = await fixture();
  const first = revision("stale-first", "v1");
  const second = revision("stale-second", "v1");
  source.add(first);
  source.add(second);
  try {
    const firstPlan = await library.planUse(first);
    const stalePlan = await library.planUse(second);
    await library.applyUse(firstPlan, "one-operation");
    await assert.rejects(
      library.applyUse(stalePlan, "stale-operation"),
      /stale_project_use_plan/u,
    );
    await assert.rejects(
      library.applyUse(await library.planUse(second), "one-operation"),
      /operationId was already used/u,
    );

    const mismatched = new ProjectTemplateLibrary(
      project,
      new FakeSource("different-library-002"),
    );
    const mismatchStatus = await mismatched.status();
    assert.equal(mismatchStatus.status, "source_library_mismatch");
    assert.equal(mismatchStatus.templates[0]?.status, "source_library_mismatch");
    await assert.rejects(mismatched.planUse(first), /source_library_mismatch/u);

    const secondPlan = await library.planUse(second);
    await fs.mkdir(path.join(library.locksDirectory, "write"), { recursive: true });
    await assert.rejects(
      library.applyUse(secondPlan, "busy-operation"),
      /project_library_busy/u,
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("Windows-reserved and case-colliding IDs are rejected", async () => {
  const { parent, source, library } = await fixture();
  try {
    await assert.rejects(
      library.planUse({ templateId: "CON", revisionId: "rev-v1", contentDigest: "a".repeat(64) }),
      /unsafe Windows templateId/u,
    );
    const upper = revision("CaseTemplate", "v1");
    const lower = revision("casetemplate", "v1");
    source.add(upper);
    source.add(lower);
    await library.applyUse(await library.planUse(upper), "case-upper");
    await assert.rejects(
      library.planUse(lower),
      /collide on Windows/u,
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

function visualCandidate(): VersionedTemplateCandidate {
  return {
    title: "Versioned adapter fixture",
    description: "Exact Published project pin fixture.",
    assetKind: "visual_reference",
    codeStatus: "none",
    executionStatus: "not_run",
    primaryPreview: "preview.png",
    assets: [
      {
        logicalPath: "preview.png",
        role: "visual",
        mediaType: "image/png",
        text: "adapter-preview",
      },
    ],
  };
}

test("VersionedTemplateLibrary adapter pins an exact Published revision", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "project-versioned-adapter-"));
  const canonical = new VersionedTemplateLibrary(path.join(parent, "canonical"));
  try {
    const working = await canonical.planCreateWorking({
      templateId: "adapter-template",
      candidate: visualCandidate(),
    });
    await canonical.applyCreateWorking(working, "adapter-working");
    const publish = await canonical.planPublish({ templateId: "adapter-template" });
    await canonical.applyPublish(publish, "adapter-publish");
    const head = (await canonical.getSeries("adapter-template"))!.publishedHead!;
    const project = path.join(parent, "project");
    await fs.mkdir(project);
    const projectLibrary = new ProjectTemplateLibrary(
      project,
      createVersionedLibraryProjectSource(canonical, "canonical-library-001"),
    );
    const plan = await projectLibrary.planUse({
      templateId: "adapter-template",
      revisionId: head.revisionId,
      contentDigest: head.contentDigest,
    });
    const result = await projectLibrary.applyUse(plan, "adapter-project-use");
    assert.equal(
      await fs.readFile(path.join(result.target, "reference", "preview.png"), "utf8"),
      "adapter-preview",
    );
    assert.equal((await projectLibrary.status()).status, "ready");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
