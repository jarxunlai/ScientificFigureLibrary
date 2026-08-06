import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  VersionedTemplateLibrary,
  type LifecycleFaultPoint,
  type VersionedTemplateCandidate,
} from "../src/versioned-library.ts";

function hash(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function visualCandidate(options: {
  title: string;
  marker: string;
  captureId?: string;
}): VersionedTemplateCandidate {
  const preview = `preview-${options.marker}`;
  return {
    title: options.title,
    assetKind: "visual_reference",
    codeStatus: "none",
    executionStatus: "not_run",
    primaryPreview: "preview.png",
    provenance: {
      url: "https://mp.weixin.qq.com/s/crash-recovery-fixture",
      ...(options.captureId ? { captureId: options.captureId } : {}),
    },
    ...(options.captureId
      ? {
          captureBinding: {
            captureId: options.captureId,
            requiredAssetSha256: [hash(preview)],
            selectionDigest: hash(`selection-${options.marker}`),
          },
        }
      : {}),
    assets: [
      {
        logicalPath: "preview.png",
        role: "visual",
        mediaType: "image/png",
        text: preview,
      },
    ],
  };
}

function oneShotFault(point: LifecycleFaultPoint, operationId: string) {
  let fired = false;
  return (candidate: LifecycleFaultPoint, context: { operationId: string }) => {
    if (!fired && candidate === point && context.operationId === operationId) {
      fired = true;
      throw new Error(`injected crash at ${point}`);
    }
  };
}

async function exitedChildPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  return pid;
}

