import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CrossRuntimeWriteLock,
  LIBRARY_WRITE_LOCK_HEARTBEAT_SCHEMA,
  LIBRARY_WRITE_LOCK_OWNER_SCHEMA,
  LibraryWriteLockedError,
  applyLibraryWriteLockRecovery,
  inspectLibraryWriteLock,
  planLibraryWriteLockRecovery,
} from "../src/cross-runtime-lock.ts";
import { ensureLibraryRootMarker } from "../src/library-runtime.ts";
import { UserTemplateLibrary } from "../src/user-library.ts";
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

function visualCandidate(): VersionedTemplateCandidate {
  return {
    title: "Lock fixture",
    assetKind: "visual_reference",
    codeStatus: "none",
    executionStatus: "not_run",
    primaryPreview: "preview.png",
    assets: [{ logicalPath: "preview.png", role: "visual", text: "lock" }],
  };
}

test("cross-runtime lock heartbeats and competing writers fail fast without PID stealing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-cross-runtime-lock-"));
  try {
    const marker = await ensureLibraryRootMarker(root);
    const first = new CrossRuntimeWriteLock({
      root,
      libraryId: marker.value.libraryId,
      operation: "first-writer",
      heartbeatIntervalMs: 15,
    });
    await first.acquire();
    try {
      await new Promise((resolve) => setTimeout(resolve, 55));
      const snapshot = await inspectLibraryWriteLock(path.join(root, ".write-lock"));
      assert.equal(snapshot.ownerValid, true);
      assert.equal(snapshot.heartbeatValid, true);
      assert.ok((snapshot.heartbeat?.sequence ?? 0) >= 2);
      await assert.rejects(
        new CrossRuntimeWriteLock({
          root,
          libraryId: marker.value.libraryId,
          operation: "competing-writer",
        }).acquire(),
        (error: unknown) =>
          error instanceof LibraryWriteLockedError && error.code === "library_busy",
      );
      assert.equal((await inspectLibraryWriteLock(path.join(root, ".write-lock"))).exists, true);
    } finally {
      await first.release();
    }
    assert.equal((await inspectLibraryWriteLock(path.join(root, ".write-lock"))).exists, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an abandoned lock is never inferred from PID and requires plan/apply recovery with archive and receipt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lock-recovery-"));
  try {
    const marker = await ensureLibraryRootMarker(root);
    const lockDirectory = path.join(root, ".write-lock");
    await fs.mkdir(lockDirectory);
    const lockId = "00000000-0000-4000-8000-000000000001";
    await fs.writeFile(
      path.join(lockDirectory, "owner.json"),
      `${JSON.stringify({
        schema: LIBRARY_WRITE_LOCK_OWNER_SCHEMA,
        lockId,
        libraryId: marker.value.libraryId,
        operation: "abandoned-windows-writer",
        hostname: "other-runtime",
        platform: "win32",
        runtime: "node",
        processId: 2147483647,
        createdAt: "2026-08-01T00:00:00.000Z",
        heartbeatIntervalMs: 5000,
      }, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(lockDirectory, "heartbeat.json"),
      `${JSON.stringify({
        schema: LIBRARY_WRITE_LOCK_HEARTBEAT_SCHEMA,
        lockId,
        sequence: 7,
        updatedAt: "2026-08-01T00:00:05.000Z",
      }, null, 2)}\n`,
    );

    await assert.rejects(
      new CrossRuntimeWriteLock({
        root,
        libraryId: marker.value.libraryId,
        operation: "must-not-probe-pid",
      }).acquire(),
      (error: unknown) =>
        error instanceof LibraryWriteLockedError &&
        error.snapshot.owner?.platform === "win32" &&
        error.snapshot.owner?.processId === 2147483647,
    );
    assert.equal((await inspectLibraryWriteLock(lockDirectory)).exists, true);

    const plan = await planLibraryWriteLockRecovery({
      libraryRoot: root,
      libraryId: marker.value.libraryId,
      reason: "The user verified that the other runtime has stopped.",
    });
    assert.equal(plan.ownerValid, true);
    assert.equal(plan.heartbeatValid, true);
    const applied = await applyLibraryWriteLockRecovery(plan, "recover-abandoned-lock");
    assert.equal(applied.idempotentReplay, false);
    assert.equal((await inspectLibraryWriteLock(lockDirectory)).exists, false);
    assert.equal((await inspectLibraryWriteLock(applied.archiveDirectory)).digest, plan.expectedLockDigest);
    assert.equal((await fs.stat(applied.archiveDirectory)).isDirectory(), true);
    const replay = await applyLibraryWriteLockRecovery(plan, "recover-abandoned-lock");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.receiptId, applied.receiptId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recovery refuses a lock whose heartbeat or contents changed after planning", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lock-stale-recovery-"));
  try {
    const marker = await ensureLibraryRootMarker(root);
    const lockDirectory = path.join(root, ".write-lock");
    await fs.mkdir(lockDirectory);
    await fs.writeFile(path.join(lockDirectory, "owner.json"), "corrupt owner\n");
    const plan = await planLibraryWriteLockRecovery({
      libraryRoot: root,
      libraryId: marker.value.libraryId,
      reason: "Explicitly recover a corrupt abandoned lock.",
    });
    assert.equal(plan.ownerValid, false);
    await fs.writeFile(path.join(lockDirectory, "heartbeat.json"), "changed\n");
    await assert.rejects(
      applyLibraryWriteLockRecovery(plan, "stale-recovery"),
      /stale write-lock recovery plan/u,
    );
    assert.equal((await inspectLibraryWriteLock(lockDirectory)).exists, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recovery Apply rejects redigested malformed plan identity and observations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lock-plan-validation-"));
  try {
    const marker = await ensureLibraryRootMarker(root);
    const lockDirectory = path.join(root, ".write-lock");
    await fs.mkdir(lockDirectory);
    await fs.writeFile(path.join(lockDirectory, "owner.json"), "corrupt owner\n");
    const plan = await planLibraryWriteLockRecovery({
      libraryRoot: root,
      libraryId: marker.value.libraryId,
      reason: "The user confirmed this corrupt lock is abandoned.",
    });
    await assert.rejects(
      applyLibraryWriteLockRecovery(
        redigestPlan({ ...plan, recoveryId: "../escape" }),
        "malformed-recovery-id",
      ),
      /unsafe operationId/u,
    );
    await assert.rejects(
      applyLibraryWriteLockRecovery(
        redigestPlan({ ...plan, ownerValid: true }),
        "malformed-recovery-observation",
      ),
      /invalid write-lock recovery observation metadata/u,
    );
    assert.equal((await inspectLibraryWriteLock(lockDirectory)).exists, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("flat imports and versioned lifecycle writes share the same root lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-unified-write-lock-"));
  try {
    const marker = await ensureLibraryRootMarker(root);
    const versioned = new VersionedTemplateLibrary(root);
    const user = new UserTemplateLibrary(root);
    const lifecycle = await versioned.planCreateWorking({
      templateId: "unified-lock-series",
      candidate: visualCandidate(),
    });
    const codePath = path.join(root, "fixture.R");
    await fs.writeFile(codePath, "plot(1)\n");
    const held = new CrossRuntimeWriteLock({
      root,
      libraryId: marker.value.libraryId,
      operation: "external-runtime",
    });
    await held.acquire();
    try {
      await assert.rejects(
        versioned.applyCreateWorking(lifecycle, "blocked-versioned"),
        (error: unknown) => error instanceof LibraryWriteLockedError,
      );
      await assert.rejects(
        user.importTemplate({ title: "Blocked flat import", codePaths: [codePath] }),
        (error: unknown) => error instanceof LibraryWriteLockedError,
      );
    } finally {
      await held.release();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
