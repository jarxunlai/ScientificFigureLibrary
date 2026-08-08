import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LibraryRuntime,
  applyGlobalLibraryBinding,
  assertNoPortableCaseCollision,
  assertPortableFilesystemSegment,
  assertPortableSegment,
  defaultLibraryLocatorPath,
  planGlobalLibraryBinding,
  readLibraryRootMarker,
} from "../src/library-runtime.ts";
import {
  VersionedTemplateLibrary,
  type VersionedTemplateCandidate,
} from "../src/versioned-library.ts";

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function redigestPlan<T extends { planDigest: string }>(value: T): T {
  const { planDigest: _planDigest, ...payload } = value;
  return {
    ...value,
    planDigest: createHash("sha256")
      .update(JSON.stringify(canonicalize(payload)))
      .digest("hex"),
  };
}

function visualCandidate(title: string): VersionedTemplateCandidate {
  return {
    title,
    assetKind: "visual_reference",
    codeStatus: "none",
    executionStatus: "not_run",
    primaryPreview: "preview.png",
    provenance: { source: "runtime-test" },
    assets: [{ logicalPath: "preview.png", role: "visual", text: title }],
  };
}

test("standard locator paths are native to Windows and WSL/Linux", () => {
  assert.equal(
    defaultLibraryLocatorPath({
      platform: "win32",
      env: { APPDATA: "E:\\Users\\Researcher\\AppData\\Roaming" },
      homedir: "E:\\Users\\Researcher",
    }),
    "E:\\Users\\Researcher\\AppData\\Roaming\\ScientificFigureLibrary\\locator.json",
  );
  assert.equal(
    defaultLibraryLocatorPath({
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/home/researcher/.xdg" },
      homedir: "/home/researcher",
    }),
    "/home/researcher/.xdg/scientific-figure-library/locator.json",
  );
  assert.equal(
    defaultLibraryLocatorPath({
      platform: "linux",
      env: {},
      homedir: "/home/researcher",
    }),
    "/home/researcher/.config/scientific-figure-library/locator.json",
  );
});

