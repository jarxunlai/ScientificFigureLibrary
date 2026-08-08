import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  VersionedTemplateLibrary,
  type RevisionMaterializationResult,
} from "./versioned-library.ts";

export const PROJECT_TEMPLATE_LOCK_SCHEMA = "figure-library.project-lock.v1" as const;
export const PROJECT_USE_PLAN_SCHEMA = "figure-library.project-use-plan.v1" as const;
export const PROJECT_USE_RECEIPT_SCHEMA = "figure-library.project-use-receipt.v1" as const;

const HASH = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const MAX_SNAPSHOT_FILES = 20_000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;

export type ProjectUseAction = "create" | "activate" | "update" | "repair" | "reuse";
export type ProjectSnapshotIntegrity = "ready" | "missing" | "modified";
export type ProjectLibraryState =
  | "ready"
  | "missing"
  | "modified"
  | "source_library_mismatch";

export interface ProjectTemplateSelection {
  templateId: string;
  revisionId: string;
  contentDigest: string;
}

export interface ProjectTemplateResolvedRevision extends ProjectTemplateSelection {
  releaseId?: string;
  publishedAt?: string;
}

/**
 * Host/server supplied access to the canonical published source. Implementations
 * must materialize the exact resolved revision into `destination` without
 * executing template code. `destination` does not exist when called.
 */
export interface ProjectTemplateSourceResolver {
  /** Stable, opaque identity from the canonical library root marker. Never a path. */
  readonly libraryId: string;
  resolveExact(
    selection: ProjectTemplateSelection,
  ): Promise<ProjectTemplateResolvedRevision>;
  resolvePublished?(
    templateId: string,
    currentSelection?: ProjectTemplateSelection,
  ): Promise<ProjectTemplateResolvedRevision | undefined>;
  materialize(
    revision: ProjectTemplateResolvedRevision,
    destination: string,
  ): Promise<void>;
}

export interface ProjectSnapshotFileV1 {
  file: string;
  bytes: number;
  sha256: string;
}

export interface ProjectTemplateSnapshotV1 extends ProjectTemplateResolvedRevision {
  snapshotKey: string;
  materializedAt: string;
  files: ProjectSnapshotFileV1[];
  inventoryDigest: string;
}

export interface ProjectTemplatePinV1 {
  templateId: string;
  active: ProjectTemplateSelection;
  snapshots: ProjectTemplateSnapshotV1[];
}

export interface ProjectTemplateLockV1 {
  schema: typeof PROJECT_TEMPLATE_LOCK_SCHEMA;
  sourceLibraryId: string;
  createdAt: string;
  updatedAt: string;
  templates: ProjectTemplatePinV1[];
  lastOperation?: {
    operationId: string;
    planDigest: string;
    action: Exclude<ProjectUseAction, "reuse">;
    templateId: string;
    snapshotKey: string;
    appliedAt: string;
  };
  projectLockDigest: string;
}

export interface ProjectSnapshotStatus {
  revisionId: string;
  contentDigest: string;
  snapshotKey: string;
  active: boolean;
  integrity: ProjectSnapshotIntegrity;
  inventoryDigest: string;
  observedInventoryDigest?: string;
  issues: string[];
}

export interface ProjectTemplateStatus {
  templateId: string;
  status: ProjectLibraryState;
  active: ProjectTemplateSelection;
  snapshots: ProjectSnapshotStatus[];
  updateAvailable: boolean | null;
  available?: ProjectTemplateResolvedRevision;
  updateCheckError?: string;
}

export interface ProjectLibraryStatus {
  projectDirectory: string;
  root: string;
  status: ProjectLibraryState;
  projectLockDigest: string | null;
  sourceLibraryId: string | null;
  currentSourceLibraryId: string;
  sourceLibraryMismatch: boolean;
  templates: ProjectTemplateStatus[];
  issues: string[];
}

export interface ProjectUsePlan {
  schema: typeof PROJECT_USE_PLAN_SCHEMA;
  action: ProjectUseAction;
  projectDirectoryDigest: string;
  sourceLibraryId: string;
  desired: ProjectTemplateResolvedRevision;
  snapshotKey: string;
  expectedProjectLockDigest: string | null;
  expectedSnapshotIntegrity: ProjectSnapshotIntegrity | "absent";
  createdAt: string;
  planDigest: string;
}

export interface ProjectUseApplyResult extends ProjectTemplateResolvedRevision {
  operationId: string;
  action: ProjectUseAction;
  snapshotKey: string;
  target: string;
  projectLockDigest: string | null;
  reused: boolean;
  idempotentReplay: boolean;
  appliedAt: string;
}

interface StoredApplyResult extends ProjectTemplateResolvedRevision {
  operationId: string;
  action: Exclude<ProjectUseAction, "reuse">;
  snapshotKey: string;
  projectLockDigest: string;
  appliedAt: string;
}

interface ProjectUseReceiptV1 {
  schema: typeof PROJECT_USE_RECEIPT_SCHEMA;
  operationId: string;
  planDigest: string;
  result: StoredApplyResult;
}

interface InventoryResult {
  files: ProjectSnapshotFileV1[];
  inventoryDigest: string;
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON values must contain finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!value || typeof value !== "object") throw new Error("value is not JSON serializable");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("value is not a plain JSON object");
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withoutDigest<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete (copy as Partial<T>)[key];
  return copy as Omit<T, K>;
}

function assertWindowsSafeId(value: string, label: string) {
  if (
    !SAFE_ID.test(value) ||
    value === "." ||
    value === ".." ||
    value.endsWith(".") ||
    value.endsWith(" ") ||
    WINDOWS_RESERVED.test(value)
  ) {
    throw new Error(`unsafe Windows ${label}: ${value}`);
  }
  return value;
}

