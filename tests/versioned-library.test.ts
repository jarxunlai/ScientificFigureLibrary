import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  VersionedTemplateLibrary,
  type VersionedTemplateCandidate,
} from "../src/versioned-library.ts";

function hash(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryLibrary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "versioned-figure-library-"));
  return { root, library: new VersionedTemplateLibrary(root) };
}

function plotCandidate(options: {
  title: string;
  preview?: string;
  code?: string;
  link?: boolean;
  captureId?: string;
}): VersionedTemplateCandidate {
  const preview = options.preview ?? "preview-v1";
  const code = options.code ?? "print('v1')\n";
  return {
    title: options.title,
    description: "An independently reusable Figure Unit.",
    tags: ["volcano", "publication"],
    visualProfile: "points with labelled extremes",
    dataProfile: "tabular x/y values",
    packages: ["ggplot2"],
    license: "Published scientific figure reference",
    assetKind: "plot_template",
    language: "R",
    plotFamily: "volcano",
    codeStatus: "scaffold",
    executionStatus: "not_run",
    primaryPreview: "preview.png",
    canonicalImplementation: { assetPath: "code/plot.R", selectedBy: "user" },
    ...(options.link
      ? {
          figureCodeLinks: [
            {
              visualAssetPath: "preview.png",
              codeAssetPaths: ["code/plot.R"],
              evidence: "The user confirmed this visual/code pairing in the annotation workbench.",
              confidence: 1,
            },
          ],
        }
      : {}),
    ...(options.captureId
      ? {
          captureBinding: {
            captureId: options.captureId,
            requiredAssetSha256: [hash(preview), hash(code)].sort(),
            selectionDigest: hash("selection"),
          },
        }
      : {}),
    provenance: {
      url: "https://mp.weixin.qq.com/s/example",
      capturedAt: "2026-08-05T00:00:00.000Z",
      ...(options.captureId ? { captureId: options.captureId } : {}),
    },
    assets: [
      { logicalPath: "preview.png", role: "visual", mediaType: "image/png", text: preview },
      { logicalPath: "code/plot.R", role: "code", language: "R", text: code },
    ],
  };
}

