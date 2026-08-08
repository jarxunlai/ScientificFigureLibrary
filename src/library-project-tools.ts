import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CatalogIndex } from "./catalog.ts";
import {
  applyLibraryWriteLockRecovery,
  planLibraryWriteLockRecovery,
  type LibraryWriteLockRecoveryPlanV1,
} from "./cross-runtime-lock.ts";
import {
  applyGlobalLibraryBinding,
  planGlobalLibraryBinding,
  type GlobalLibraryBindingPlanV1,
  type LibraryRuntime,
  type LibraryRuntimeSnapshot,
} from "./library-runtime.ts";
import { materializeFigureYaTemplate, type MaterializeMode } from "./materialize.ts";
import {
  ProjectTemplateLibrary,
  type ProjectTemplateResolvedRevision,
  type ProjectTemplateSelection,
  type ProjectTemplateSourceResolver,
  type ProjectUsePlan,
} from "./project-library.ts";
import type { FigureYaModule, UserTemplate } from "./types.ts";
import type { UserTemplateLibrary } from "./user-library.ts";
import type { VersionedTemplateLibrary } from "./versioned-library.ts";

const HASH = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface CurrentLibraryContext {
  snapshot: LibraryRuntimeSnapshot;
  userLibrary: UserTemplateLibrary;
  versionedLibrary: VersionedTemplateLibrary;
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("metadata contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") throw new Error("metadata is not JSON serializable");
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function errorResult(prefix: string, error: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
  };
}

function sourceLibraryId(snapshot: LibraryRuntimeSnapshot) {
  return snapshot.libraryId ?? `${snapshot.directorySource}-unbound`;
}