function assertLibraryId(value: string) {
  return assertWindowsSafeId(value, "libraryId");
}

function assertHash(value: string, label: string) {
  if (!HASH.test(value)) throw new Error(`invalid ${label}: ${value}`);
  return value;
}

function assertIsoDate(value: string, label: string) {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(`invalid ${label}: ${value}`);
  return value;
}

function validateRelativeFile(value: string) {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error(`unsafe snapshot file: ${value}`);
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      /[<>:"|?*]/u.test(segment) ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      WINDOWS_RESERVED.test(segment)
    ) {
      throw new Error(`unsafe Windows snapshot file: ${value}`);
    }
  }
  return segments.join("/");
}

function validateSelection(value: unknown, label = "selection"): ProjectTemplateSelection {
  if (!isRecord(value)) throw new Error(`invalid ${label}`);
  return {
    templateId: assertWindowsSafeId(String(value.templateId ?? ""), "templateId"),
    revisionId: assertWindowsSafeId(String(value.revisionId ?? ""), "revisionId"),
    contentDigest: assertHash(String(value.contentDigest ?? ""), "contentDigest"),
  };
}

function validateResolvedRevision(
  value: unknown,
  label = "resolved revision",
): ProjectTemplateResolvedRevision {
  const selection = validateSelection(value, label);
  const record = value as Record<string, unknown>;
  const releaseId = record.releaseId;
  const publishedAt = record.publishedAt;
  if (releaseId !== undefined && typeof releaseId !== "string") {
    throw new Error(`invalid ${label} releaseId`);
  }
  if (publishedAt !== undefined && typeof publishedAt !== "string") {
    throw new Error(`invalid ${label} publishedAt`);
  }
  return {
    ...selection,
    ...(releaseId ? { releaseId: assertWindowsSafeId(releaseId, "releaseId") } : {}),
    ...(publishedAt ? { publishedAt: assertIsoDate(publishedAt, "publishedAt") } : {}),
  };
}

function sameSelection(left: ProjectTemplateSelection, right: ProjectTemplateSelection) {
  return (
    left.templateId === right.templateId &&
    left.revisionId === right.revisionId &&
    left.contentDigest === right.contentDigest
  );
}

function snapshotKey(selection: ProjectTemplateSelection) {
  return `revision-${sha256(
    `${selection.templateId}\0${selection.revisionId}\0${selection.contentDigest}`,
  ).slice(0, 32)}`;
}

function inventoryDigest(files: ProjectSnapshotFileV1[]) {
  return sha256(canonicalJson(files));
}

function projectLockDigest(lock: Omit<ProjectTemplateLockV1, "projectLockDigest"> | ProjectTemplateLockV1) {
  return sha256(
    canonicalJson(withoutDigest(lock as ProjectTemplateLockV1, "projectLockDigest")),
  );
}

function planDigest(plan: Omit<ProjectUsePlan, "planDigest"> | ProjectUsePlan) {
  return sha256(canonicalJson(withoutDigest(plan as ProjectUsePlan, "planDigest")));
}

function sortLockTemplates(templates: ProjectTemplatePinV1[]) {
  return [...templates]
    .map((pin) => ({
      ...pin,
      snapshots: [...pin.snapshots].sort(
        (left, right) =>
          left.materializedAt.localeCompare(right.materializedAt) ||
          left.snapshotKey.localeCompare(right.snapshotKey),
      ),
    }))
    .sort((left, right) => left.templateId.localeCompare(right.templateId));
}