test("working revisions, gates, atomic publishing, history, diff, and exact materialization", async () => {
  const { root, library } = await temporaryLibrary();
  try {
    const create = await library.planCreateWorking({
      templateId: "volcano-series",
      candidate: plotCandidate({ title: "Volcano v1", link: true }),
      assessment: {
        blockingGates: [
          {
            gateId: "review-figure-code-pairing",
            code: "explicit_pairing_review_required",
            message: "The fixture requires an explicit human pairing review.",
            source: "agent",
          },
        ],
      },
    });
    assert.equal(create.action, "create_working");
    assert.match(create.planDigest, /^[a-f0-9]{64}$/u);
    assert.equal(create.review.validationErrors.length, 0);
    assert.deepEqual(
      create.review.blockingGates.map((gate) => gate.gateId),
      ["review-figure-code-pairing"],
    );

    const firstApply = await library.applyCreateWorking(create, "op-create-v1");
    assert.equal(firstApply.idempotentReplay, false);
    const replay = await library.applyCreateWorking(create, "op-create-v1");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.stateDigest, firstApply.stateDigest);
    await assert.rejects(
      library.planPublish({ templateId: "volcano-series" }),
      /blocking review gates/u,
    );

    const gates = await library.planGateUpdate({
      templateId: "volcano-series",
      decisions: [
        {
          gateId: "review-figure-code-pairing",
          decision: "resolved",
          note: "I reviewed and accept this pairing.",
        },
      ],
    });
    await library.applyGateUpdate(gates, "op-gates-v1");
    const publishV1 = await library.planPublish({ templateId: "volcano-series" });
    const publishedV1 = await library.applyPublish(publishV1, "op-publish-v1");
    assert.ok(publishedV1.releaseId);
    const firstReleaseId = publishedV1.releaseId!;
    const firstRevisionId = publishedV1.revisionId!;
    const firstDigest = publishedV1.contentDigest!;

    const initialCandidates = await library.listPublishedCandidates();
    assert.equal(initialCandidates.length, 1);
    assert.equal(initialCandidates[0]?.title, "Volcano v1");
    assert.equal(initialCandidates[0]?.executionStatus, "not_run");

    const staleA = await library.planCreateWorking({
      templateId: "volcano-series",
      candidate: plotCandidate({ title: "Volcano v2", preview: "preview-v2", code: "print('v2')\n", link: true }),
    });
    const staleB = await library.planCreateWorking({
      templateId: "volcano-series",
      candidate: plotCandidate({ title: "Competing v2", preview: "other", code: "print('other')\n", link: true }),
    });
    await library.applyCreateWorking(staleA, "op-create-v2");
    await assert.rejects(library.applyCreateWorking(staleB, "op-stale"), /stale lifecycle plan/u);
    await assert.rejects(library.applyCreateWorking(staleB, "op-create-v2"), /different plan/u);

    const whileEditing = await library.getSeries("volcano-series");
    assert.equal(whileEditing?.publishedHead?.revisionId, firstRevisionId);
    assert.equal((await library.listPublishedCandidates())[0]?.title, "Volcano v1");
    assert.notEqual(whileEditing?.workingHead?.revisionId, firstRevisionId);

    const revisionDiff = await library.diff(
      "volcano-series",
      firstRevisionId,
      staleA.content.revisionId,
    );
    assert.ok(revisionDiff.fieldChanges.some((change) => change.field === "title"));
    assert.deepEqual(revisionDiff.assets.changed.map((item) => item.logicalPath), ["code/plot.R", "preview.png"]);

    const publishV2 = await library.planPublish({ templateId: "volcano-series" });
    const publishedV2 = await library.applyPublish(publishV2, "op-publish-v2");
    assert.notEqual(publishedV2.releaseId, firstReleaseId);
    assert.equal((await library.listPublishedCandidates())[0]?.title, "Volcano v2");

    const historicalPreview = await library.getPreview("volcano-series", {
      revisionId: firstRevisionId,
      contentDigest: firstDigest,
    });
    assert.equal(Buffer.from(historicalPreview!.bytes).toString(), "preview-v1");
    await assert.rejects(
      library.getPreview("volcano-series", { revisionId: firstRevisionId }),
      /requires both revisionId and contentDigest/u,
    );

    const output = path.join(root, "materialized");
    const materialized = await library.materializeRevision({
      templateId: "volcano-series",
      revisionId: firstRevisionId,
      contentDigest: firstDigest,
      destination: output,
    });
    assert.equal(materialized.releaseId, firstReleaseId);
    assert.equal(
      await fs.readFile(path.join(materialized.target, "reference", "code", "plot.R"), "utf8"),
      "print('v1')\n",
    );
    assert.equal(
      (await fs.stat(path.join(materialized.target, "reference", "preview.png"))).mode & 0o222,
      0,
    );
    const lock = JSON.parse(
      await fs.readFile(path.join(materialized.target, "template.lock.json"), "utf8"),
    ) as { revisionId: string; contentDigest: string; executionStatus: string };
    assert.deepEqual(lock, { ...lock, revisionId: firstRevisionId, contentDigest: firstDigest, executionStatus: "not_run" });

    const restore = await library.planRestoreRelease({
      templateId: "volcano-series",
      releaseId: firstReleaseId,
    });
    await library.applyRestoreRelease(restore, "op-restore-v1");
    assert.equal((await library.listPublishedCandidates())[0]?.title, "Volcano v2");
    await assert.rejects(library.planPublish({ templateId: "volcano-series" }), /blocking review gates/u);
    const restoreGate = await library.planGateUpdate({
      templateId: "volcano-series",
      decisions: [
        {
          gateId: "review-restored-release",
          decision: "resolved",
          note: "I reviewed the restored historical content.",
        },
      ],
    });
    await library.applyGateUpdate(restoreGate, "op-restore-review");
    const republish = await library.planPublish({ templateId: "volcano-series" });
    assert.equal(republish.release.restoredFromReleaseId, firstReleaseId);
    await library.applyPublish(republish, "op-republish-v1");

    const history = await library.history("volcano-series");
    assert.equal(history.releases.length, 3);
    assert.ok(history.revisions.length >= 3);
    assert.equal(history.releases.at(-1)?.restoredFromReleaseId, firstReleaseId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("capture-bound snapshots write self-contained receipts and never claim execution", async () => {
  const { root, library } = await temporaryLibrary();
  try {
    const plan = await library.planCreateWorking({
      templateId: "capture-derived",
      candidate: plotCandidate({ title: "Captured Figure Unit", link: true, captureId: "capture-001" }),
    });
    const applied = await library.applyCreateWorking(plan, "op-capture-create");
    assert.match(applied.captureReceiptId ?? "", /^capture-receipt-/u);
    const receipts = await library.listCaptureReceipts("capture-001");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.selfContained, true);
    assert.deepEqual(receipts[0]?.requiredAssetSha256, plan.content.captureBinding?.requiredAssetSha256);
    assert.equal(receipts[0]?.assetInventory.length, 2);
    const content = await library.getContent("capture-derived", plan.content.revisionId);
    assert.equal(content?.executionStatus, "not_run");
    assert.equal(content?.codeStatus, "scaffold");
    const preview = plan.content.assets.find((asset) => asset.logicalPath === "preview.png");
    assert.ok(preview);
    const storedPreview = path.join(
      root,
      "store",
      "templates",
      "capture-derived",
      "revisions",
      plan.content.revisionId,
      preview.file,
    );
    await fs.chmod(storedPreview, 0o644);
    await fs.writeFile(storedPreview, "tampered-after-receipt");
    await assert.rejects(
      library.listCaptureReceipts("capture-001"),
      /asset (?:size|checksum) mismatch/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an orphan Release file is not Published or restorable until the Series head reaches it", async () => {
  const { root, library } = await temporaryLibrary();
  try {
    const first = await library.planCreateWorking({
      templateId: "orphan-release-series",
      candidate: plotCandidate({ title: "Reachable v1", link: true }),
    });
    await library.applyCreateWorking(first, "orphan-working-v1");
    const publishFirst = await library.planPublish({ templateId: "orphan-release-series" });
    await library.applyPublish(publishFirst, "orphan-publish-v1");

    const second = await library.planCreateWorking({
      templateId: "orphan-release-series",
      candidate: plotCandidate({
        title: "Unreachable v2",
        preview: "orphan-preview-v2",
        code: "print('orphan-v2')\n",
        link: true,
      }),
    });
    await library.applyCreateWorking(second, "orphan-working-v2");
    const orphanPlan = await library.planPublish({ templateId: "orphan-release-series" });
    const releaseFile = path.join(
      root,
      "store",
      "templates",
      "orphan-release-series",
      "releases",
      `${orphanPlan.release.releaseId}.json`,
    );
    await fs.writeFile(releaseFile, `${JSON.stringify(orphanPlan.release, null, 2)}\n`, { flag: "wx" });

    const history = await library.history("orphan-release-series");
    assert.deepEqual(history.releases.map((release) => release.releaseId), [
      publishFirst.release.releaseId,
    ]);
    await assert.rejects(
      library.getPreview("orphan-release-series", {
        revisionId: orphanPlan.release.revisionId,
        contentDigest: orphanPlan.release.contentDigest,
      }),
      /not a published release/u,
    );
    const discard = await library.planDiscardWorking({ templateId: "orphan-release-series" });
    await library.applyDiscardWorking(discard, "orphan-discard-v2");
    await assert.rejects(
      library.planRestoreRelease({
        templateId: "orphan-release-series",
        releaseId: orphanPlan.release.releaseId,
      }),
      /not reachable from Published Head/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("asset sources are re-hashed at apply time and stale bytes cannot be committed", async () => {
  const { root, library } = await temporaryLibrary();
  try {
    const source = path.join(root, "source.png");
    await fs.writeFile(source, "planned");
    const plan = await library.planCreateWorking({
      templateId: "changed-source",
      candidate: {
        title: "Changed source",
        assetKind: "visual_reference",
        codeStatus: "none",
        primaryPreview: "preview.png",
        assets: [{ logicalPath: "preview.png", role: "visual", sourcePath: source }],
      },
    });
    await fs.writeFile(source, "changed-after-plan");
    await assert.rejects(library.applyCreateWorking(plan, "op-changed-source"), /asset changed after planning/u);
    assert.equal(await library.getSeries("changed-source"), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("explicit legacy adoption is non-destructive and publishes approved content", async () => {
  const { root, library } = await temporaryLibrary();
  try {
    const directory = path.join(root, "templates", "legacy-volcano");
    const preview = new TextEncoder().encode("legacy-preview");
    const code = new TextEncoder().encode("plot(1:3)\n");
    await fs.mkdir(path.join(directory, "code"), { recursive: true });
    await fs.writeFile(path.join(directory, "preview.png"), preview);
    await fs.writeFile(path.join(directory, "code", "plot.R"), code);
    const legacy = {
      schema: "figure-library.template.v1",
      templateId: "legacy-volcano",
      sourceId: "user",
      title: "Legacy volcano",
      description: "A legacy approved template.",
      tags: ["legacy", "volcano"],
      visualProfile: "legacy visual profile",
      dataProfile: "legacy table",
      packages: ["graphics"],
      license: "Published scientific figure reference",
      importedAt: "2025-01-01T00:00:00.000Z",
      assetKind: "plot_template",
      language: "R",
      plotFamily: "volcano",
      reviewStatus: "approved",
      codeStatus: "reviewed",
      provenance: { url: "https://example.test/paper" },
      preview: { file: "preview.png", mediaType: "image/png", bytes: preview.byteLength, sha256: hash(preview) },
      code: [{ file: "code/plot.R", bytes: code.byteLength, sha256: hash(code) }],
      references: [],
    };
    const original = `${JSON.stringify(legacy, null, 2)}\n`;
    await fs.writeFile(path.join(directory, "template.json"), original);

    await assert.rejects(
      library.planAdoptLegacy({ templateId: "legacy-volcano" }),
      /requires canonicalImplementationAssetPath/u,
    );
    const plan = await library.planAdoptLegacy({
      templateId: "legacy-volcano",
      canonicalImplementationAssetPath: "code/plot.R",
    });
    assert.equal(plan.action, "adopt_legacy");
    const applied = await library.applyAdoptLegacy(plan, "op-adopt-legacy");
    assert.equal(applied.migrationId, plan.migrationId);
    assert.ok(applied.releaseId);
    assert.equal(await fs.readFile(path.join(directory, "template.json"), "utf8"), original);
    assert.equal(await fs.stat(path.join(root, "store", "templates", "legacy-volcano", "series.json")).then(() => true), true);
    assert.equal(await fs.readdir(directory).then((items) => items.includes("series.json")), false);
    assert.equal((await library.listPublishedCandidates())[0]?.title, "Legacy volcano");
    const adopted = await library.getContent("legacy-volcano", plan.legacy.content.revisionId);
    assert.equal(adopted?.executionStatus, "not_run");
    assert.equal(adopted?.canonicalImplementation?.assetPath, "code/plot.R");
    const receipt = JSON.parse(
      await fs.readFile(
        path.join(root, "store", "templates", "legacy-volcano", "receipts", "legacy", `${plan.migrationId}.json`),
        "utf8",
      ),
    ) as { nonDestructive: boolean; legacyManifestSha256: string };
    assert.equal(receipt.nonDestructive, true);
    assert.equal(receipt.legacyManifestSha256, hash(original));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