test("global binding creates a stable root marker and LibraryRuntime observes locator revisions without restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-runtime-"));
  try {
    const locatorPath = path.join(root, "config", "locator.json");
    const firstRoot = path.join(root, "canonical-a");
    const secondRoot = path.join(root, "canonical-b");
    const runtime = new LibraryRuntime({ locatorPath, env: {}, homedir: path.join(root, "home") });

    const before = await runtime.current();
    assert.equal(before.directorySource, "legacy-default");
    assert.equal(before.writesEnabled, false);
    assert.equal(before.configRevision, null);

    const firstPlan = await planGlobalLibraryBinding({ libraryDirectory: firstRoot, locatorPath });
    const first = await applyGlobalLibraryBinding(firstPlan, "bind-a");
    assert.equal(first.idempotentReplay, false);
    assert.equal(first.configRevision, 1);
    const firstReplay = await applyGlobalLibraryBinding(firstPlan, "bind-a");
    assert.equal(firstReplay.idempotentReplay, true);

    const firstSnapshot = await runtime.current();
    assert.equal(firstSnapshot.directorySource, "locator");
    assert.equal(firstSnapshot.root, path.resolve(firstRoot));
    assert.equal(firstSnapshot.libraryId, first.libraryId);
    assert.equal(firstSnapshot.configRevision, 1);
    assert.equal(firstSnapshot.writesEnabled, true);
    assert.equal((await readLibraryRootMarker(firstRoot))?.value.libraryId, first.libraryId);

    const stale = await planGlobalLibraryBinding({ libraryDirectory: secondRoot, locatorPath });
    const replacement = await planGlobalLibraryBinding({ libraryDirectory: secondRoot, locatorPath });
    const second = await applyGlobalLibraryBinding(replacement, "bind-b");
    assert.equal(second.configRevision, 2);
    await assert.rejects(
      applyGlobalLibraryBinding(stale, "bind-stale"),
      /stale global library binding plan/u,
    );

    const refreshed = await runtime.refresh();
    assert.equal(refreshed.root, path.resolve(secondRoot));
    assert.equal(refreshed.configRevision, 2);
    assert.equal(refreshed.libraryId, second.libraryId);
    assert.notEqual(refreshed.contextKey, firstSnapshot.contextKey);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("lifecycle Apply rejects a plan created under an older locator configRevision", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-runtime-context-"));
  try {
    const locatorPath = path.join(root, "config", "locator.json");
    const canonical = path.join(root, "canonical");
    await applyGlobalLibraryBinding(
      await planGlobalLibraryBinding({ libraryDirectory: canonical, locatorPath }),
      "bind-context-1",
    );
    const runtime = new LibraryRuntime({ locatorPath, env: {} });
    const firstSnapshot = await runtime.current();
    const firstLibrary = new VersionedTemplateLibrary(firstSnapshot);
    const plan = await firstLibrary.planCreateWorking({
      templateId: "context-series",
      candidate: visualCandidate("Context v1"),
    });
    assert.deepEqual(plan.libraryContext, {
      libraryId: firstSnapshot.libraryId,
      configRevision: 1,
    });

    await applyGlobalLibraryBinding(
      await planGlobalLibraryBinding({ libraryDirectory: canonical, locatorPath }),
      "bind-context-2",
    );
    const secondSnapshot = await runtime.current();
    assert.equal(secondSnapshot.libraryId, firstSnapshot.libraryId);
    assert.equal(secondSnapshot.configRevision, 2);
    const secondLibrary = new VersionedTemplateLibrary(secondSnapshot);
    await assert.rejects(
      secondLibrary.applyCreateWorking(plan, "apply-old-context"),
      /stale library context/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("copy_legacy binding inventories and copies flat templates non-destructively with a receipt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-legacy-copy-"));
  try {
    const legacy = path.join(root, "legacy-default");
    const legacyTemplate = path.join(legacy, "templates", "legacy-one");
    const target = path.join(root, "canonical");
    const locatorPath = path.join(root, "config", "locator.json");
    await fs.mkdir(path.join(legacyTemplate, "code"), { recursive: true });
    await fs.writeFile(path.join(legacyTemplate, "code", "plot.R"), "plot(1)\n");
    await fs.writeFile(
      path.join(legacyTemplate, "template.json"),
      `${JSON.stringify({
        schema: "figure-library.template.v1",
        templateId: "legacy-one",
        sourceId: "user",
      }, null, 2)}\n`,
    );

    const plan = await planGlobalLibraryBinding({
      libraryDirectory: target,
      locatorPath,
      migrationMode: "copy_legacy",
      legacySourceDirectory: legacy,
    });
    assert.equal(plan.migration.mode, "copy_legacy");
    if (plan.migration.mode !== "copy_legacy") assert.fail("expected a copy_legacy plan");
    assert.deepEqual(
      plan.migration.sourceInventory.map((entry) => entry.relativePath),
      ["templates/legacy-one/code/plot.R", "templates/legacy-one/template.json"],
    );
    const applied = await applyGlobalLibraryBinding(plan, "bind-and-copy-legacy");
    assert.equal(applied.migrationMode, "copy_legacy");
    assert.ok(applied.migrationReceiptFile);
    assert.equal(
      await fs.readFile(path.join(target, "templates", "legacy-one", "code", "plot.R"), "utf8"),
      "plot(1)\n",
    );
    assert.equal(
      await fs.readFile(path.join(legacyTemplate, "code", "plot.R"), "utf8"),
      "plot(1)\n",
      "the legacy source is preserved",
    );
    const receipt = JSON.parse(await fs.readFile(applied.migrationReceiptFile!, "utf8")) as {
      sourcePreserved: boolean;
      sourceInventoryDigest: string;
      copiedFiles: number;
    };
    assert.equal(receipt.sourcePreserved, true);
    assert.equal(receipt.sourceInventoryDigest, plan.migration.sourceInventoryDigest);
    assert.equal(receipt.copiedFiles, 2);

    const replay = await applyGlobalLibraryBinding(plan, "bind-and-copy-legacy");
    assert.equal(replay.idempotentReplay, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("binding refuses an arbitrary non-empty unmarked target and legacy target conflicts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-bind-guard-"));
  try {
    const arbitrary = path.join(root, "arbitrary");
    await fs.mkdir(arbitrary);
    await fs.writeFile(path.join(arbitrary, "unrelated.txt"), "not a library\n");
    await assert.rejects(
      planGlobalLibraryBinding({
        libraryDirectory: arbitrary,
        locatorPath: path.join(root, "config-a", "locator.json"),
      }),
      /non-empty.*no root marker or recognized legacy/u,
    );

    const legacy = path.join(root, "legacy");
    const sourceTemplate = path.join(legacy, "templates", "case-template");
    const target = path.join(root, "target");
    await fs.mkdir(sourceTemplate, { recursive: true });
    await fs.writeFile(
      path.join(sourceTemplate, "template.json"),
      JSON.stringify({
        schema: "figure-library.template.v1",
        templateId: "case-template",
        sourceId: "user",
      }),
    );
    await fs.mkdir(path.join(target, "templates", "CASE-TEMPLATE"), { recursive: true });
    await fs.writeFile(
      path.join(target, "templates", "CASE-TEMPLATE", "template.json"),
      JSON.stringify({
        schema: "figure-library.template.v1",
        templateId: "CASE-TEMPLATE",
        sourceId: "user",
      }),
    );
    await assert.rejects(
      planGlobalLibraryBinding({
        libraryDirectory: target,
        locatorPath: path.join(root, "config-b", "locator.json"),
        migrationMode: "copy_legacy",
        legacySourceDirectory: legacy,
      }),
      /legacy copy target template conflict/u,
    );

    const versionedTarget = path.join(root, "versioned-target");
    const seriesDirectory = path.join(
      versionedTarget,
      "store",
      "templates",
      "CASE-TEMPLATE",
    );
    await fs.mkdir(seriesDirectory, { recursive: true });
    await fs.writeFile(
      path.join(seriesDirectory, "series.json"),
      JSON.stringify({
        schema: "figure-library.template-series.v1",
        templateId: "CASE-TEMPLATE",
      }),
    );
    await assert.rejects(
      planGlobalLibraryBinding({
        libraryDirectory: versionedTarget,
        locatorPath: path.join(root, "config-c", "locator.json"),
        migrationMode: "copy_legacy",
        legacySourceDirectory: legacy,
      }),
      /legacy copy target template conflict/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("binding Apply rejects redigested malformed identifiers and locator revision transitions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-bind-validation-"));
  try {
    const plan = await planGlobalLibraryBinding({
      libraryDirectory: path.join(root, "canonical"),
      locatorPath: path.join(root, "config", "locator.json"),
    });
    await assert.rejects(
      applyGlobalLibraryBinding(
        redigestPlan({ ...plan, bindingId: "../escape" }),
        "malformed-binding-id",
      ),
      /unsafe portable bindingId/u,
    );
    await assert.rejects(
      applyGlobalLibraryBinding(
        redigestPlan({
          ...plan,
          expectedConfigRevision: 7,
          configRevision: 8,
        }),
        "malformed-revision-transition",
      ),
      /locator revision transition/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("portable path guards reject Windows reserved names and case-fold collisions", async () => {
  for (const value of ["CON", "con.txt", "AUX.png", "LPT9", "NUL.json"]) {
    assert.throws(() => assertPortableSegment(value), /unsafe portable/u);
    assert.throws(() => assertPortableFilesystemSegment(value), /unsafe portable/u);
  }
  assert.throws(
    () => assertNoPortableCaseCollision(["Panel/Plot.R", "panel/plot.r"]),
    /case-fold collision/u,
  );

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-portable-path-"));
  try {
    const library = new VersionedTemplateLibrary(root);
    await assert.rejects(
      library.planCreateWorking({ templateId: "CON", candidate: visualCandidate("Reserved") }),
      /unsafe portable templateId/u,
    );
    await assert.rejects(
      library.planCreateWorking({
        templateId: "asset-path",
        candidate: {
          ...visualCandidate("Reserved asset"),
          primaryPreview: "CON.png",
          assets: [{ logicalPath: "CON.png", role: "visual", text: "reserved" }],
        },
      }),
      /unsafe portable revision asset path segment/u,
    );

    const lower = await library.planCreateWorking({
      templateId: "case-series",
      candidate: visualCandidate("Lower"),
    });
    await library.applyCreateWorking(lower, "create-case-series");
    await assert.rejects(
      library.planCreateWorking({
        templateId: "CASE-SERIES",
        candidate: visualCandidate("Upper"),
      }),
      /case-fold collision/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