test("a public publish recovers after the Series pointer moved but its receipt was not written", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lifecycle-publish-crash-"));
  try {
    const seed = new VersionedTemplateLibrary(root);
    const working = await seed.planCreateWorking({
      templateId: "publish-crash",
      candidate: visualCandidate({ title: "Publish crash", marker: "publish" }),
    });
    await seed.applyCreateWorking(working, "seed-publish-crash-working");
    const publish = await seed.planPublish({ templateId: "publish-crash" });
    const publicDigest = hash("exact-public-publish-plan");
    const operationId = "publish-pointer-before-receipt";
    const crashing = new VersionedTemplateLibrary(root, {
      faultInjector: oneShotFault("after_series_write", operationId),
    });
    await assert.rejects(
      crashing.applyPlan(publish, operationId, {
        kind: "publish",
        planDigest: publicDigest,
      }),
      /injected crash/u,
    );

    const postCrash = await seed.getSeries("publish-crash");
    assert.equal(postCrash?.publishedHead?.releaseId, publish.release.releaseId);
    assert.equal(postCrash?.workingHead, undefined);
    await assert.rejects(
      fs.access(path.join(root, "store", "operations", `${operationId}.json`)),
      /ENOENT/u,
    );
    assert.equal(
      await fs.access(path.join(root, "store", "operation-intents", `${operationId}.json`)).then(() => true),
      true,
    );

    // Model the lock directory left by a hard process exit. A new process may
    // remove it only after confirming that the recorded PID no longer exists.
    const deadPid = await exitedChildPid();
    const lock = path.join(root, ".write-lock");
    await fs.mkdir(lock);
    await fs.writeFile(
      path.join(lock, "owner.json"),
      `${JSON.stringify({ operation: "crashed", pid: deadPid, token: "dead-owner", createdAt: new Date().toISOString() })}\n`,
    );

    const restarted = new VersionedTemplateLibrary(root);
    const recovered = await restarted.replayPublicOperation({
      kind: "publish",
      planDigest: publicDigest,
      operationId,
      expectedTemplateId: "publish-crash",
      expectedSeriesDigest: publish.expectedSeriesDigest,
      expectedAction: "publish",
    });
    assert.equal(recovered?.idempotentReplay, true);
    assert.equal(recovered?.releaseId, publish.release.releaseId);
    await assert.rejects(fs.access(lock), /ENOENT/u);
    assert.equal(
      await fs.access(path.join(root, "store", "operations", `${operationId}.json`)).then(() => true),
      true,
    );

    await assert.rejects(
      restarted.replayPublicOperation({
        kind: "publish",
        planDigest: hash("different-public-plan"),
        operationId,
        expectedTemplateId: "publish-crash",
        expectedSeriesDigest: publish.expectedSeriesDigest,
      }),
      /different public plan/u,
    );
    await assert.rejects(
      restarted.replayPublicOperation({
        kind: "publish",
        planDigest: publicDigest,
        operationId,
        expectedTemplateId: "publish-crash",
        expectedSeriesDigest: null,
      }),
      /expectedSeriesDigest/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a public Working Apply replays across instances after durable intent but before its Series pointer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-public-working-intent-crash-"));
  try {
    const planning = new VersionedTemplateLibrary(root);
    const plan = await planning.planCreateWorking({
      templateId: "public-working-intent-crash",
      candidate: visualCandidate({
        title: "Public Working intent crash",
        marker: "public-working-intent",
        captureId: "capture-public-intent-001",
      }),
    });
    const operationId = "public-working-after-intent";
    const publicDigest = hash("public-working-after-intent-plan");
    const crashing = new VersionedTemplateLibrary(root, {
      faultInjector: oneShotFault("after_intent_write", operationId),
    });
    await assert.rejects(
      crashing.applyPlan(plan, operationId, { kind: "working", planDigest: publicDigest }),
      /injected crash/u,
    );
    assert.equal(await planning.getSeries("public-working-intent-crash"), undefined);
    assert.ok(await planning.getContent(plan.templateId, plan.content.revisionId, plan.content.contentDigest));
    assert.ok(await planning.getReview(plan.templateId, plan.review.reviewId));

    const restarted = new VersionedTemplateLibrary(root);
    await assert.rejects(
      restarted.replayPublicOperation({
        kind: "working",
        planDigest: hash("wrong-public-working-plan"),
        operationId,
        expectedTemplateId: plan.templateId,
        expectedSeriesDigest: null,
        expectedAction: "create_working",
      }),
      /different public plan/u,
    );
    await assert.rejects(
      restarted.replayPublicOperation({
        kind: "working",
        planDigest: publicDigest,
        operationId,
        expectedTemplateId: plan.templateId,
        expectedSeriesDigest: hash("wrong-expected-working-state"),
        expectedAction: "create_working",
      }),
      /expectedSeriesDigest/u,
    );
    const recovered = await restarted.replayPublicOperation({
      kind: "working",
      planDigest: publicDigest,
      operationId,
      expectedTemplateId: plan.templateId,
      expectedSeriesDigest: null,
      expectedAction: "create_working",
    });
    assert.equal(recovered?.idempotentReplay, true);
    assert.equal(recovered?.revisionId, plan.content.revisionId);
    assert.equal(
      (await restarted.getSeries(plan.templateId))?.workingHead?.revisionId,
      plan.content.revisionId,
    );
    assert.equal((await restarted.listCaptureReceipts("capture-public-intent-001")).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a public Publish Apply replays across instances after durable intent but before its Series pointer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-public-publish-intent-crash-"));
  try {
    const library = new VersionedTemplateLibrary(root);
    const working = await library.planCreateWorking({
      templateId: "public-publish-intent-crash",
      candidate: visualCandidate({ title: "Public Publish intent crash", marker: "publish-intent" }),
    });
    await library.applyCreateWorking(working, "seed-public-publish-intent");
    const publish = await library.planPublish({ templateId: "public-publish-intent-crash" });
    const operationId = "public-publish-after-intent";
    const publicDigest = hash("public-publish-after-intent-plan");
    const crashing = new VersionedTemplateLibrary(root, {
      faultInjector: oneShotFault("after_intent_write", operationId),
    });
    await assert.rejects(
      crashing.applyPlan(publish, operationId, { kind: "publish", planDigest: publicDigest }),
      /injected crash/u,
    );
    assert.ok((await library.getSeries(publish.templateId))?.workingHead);
    assert.ok(await library.getRelease(publish.templateId, publish.release.releaseId));

    const restarted = new VersionedTemplateLibrary(root);
    const recovered = await restarted.replayPublicOperation({
      kind: "publish",
      planDigest: publicDigest,
      operationId,
      expectedTemplateId: publish.templateId,
      expectedSeriesDigest: publish.expectedSeriesDigest,
      expectedAction: "publish",
    });
    assert.equal(recovered?.idempotentReplay, true);
    assert.equal(recovered?.releaseId, publish.release.releaseId);
    assert.equal((await restarted.getSeries(publish.templateId))?.workingHead, undefined);
    assert.equal(
      (await restarted.getSeries(publish.templateId))?.publishedHead?.releaseId,
      publish.release.releaseId,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an immutable Release written before its pointer can resume from the exact pre-state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lifecycle-release-crash-"));
  try {
    const seed = new VersionedTemplateLibrary(root);
    const working = await seed.planCreateWorking({
      templateId: "release-before-pointer",
      candidate: visualCandidate({ title: "Release before pointer", marker: "release" }),
    });
    await seed.applyCreateWorking(working, "seed-release-before-pointer");
    const publish = await seed.planPublish({ templateId: "release-before-pointer" });
    const operationId = "release-object-before-pointer";
    const crashing = new VersionedTemplateLibrary(root, {
      faultInjector: oneShotFault("after_immutable_objects", operationId),
    });
    await assert.rejects(crashing.applyPublish(publish, operationId), /injected crash/u);
    assert.ok((await seed.getSeries("release-before-pointer"))?.workingHead);
    assert.equal(
      await fs.access(
        path.join(
          root,
          "store",
          "templates",
          "release-before-pointer",
          "releases",
          `${publish.release.releaseId}.json`,
        ),
      ).then(() => true),
      true,
    );

    const restarted = new VersionedTemplateLibrary(root);
    const recovered = await restarted.applyPublish(publish, operationId);
    assert.equal(recovered.idempotentReplay, false);
    assert.equal(recovered.releaseId, publish.release.releaseId);
    assert.equal((await restarted.getSeries("release-before-pointer"))?.workingHead, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Working recovery backfills the exact Capture materialization receipt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lifecycle-capture-crash-"));
  try {
    const planning = new VersionedTemplateLibrary(root);
    const plan = await planning.planCreateWorking({
      templateId: "capture-receipt-crash",
      candidate: visualCandidate({
        title: "Capture receipt crash",
        marker: "capture",
        captureId: "capture-crash-001",
      }),
    });
    const competingPlan = await planning.planCreateWorking({
      templateId: "capture-receipt-crash",
      candidate: visualCandidate({ title: "Different plan", marker: "competing" }),
    });
    const operationId = "working-pointer-before-capture-receipt";
    const crashing = new VersionedTemplateLibrary(root, {
      faultInjector: oneShotFault("after_series_write", operationId),
    });
    await assert.rejects(crashing.applyCreateWorking(plan, operationId), /injected crash/u);
    assert.deepEqual(await planning.listCaptureReceipts("capture-crash-001"), []);

    const restarted = new VersionedTemplateLibrary(root);
    await assert.rejects(
      restarted.applyCreateWorking(competingPlan, operationId),
      /different plan or public binding/u,
    );
    const recovered = await restarted.applyCreateWorking(plan, operationId);
    assert.equal(recovered.idempotentReplay, true);
    assert.match(recovered.captureReceiptId ?? "", /^capture-receipt-/u);
    const receipts = await restarted.listCaptureReceipts("capture-crash-001");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.receiptId, recovered.captureReceiptId);
    assert.equal(receipts[0]?.contentDigest, plan.content.contentDigest);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("gate and discard pointer changes recover through the shared durable intent path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lifecycle-gate-discard-crash-"));
  try {
    const library = new VersionedTemplateLibrary(root);
    const working = await library.planCreateWorking({
      templateId: "gate-discard-crash",
      candidate: visualCandidate({ title: "Gate and discard crash", marker: "gate" }),
      assessment: {
        blockingGates: [
          {
            gateId: "human-review",
            code: "human_review_required",
            message: "Explicit fixture review is required.",
            source: "agent",
          },
        ],
      },
    });
    await library.applyCreateWorking(working, "seed-gate-discard-working");
    const gate = await library.planGateUpdate({
      templateId: "gate-discard-crash",
      decisions: [
        {
          gateId: "human-review",
          decision: "resolved",
          note: "Reviewed for the crash-recovery fixture.",
        },
      ],
    });
    const gateOperation = "gate-pointer-before-receipt";
    const gateCrash = new VersionedTemplateLibrary(root, {
      faultInjector: oneShotFault("after_series_write", gateOperation),
    });
    await assert.rejects(gateCrash.applyGateUpdate(gate, gateOperation), /injected crash/u);
    const gateRecovered = await new VersionedTemplateLibrary(root).applyGateUpdate(gate, gateOperation);
    assert.equal(gateRecovered.idempotentReplay, true);
    assert.equal(gateRecovered.reviewId, gate.review.reviewId);

    const discard = await library.planDiscardWorking({ templateId: "gate-discard-crash" });
    const discardOperation = "discard-pointer-before-receipt";
    const discardCrash = new VersionedTemplateLibrary(root, {
      faultInjector: oneShotFault("after_series_write", discardOperation),
    });
    await assert.rejects(
      discardCrash.applyDiscardWorking(discard, discardOperation),
      /injected crash/u,
    );
    const discardRecovered = await new VersionedTemplateLibrary(root).applyDiscardWorking(
      discard,
      discardOperation,
    );
    assert.equal(discardRecovered.idempotentReplay, true);
    assert.equal((await library.getSeries("gate-discard-crash"))?.workingHead, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy adoption recovery backfills the non-destructive migration receipt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lifecycle-adoption-crash-"));
  try {
    const directory = path.join(root, "templates", "legacy-adoption-crash");
    const preview = new TextEncoder().encode("legacy-adoption-crash-preview");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "preview.png"), preview);
    const legacy = {
      schema: "figure-library.template.v1",
      templateId: "legacy-adoption-crash",
      sourceId: "user",
      title: "Legacy adoption crash",
      description: "Crash recovery fixture.",
      tags: ["legacy"],
      visualProfile: "fixture",
      dataProfile: "fixture",
      packages: [],
      license: "Test fixture",
      importedAt: "2026-08-05T00:00:00.000Z",
      assetKind: "visual_reference",
      reviewStatus: "approved",
      codeStatus: "none",
      preview: {
        file: "preview.png",
        mediaType: "image/png",
        bytes: preview.byteLength,
        sha256: hash(preview),
      },
      code: [],
      references: [],
    };
    await fs.writeFile(path.join(directory, "template.json"), `${JSON.stringify(legacy, null, 2)}\n`);
    const planning = new VersionedTemplateLibrary(root);
    const plan = await planning.planAdoptLegacy({ templateId: "legacy-adoption-crash" });
    const operationId = "adoption-pointer-before-migration-receipt";
    const crashing = new VersionedTemplateLibrary(root, {
      faultInjector: oneShotFault("after_series_write", operationId),
    });
    await assert.rejects(crashing.applyAdoptLegacy(plan, operationId), /injected crash/u);
    const receiptFile = path.join(
      root,
      "store",
      "templates",
      "legacy-adoption-crash",
      "receipts",
      "legacy",
      `${plan.migrationId}.json`,
    );
    await assert.rejects(fs.access(receiptFile), /ENOENT/u);

    const restarted = new VersionedTemplateLibrary(root);
    const recovered = await restarted.applyAdoptLegacy(plan, operationId);
    assert.equal(recovered.idempotentReplay, true);
    assert.equal(recovered.migrationId, plan.migrationId);
    const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8")) as {
      migrationId: string;
      legacyManifestSha256: string;
      nonDestructive: boolean;
    };
    assert.equal(receipt.migrationId, plan.migrationId);
    assert.equal(receipt.legacyManifestSha256, plan.legacy.legacyManifestSha256);
    assert.equal(receipt.nonDestructive, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a public legacy adoption replays across instances after durable intent but before its Series pointer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-public-adoption-intent-crash-"));
  try {
    const templateId = "public-adoption-intent-crash";
    const directory = path.join(root, "templates", templateId);
    const preview = new TextEncoder().encode("public-adoption-intent-preview");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "preview.png"), preview);
    const legacy = {
      schema: "figure-library.template.v1",
      templateId,
      sourceId: "user",
      title: "Public adoption intent crash",
      description: "Public replay crash-recovery fixture.",
      tags: ["legacy", "public-replay"],
      visualProfile: "fixture",
      dataProfile: "fixture",
      packages: [],
      license: "Test fixture",
      importedAt: "2026-08-05T00:00:00.000Z",
      assetKind: "visual_reference",
      reviewStatus: "approved",
      codeStatus: "none",
      preview: {
        file: "preview.png",
        mediaType: "image/png",
        bytes: preview.byteLength,
        sha256: hash(preview),
      },
      code: [],
      references: [],
    };
    await fs.writeFile(path.join(directory, "template.json"), `${JSON.stringify(legacy, null, 2)}\n`);

    const planning = new VersionedTemplateLibrary(root);
    const plan = await planning.planAdoptLegacy({ templateId });
    const operationId = "public-adoption-after-intent";
    const publicDigest = hash("public-adoption-after-intent-plan");
    const crashing = new VersionedTemplateLibrary(root, {
      faultInjector: oneShotFault("after_intent_write", operationId),
    });
    await assert.rejects(
      crashing.applyPlan(plan, operationId, { kind: "adopt", planDigest: publicDigest }),
      /injected crash/u,
    );
    assert.equal(await planning.getSeries(templateId), undefined);
    assert.ok(await planning.getContent(templateId, plan.legacy.content.revisionId));
    assert.ok(await planning.getReview(templateId, plan.legacy.review.reviewId));
    assert.ok(plan.legacy.release);
    assert.ok(await planning.getRelease(templateId, plan.legacy.release.releaseId));

    const receiptFile = path.join(
      root,
      "store",
      "templates",
      templateId,
      "receipts",
      "legacy",
      `${plan.migrationId}.json`,
    );
    await assert.rejects(fs.access(receiptFile), /ENOENT/u);

    const restarted = new VersionedTemplateLibrary(root);
    const recovered = await restarted.replayPublicOperation({
      kind: "adopt",
      planDigest: publicDigest,
      operationId,
      expectedTemplateId: templateId,
      expectedSeriesDigest: null,
      expectedAction: "adopt_legacy",
    });
    assert.equal(recovered?.idempotentReplay, true);
    assert.equal(recovered?.migrationId, plan.migrationId);
    assert.equal(recovered?.releaseId, plan.legacy.release.releaseId);
    assert.equal(
      (await restarted.getSeries(templateId))?.publishedHead?.releaseId,
      plan.legacy.release.releaseId,
    );
    const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8")) as {
      migrationId: string;
      nonDestructive: boolean;
    };
    assert.equal(receipt.migrationId, plan.migrationId);
    assert.equal(receipt.nonDestructive, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("every selected code asset requires an evidence-backed Figure/code link", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-code-evidence-coverage-"));
  try {
    const library = new VersionedTemplateLibrary(root);
    const plan = await library.planCreateWorking({
      templateId: "code-evidence-coverage",
      candidate: {
        title: "Code evidence coverage",
        assetKind: "plot_template",
        language: "R",
        codeStatus: "scaffold",
        executionStatus: "not_run",
        primaryPreview: "preview.png",
        canonicalImplementation: { assetPath: "code/canonical.R", selectedBy: "user" },
        figureCodeLinks: [
          {
            visualAssetPath: "preview.png",
            codeAssetPaths: ["code/canonical.R"],
            evidence: "The user linked the canonical implementation to this Figure.",
          },
        ],
        assets: [
          { logicalPath: "preview.png", role: "visual", text: "preview" },
          { logicalPath: "code/canonical.R", role: "code", language: "R", text: "plot(1)\n" },
          { logicalPath: "code/unlinked.R", role: "code", language: "R", text: "plot(2)\n" },
        ],
      },
    });
    assert.ok(plan.review.validationErrors.some((item) => item.code === "unlinked_code_asset"));
    await library.applyCreateWorking(plan, "apply-unlinked-code-working");
    await assert.rejects(
      library.planPublish({ templateId: "code-evidence-coverage" }),
      /validation errors.*unlinked_code_asset/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a live or corrupt write lock is never removed automatically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-live-write-lock-"));
  try {
    const library = new VersionedTemplateLibrary(root);
    const plan = await library.planCreateWorking({
      templateId: "locked-series",
      candidate: visualCandidate({ title: "Locked series", marker: "lock" }),
    });
    const lock = path.join(root, ".write-lock");
    await fs.mkdir(lock);
    await fs.writeFile(
      path.join(lock, "owner.json"),
      `${JSON.stringify({ operation: "live-writer", pid: process.pid, token: "live-owner", createdAt: new Date().toISOString() })}\n`,
    );
    await assert.rejects(library.applyCreateWorking(plan, "blocked-by-live-writer"), /live writer/u);
    assert.equal(await fs.access(lock).then(() => true), true);

    await fs.rm(lock, { recursive: true, force: true });
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, "owner.json"), "{\"pid\":\"not-an-integer\"}\n");
    await assert.rejects(
      library.applyCreateWorking(plan, "blocked-by-corrupt-lock"),
      /manual recovery required/u,
    );
    assert.equal(await fs.access(lock).then(() => true), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