function sameNativePath(left: string, right: string) {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

function flatRevision(template: UserTemplate): ProjectTemplateResolvedRevision {
  return {
    templateId: template.templateId,
    revisionId: "flat-v1",
    contentDigest: sha256(canonicalJson(template)),
    publishedAt: template.updatedAt ?? template.importedAt,
  };
}

function figureYaRevision(
  index: CatalogIndex,
  module: FigureYaModule,
  mode: MaterializeMode,
): ProjectTemplateResolvedRevision {
  const revisionId = `figureya-${mode}-${index.catalog.compressed.commit.slice(0, 40)}`;
  return {
    templateId: module.moduleId,
    revisionId,
    contentDigest: sha256(
      canonicalJson({
        source: "figureya",
        mode,
        moduleId: module.moduleId,
        archiveBytes: module.archiveBytes ?? null,
        archiveGitBlobSha1: module.archiveGitBlobSha1 ?? null,
        sourceCommit: index.catalog.figureya.commit,
        archiveCommit: index.catalog.compressed.commit,
      }),
    ),
  };
}

async function moveMaterializedChild(
  parent: string,
  templateId: string,
  destination: string,
  materialize: () => Promise<unknown>,
) {
  try {
    await materialize();
    await fs.rename(path.join(parent, templateId), destination);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function createCombinedProjectResolver(options: {
  context: CurrentLibraryContext;
  index: CatalogIndex;
  mode?: MaterializeMode;
  sourcePackDir?: string;
  allowNetwork?: boolean;
}): Promise<ProjectTemplateSourceResolver> {
  const { context, index } = options;
  const defaultMode = options.mode ?? "template";

  async function versionedExact(selection: ProjectTemplateSelection) {
    try {
      const history = await context.versionedLibrary.history(selection.templateId);
      const release = history.releases.find(
        (item) =>
          item.revisionId === selection.revisionId &&
          item.contentDigest === selection.contentDigest,
      );
      return release
        ? {
            ...selection,
            releaseId: release.releaseId,
            publishedAt: release.publishedAt,
          }
        : undefined;
    } catch (error) {
      if (/unknown versioned template/iu.test(error instanceof Error ? error.message : String(error))) {
        return undefined;
      }
      throw error;
    }
  }

  async function exactSource(selection: ProjectTemplateSelection): Promise<{
    revision: ProjectTemplateResolvedRevision;
    kind: "versioned" | "flat" | "figureya";
    mode?: MaterializeMode;
  }> {
    const series = await context.versionedLibrary.getSeries(selection.templateId);
    if (series) {
      const revision = await versionedExact(selection);
      if (!revision) throw new Error("only an exact Published versioned revision can be pinned");
      return { revision, kind: "versioned" };
    }

    const flat = await context.userLibrary.get(selection.templateId);
    if (flat) {
      const revision = flatRevision(flat.template);
      if (
        revision.revisionId !== selection.revisionId ||
        revision.contentDigest !== selection.contentDigest
      ) {
        throw new Error("flat-v1 exact selector no longer matches the stored template");
      }
      if ((flat.template.reviewStatus ?? "approved") !== "approved") {
        throw new Error("only an approved flat-v1 template can be pinned");
      }
      return { revision, kind: "flat" };
    }

    const module = index.get(selection.templateId);
    if (!module?.archiveAvailable) throw new Error(`unknown materializable template: ${selection.templateId}`);
    for (const mode of ["template", "full"] as const) {
      const revision = figureYaRevision(index, module, mode);
      if (
        revision.revisionId === selection.revisionId &&
        revision.contentDigest === selection.contentDigest
      ) {
        return { revision, kind: "figureya", mode };
      }
    }
    throw new Error("FigureYa exact selector does not match the pinned catalog revision");
  }

  return {
    libraryId: sourceLibraryId(context.snapshot),
    async resolveExact(selection) {
      return (await exactSource(selection)).revision;
    },
    async resolvePublished(templateId, currentSelection) {
      const series = await context.versionedLibrary.getSeries(templateId);
      if (series?.publishedHead) {
        const release = await context.versionedLibrary.getRelease(
          templateId,
          series.publishedHead.releaseId,
        );
        if (!release) throw new Error("Published Head release is missing");
        return {
          templateId,
          revisionId: series.publishedHead.revisionId,
          contentDigest: series.publishedHead.contentDigest,
          releaseId: release.releaseId,
          publishedAt: release.publishedAt,
        };
      }
      if (series) return undefined;
      const flat = await context.userLibrary.get(templateId);
      if (flat) {
        return (flat.template.reviewStatus ?? "approved") === "approved"
          ? flatRevision(flat.template)
          : undefined;
      }
      const module = index.get(templateId);
      if (!module?.archiveAvailable) return undefined;
      const currentMode = currentSelection?.revisionId.startsWith("figureya-full-")
        ? "full"
        : currentSelection?.revisionId.startsWith("figureya-template-")
          ? "template"
          : defaultMode;
      return figureYaRevision(index, module, currentMode);
    },
    async materialize(revision, destination) {
      const selected = await exactSource(revision);
      const temporaryParent = `${destination}.source-${randomUUID()}`;
      if (selected.kind === "versioned") {
        await moveMaterializedChild(temporaryParent, revision.templateId, destination, async () => {
          await context.versionedLibrary.materializeRevision({
            templateId: revision.templateId,
            revisionId: revision.revisionId,
            contentDigest: revision.contentDigest,
            destination: temporaryParent,
          });
        });
        return;
      }
      if (selected.kind === "flat") {
        await moveMaterializedChild(temporaryParent, revision.templateId, destination, async () => {
          await context.userLibrary.materialize(revision.templateId, temporaryParent);
        });
        return;
      }
      const module = index.get(revision.templateId);
      if (!module) throw new Error(`unknown FigureYa module: ${revision.templateId}`);
      await moveMaterializedChild(temporaryParent, revision.templateId, destination, async () => {
        await materializeFigureYaTemplate({
          catalog: index.catalog,
          module,
          destination: temporaryParent,
          mode: selected.mode ?? defaultMode,
          sourcePackDir: options.sourcePackDir,
          allowNetwork: options.allowNetwork ?? true,
        });
      });
    },
  };
}

const BindingPlanInput = z.object({
  libraryDirectory: z.string().min(1).max(2_000),
  migrationMode: z.enum(["none", "copy_legacy"]).optional().default("none"),
  legacySourceDirectory: z
    .string()
    .min(1)
    .max(2_000)
    .optional()
    .describe(
      "Optional absolute native path to the unmarked legacy flat-template Library copied non-destructively when migrationMode is copy_legacy.",
    ),
});

const OpaquePlan = z.record(z.string(), z.unknown());
const ApplyPlanInput = z.object({
  plan: OpaquePlan,
  planDigest: z.string().regex(HASH),
  operationId: z.string().regex(OPERATION_ID),
});

const RecoveryPlanInput = z.object({
  reason: z.string().min(1).max(2_000),
});

const ProjectStatusInput = z.object({
  projectDirectory: z.string().min(1).max(2_000),
});

const ProjectUsePlanInput = z.object({
  projectDirectory: z.string().min(1).max(2_000),
  templateId: z.string().min(1).max(200),
  revisionId: z.string().min(1).max(200).optional(),
  contentDigest: z.string().regex(HASH).optional(),
  mode: z.enum(["template", "full"]).optional().default("template"),
  sourcePackDir: z.string().min(1).max(2_000).optional(),
  allowNetwork: z.boolean().optional().default(true),
});

const ProjectUseApplyInput = z.object({
  projectDirectory: z.string().min(1).max(2_000),
  plan: OpaquePlan,
  planDigest: z.string().regex(HASH),
  expectedAction: z.enum(["create", "activate", "update", "repair", "reuse"]),
  expectedProjectLockDigest: z.string().regex(HASH).nullable(),
  operationId: z.string().regex(OPERATION_ID),
  mode: z.enum(["template", "full"]).optional().default("template"),
  sourcePackDir: z.string().min(1).max(2_000).optional(),
  allowNetwork: z.boolean().optional().default(true),
});

function requireStableProjectLibrary(context: CurrentLibraryContext) {
  if (!context.snapshot.libraryId) {
    throw new Error(
      "library_not_bound: project template pinning requires a stable canonical libraryId; bind the global Library first",
    );
  }
}

async function inspectProjectWriteLock(lockDirectory: string) {
  const directory = path.resolve(lockDirectory);
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        format: "project-template-write-lock.v1" as const,
        directory,
        exists: false,
        ownerValid: false,
      };
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return {
      format: "project-template-write-lock.v1" as const,
      directory,
      exists: true,
      ownerValid: false,
      issue: "project write-lock path is not a regular directory",
    };
  }
  try {
    const value = JSON.parse(await fs.readFile(path.join(directory, "owner.json"), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("owner metadata is not an object");
    }
    const owner = value as Record<string, unknown>;
    if (
      typeof owner.operationId !== "string" ||
      !OPERATION_ID.test(owner.operationId) ||
      typeof owner.token !== "string" ||
      !owner.token ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.pid as number) <= 0 ||
      typeof owner.createdAt !== "string" ||
      Number.isNaN(Date.parse(owner.createdAt))
    ) {
      throw new Error("owner metadata is invalid");
    }
    return {
      format: "project-template-write-lock.v1" as const,
      directory,
      exists: true,
      ownerValid: true,
      owner: {
        operationId: owner.operationId,
        pid: owner.pid as number,
        createdAt: owner.createdAt,
      },
    };
  } catch (error) {
    return {
      format: "project-template-write-lock.v1" as const,
      directory,
      exists: true,
      ownerValid: false,
      issue: error instanceof Error ? error.message : String(error),
    };
  }
}

export function registerLibraryProjectTools(options: {
  server: McpServer;
  runtime: LibraryRuntime;
  currentLibraries: () => Promise<CurrentLibraryContext>;
  index: CatalogIndex;
}) {
  const { server, runtime, currentLibraries, index } = options;

  server.registerTool(
    "figure_library_plan_bind_global",
    {
      title: "Plan a global ScientificFigureLibrary binding",
      description:
        "Validate a user-supplied canonical Library directory and optional non-destructive legacy copy. Read-only; review the exact native path, libraryId, inventory, and warnings before Apply.",
      inputSchema: BindingPlanInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const current = await runtime.current();
        if (
          current.directorySource === "FIGURE_LIBRARY_DIR" &&
          !sameNativePath(input.libraryDirectory, current.root)
        ) {
          throw new Error(
            "binding_blocked_by_environment_override: FIGURE_LIBRARY_DIR takes precedence over the locator. To bind the current flat Library in place, plan with that same directory; to select a different directory, remove the override first",
          );
        }
        if (input.legacySourceDirectory && input.migrationMode !== "copy_legacy") {
          throw new Error("legacySourceDirectory requires migrationMode copy_legacy");
        }
        if (input.legacySourceDirectory && !path.isAbsolute(input.legacySourceDirectory)) {
          throw new Error("legacySourceDirectory must be an absolute trusted native path");
        }
        const plan = await planGlobalLibraryBinding(input);
        return {
          content: [{ type: "text", text: `No files were written. Planned global Library binding to ${plan.libraryDirectory}.` }],
          structuredContent: { plan },
        };
      } catch (error) {
        return errorResult("Global Library binding plan failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_apply_bind_global",
    {
      title: "Apply a confirmed global Library binding",
      description:
        "Apply the exact reviewed binding/migration plan with operation-id idempotency. The next tool call dynamically uses the new locator unless the same directory remains selected by the documented FIGURE_LIBRARY_DIR override.",
      inputSchema: ApplyPlanInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ plan, planDigest, operationId }): Promise<CallToolResult> => {
      try {
        const current = await runtime.current();
        if (
          typeof plan.locatorPath !== "string" ||
          !sameNativePath(plan.locatorPath, current.locatorPath)
        ) {
          throw new Error("binding plan locatorPath does not match this runtime's locator");
        }
        if (
          current.directorySource === "FIGURE_LIBRARY_DIR" &&
          (typeof plan.libraryDirectory !== "string" ||
            !sameNativePath(plan.libraryDirectory, current.root))
        ) {
          throw new Error(
            "binding_blocked_by_environment_override: FIGURE_LIBRARY_DIR takes precedence over the locator. Bind that same directory in place or remove the override before applying a different target",
          );
        }
        if (plan.planDigest !== planDigest) throw new Error("planDigest does not match the supplied binding plan");
        const result = await applyGlobalLibraryBinding(
          plan as unknown as GlobalLibraryBindingPlanV1,
          operationId,
        );
        const effective = await runtime.refresh();
        return {
          content: [{ type: "text", text: `${result.idempotentReplay ? "Replayed" : "Applied"} global Library binding ${result.libraryId}; effective source is ${effective.directorySource}.` }],
          structuredContent: {
            planDigest,
            result,
            effective: {
              libraryDirectory: effective.root,
              directorySource: effective.directorySource,
              libraryId: effective.libraryId,
              configRevision: effective.configRevision,
            },
          },
        };
      } catch (error) {
        return errorResult("Global Library binding Apply failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_plan_recover_write_lock",
    {
      title: "Plan abandoned global write-lock recovery",
      description:
        "Inspect and plan recovery of one exact global write lock. Before Apply, the user must confirm every Wisp/Codex/Claude writer for this Library is stopped. Never auto-steals a lock.",
      inputSchema: RecoveryPlanInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ reason }): Promise<CallToolResult> => {
      try {
        const context = await currentLibraries();
        if (!context.snapshot.libraryId) throw new Error("library_not_bound: no stable libraryId is available");
        const plan = await planLibraryWriteLockRecovery({
          libraryRoot: context.snapshot.root,
          libraryId: context.snapshot.libraryId,
          reason,
        });
        return {
          content: [{ type: "text", text: "No files were changed. Stop every writer and review the exact lock owner/digest before Apply." }],
          structuredContent: { plan },
        };
      } catch (error) {
        return errorResult("Write-lock recovery plan failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_apply_recover_write_lock",
    {
      title: "Apply confirmed global write-lock recovery",
      description:
        "Archive the exact unchanged abandoned lock and write a recovery receipt. Use only after the user confirms all writers are stopped.",
      inputSchema: ApplyPlanInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ plan, planDigest, operationId }): Promise<CallToolResult> => {
      try {
        const context = await currentLibraries();
        if (!context.snapshot.libraryId) {
          throw new Error("library_not_bound: no stable libraryId is available");
        }
        if (
          typeof plan.libraryRoot !== "string" ||
          !sameNativePath(plan.libraryRoot, context.snapshot.root) ||
          plan.libraryId !== context.snapshot.libraryId
        ) {
          throw new Error("write-lock recovery plan does not match the current canonical Library");
        }
        if (plan.planDigest !== planDigest) throw new Error("planDigest does not match the supplied recovery plan");
        const result = await applyLibraryWriteLockRecovery(
          plan as unknown as LibraryWriteLockRecoveryPlanV1,
          operationId,
        );
        return {
          content: [{ type: "text", text: `${result.idempotentReplay ? "Replayed" : "Applied"} write-lock recovery; the old lock was retained in the recovery archive.` }],
          structuredContent: { planDigest, result },
        };
      } catch (error) {
        return errorResult("Write-lock recovery Apply failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_project_status",
    {
      title: "Inspect exact templates pinned to a plotting project",
      description:
        "Verify project.lock.json and every materialized file hash, list active exact revisions, and report source mismatch or newer Published availability. Call this first in every plotting conversation.",
      inputSchema: ProjectStatusInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectDirectory }): Promise<CallToolResult> => {
      try {
        const context = await currentLibraries();
        const resolver = await createCombinedProjectResolver({ context, index, allowNetwork: false });
        const project = new ProjectTemplateLibrary(projectDirectory, resolver);
        const status = await project.status();
        const lock = await inspectProjectWriteLock(path.join(project.root, "locks", "write"));
        return {
          content: [{ type: "text", text: `${status.templates.length} project template pins; status ${status.status}.` }],
          structuredContent: { status, writeLock: lock },
        };
      } catch (error) {
        return errorResult("Project template status failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_plan_project_use",
    {
      title: "Plan an exact project template pin",
      description:
        "Resolve an exact Published/approved/FigureYa revision and plan create, activate, update, repair, or zero-write reuse. Review candidate preview and obtain user confirmation before planning a new or changed pin.",
      inputSchema: ProjectUsePlanInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> => {
      try {
        if (Boolean(input.revisionId) !== Boolean(input.contentDigest)) {
          throw new Error("revisionId and contentDigest must be supplied together");
        }
        const context = await currentLibraries();
        requireStableProjectLibrary(context);
        const resolver = await createCombinedProjectResolver({
          context,
          index,
          mode: input.mode,
          sourcePackDir: input.sourcePackDir,
          allowNetwork: input.allowNetwork,
        });
        const project = new ProjectTemplateLibrary(input.projectDirectory, resolver);
        const desired = input.revisionId && input.contentDigest
          ? { templateId: input.templateId, revisionId: input.revisionId, contentDigest: input.contentDigest }
          : await resolver.resolvePublished?.(input.templateId);
        if (!desired) throw new Error(`no current Published/approved template: ${input.templateId}`);
        const plan = await project.planUse(desired);
        return {
          content: [{ type: "text", text: `No files were written. Project action ${plan.action} for ${plan.desired.templateId}/${plan.desired.revisionId}.` }],
          structuredContent: { plan, projectRoot: project.root },
        };
      } catch (error) {
        return errorResult("Project template use plan failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_apply_project_use",
    {
      title: "Apply a confirmed exact project template pin",
      description:
        "Apply the supplied exact plan with project lock digest and operation-id idempotency. It never executes code, silently upgrades, overwrites a modified snapshot, or writes global absolute paths into project.lock.json.",
      inputSchema: ProjectUseApplyInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input): Promise<CallToolResult> => {
      try {
        if (input.plan.planDigest !== input.planDigest) throw new Error("planDigest does not match the supplied project plan");
        if (input.plan.action !== input.expectedAction) throw new Error("expectedAction does not match the project plan");
        if (input.plan.expectedProjectLockDigest !== input.expectedProjectLockDigest) {
          throw new Error("expectedProjectLockDigest does not match the project plan");
        }
        const context = await currentLibraries();
        requireStableProjectLibrary(context);
        const resolver = await createCombinedProjectResolver({
          context,
          index,
          mode: input.mode,
          sourcePackDir: input.sourcePackDir,
          allowNetwork: input.allowNetwork,
        });
        const project = new ProjectTemplateLibrary(input.projectDirectory, resolver);
        const result = await project.applyUse(input.plan as unknown as ProjectUsePlan, input.operationId);
        return {
          content: [{ type: "text", text: `${result.reused ? "Reused" : result.idempotentReplay ? "Replayed" : "Applied"} project template ${result.templateId}/${result.revisionId} at ${result.target}.` }],
          structuredContent: { planDigest: input.planDigest, result },
        };
      } catch (error) {
        return errorResult("Project template use Apply failed; do not retry automatically", error);
      }
    },
  );
}