function validateSnapshot(value: unknown, templateId: string): ProjectTemplateSnapshotV1 {
  const revision = validateResolvedRevision(value, "project snapshot");
  if (revision.templateId !== templateId) throw new Error("project snapshot templateId mismatch");
  const record = value as Record<string, unknown>;
  const key = String(record.snapshotKey ?? "");
  if (key !== snapshotKey(revision)) throw new Error(`project snapshot key mismatch: ${key}`);
  if (!Array.isArray(record.files)) throw new Error("project snapshot files must be an array");
  if (record.files.length > MAX_SNAPSHOT_FILES) throw new Error("project snapshot contains too many files");
  const files = record.files.map((item): ProjectSnapshotFileV1 => {
    if (!isRecord(item)) throw new Error("invalid project snapshot file");
    const bytes = Number(item.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("invalid snapshot file size");
    return {
      file: validateRelativeFile(String(item.file ?? "")),
      bytes,
      sha256: assertHash(String(item.sha256 ?? ""), "snapshot file sha256"),
    };
  });
  files.sort((left, right) => left.file.localeCompare(right.file));
  if (new Set(files.map((item) => item.file.toLocaleLowerCase("en-US"))).size !== files.length) {
    throw new Error("project snapshot contains duplicate or case-colliding files");
  }
  const expectedInventoryDigest = inventoryDigest(files);
  if (record.inventoryDigest !== expectedInventoryDigest) {
    throw new Error(`project snapshot inventory digest mismatch: ${key}`);
  }
  return {
    ...revision,
    snapshotKey: key,
    materializedAt: assertIsoDate(String(record.materializedAt ?? ""), "materializedAt"),
    files,
    inventoryDigest: expectedInventoryDigest,
  };
}

function validateProjectLock(value: unknown): ProjectTemplateLockV1 {
  if (!isRecord(value) || value.schema !== PROJECT_TEMPLATE_LOCK_SCHEMA) {
    throw new Error("invalid project template lock schema");
  }
  const storedRawDigest = assertHash(
    String(value.projectLockDigest ?? ""),
    "projectLockDigest",
  );
  if (
    projectLockDigest(value as unknown as ProjectTemplateLockV1) !==
    storedRawDigest
  ) {
    throw new Error("project lock digest mismatch");
  }
  if (!Array.isArray(value.templates)) throw new Error("project lock templates must be an array");
  const templates = value.templates.map((item): ProjectTemplatePinV1 => {
    if (!isRecord(item)) throw new Error("invalid project template pin");
    const templateId = assertWindowsSafeId(String(item.templateId ?? ""), "templateId");
    const active = validateSelection(item.active, "active project selection");
    if (active.templateId !== templateId) throw new Error("active project templateId mismatch");
    if (!Array.isArray(item.snapshots) || item.snapshots.length === 0) {
      throw new Error(`project template pin has no snapshots: ${templateId}`);
    }
    const snapshots = item.snapshots.map((snapshot) => validateSnapshot(snapshot, templateId));
    if (new Set(snapshots.map((snapshot) => snapshot.snapshotKey)).size !== snapshots.length) {
      throw new Error(`duplicate project snapshots: ${templateId}`);
    }
    if (!snapshots.some((snapshot) => sameSelection(snapshot, active))) {
      throw new Error(`active project snapshot is missing: ${templateId}`);
    }
    return { templateId, active, snapshots };
  });
  if (new Set(templates.map((item) => item.templateId.toLocaleLowerCase("en-US"))).size !== templates.length) {
    throw new Error("project template IDs collide on Windows");
  }
  let lastOperation: ProjectTemplateLockV1["lastOperation"];
  if (value.lastOperation !== undefined) {
    if (!isRecord(value.lastOperation)) throw new Error("invalid project lastOperation");
    const action = String(value.lastOperation.action ?? "");
    if (!["create", "activate", "update", "repair"].includes(action)) {
      throw new Error("invalid project lastOperation action");
    }
    lastOperation = {
      operationId: assertWindowsSafeId(
        String(value.lastOperation.operationId ?? ""),
        "operationId",
      ),
      planDigest: assertHash(String(value.lastOperation.planDigest ?? ""), "planDigest"),
      action: action as Exclude<ProjectUseAction, "reuse">,
      templateId: assertWindowsSafeId(
        String(value.lastOperation.templateId ?? ""),
        "templateId",
      ),
      snapshotKey: assertWindowsSafeId(
        String(value.lastOperation.snapshotKey ?? ""),
        "snapshotKey",
      ),
      appliedAt: assertIsoDate(String(value.lastOperation.appliedAt ?? ""), "appliedAt"),
    };
  }
  const lock: ProjectTemplateLockV1 = {
    schema: PROJECT_TEMPLATE_LOCK_SCHEMA,
    sourceLibraryId: assertLibraryId(String(value.sourceLibraryId ?? "")),
    createdAt: assertIsoDate(String(value.createdAt ?? ""), "createdAt"),
    updatedAt: assertIsoDate(String(value.updatedAt ?? ""), "updatedAt"),
    templates: sortLockTemplates(templates),
    ...(lastOperation ? { lastOperation } : {}),
    projectLockDigest: storedRawDigest,
  };
  if (projectLockDigest(lock) !== lock.projectLockDigest) {
    throw new Error("project lock digest mismatch");
  }
  return lock;
}

function validatePlan(value: ProjectUsePlan): ProjectUsePlan {
  if (!isRecord(value) || value.schema !== PROJECT_USE_PLAN_SCHEMA) {
    throw new Error("invalid project use plan schema");
  }
  const storedRawDigest = assertHash(String(value.planDigest ?? ""), "planDigest");
  if (planDigest(value) !== storedRawDigest) {
    throw new Error("project use plan digest mismatch");
  }
  const action = String(value.action ?? "");
  if (!["create", "activate", "update", "repair", "reuse"].includes(action)) {
    throw new Error(`invalid project use action: ${action}`);
  }
  const expectedProjectLockDigest = value.expectedProjectLockDigest;
  if (expectedProjectLockDigest !== null && typeof expectedProjectLockDigest !== "string") {
    throw new Error("invalid expectedProjectLockDigest");
  }
  if (
    !["absent", "ready", "missing", "modified"].includes(
      String(value.expectedSnapshotIntegrity ?? ""),
    )
  ) {
    throw new Error("invalid expectedSnapshotIntegrity");
  }
  const plan: ProjectUsePlan = {
    schema: PROJECT_USE_PLAN_SCHEMA,
    action: action as ProjectUseAction,
    projectDirectoryDigest: assertHash(
      String(value.projectDirectoryDigest ?? ""),
      "projectDirectoryDigest",
    ),
    sourceLibraryId: assertLibraryId(String(value.sourceLibraryId ?? "")),
    desired: validateResolvedRevision(value.desired, "desired project revision"),
    snapshotKey: assertWindowsSafeId(String(value.snapshotKey ?? ""), "snapshotKey"),
    expectedProjectLockDigest:
      expectedProjectLockDigest === null
        ? null
        : assertHash(expectedProjectLockDigest, "expectedProjectLockDigest"),
    expectedSnapshotIntegrity: value.expectedSnapshotIntegrity as ProjectUsePlan["expectedSnapshotIntegrity"],
    createdAt: assertIsoDate(String(value.createdAt ?? ""), "plan createdAt"),
    planDigest: storedRawDigest,
  };
  if (plan.snapshotKey !== snapshotKey(plan.desired)) {
    throw new Error("project use plan snapshotKey mismatch");
  }
  if (planDigest(plan) !== plan.planDigest) throw new Error("project use plan digest mismatch");
  return plan;
}

async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function pathContains(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalFutureDirectory(candidate: string) {
  let current = path.resolve(candidate);
  const missing: string[] = [];
  while (true) {
    try {
      const real = await fs.realpath(current);
      const stat = await fs.stat(real);
      if (!stat.isDirectory()) return undefined;
      return path.resolve(real, ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    missing.unshift(path.basename(current));
    current = parent;
  }
}

async function atomicWriteJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function scanSnapshot(directory: string): Promise<InventoryResult> {
  const files: ProjectSnapshotFileV1[] = [];
  let totalBytes = 0;
  async function visit(current: string, prefix: string) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = validateRelativeFile(prefix ? `${prefix}/${entry.name}` : entry.name);
      const absolute = path.join(current, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`snapshot contains a symbolic link: ${relative}`);
      if (stat.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!stat.isFile()) throw new Error(`snapshot contains a non-regular file: ${relative}`);
      if (files.length >= MAX_SNAPSHOT_FILES) throw new Error("snapshot contains too many files");
      totalBytes += stat.size;
      if (totalBytes > MAX_SNAPSHOT_BYTES) throw new Error("snapshot exceeds 1 GiB limit");
      const bytes = new Uint8Array(await fs.readFile(absolute));
      files.push({ file: relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
    }
  }
  await visit(directory, "");
  files.sort((left, right) => left.file.localeCompare(right.file));
  if (files.length === 0) throw new Error("materialized snapshot contains no files");
  if (new Set(files.map((item) => item.file.toLocaleLowerCase("en-US"))).size !== files.length) {
    throw new Error("snapshot files collide on Windows");
  }
  return { files, inventoryDigest: inventoryDigest(files) };
}

async function inspectSnapshot(
  directory: string,
  expected?: ProjectTemplateSnapshotV1,
): Promise<{ integrity: ProjectSnapshotIntegrity; observed?: InventoryResult; issues: string[] }> {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { integrity: "missing", issues: ["snapshot directory is missing"] };
    }
    return {
      integrity: "modified",
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { integrity: "modified", issues: ["snapshot path is not a regular directory"] };
  }
  try {
    const observed = await scanSnapshot(directory);
    if (!expected) return { integrity: "ready", observed, issues: [] };
    if (observed.inventoryDigest !== expected.inventoryDigest) {
      return {
        integrity: "modified",
        observed,
        issues: ["snapshot inventory hash does not match project.lock"],
      };
    }
    return { integrity: "ready", observed, issues: [] };
  } catch (error) {
    return {
      integrity: "modified",
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function sealSnapshot(directory: string) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const stat = await fs.lstat(absolute);
    if (stat.isDirectory()) await sealSnapshot(absolute);
    else if (stat.isFile()) await fs.chmod(absolute, 0o444).catch(() => undefined);
  }
}

const PROJECT_GITIGNORE = `/templates/\n/previews/\n/locks/\n/quarantine/\n`;

export class ProjectTemplateLibrary {
  readonly projectDirectory: string;
  readonly projectDirectoryDigest: string;
  readonly root: string;
  readonly templatesDirectory: string;
  readonly previewsDirectory: string;
  readonly locksDirectory: string;
  readonly quarantineDirectory: string;
  readonly lockFile: string;
  readonly resolver: ProjectTemplateSourceResolver;

  constructor(projectDirectory: string, resolver: ProjectTemplateSourceResolver) {
    if (!path.isAbsolute(projectDirectory)) {
      throw new Error("projectDirectory must be an absolute trusted host path");
    }
    this.projectDirectory = path.resolve(projectDirectory);
    this.projectDirectoryDigest = sha256(
      process.platform === "win32"
        ? this.projectDirectory.toLocaleLowerCase("en-US")
        : this.projectDirectory,
    );
    this.root = path.join(this.projectDirectory, ".wisp", "figure-library");
    this.templatesDirectory = path.join(this.root, "templates");
    this.previewsDirectory = path.join(this.root, "previews");
    this.locksDirectory = path.join(this.root, "locks");
    this.quarantineDirectory = path.join(this.root, "quarantine");
    this.lockFile = path.join(this.root, "project.lock.json");
    assertLibraryId(resolver.libraryId);
    this.resolver = resolver;
  }

  private snapshotDirectory(templateId: string, key: string) {
    return path.join(
      this.templatesDirectory,
      assertWindowsSafeId(templateId, "templateId"),
      assertWindowsSafeId(key, "snapshotKey"),
    );
  }

  private operationFile(operationId: string) {
    return path.join(
      this.locksDirectory,
      "operations",
      `${assertWindowsSafeId(operationId, "operationId")}.json`,
    );
  }

  /**
   * The project path is trusted host input, but project contents are not. Refuse
   * a project-local `.wisp` or `figure-library` symlink before reading managed
   * state and, critically, before creating locks or materialized files.
   */
  private async assertProjectBoundary() {
    const projectStat = await fs.lstat(this.projectDirectory);
    if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) {
      throw new Error("project_path_unsafe: projectDirectory must be a real directory");
    }
    const canonicalProject = path.resolve(await fs.realpath(this.projectDirectory));
    const managedDirectories = [
      path.join(this.projectDirectory, ".wisp"),
      this.root,
      this.templatesDirectory,
      this.previewsDirectory,
      this.locksDirectory,
      path.join(this.locksDirectory, "operations"),
      path.join(this.locksDirectory, "write"),
      this.quarantineDirectory,
    ];
    for (const directory of managedDirectories) {
      try {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(
            `project_path_unsafe: managed project directory must be real, not a symlink: ${directory}`,
          );
        }
        const canonical = path.resolve(await fs.realpath(directory));
        if (!pathContains(canonicalProject, canonical)) {
          throw new Error(
            `project_path_unsafe: managed project directory escapes projectDirectory: ${directory}`,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const canonicalRoot = await canonicalFutureDirectory(this.root);
    if (!canonicalRoot || !pathContains(canonicalProject, canonicalRoot)) {
      throw new Error(
        "project_path_unsafe: project figure-library root escapes projectDirectory",
      );
    }
    for (const file of [path.join(this.root, ".gitignore"), this.lockFile]) {
      await this.assertRegularManagedFileIfExists(file, "managed project file", canonicalProject);
    }
  }

  private async assertRegularManagedFileIfExists(
    file: string,
    label: string,
    canonicalProjectInput?: string,
  ) {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`project_path_unsafe: ${label} must be a regular non-symlink file: ${file}`);
      }
      const canonicalProject = canonicalProjectInput ??
        path.resolve(await fs.realpath(this.projectDirectory));
      const canonical = path.resolve(await fs.realpath(file));
      if (!pathContains(canonicalProject, canonical)) {
        throw new Error(`project_path_unsafe: ${label} escapes projectDirectory: ${file}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async assertManagedDirectoryPath(directory: string) {
    await this.assertProjectBoundary();
    const canonicalProject = path.resolve(await fs.realpath(this.projectDirectory));
    const relative = path.relative(this.root, path.resolve(directory));
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("project_path_unsafe: managed directory is outside figure-library root");
    }
    let current = this.root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const stat = await fs.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(
            `project_path_unsafe: managed directory chain contains a non-directory or symlink: ${current}`,
          );
        }
        const canonical = path.resolve(await fs.realpath(current));
        if (!pathContains(canonicalProject, canonical)) {
          throw new Error(
            `project_path_unsafe: managed directory chain escapes projectDirectory: ${current}`,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }

  private async inspectProjectSnapshot(
    directory: string,
    expected?: ProjectTemplateSnapshotV1,
  ) {
    try {
      await this.assertManagedDirectoryPath(directory);
      return await inspectSnapshot(directory, expected);
    } catch (error) {
      return {
        integrity: "modified" as const,
        issues: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  private async ensureManagedDirectory(directory: string) {
    try {
      await fs.mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        `project_path_unsafe: managed project directory must be real, not a symlink: ${directory}`,
      );
    }
  }

  private async readLock(): Promise<ProjectTemplateLockV1 | undefined> {
    await this.assertProjectBoundary();
    await this.assertRegularManagedFileIfExists(this.lockFile, "project.lock.json");
    try {
      return validateProjectLock(JSON.parse(await fs.readFile(this.lockFile, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async readReceipt(operationId: string): Promise<ProjectUseReceiptV1 | undefined> {
    await this.assertProjectBoundary();
    await this.assertRegularManagedFileIfExists(
      this.operationFile(operationId),
      "project operation receipt",
    );
    try {
      const value = JSON.parse(
        await fs.readFile(this.operationFile(operationId), "utf8"),
      ) as unknown;
      if (!isRecord(value) || value.schema !== PROJECT_USE_RECEIPT_SCHEMA) {
        throw new Error(`invalid project operation receipt: ${operationId}`);
      }
      if (value.operationId !== operationId) throw new Error("project receipt operationId mismatch");
      const plan = assertHash(String(value.planDigest ?? ""), "receipt planDigest");
      if (!isRecord(value.result)) throw new Error("invalid project operation result");
      const resultRevision = validateResolvedRevision(value.result, "receipt result");
      const action = String(value.result.action ?? "");
      if (!["create", "activate", "update", "repair"].includes(action)) {
        throw new Error("invalid receipt action");
      }
      const result: StoredApplyResult = {
        ...resultRevision,
        operationId: assertWindowsSafeId(
          String(value.result.operationId ?? ""),
          "operationId",
        ),
        action: action as StoredApplyResult["action"],
        snapshotKey: assertWindowsSafeId(
          String(value.result.snapshotKey ?? ""),
          "snapshotKey",
        ),
        projectLockDigest: assertHash(
          String(value.result.projectLockDigest ?? ""),
          "projectLockDigest",
        ),
        appliedAt: assertIsoDate(String(value.result.appliedAt ?? ""), "appliedAt"),
      };
      if (result.operationId !== operationId) throw new Error("receipt result operationId mismatch");
      return {
        schema: PROJECT_USE_RECEIPT_SCHEMA,
        operationId,
        planDigest: plan,
        result,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private publicResult(result: StoredApplyResult, idempotentReplay: boolean): ProjectUseApplyResult {
    return {
      ...result,
      target: this.snapshotDirectory(result.templateId, result.snapshotKey),
      reused: false,
      idempotentReplay,
    };
  }

  private async withWriteLock<T>(operationId: string, callback: () => Promise<T>): Promise<T> {
    await this.ensureLayout();
    await this.assertProjectBoundary();
    const directory = path.join(this.locksDirectory, "write");
    const owner = {
      operationId,
      token: randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    try {
      await fs.mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("project_library_busy: another project template write is in progress");
      }
      throw error;
    }
    try {
      await fs.writeFile(
        path.join(directory, "owner.json"),
        `${JSON.stringify(owner, null, 2)}\n`,
        { flag: "wx" },
      );
      return await callback();
    } finally {
      try {
        const current = JSON.parse(
          await fs.readFile(path.join(directory, "owner.json"), "utf8"),
        ) as unknown;
        if (isRecord(current) && current.token === owner.token) {
          await fs.rm(directory, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async ensureLayout() {
    await this.assertProjectBoundary();
    await this.ensureManagedDirectory(path.join(this.projectDirectory, ".wisp"));
    await this.ensureManagedDirectory(this.root);
    await this.assertProjectBoundary();
    const gitignore = path.join(this.root, ".gitignore");
    try {
      await this.assertRegularManagedFileIfExists(gitignore, "project figure-library .gitignore");
      const existing = await fs.readFile(gitignore, "utf8");
      const lines = new Set(
        existing
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean),
      );
      for (const required of ["/templates/", "/previews/", "/locks/", "/quarantine/"]) {
        if (!lines.has(required)) {
          throw new Error(
            `project figure-library .gitignore is missing required rule ${required}`,
          );
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.writeFile(gitignore, PROJECT_GITIGNORE, { flag: "wx" });
    }
    for (const directory of [
      this.templatesDirectory,
      this.previewsDirectory,
      this.locksDirectory,
      path.join(this.locksDirectory, "operations"),
      this.quarantineDirectory,
    ]) {
      await this.ensureManagedDirectory(directory);
    }
    await this.assertProjectBoundary();
  }

  async status(): Promise<ProjectLibraryStatus> {
    let lock: ProjectTemplateLockV1 | undefined;
    try {
      lock = await this.readLock();
    } catch (error) {
      return {
        projectDirectory: this.projectDirectory,
        root: this.root,
        status: "modified",
        projectLockDigest: null,
        sourceLibraryId: null,
        currentSourceLibraryId: this.resolver.libraryId,
        sourceLibraryMismatch: false,
        templates: [],
        issues: [error instanceof Error ? error.message : String(error)],
      };
    }
    if (!lock) {
      return {
        projectDirectory: this.projectDirectory,
        root: this.root,
        status: "missing",
        projectLockDigest: null,
        sourceLibraryId: null,
        currentSourceLibraryId: this.resolver.libraryId,
        sourceLibraryMismatch: false,
        templates: [],
        issues: ["project.lock.json is missing"],
      };
    }
    const sourceLibraryMismatch = lock.sourceLibraryId !== this.resolver.libraryId;
    const templates: ProjectTemplateStatus[] = [];
    for (const pin of lock.templates) {
      const snapshots: ProjectSnapshotStatus[] = [];
      for (const snapshot of pin.snapshots) {
        const inspected = await this.inspectProjectSnapshot(
          this.snapshotDirectory(pin.templateId, snapshot.snapshotKey),
          snapshot,
        );
        snapshots.push({
          revisionId: snapshot.revisionId,
          contentDigest: snapshot.contentDigest,
          snapshotKey: snapshot.snapshotKey,
          active: sameSelection(snapshot, pin.active),
          integrity: inspected.integrity,
          inventoryDigest: snapshot.inventoryDigest,
          ...(inspected.observed
            ? { observedInventoryDigest: inspected.observed.inventoryDigest }
            : {}),
          issues: inspected.issues,
        });
      }
      let updateAvailable: boolean | null = null;
      let available: ProjectTemplateResolvedRevision | undefined;
      let updateCheckError: string | undefined;
      if (!sourceLibraryMismatch && this.resolver.resolvePublished) {
        try {
          const resolved = await this.resolver.resolvePublished(pin.templateId, pin.active);
          if (resolved) {
            available = validateResolvedRevision(resolved, "published project revision");
            if (available.templateId !== pin.templateId) {
              throw new Error("published resolver returned the wrong templateId");
            }
            updateAvailable = !sameSelection(available, pin.active);
          } else {
            updateAvailable = false;
          }
        } catch (error) {
          updateCheckError = error instanceof Error ? error.message : String(error);
        }
      }
      let status: ProjectLibraryState = "ready";
      if (sourceLibraryMismatch) status = "source_library_mismatch";
      else if (snapshots.some((snapshot) => snapshot.integrity === "modified")) status = "modified";
      else if (snapshots.some((snapshot) => snapshot.integrity === "missing")) status = "missing";
      templates.push({
        templateId: pin.templateId,
        status,
        active: pin.active,
        snapshots,
        updateAvailable,
        ...(available ? { available } : {}),
        ...(updateCheckError ? { updateCheckError } : {}),
      });
    }
    let status: ProjectLibraryState = "ready";
    if (sourceLibraryMismatch) status = "source_library_mismatch";
    else if (templates.some((template) => template.status === "modified")) status = "modified";
    else if (templates.some((template) => template.status === "missing")) status = "missing";
    return {
      projectDirectory: this.projectDirectory,
      root: this.root,
      status,
      projectLockDigest: lock.projectLockDigest,
      sourceLibraryId: lock.sourceLibraryId,
      currentSourceLibraryId: this.resolver.libraryId,
      sourceLibraryMismatch,
      templates,
      issues: [],
    };
  }

  private async desiredSnapshotIntegrity(
    lock: ProjectTemplateLockV1 | undefined,
    desired: ProjectTemplateSelection,
  ): Promise<ProjectSnapshotIntegrity | "absent"> {
    const pin = lock?.templates.find((item) => item.templateId === desired.templateId);
    const snapshot = pin?.snapshots.find((item) => sameSelection(item, desired));
    if (!snapshot) {
      return (await exists(this.snapshotDirectory(desired.templateId, snapshotKey(desired))))
        ? "modified"
        : "absent";
    }
    return (
      await this.inspectProjectSnapshot(
        this.snapshotDirectory(desired.templateId, snapshot.snapshotKey),
        snapshot,
      )
    ).integrity;
  }

  async planUse(options: {
    templateId: string;
    revisionId: string;
    contentDigest: string;
    action?: ProjectUseAction;
  }): Promise<ProjectUsePlan> {
    const requested = validateSelection(options, "requested project revision");
    let lock: ProjectTemplateLockV1 | undefined;
    try {
      lock = await this.readLock();
    } catch (error) {
      throw new Error(
        `project_lock_modified: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (lock && lock.sourceLibraryId !== this.resolver.libraryId) {
      throw new Error(
        `source_library_mismatch: project=${lock.sourceLibraryId} current=${this.resolver.libraryId}`,
      );
    }
    const caseCollision = lock?.templates.find(
      (item) =>
        item.templateId !== requested.templateId &&
        item.templateId.toLocaleLowerCase("en-US") ===
          requested.templateId.toLocaleLowerCase("en-US"),
    );
    if (caseCollision) {
      throw new Error(
        `project template IDs collide on Windows: ${caseCollision.templateId} / ${requested.templateId}`,
      );
    }
    const desired = validateResolvedRevision(
      await this.resolver.resolveExact(requested),
      "resolved project revision",
    );
    if (!sameSelection(desired, requested)) {
      throw new Error("source resolver did not return the exact requested revision");
    }
    const pin = lock?.templates.find((item) => item.templateId === desired.templateId);
    const snapshot = pin?.snapshots.find((item) => sameSelection(item, desired));
    const integrity = await this.desiredSnapshotIntegrity(lock, desired);
    let action: ProjectUseAction;
    if (!pin) action = "create";
    else if (snapshot && integrity === "ready") {
      action = sameSelection(pin.active, desired) ? "reuse" : "activate";
    } else if (snapshot) action = "repair";
    else action = "update";
    if (options.action && options.action !== action) {
      throw new Error(`project use action mismatch: requested ${options.action}, required ${action}`);
    }
    const base: Omit<ProjectUsePlan, "planDigest"> = {
      schema: PROJECT_USE_PLAN_SCHEMA,
      action,
      projectDirectoryDigest: this.projectDirectoryDigest,
      sourceLibraryId: this.resolver.libraryId,
      desired,
      snapshotKey: snapshotKey(desired),
      expectedProjectLockDigest: lock?.projectLockDigest ?? null,
      expectedSnapshotIntegrity: integrity,
      createdAt: new Date().toISOString(),
    };
    return { ...base, planDigest: planDigest(base) };
  }

  private async materializeSnapshot(
    desired: ProjectTemplateResolvedRevision,
    key: string,
    operationId: string,
  ): Promise<ProjectTemplateSnapshotV1> {
    const target = this.snapshotDirectory(desired.templateId, key);
    const staging = path.join(
      this.locksDirectory,
      `staging-${assertWindowsSafeId(operationId, "operationId")}-${randomUUID()}`,
    );
    try {
      await this.resolver.materialize(desired, staging);
      const stat = await fs.lstat(staging);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("source resolver did not create a regular snapshot directory");
      }
      const inventory = await scanSnapshot(staging);
      await sealSnapshot(staging);
      await this.assertManagedDirectoryPath(path.dirname(target));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await this.assertManagedDirectoryPath(path.dirname(target));
      await fs.rename(staging, target);
      return {
        ...desired,
        snapshotKey: key,
        materializedAt: new Date().toISOString(),
        files: inventory.files,
        inventoryDigest: inventory.inventoryDigest,
      };
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async applyUse(planInput: ProjectUsePlan, operationIdInput: string): Promise<ProjectUseApplyResult> {
    const plan = validatePlan(planInput);
    if (plan.projectDirectoryDigest !== this.projectDirectoryDigest) {
      throw new Error("projectDirectory does not match the reviewed project use plan");
    }
    const operationId = assertWindowsSafeId(operationIdInput, "operationId");
    if (plan.sourceLibraryId !== this.resolver.libraryId) {
      throw new Error(
        `source_library_mismatch: plan=${plan.sourceLibraryId} current=${this.resolver.libraryId}`,
      );
    }

    if (plan.action === "reuse") {
      const lock = await this.readLock();
      if ((lock?.projectLockDigest ?? null) !== plan.expectedProjectLockDigest) {
        throw new Error("stale_project_use_plan: project.lock changed after planning");
      }
      const integrity = await this.desiredSnapshotIntegrity(lock, plan.desired);
      const pin = lock?.templates.find((item) => item.templateId === plan.desired.templateId);
      if (!lock || integrity !== "ready" || !pin || !sameSelection(pin.active, plan.desired)) {
        throw new Error("stale_project_use_plan: exact reused pin is no longer ready and active");
      }
      return {
        ...plan.desired,
        operationId,
        action: "reuse",
        snapshotKey: plan.snapshotKey,
        target: this.snapshotDirectory(plan.desired.templateId, plan.snapshotKey),
        projectLockDigest: lock.projectLockDigest,
        reused: true,
        idempotentReplay: false,
        appliedAt: plan.createdAt,
      };
    }

    const mutationPlan = plan as ProjectUsePlan & {
      action: Exclude<ProjectUseAction, "reuse">;
    };

    const prior = await this.readReceipt(operationId);
    if (prior) {
      if (prior.planDigest !== plan.planDigest) {
        throw new Error("operationId was already used for a different project use plan");
      }
      return this.publicResult(prior.result, true);
    }

    return this.withWriteLock(operationId, async () => {
      const racedReceipt = await this.readReceipt(operationId);
      if (racedReceipt) {
        if (racedReceipt.planDigest !== plan.planDigest) {
          throw new Error("operationId was already used for a different project use plan");
        }
        return this.publicResult(racedReceipt.result, true);
      }
      const current = await this.readLock();
      if ((current?.projectLockDigest ?? null) !== plan.expectedProjectLockDigest) {
        if (
          current?.lastOperation?.operationId === operationId &&
          current.lastOperation.planDigest === plan.planDigest
        ) {
          const recovered: StoredApplyResult = {
            ...plan.desired,
            operationId,
            action: mutationPlan.action,
            snapshotKey: plan.snapshotKey,
            projectLockDigest: current.projectLockDigest,
            appliedAt: current.lastOperation.appliedAt,
          };
          const receipt: ProjectUseReceiptV1 = {
            schema: PROJECT_USE_RECEIPT_SCHEMA,
            operationId,
            planDigest: plan.planDigest,
            result: recovered,
          };
          await atomicWriteJson(this.operationFile(operationId), receipt);
          return this.publicResult(recovered, true);
        }
        throw new Error("stale_project_use_plan: project.lock changed after planning");
      }
      if (current && current.sourceLibraryId !== this.resolver.libraryId) {
        throw new Error("source_library_mismatch: project lock changed source library");
      }
      const currentIntegrity = await this.desiredSnapshotIntegrity(current, plan.desired);
      if (currentIntegrity !== plan.expectedSnapshotIntegrity) {
        throw new Error("stale_project_use_plan: snapshot changed after planning");
      }
      const resolved = validateResolvedRevision(
        await this.resolver.resolveExact(plan.desired),
        "apply resolved project revision",
      );
      if (!sameSelection(resolved, plan.desired)) {
        throw new Error("source revision changed after project use planning");
      }
      await this.ensureLayout();

      let nextSnapshot: ProjectTemplateSnapshotV1 | undefined;
      if (mutationPlan.action === "create" || mutationPlan.action === "update") {
        if (currentIntegrity !== "absent") {
          throw new Error("stale_project_use_plan: new snapshot target already exists");
        }
        nextSnapshot = await this.materializeSnapshot(resolved, plan.snapshotKey, operationId);
      } else if (mutationPlan.action === "repair") {
        const target = this.snapshotDirectory(plan.desired.templateId, plan.snapshotKey);
        if (await exists(target)) {
          const quarantineParent = path.join(
            this.quarantineDirectory,
            plan.desired.templateId,
          );
          await this.assertManagedDirectoryPath(quarantineParent);
          await fs.mkdir(quarantineParent, { recursive: true });
          await this.assertManagedDirectoryPath(quarantineParent);
          const quarantineTarget = path.join(
            quarantineParent,
            `${plan.snapshotKey}-${Date.now()}-${randomUUID()}`,
          );
          await fs.rename(target, quarantineTarget);
        }
        nextSnapshot = await this.materializeSnapshot(resolved, plan.snapshotKey, operationId);
      }

      const appliedAt = new Date().toISOString();
      const templateMap = new Map(
        (current?.templates ?? []).map((pin) => [pin.templateId, pin] as const),
      );
      const priorPin = templateMap.get(plan.desired.templateId);
      let snapshots = [...(priorPin?.snapshots ?? [])];
      if (nextSnapshot) {
        snapshots = snapshots.filter((snapshot) => !sameSelection(snapshot, plan.desired));
        snapshots.push(nextSnapshot);
      }
      if (mutationPlan.action === "activate" && !priorPin) {
        throw new Error("stale_project_use_plan: activation target is not pinned");
      }
      templateMap.set(plan.desired.templateId, {
        templateId: plan.desired.templateId,
        active: {
          templateId: plan.desired.templateId,
          revisionId: plan.desired.revisionId,
          contentDigest: plan.desired.contentDigest,
        },
        snapshots,
      });
      const nextWithoutDigest: Omit<ProjectTemplateLockV1, "projectLockDigest"> = {
        schema: PROJECT_TEMPLATE_LOCK_SCHEMA,
        sourceLibraryId: this.resolver.libraryId,
        createdAt: current?.createdAt ?? appliedAt,
        updatedAt: appliedAt,
        templates: sortLockTemplates([...templateMap.values()]),
        lastOperation: {
          operationId,
          planDigest: plan.planDigest,
          action: mutationPlan.action,
          templateId: plan.desired.templateId,
          snapshotKey: plan.snapshotKey,
          appliedAt,
        },
      };
      const next: ProjectTemplateLockV1 = {
        ...nextWithoutDigest,
        projectLockDigest: projectLockDigest(nextWithoutDigest),
      };
      const validatedNext = validateProjectLock(next);
      await atomicWriteJson(this.lockFile, validatedNext);
      const storedResult: StoredApplyResult = {
        ...plan.desired,
        operationId,
        action: mutationPlan.action,
        snapshotKey: plan.snapshotKey,
        projectLockDigest: next.projectLockDigest,
        appliedAt,
      };
      const receipt: ProjectUseReceiptV1 = {
        schema: PROJECT_USE_RECEIPT_SCHEMA,
        operationId,
        planDigest: plan.planDigest,
        result: storedResult,
      };
      await atomicWriteJson(this.operationFile(operationId), receipt);
      return this.publicResult(storedResult, false);
    });
  }
}

/** Adapter for exact Published/previously-Published revisions in the canonical store. */
export function createVersionedLibraryProjectSource(
  library: VersionedTemplateLibrary,
  libraryId: string,
): ProjectTemplateSourceResolver {
  assertLibraryId(libraryId);
  async function resolveExact(
    selection: ProjectTemplateSelection,
  ): Promise<ProjectTemplateResolvedRevision> {
    const requested = validateSelection(selection);
    const history = await library.history(requested.templateId);
    const release = history.releases.find(
      (item) =>
        item.revisionId === requested.revisionId &&
        item.contentDigest === requested.contentDigest,
    );
    if (!release) throw new Error("only an exact published revision can be pinned to a project");
    return {
      ...requested,
      releaseId: release.releaseId,
      publishedAt: release.publishedAt,
    };
  }
  return {
    libraryId,
    resolveExact,
    async resolvePublished(templateId) {
      const safeTemplateId = assertWindowsSafeId(templateId, "templateId");
      const series = await library.getSeries(safeTemplateId);
      if (!series?.publishedHead) return undefined;
      const release = await library.getRelease(safeTemplateId, series.publishedHead.releaseId);
      if (!release) throw new Error("Published Head release is missing");
      return {
        templateId: safeTemplateId,
        revisionId: series.publishedHead.revisionId,
        contentDigest: series.publishedHead.contentDigest,
        releaseId: release.releaseId,
        publishedAt: release.publishedAt,
      };
    },
    async materialize(revision, destination) {
      const exact = await resolveExact(revision);
      const temporaryParent = `${destination}.source-${randomUUID()}`;
      let result: RevisionMaterializationResult | undefined;
      try {
        result = await library.materializeRevision({
          templateId: exact.templateId,
          revisionId: exact.revisionId,
          contentDigest: exact.contentDigest,
          destination: temporaryParent,
        });
        await fs.rename(result.target, destination);
      } finally {
        await fs.rm(temporaryParent, { recursive: true, force: true });
      }
    },
  };
}
