import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";

export const CAPTURE_MANIFEST_SCHEMA = "figure-library.capture-record.v1" as const;
export const CAPTURE_STATE_SCHEMA = "figure-library.capture-state.v1" as const;
export const CAPTURE_OPERATION_SCHEMA = "figure-library.capture-operation.v1" as const;
export const CAPTURE_CLEANUP_PLAN_SCHEMA = "figure-library.capture-cleanup-plan.v1" as const;

const MATERIALIZATION_RECEIPT_SCHEMA =
  "figure-library.capture-materialization-receipt.v1" as const;
const HASH = /^[a-f0-9]{64}$/u;
const SAFE_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_ARTICLE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 256 * 1024 * 1024;
const MAX_VISUAL_ASSETS = 100;
const MAX_CODE_BLOCKS = 100;
const MAX_CONTEXT_BLOCKS = 240;
const MAX_CODE_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
/** Leaves headroom below the Wisp tool-call timeout (120 seconds). */
export const CAPTURE_TOTAL_TIMEOUT_MS = 90_000;
const MAX_REDIRECTS = 6;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type CaptureLibraryRootProvider = () => string | Promise<string>;
export interface CaptureResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type CaptureResolver = (
  hostname: string,
) => Promise<readonly CaptureResolvedAddress[]>;
export interface CaptureTransportRequest {
  /** The original, user-visible URL. The socket target is supplied by requestOptions.lookup. */
  url: URL;
  /** Every address in this list has been validated as public for this exact redirect hop. */
  resolvedAddresses: readonly CaptureResolvedAddress[];
  /**
   * Complete Node request options, including an original-host Host header/TLS servername and
   * a controlled lookup function that can only return resolvedAddresses.
   */
  requestOptions: https.RequestOptions & { autoSelectFamily?: boolean };
}
export type CaptureRequestTransport = (
  request: CaptureTransportRequest,
) => Promise<Response>;
export type CaptureState = "active" | "archived";
export type CleanupMode = "prune_payload" | "full_purge";

export class CaptureError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CaptureError";
    this.code = code;
  }
}

const CAPTURE_ABORT_CODES = new Set(["capture_cancelled", "capture_deadline_exceeded"]);

function isCaptureAbort(error: unknown): error is CaptureError {
  return error instanceof CaptureError && CAPTURE_ABORT_CODES.has(error.code);
}

/**
 * One budget for the complete capture. It bounds operations (such as DNS test seams) that do
 * not natively accept AbortSignal and supplies the same signal to operations that do.
 */
class CaptureDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly deadlineAt: number;
  private readonly timeout: ReturnType<typeof setTimeout> | undefined;
  private readonly externalSignal?: AbortSignal;
  private readonly externalAbort?: () => void;
  private completed = false;

  constructor(timeoutMs: number, externalSignal?: AbortSignal) {
    this.signal = this.controller.signal;
    this.deadlineAt = performance.now() + timeoutMs;
    this.externalSignal = externalSignal;
    this.externalAbort = externalSignal
      ? () =>
          this.abort(
            "capture_cancelled",
            "article capture was cancelled by the host; no capture was stored",
          )
      : undefined;
    if (externalSignal?.aborted) this.externalAbort?.();
    else if (externalSignal && this.externalAbort) {
      externalSignal.addEventListener("abort", this.externalAbort, { once: true });
    }
    this.timeout = this.signal.aborted
      ? undefined
      : setTimeout(
          () =>
            this.abort(
              "capture_deadline_exceeded",
              `article capture exceeded its ${timeoutMs} ms total deadline; no capture was stored`,
            ),
          timeoutMs,
        );
  }

  private abort(code: string, message: string) {
    if (!this.completed && !this.signal.aborted) {
      this.controller.abort(new CaptureError(code, message));
    }
  }

  error() {
    const reason = this.signal.reason;
    return reason instanceof CaptureError
      ? reason
      : new CaptureError(
          "capture_cancelled",
          "article capture was cancelled; no capture was stored",
        );
  }

  throwIfAborted() {
    if (!this.signal.aborted && performance.now() >= this.deadlineAt) {
      this.abort(
        "capture_deadline_exceeded",
        "article capture exceeded its total deadline; no capture was stored",
      );
    }
    if (this.signal.aborted) throw this.error();
  }

  async race<T>(operation: PromiseLike<T>): Promise<T> {
    this.throwIfAborted();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.error());
      this.signal.addEventListener("abort", onAbort, { once: true });
      // AbortSignal does not dispatch a late event to listeners added after abort.
      if (this.signal.aborted) onAbort();
    });
    try {
      return await Promise.race([Promise.resolve(operation), aborted]);
    } finally {
      if (onAbort) this.signal.removeEventListener("abort", onAbort);
    }
  }

  /** Close the abort boundary only after every durable object is readable. */
  complete() {
    this.throwIfAborted();
    this.completed = true;
    this.detach();
  }

  private detach() {
    if (this.timeout) clearTimeout(this.timeout);
    if (this.externalSignal && this.externalAbort) {
      this.externalSignal.removeEventListener("abort", this.externalAbort);
    }
  }

  dispose() {
    this.detach();
  }
}

export interface CaptureDirectoryStatus {
  configured: boolean;
  enabled: boolean;
  source: "constructor" | "environment" | "project" | "unconfigured";
  root?: string;
  projectDirectory?: string;
  libraryRoot?: string;
  isolated: boolean;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  creatable: boolean;
  available: boolean;
  reason?: string;
}

export interface CaptureWarning {
  code: string;
  message: string;
  sourceUrl?: string;
}

export interface CaptureStoredAsset {
  file: string;
  bytes: number;
  sha256: string;
  mediaType: string;
  sourceUrl: string;
}

export interface CaptureRawPayload extends CaptureStoredAsset {
  assetId: string;
}

export interface CaptureVisualAsset extends CaptureStoredAsset {
  assetId: string;
  requestedSourceUrl?: string;
  alt?: string;
  contextBlockIds: string[];
}

export interface CaptureCodeBlock extends CaptureStoredAsset {
  blockId: string;
  language: string;
  excerpt: string;
  contextBlockIds: string[];
}

export interface CaptureContextBlock extends CaptureStoredAsset {
  blockId: string;
  text: string;
}

export interface CaptureManifestV1 {
  schema: typeof CAPTURE_MANIFEST_SCHEMA;
  captureId: string;
  captureDigest: string;
  createdAt: string;
  operationId?: string;
  source: {
    url: string;
    finalUrl: string;
    host: string;
    sourceKind: "wechat" | "web";
    fetchMode: "http-first";
    capturedAt: string;
    httpStatus: number;
    mediaType: string;
    rawSha256: string;
  };
  article: {
    title: string;
    author?: string;
    publishedAt?: string;
    description?: string;
    bodyTextSha256: string;
  };
  rawPayload: CaptureRawPayload;
  visualAssets: CaptureVisualAsset[];
  codeBlocks: CaptureCodeBlock[];
  context: CaptureContextBlock[];
  warnings: CaptureWarning[];
  totals: {
    visualAssets: number;
    codeBlocks: number;
    contextBlocks: number;
    storedBytes: number;
  };
}

interface CaptureStateV1 {
  schema: typeof CAPTURE_STATE_SCHEMA;
  captureId: string;
  status: CaptureState;
  updatedAt: string;
  lastArchivedAt?: string;
  lastRestoredAt?: string;
}

export type CaptureRecord = CaptureManifestV1 & {
  state: CaptureState;
  stateUpdatedAt: string;
  archivedAt?: string;
  restoredAt?: string;
};

export interface CaptureSummary {
  captureId: string;
  state: CaptureState;
  title: string;
  sourceUrl: string;
  capturedAt: string;
  visualAssetCount: number;
  codeBlockCount: number;
  contextBlockCount: number;
  warningCount: number;
}

export interface CaptureCleanupBlocker {
  code: string;
  message: string;
}

export interface CaptureCleanupPlanV1 {
  schema: typeof CAPTURE_CLEANUP_PLAN_SCHEMA;
  captureId: string;
  mode: CleanupMode;
  createdAt: string;
  state: CaptureState;
  ready: boolean;
  blockers: CaptureCleanupBlocker[];
  matchedReceipts: Array<{
    receiptId: string;
    templateId: string;
    revisionId: string;
    contentDigest: string;
    committedAt: string;
    requiredAssetSha256: string[];
    selectionDigest?: string;
  }>;
  selectedAssetSha256: string[];
  payload: {
    files: string[];
    bytes: number;
  };
  preservedMetadataFiles: string[];
  deletionEnabled: false;
  written: false;
  planDigest: string;
}

export interface CaptureArticleInput {
  url: string;
  operationId?: string;
  /** Host-side cancellation; not part of the public MCP input schema. */
  signal?: AbortSignal;
}

export interface CaptureListInput {
  includeArchived?: boolean;
}

export interface CaptureCleanupInput {
  captureId: string;
  mode: CleanupMode;
  durableReceipts?: readonly unknown[];
}

interface PositionedImage {
  position: number;
  url: string;
  alt?: string;
}

interface PositionedCode {
  position: number;
  text: string;
  language: string;
}

interface PositionedContext {
  position: number;
  text: string;
}

interface ParsedArticle {
  title: string;
  author?: string;
  publishedAt?: string;
  description?: string;
  bodyText: string;
  images: PositionedImage[];
  codes: PositionedCode[];
  contexts: PositionedContext[];
}

interface OperationReceiptV1 {
  schema: typeof CAPTURE_OPERATION_SCHEMA;
  operationId: string;
  requestedUrl: string;
  captureId: string;
  rawSha256: string;
  completedAt: string;
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return undefined;
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

function assertSafeSegment(value: string, label: string) {
  if (!SAFE_SEGMENT.test(value)) {
    throw new CaptureError("invalid_identifier", `${label} is not a safe portable identifier`);
  }
  return value;
}

function pathContains(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function rootsOverlap(left: string, right: string) {
  return pathContains(left, right) || pathContains(right, left);
}

async function canonicalFuturePath(candidate: string) {
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

function validateRelativeFile(file: string) {
  const normalized = file.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new CaptureError("invalid_capture_manifest", `unsafe stored capture file: ${file}`);
  }
  return normalized;
}

function resolveStoredFile(directory: string, file: string) {
  const normalized = validateRelativeFile(file);
  const root = path.resolve(directory);
  const resolved = path.resolve(root, ...normalized.split("/"));
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new CaptureError("invalid_capture_manifest", `unsafe stored capture file: ${file}`);
  }
  return resolved;
}

function decodeEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    mdash: "—",
    nbsp: " ",
    ndash: "–",
    quot: '"',
    rdquo: "”",
    rsquo: "’",
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/giu, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hexadecimal = entity[1]?.toLocaleLowerCase() === "x";
      const parsed = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 0x10ffff) {
        try {
          return String.fromCodePoint(parsed);
        } catch {
          return match;
        }
      }
      return match;
    }
    return named[entity.toLocaleLowerCase()] ?? match;
  });
}

function attributes(tag: string) {
  const result: Record<string, string> = {};
  const expression = /(?:^|\s)([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu;
  for (const match of tag.matchAll(expression)) {
    const name = match[1]?.toLocaleLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    if (name && value !== undefined && result[name] === undefined) {
      result[name] = decodeEntities(value.trim());
    }
  }
  return result;
}

function withoutExecutableMarkup(html: string) {
  return html
    .replace(/<(?:script|style|template|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|template|noscript)>/giu, " ")
    .replace(/<!--([\s\S]*?)-->/gu, " ");
}

function htmlToText(html: string) {
  return decodeEntities(
    withoutExecutableMarkup(html)
      .replace(/<br\s*\/?\s*>/giu, "\n")
      .replace(/<\/(?:p|div|section|article|h[1-6]|li|pre|blockquote|figcaption)>/giu, "\n")
      .replace(/<[^>]+>/gu, " "),
  )
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function extractElementInnerHtml(html: string, requestedId?: string, requestedTag?: string) {
  const opening = /<([A-Za-z][A-Za-z0-9:-]*)\b[^>]*>/gu;
  for (const match of html.matchAll(opening)) {
    const tag = match[1]?.toLocaleLowerCase();
    if (!tag) continue;
    const parsed = attributes(match[0]);
    if (requestedId && parsed.id !== requestedId) continue;
    if (requestedTag && tag !== requestedTag) continue;
    const start = (match.index ?? 0) + match[0].length;
    const matcher = new RegExp(`<\\/?${tag}\\b[^>]*>`, "giu");
    matcher.lastIndex = start;
    let depth = 1;
    for (let current = matcher.exec(html); current; current = matcher.exec(html)) {
      const token = current[0];
      if (token.startsWith("</")) depth -= 1;
      else if (!token.endsWith("/>")) depth += 1;
      if (depth === 0) return html.slice(start, current.index);
    }
    return html.slice(start);
  }
  return undefined;
}

function metaContent(html: string, keys: readonly string[]) {
  const wanted = new Set(keys.map((key) => key.toLocaleLowerCase()));
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const parsed = attributes(match[0]);
    const key = (parsed.property ?? parsed.name ?? parsed.itemprop)?.toLocaleLowerCase();
    if (key && wanted.has(key) && parsed.content?.trim()) return parsed.content.trim();
  }
  return undefined;
}

function elementTextById(html: string, id: string) {
  const inner = extractElementInnerHtml(html, id);
  return inner === undefined ? undefined : htmlToText(inner);
}

function normalizePublishedAt(value: string | undefined) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d{10,13}$/u.test(trimmed)) {
    const milliseconds = Number(trimmed) * (trimmed.length === 10 ? 1_000 : 1);
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.valueOf()) ? trimmed : date.toISOString();
}

function inferLanguage(raw: string) {
  const value = raw.toLocaleLowerCase();
  const match = value.match(/(?:language|lang|brush)[-_:\s]+([a-z0-9+#.-]+)/u)?.[1] ?? value;
  if (/\b(?:r|rscript)\b/u.test(match)) return "R";
  if (/\b(?:py|python)\b/u.test(match)) return "Python";
  if (/\b(?:jl|julia)\b/u.test(match)) return "Julia";
  if (/\b(?:matlab|octave)\b/u.test(match)) return "MATLAB";
  if (/\b(?:js|javascript|typescript|ts)\b/u.test(match)) return "JavaScript";
  if (/\b(?:sh|shell|bash|zsh)\b/u.test(match)) return "Shell";
  if (/\b(?:sql)\b/u.test(match)) return "SQL";
  return "text";
}

function codeMedia(language: string) {
  switch (language) {
    case "R":
      return { extension: "R", mediaType: "text/x-r" };
    case "Python":
      return { extension: "py", mediaType: "text/x-python" };
    case "Julia":
      return { extension: "jl", mediaType: "text/x-julia" };
    case "MATLAB":
      return { extension: "m", mediaType: "text/x-matlab" };
    case "JavaScript":
      return { extension: "js", mediaType: "text/javascript" };
    case "Shell":
      return { extension: "sh", mediaType: "text/x-shellscript" };
    case "SQL":
      return { extension: "sql", mediaType: "application/sql" };
    default:
      return { extension: "txt", mediaType: "text/plain" };
  }
}

function parseArticle(html: string) {
  const articleHtml =
    extractElementInnerHtml(html, "js_content") ??
    extractElementInnerHtml(html, undefined, "article") ??
    extractElementInnerHtml(html, undefined, "body") ??
    html;
  const bodyText = htmlToText(articleHtml);
  const title =
    metaContent(html, ["og:title", "twitter:title"]) ??
    elementTextById(html, "activity-name") ??
    htmlToText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? "") ??
    "Untitled captured article";
  const author =
    metaContent(html, ["author", "article:author", "og:article:author"]) ??
    elementTextById(html, "js_name") ??
    elementTextById(html, "rich_media_meta_nickname");
  const publishedScript =
    html.match(/\b(?:ct|publish_time)\s*[:=]\s*["']?(\d{10,13}|[^"';\n<]+)["']?/iu)?.[1];
  const publishedAt = normalizePublishedAt(
    metaContent(html, ["article:published_time", "publishdate", "date"]) ?? publishedScript,
  );
  const description = metaContent(html, ["og:description", "description"]);

  const images: PositionedImage[] = [];
  for (const match of articleHtml.matchAll(/<img\b[^>]*>/giu)) {
    const parsed = attributes(match[0]);
    const url = parsed["data-src"] ?? parsed["data-original"] ?? parsed.src;
    if (!url) continue;
    images.push({
      position: match.index ?? 0,
      url,
      ...(parsed.alt?.trim() ? { alt: parsed.alt.trim() } : {}),
    });
  }

  const codes: PositionedCode[] = [];
  const preRanges: Array<[number, number]> = [];
  for (const match of articleHtml.matchAll(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/giu)) {
    const text = htmlToText(match[2] ?? "");
    const position = match.index ?? 0;
    preRanges.push([position, position + match[0].length]);
    if (text && Buffer.byteLength(text) <= MAX_CODE_BYTES) {
      codes.push({ position, text, language: inferLanguage(match[1] ?? "") });
    }
  }
  for (const match of articleHtml.matchAll(/<code\b([^>]*)>([\s\S]*?)<\/code>/giu)) {
    const position = match.index ?? 0;
    if (preRanges.some(([start, end]) => position >= start && position < end)) continue;
    const text = htmlToText(match[2] ?? "");
    if (text && Buffer.byteLength(text) <= MAX_CODE_BYTES) {
      codes.push({ position, text, language: inferLanguage(match[1] ?? "") });
    }
  }
  codes.sort((left, right) => left.position - right.position);

  const contexts: PositionedContext[] = [];
  const seenContext = new Set<string>();
  for (const match of articleHtml.matchAll(
    /<(?:p|h[1-6]|li|blockquote|figcaption)\b[^>]*>([\s\S]*?)<\/(?:p|h[1-6]|li|blockquote|figcaption)>/giu,
  )) {
    const text = htmlToText(match[1] ?? "");
    if (!text || Buffer.byteLength(text) > MAX_CONTEXT_BYTES) continue;
    const digest = sha256(text);
    if (seenContext.has(digest)) continue;
    seenContext.add(digest);
    contexts.push({ position: match.index ?? 0, text });
    if (contexts.length >= MAX_CONTEXT_BLOCKS) break;
  }
  if (!contexts.length && bodyText) contexts.push({ position: 0, text: bodyText.slice(0, MAX_CONTEXT_BYTES) });

  return {
    title: title.trim() || "Untitled captured article",
    ...(author?.trim() ? { author: author.trim() } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(description?.trim() ? { description: description.trim() } : {}),
    bodyText,
    images,
    codes,
    contexts,
  } satisfies ParsedArticle;
}

function challengeKind(status: number, html: string) {
  if (status === 401 || status === 407) return "capture_login_required";
  if ([403, 409, 423, 429, 503].includes(status)) return "capture_challenge";
  const login = /(?:id=["']login|need_login|请先登录|登录后继续)/iu.test(html);
  if (login) return "capture_login_required";
  const challenge = /(?:verify_wx|waf_captcha|为了保护你的网络安全|访问过于频繁|当前(?:网络)?环境异常|请完成(?:安全)?验证|拖动滑块完成拼图)/iu.test(
    html,
  );
  return challenge ? "capture_challenge" : undefined;
}

function normalizeFetchUrl(value: string, base?: string) {
  let parsed: URL;
  try {
    parsed = new URL(value, base);
  } catch (error) {
    throw new CaptureError("invalid_capture_url", `invalid capture URL: ${value}`, {
      cause: error,
    });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new CaptureError("invalid_capture_url", "capture URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new CaptureError("invalid_capture_url", "capture URL must not contain credentials");
  }
  const host = parsed.hostname.toLocaleLowerCase().replace(/^\[|\]$/gu, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new CaptureError("unsafe_capture_url", `capture URL uses a local hostname: ${host}`);
  }
  if (isIP(host) && isNonPublicAddress(host)) {
    throw new CaptureError("unsafe_capture_url", `capture URL uses a non-public address: ${host}`);
  }
  parsed.hash = "";
  return parsed;
}

function ipv4Number(address: string) {
  if (isIP(address) !== 4) return undefined;
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) return undefined;
  return (
    (((octets[0] ?? 0) << 24) >>> 0) +
    ((octets[1] ?? 0) << 16) +
    ((octets[2] ?? 0) << 8) +
    (octets[3] ?? 0)
  ) >>> 0;
}

function ipv4InCidr(value: number, network: string, prefix: number) {
  const base = ipv4Number(network);
  if (base === undefined) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function ipv6Number(address: string) {
  if (isIP(address) !== 6) return undefined;
  let normalized = address.toLocaleLowerCase().split("%", 1)[0] ?? "";
  const ipv4Tail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (ipv4Tail) {
    const ipv4 = ipv4Number(ipv4Tail);
    if (ipv4 === undefined) return undefined;
    normalized = `${normalized.slice(0, normalized.length - ipv4Tail.length)}${(
      (ipv4 >>> 16) & 0xffff
    ).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) {
    return undefined;
  }
  return groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

function ipv6InCidr(value: bigint, network: string, prefix: number) {
  const base = ipv6Number(network);
  if (base === undefined) return false;
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (base >> shift);
}

function isNonPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    if (value === undefined) return true;
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      // Azure's host virtual service address is globally numbered but only meaningful
      // from inside a guest network, so treat it like other metadata/platform endpoints.
      ["168.63.129.16", 32],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([network, prefix]) => ipv4InCidr(value, network as string, prefix as number));
  }
  if (family === 6) {
    const value = ipv6Number(address);
    if (value === undefined) return true;
    const mappedPrefix = ipv6Number("::ffff:0:0");
    if (mappedPrefix !== undefined && (value >> 32n) === (mappedPrefix >> 32n)) {
      return isNonPublicAddress(
        `${Number((value >> 24n) & 255n)}.${Number((value >> 16n) & 255n)}.${Number(
          (value >> 8n) & 255n,
        )}.${Number(value & 255n)}`,
      );
    }
    const nat64Prefix = ipv6Number("64:ff9b::");
    if (nat64Prefix !== undefined && (value >> 32n) === (nat64Prefix >> 32n)) {
      return isNonPublicAddress(
        `${Number((value >> 24n) & 255n)}.${Number((value >> 16n) & 255n)}.${Number(
          (value >> 8n) & 255n,
        )}.${Number(value & 255n)}`,
      );
    }
    // Currently routable IPv6 global unicast is 2000::/3. Everything else is
    // reserved/non-global unless handled explicitly above (for example NAT64).
    if (!ipv6InCidr(value, "2000::", 3)) return true;
    return [
      ["::", 96],
      ["64:ff9b:1::", 48],
      ["100::", 64],
      ["2001::", 32],
      ["2001:2::", 48],
      ["2001:10::", 28],
      ["2001:20::", 28],
      ["2001:db8::", 32],
      ["2002::", 16],
      ["3fff::", 20],
      ["5f00::", 16],
      ["fc00::", 7],
      ["fe80::", 10],
      ["fec0::", 10],
      ["ff00::", 8],
    ].some(([network, prefix]) => ipv6InCidr(value, network as string, prefix as number));
  }
  return true;
}

function normalizedHostname(value: string) {
  return value.toLocaleLowerCase().replace(/^\[|\]$/gu, "");
}

function pinnedLookup(
  expectedHostname: string,
  addresses: readonly CaptureResolvedAddress[],
): LookupFunction {
  const expected = normalizedHostname(expectedHostname);
  const pinned = addresses.map((address) => ({ ...address }));
  return (requestedHostname, options, callback) => {
    if (normalizedHostname(requestedHostname) !== expected) {
      const error = new Error(
        `controlled capture lookup refused unexpected hostname ${requestedHostname}`,
      ) as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "", 0);
      return;
    }
    if (options.all) {
      callback(null, pinned.map((address) => ({ ...address })));
      return;
    }
    const selected = pinned[0];
    if (!selected) {
      const error = new Error(
        "controlled capture lookup has no pinned address",
      ) as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "", 0);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

function headersFromIncomingMessage(headers: http.IncomingHttpHeaders) {
  const converted = new Headers();
  for (const [name, raw] of Object.entries(headers)) {
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) converted.append(name, value);
    } else {
      converted.append(name, raw);
    }
  }
  return converted;
}

function nodePinnedRequest(input: CaptureTransportRequest) {
  return new Promise<Response>((resolve, reject) => {
    const requestFunction = input.url.protocol === "https:" ? https.request : http.request;
    const request = requestFunction(input.requestOptions, (incoming) => {
      try {
        const status = incoming.statusCode ?? 500;
        const bodyForbidden = status === 204 || status === 205 || status === 304;
        if (bodyForbidden) incoming.resume();
        const body = bodyForbidden
          ? null
          : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        resolve(
          new Response(body, {
            status,
            statusText: incoming.statusMessage,
            headers: headersFromIncomingMessage(incoming.headers),
          }),
        );
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.once("error", reject);
    request.end();
  });
}

function fetchTransport(fetchImpl: FetchLike): CaptureRequestTransport {
  return (input) =>
    fetchImpl(input.url, {
      method: "GET",
      redirect: "manual",
      signal: input.requestOptions.signal,
      headers: input.requestOptions.headers as HeadersInit,
    });
}

function imageFormat(bytes: Uint8Array, _header: string, _sourceUrl: string) {
  const signature = Buffer.from(bytes.subarray(0, 16));
  let mediaType = "";
  if (signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mediaType = "image/png";
  } else if (signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) {
    mediaType = "image/jpeg";
  } else if (signature.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/u)) {
    mediaType = "image/gif";
  } else if (
    signature.subarray(0, 4).toString("ascii") === "RIFF" &&
    signature.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    mediaType = "image/webp";
  } else if (/^\s*<svg\b/iu.test(new TextDecoder().decode(bytes.subarray(0, 512)))) {
    mediaType = "image/svg+xml";
  }
  if (!mediaType) return undefined;
  const extension: Record<string, string> = {
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
  };
  return { mediaType, extension: extension[mediaType] ?? "img" };
}

function nearestContextIds(position: number, contexts: Array<{ position: number; blockId: string }>) {
  return [...contexts]
    .sort(
      (left, right) =>
        Math.abs(left.position - position) - Math.abs(right.position - position) ||
        left.position - right.position,
    )
    .slice(0, 2)
    .map((item) => item.blockId);
}

function validStoredAsset(value: unknown, idKey: "assetId" | "blockId") {
  if (!value || typeof value !== "object") return false;
  const asset = value as Record<string, unknown>;
  return (
    typeof asset[idKey] === "string" &&
    SAFE_SEGMENT.test(asset[idKey] as string) &&
    typeof asset.file === "string" &&
    typeof asset.bytes === "number" &&
    Number.isSafeInteger(asset.bytes) &&
    (asset.bytes as number) >= 0 &&
    typeof asset.sha256 === "string" &&
    HASH.test(asset.sha256 as string) &&
    typeof asset.mediaType === "string" &&
    typeof asset.sourceUrl === "string"
  );
}

function assertCaptureManifest(value: unknown): asserts value is CaptureManifestV1 {
  if (!value || typeof value !== "object") {
    throw new CaptureError("invalid_capture_manifest", "capture manifest is not an object");
  }
  const item = value as Partial<CaptureManifestV1>;
  if (
    item.schema !== CAPTURE_MANIFEST_SCHEMA ||
    typeof item.captureId !== "string" ||
    !SAFE_SEGMENT.test(item.captureId) ||
    typeof item.captureDigest !== "string" ||
    !HASH.test(item.captureDigest) ||
    !item.source ||
    typeof item.source.finalUrl !== "string" ||
    !item.article ||
    typeof item.article.title !== "string" ||
    !validStoredAsset(item.rawPayload, "assetId") ||
    !Array.isArray(item.visualAssets) ||
    !item.visualAssets.every((asset) => validStoredAsset(asset, "assetId")) ||
    !Array.isArray(item.codeBlocks) ||
    !item.codeBlocks.every((asset) => validStoredAsset(asset, "blockId")) ||
    !Array.isArray(item.context) ||
    !item.context.every((asset) => validStoredAsset(asset, "blockId"))
  ) {
    throw new CaptureError("invalid_capture_manifest", "capture manifest failed validation");
  }
  const storedAssets: CaptureStoredAsset[] = [
    item.rawPayload as CaptureRawPayload,
    ...item.visualAssets,
    ...item.codeBlocks,
    ...item.context,
  ];
  for (const asset of storedAssets) validateRelativeFile(asset.file);
}

function assertCaptureState(value: unknown, captureId: string): asserts value is CaptureStateV1 {
  if (!value || typeof value !== "object") {
    throw new CaptureError("invalid_capture_state", "capture state is not an object");
  }
  const state = value as Partial<CaptureStateV1>;
  if (
    state.schema !== CAPTURE_STATE_SCHEMA ||
    state.captureId !== captureId ||
    !["active", "archived"].includes(state.status ?? "") ||
    typeof state.updatedAt !== "string"
  ) {
    throw new CaptureError("invalid_capture_state", "capture state failed validation");
  }
}

function recordFrom(manifest: CaptureManifestV1, state: CaptureStateV1): CaptureRecord {
  return {
    ...manifest,
    state: state.status,
    stateUpdatedAt: state.updatedAt,
    ...(state.lastArchivedAt ? { archivedAt: state.lastArchivedAt } : {}),
    ...(state.lastRestoredAt ? { restoredAt: state.lastRestoredAt } : {}),
  };
}

async function nearestExistingDirectory(candidate: string) {
  let current = path.resolve(candidate);
  while (true) {
    try {
      const stat = await fs.lstat(current);
      return stat.isDirectory() && !stat.isSymbolicLink() ? current : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function boundedResponseBytes(
  response: Response,
  maximum: number,
  timeoutMs = FETCH_TIMEOUT_MS,
  deadline?: CaptureDeadline,
) {
  try {
    deadline?.throwIfAborted();
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel().catch(() => undefined);
    throw new CaptureError("capture_payload_too_large", `response exceeds ${maximum} bytes`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximum) {
      throw new CaptureError("capture_payload_too_large", `response exceeds ${maximum} bytes`);
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new CaptureError("capture_fetch_timeout", "capture response body timed out")),
      timeoutMs,
    );
  });
  const readWithLimits = <T>(operation: Promise<T>) => {
    const requestLimited = Promise.race([operation, timedOut]);
    return deadline ? deadline.race(requestLimited) : requestLimited;
  };
  try {
    while (true) {
      const item = await readWithLimits(reader.read());
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new CaptureError("capture_payload_too_large", `response exceeds ${maximum} bytes`);
      }
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof CaptureError) throw error;
    throw new CaptureError(
      "capture_network_error",
      `capture response body failed: ${(error as Error).message}`,
      { cause: error },
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total));
}

function receiptMatch(value: unknown, captureId: string, captureHashes: Set<string>) {
  if (!value || typeof value !== "object") return undefined;
  const receipt = value as Record<string, unknown>;
  const required = receipt.requiredAssetSha256;
  const inventory = receipt.assetInventory;
  if (
    receipt.schema !== MATERIALIZATION_RECEIPT_SCHEMA ||
    receipt.captureId !== captureId ||
    receipt.selfContained !== true ||
    typeof receipt.receiptId !== "string" ||
    !SAFE_SEGMENT.test(receipt.receiptId) ||
    typeof receipt.templateId !== "string" ||
    !SAFE_SEGMENT.test(receipt.templateId) ||
    typeof receipt.revisionId !== "string" ||
    !SAFE_SEGMENT.test(receipt.revisionId) ||
    typeof receipt.contentDigest !== "string" ||
    !HASH.test(receipt.contentDigest) ||
    typeof receipt.committedAt !== "string" ||
    Number.isNaN(Date.parse(receipt.committedAt)) ||
    !Array.isArray(required) ||
    !required.length ||
    !required.every((hash) => typeof hash === "string" && HASH.test(hash) && captureHashes.has(hash)) ||
    !Array.isArray(inventory) ||
    !inventory.every((asset) => {
      if (!asset || typeof asset !== "object") return false;
      const item = asset as Record<string, unknown>;
      return (
        typeof item.logicalPath === "string" &&
        typeof item.role === "string" &&
        ["visual", "code", "data", "metadata", "context", "provenance"].includes(item.role) &&
        typeof item.bytes === "number" &&
        Number.isSafeInteger(item.bytes) &&
        item.bytes >= 0 &&
        typeof item.sha256 === "string" &&
        HASH.test(item.sha256)
      );
    })
  ) {
    return undefined;
  }
  const inventoryHashes = new Set(
    inventory.map((asset) => (asset as Record<string, unknown>).sha256 as string),
  );
  if (!(required as string[]).every((hash) => inventoryHashes.has(hash))) return undefined;
  const selectionDigest = receipt.selectionDigest;
  if (selectionDigest !== undefined && (typeof selectionDigest !== "string" || !HASH.test(selectionDigest))) {
    return undefined;
  }
  return {
    receiptId: receipt.receiptId as string,
    templateId: receipt.templateId as string,
    revisionId: receipt.revisionId as string,
    contentDigest: receipt.contentDigest as string,
    committedAt: receipt.committedAt as string,
    requiredAssetSha256: [...new Set(required as string[])].sort(),
    ...(typeof selectionDigest === "string" ? { selectionDigest } : {}),
  };
}

export class CaptureStore {
  root?: string;
  source: CaptureDirectoryStatus["source"];
  readonly libraryRoot?: string;
  private projectDirectory?: string;
  private projectIdentity?: string;
  private libraryRootProvider?: CaptureLibraryRootProvider;
  private readonly resolver: CaptureResolver;
  private readonly requestTransport: CaptureRequestTransport;
  private readonly requestTimeoutMs: number;
  private readonly captureTimeoutMs: number;

  constructor(
    root?: string,
    fetchImpl?: FetchLike,
    resolver?: CaptureResolver,
    requestTransport?: CaptureRequestTransport,
    requestTimeoutMs = FETCH_TIMEOUT_MS,
    captureTimeoutMs = CAPTURE_TOTAL_TIMEOUT_MS,
    libraryRootProvider?: CaptureLibraryRootProvider,
  ) {
    const explicit = root?.trim();
    const environment = process.env.FIGURE_CAPTURE_DIR?.trim();
    const selected = explicit || environment;
    this.root = selected ? path.resolve(selected) : undefined;
    this.source = explicit ? "constructor" : environment ? "environment" : "unconfigured";
    const environmentLibraryRoot = process.env.FIGURE_LIBRARY_DIR?.trim() || undefined;
    this.libraryRoot = path.resolve(
      environmentLibraryRoot ?? path.join(os.homedir(), ".figure-library"),
    );
    this.libraryRootProvider = libraryRootProvider;
    this.resolver =
      resolver ??
      (async (hostname) => {
        const answers = await dnsLookup(hostname, { all: true, verbatim: true });
        return answers.map((answer) => ({
          address: answer.address,
          family: answer.family as 4 | 6,
        }));
      });
    // fetchImpl is retained as a compatibility/test seam. Production calls do not use
    // global fetch: Node's HTTP(S) transport below consumes the controlled lookup options.
    this.requestTransport =
      requestTransport ?? (fetchImpl ? fetchTransport(fetchImpl) : nodePinnedRequest);
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new CaptureError("invalid_capture_timeout", "capture timeout must be a positive integer");
    }
    if (!Number.isSafeInteger(captureTimeoutMs) || captureTimeoutMs <= 0) {
      throw new CaptureError(
        "invalid_capture_deadline",
        "capture total deadline must be a positive integer",
      );
    }
    this.requestTimeoutMs = requestTimeoutMs;
    this.captureTimeoutMs = captureTimeoutMs;
  }

  setLibraryRootProvider(provider?: CaptureLibraryRootProvider) {
    this.libraryRootProvider = provider;
    return this;
  }

  private async effectiveLibraryRoot() {
    if (this.libraryRootProvider) {
      const selected = (await this.libraryRootProvider()).trim();
      if (!selected || !path.isAbsolute(selected)) {
        throw new CaptureError(
          "capture_library_root_invalid",
          "the canonical Library root provider must return an absolute directory path",
        );
      }
      return path.resolve(selected);
    }
    return path.resolve(this.libraryRoot || path.join(os.homedir(), ".figure-library"));
  }

  private async assertManagedStoreBoundary() {
    if (!this.root) {
      throw new CaptureError("capture_not_configured", "Capture is not configured");
    }
    let rootStat;
    try {
      rootStat = await fs.lstat(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new CaptureError(
        "capture_path_unsafe",
        "Capture root must be a real non-symlink directory",
      );
    }
    const canonicalRoot = path.resolve(await fs.realpath(this.root));
    for (const directory of [
      path.join(this.root, "captures"),
      path.join(this.root, "operations"),
    ]) {
      try {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new CaptureError(
            "capture_path_unsafe",
            `Capture managed directory must be real, not a symlink: ${directory}`,
          );
        }
        const canonical = path.resolve(await fs.realpath(directory));
        if (!pathContains(canonicalRoot, canonical)) {
          throw new CaptureError(
            "capture_path_unsafe",
            `Capture managed directory escapes the Capture root: ${directory}`,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async assertCaptureDirectoryBoundary(captureId: string) {
    await this.assertManagedStoreBoundary();
    if (!this.root) throw new CaptureError("capture_not_configured", "Capture is not configured");
    const directory = this.captureDirectory(captureId);
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new CaptureError(
          "capture_path_unsafe",
          `Capture record directory must be real, not a symlink: ${captureId}`,
        );
      }
      const canonicalRoot = path.resolve(await fs.realpath(this.root));
      const canonical = path.resolve(await fs.realpath(directory));
      if (!pathContains(canonicalRoot, canonical)) {
        throw new CaptureError(
          "capture_path_unsafe",
          `Capture record directory escapes the Capture root: ${captureId}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async assertRegularManagedFileIfExists(file: string, label: string) {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new CaptureError(
          "capture_path_unsafe",
          `${label} must be a regular non-symlink file`,
        );
      }
      if (!this.root) throw new CaptureError("capture_not_configured", "Capture is not configured");
      const canonicalRoot = path.resolve(await fs.realpath(this.root));
      const canonical = path.resolve(await fs.realpath(file));
      if (!pathContains(canonicalRoot, canonical)) {
        throw new CaptureError("capture_path_unsafe", `${label} escapes the Capture root`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /**
   * Bind an otherwise-unconfigured process to the trusted host project. Explicit constructor
   * and FIGURE_CAPTURE_DIR roots always win. A project binding is intentionally process-local:
   * the same project is idempotent, while a second project is rejected rather than mixing raw
   * Capture payloads between Wisp projects.
   */
  async bindProjectDirectory(projectDirectory?: string) {
    const supplied = projectDirectory?.trim();
    if (!supplied || this.source === "constructor" || this.source === "environment") return;
    if (!path.isAbsolute(supplied)) {
      throw new CaptureError(
        "capture_project_invalid",
        "trusted projectDirectory must be an absolute host-local directory",
      );
    }

    const requested = path.resolve(supplied);
    let canonical: string;
    try {
      canonical = path.resolve(await fs.realpath(requested));
      const stat = await fs.stat(canonical);
      if (!stat.isDirectory()) {
        throw new CaptureError(
          "capture_project_invalid",
          "trusted projectDirectory is not a directory",
        );
      }
    } catch (error) {
      if (error instanceof CaptureError) throw error;
      throw new CaptureError(
        "capture_project_invalid",
        `cannot resolve trusted projectDirectory: ${(error as Error).message}`,
        { cause: error },
      );
    }

    const identity = process.platform === "win32" ? canonical.toLocaleLowerCase() : canonical;
    // Re-check after the awaits above so two concurrent first calls cannot bind different roots.
    if (this.projectIdentity) {
      if (this.projectIdentity !== identity) {
        throw new CaptureError(
          "capture_project_mismatch",
          `this plugin process is already bound to ${this.projectDirectory}; refusing a different projectDirectory`,
        );
      }
      return;
    }

    this.projectIdentity = identity;
    this.projectDirectory = canonical;
    this.root = path.join(canonical, ".wisp", "figure-captures");
    this.source = "project";
  }

  async status(): Promise<CaptureDirectoryStatus> {
    if (!this.root) {
      return {
        configured: false,
        enabled: false,
        source: "unconfigured",
        isolated: true,
        exists: false,
        readable: false,
        writable: false,
        creatable: false,
        available: false,
        reason:
          "Capture needs FIGURE_CAPTURE_DIR or a trusted projectDirectory; it is disabled without affecting the library",
      };
    }
    let libraryRoot: string;
    try {
      libraryRoot = await this.effectiveLibraryRoot();
    } catch (error) {
      return {
        configured: true,
        enabled: false,
        source: this.source,
        root: this.root,
        ...(this.projectDirectory ? { projectDirectory: this.projectDirectory } : {}),
        isolated: false,
        exists: false,
        readable: false,
        writable: false,
        creatable: false,
        available: false,
        reason: `cannot resolve the current canonical Library root: ${(error as Error).message}`,
      };
    }
    const [canonicalCaptureRoot, canonicalLibraryRoot] = await Promise.all([
      canonicalFuturePath(this.root),
      canonicalFuturePath(libraryRoot),
    ]);
    if (
      this.projectDirectory &&
      !pathContains(this.projectDirectory, canonicalCaptureRoot ?? this.root)
    ) {
      return {
        configured: true,
        enabled: false,
        source: this.source,
        root: this.root,
        projectDirectory: this.projectDirectory,
        libraryRoot,
        isolated: true,
        exists: false,
        readable: false,
        writable: false,
        creatable: false,
        available: false,
        reason:
          "project-local Capture path escapes projectDirectory through an intermediate symbolic link",
      };
    }
    const isolated = !rootsOverlap(
      canonicalCaptureRoot ?? this.root,
      canonicalLibraryRoot ?? libraryRoot,
    );
    if (!isolated) {
      const exists = await fs.lstat(this.root).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          return false;
        },
      );
      return {
        configured: true,
        enabled: false,
        source: this.source,
        root: this.root,
        ...(this.projectDirectory ? { projectDirectory: this.projectDirectory } : {}),
        libraryRoot,
        isolated: false,
        exists,
        readable: false,
        writable: false,
        creatable: false,
        available: false,
        reason: "FIGURE_CAPTURE_DIR must be completely separate from FIGURE_LIBRARY_DIR",
      };
    }
    try {
      const stat = await fs.lstat(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return {
          configured: true,
          enabled: false,
          source: this.source,
          root: this.root,
          ...(this.projectDirectory ? { projectDirectory: this.projectDirectory } : {}),
          libraryRoot,
          isolated: true,
          exists: true,
          readable: false,
          writable: false,
          creatable: false,
          available: false,
          reason: "FIGURE_CAPTURE_DIR must be a real directory, not a file or symbolic link",
        };
      }
      try {
        await this.assertManagedStoreBoundary();
      } catch (error) {
        return {
          configured: true,
          enabled: false,
          source: this.source,
          root: this.root,
          ...(this.projectDirectory ? { projectDirectory: this.projectDirectory } : {}),
          libraryRoot,
          isolated: true,
          exists: true,
          readable: false,
          writable: false,
          creatable: false,
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      const readable = await fs.access(this.root, fsConstants.R_OK).then(
        () => true,
        () => false,
      );
      const writable = await fs.access(this.root, fsConstants.W_OK).then(
        () => true,
        () => false,
      );
      return {
        configured: true,
        enabled: readable && writable,
        source: this.source,
        root: this.root,
        ...(this.projectDirectory ? { projectDirectory: this.projectDirectory } : {}),
        libraryRoot,
        isolated: true,
        exists: true,
        readable,
        writable,
        creatable: false,
        available: readable && writable,
        ...(!readable || !writable
          ? { reason: "FIGURE_CAPTURE_DIR is not both readable and writable" }
          : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          configured: true,
          enabled: false,
          source: this.source,
          root: this.root,
          ...(this.projectDirectory ? { projectDirectory: this.projectDirectory } : {}),
          libraryRoot,
          isolated: true,
          exists: false,
          readable: false,
          writable: false,
          creatable: false,
          available: false,
          reason: `cannot inspect FIGURE_CAPTURE_DIR: ${(error as Error).message}`,
        };
      }
      const ancestor = await nearestExistingDirectory(this.root);
      const creatable = Boolean(
        ancestor &&
          (await fs.access(ancestor, fsConstants.W_OK).then(
            () => true,
            () => false,
          )),
      );
      return {
        configured: true,
        enabled: creatable,
        source: this.source,
        root: this.root,
        ...(this.projectDirectory ? { projectDirectory: this.projectDirectory } : {}),
        libraryRoot,
        isolated: true,
        exists: false,
        readable: false,
        writable: creatable,
        creatable,
        available: creatable,
        ...(!creatable ? { reason: "FIGURE_CAPTURE_DIR cannot be created" } : {}),
      };
    }
  }

  private async ensureStore() {
    const status = await this.status();
    if (!status.configured) {
      throw new CaptureError("capture_not_configured", status.reason ?? "Capture is not configured");
    }
    if (!status.isolated) {
      throw new CaptureError("capture_directory_conflict", status.reason ?? "Capture directory overlaps the library");
    }
    if (!status.available || !this.root) {
      throw new CaptureError("capture_directory_unavailable", status.reason ?? "Capture directory is unavailable");
    }
    await fs.mkdir(this.root, { recursive: true });
    const rootStat = await fs.lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new CaptureError(
        "capture_directory_unavailable",
        "Capture root must remain a real directory while it is initialized",
      );
    }
    await this.assertManagedStoreBoundary();
    await this.ensureLocalGitignore();
    for (const directory of [
      path.join(this.root, "captures"),
      path.join(this.root, "operations"),
    ]) {
      try {
        await fs.mkdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new CaptureError(
          "capture_path_unsafe",
          `Capture managed directory must be real, not a symlink: ${directory}`,
        );
      }
    }
    await this.assertManagedStoreBoundary();
    return this.root;
  }

  private async ensureLocalGitignore() {
    if (!this.root) return;
    const target = path.join(this.root, ".gitignore");
    const marker = "# ScientificFigureLibrary project-local Raw Capture";
    const managedBlock = `${marker}\n*\n!.gitignore\n`;
    let existing = "";
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new CaptureError(
          "capture_gitignore_invalid",
          "Capture-local .gitignore must be a regular file",
        );
      }
      existing = await fs.readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing.includes(marker)) return;
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    await fs.appendFile(target, `${separator}${managedBlock}`, { encoding: "utf8" });
  }

  private captureDirectory(captureId: string) {
    if (!this.root) throw new CaptureError("capture_not_configured", "Capture is not configured");
    return path.join(this.root, "captures", assertSafeSegment(captureId, "captureId"));
  }

  private operationFile(operationId: string) {
    if (!this.root) throw new CaptureError("capture_not_configured", "Capture is not configured");
    return path.join(
      this.root,
      "operations",
      `${assertSafeSegment(operationId, "operationId")}.json`,
    );
  }

  private async assertPublicResolution(url: URL, deadline: CaptureDeadline) {
    deadline.throwIfAborted();
    const hostname = normalizedHostname(url.hostname);
    const literalFamily = isIP(hostname);
    if (literalFamily) {
      if (isNonPublicAddress(hostname)) {
        throw new CaptureError(
          "unsafe_capture_address",
          `capture target resolves to a non-public address: ${hostname}`,
        );
      }
      return [{ address: hostname, family: literalFamily as 4 | 6 }];
    }

    let answers: readonly CaptureResolvedAddress[];
    try {
      answers = await deadline.race(this.resolver(hostname));
    } catch (error) {
      if (isCaptureAbort(error)) throw error;
      throw new CaptureError(
        "capture_dns_error",
        `cannot resolve capture hostname ${hostname}: ${(error as Error).message}`,
        { cause: error },
      );
    }
    if (!answers.length) {
      throw new CaptureError(
        "capture_dns_unresolved",
        `capture hostname did not resolve to an A or AAAA address: ${hostname}`,
      );
    }
    const normalized = answers.map((answer) => ({
      address: answer.address.toLocaleLowerCase().split("%", 1)[0] ?? answer.address,
      family: answer.family,
    }));
    for (const answer of normalized) {
      const detectedFamily = isIP(answer.address);
      if (
        (answer.family !== 4 && answer.family !== 6) ||
        detectedFamily !== answer.family ||
        isNonPublicAddress(answer.address)
      ) {
        throw new CaptureError(
          "unsafe_capture_address",
          `capture hostname ${hostname} resolved to a non-public or invalid address: ${answer.address}`,
        );
      }
    }
    return normalized.filter(
      (answer, index) =>
        normalized.findIndex(
          (candidate) =>
            candidate.family === answer.family && candidate.address === answer.address,
        ) === index,
    );
  }

  private async fetchFollowingRedirects(url: URL, accept: string, deadline: CaptureDeadline) {
    let current = url;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      deadline.throwIfAborted();
      // Resolve every redirect hop exactly once. The resulting public addresses are then
      // returned by a controlled lookup callback, so the socket cannot trigger a second,
      // attacker-controlled DNS resolution between validation and connect.
      const resolvedAddresses = await this.assertPublicResolution(current, deadline);
      const controller = new AbortController();
      let requestTimedOut = false;
      const timeout = setTimeout(() => {
        requestTimedOut = true;
        controller.abort();
      }, this.requestTimeoutMs);
      const abortForCapture = () => controller.abort(deadline.signal.reason);
      deadline.signal.addEventListener("abort", abortForCapture, { once: true });
      let response: Response;
      let transportPromise: Promise<Response> | undefined;
      try {
        const hostname = normalizedHostname(current.hostname);
        const headers = {
          Accept: accept,
          "Accept-Encoding": "identity",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
          Connection: "close",
          Host: current.host,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ScientificFigureLibrary/0.4",
        };
        const requestOptions: https.RequestOptions & { autoSelectFamily?: boolean } = {
          protocol: current.protocol,
          hostname,
          ...(current.port ? { port: Number(current.port) } : {}),
          path: `${current.pathname}${current.search}`,
          method: "GET",
          headers,
          signal: controller.signal,
          lookup: pinnedLookup(hostname, resolvedAddresses),
          // A fresh socket ensures another request cannot contribute a pooled connection
          // whose peer address predates this hop's DNS validation.
          agent: false,
          family: resolvedAddresses.length === 1 ? resolvedAddresses[0]?.family : 0,
          autoSelectFamily: resolvedAddresses.length > 1,
          ...(current.protocol === "https:"
            ? {
                // Keep the original DNS name for SNI and certificate identity checks even
                // though lookup returns a validated IP address for the actual connection.
                ...(isIP(hostname) ? {} : { servername: hostname }),
                rejectUnauthorized: true,
              }
            : {}),
        };
        transportPromise = this.requestTransport({
          url: current,
          resolvedAddresses,
          requestOptions,
        });
        response = await deadline.race(transportPromise);
      } catch (error) {
        if (deadline.signal.aborted || isCaptureAbort(error)) {
          // A custom/test transport may ignore AbortSignal and resolve after the deadline
          // race. Dispose that late body without allowing it to resume the capture pipeline.
          void transportPromise
            ?.then((lateResponse) => lateResponse.body?.cancel().catch(() => undefined))
            .catch(() => undefined);
          throw deadline.error();
        }
        const aborted =
          requestTimedOut || controller.signal.aborted || (error as Error).name === "AbortError";
        throw new CaptureError(
          aborted ? "capture_fetch_timeout" : "capture_network_error",
          aborted
            ? `capture request timed out: ${current.toString()}`
            : `capture request failed: ${(error as Error).message}`,
          { cause: error },
        );
      } finally {
        clearTimeout(timeout);
        deadline.signal.removeEventListener("abort", abortForCapture);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) {
          throw new CaptureError("capture_redirect_invalid", "capture redirect omitted Location");
        }
        if (redirect === MAX_REDIRECTS) {
          throw new CaptureError("capture_redirect_limit", "capture exceeded the redirect limit");
        }
        current = normalizeFetchUrl(location, current.toString());
        continue;
      }
      const finalUrl = response.url ? normalizeFetchUrl(response.url, current.toString()) : current;
      if (finalUrl.toString() !== current.toString()) {
        await response.body?.cancel().catch(() => undefined);
        throw new CaptureError(
          "capture_transport_redirected",
          "capture transport followed a redirect instead of returning it for validation",
        );
      }
      return { response, finalUrl };
    }
    throw new CaptureError("capture_redirect_limit", "capture exceeded the redirect limit");
  }

  private async loadManifest(captureId: string) {
    await this.assertCaptureDirectoryBoundary(captureId);
    const directory = this.captureDirectory(captureId);
    await this.assertRegularManagedFileIfExists(
      path.join(directory, "manifest.json"),
      "Capture manifest",
    );
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new CaptureError("invalid_capture_manifest", `cannot read capture ${captureId}`, {
        cause: error,
      });
    }
    assertCaptureManifest(value);
    if (value.captureId !== captureId) {
      throw new CaptureError("invalid_capture_manifest", "captureId does not match its directory");
    }
    return value;
  }

  private async loadState(captureId: string) {
    await this.assertCaptureDirectoryBoundary(captureId);
    const directory = this.captureDirectory(captureId);
    await this.assertRegularManagedFileIfExists(path.join(directory, "state.json"), "Capture state");
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(path.join(directory, "state.json"), "utf8"));
    } catch (error) {
      throw new CaptureError("invalid_capture_state", `cannot read capture state ${captureId}`, {
        cause: error,
      });
    }
    assertCaptureState(value, captureId);
    return value;
  }

  private async writeState(captureId: string, state: CaptureStateV1) {
    await this.assertCaptureDirectoryBoundary(captureId);
    const directory = this.captureDirectory(captureId);
    const target = path.join(directory, "state.json");
    await this.assertRegularManagedFileIfExists(target, "Capture state");
    const transactionId = randomUUID();
    const temporary = path.join(directory, `.state-${transactionId}.json`);
    const backup = path.join(directory, `.state-${transactionId}.backup.json`);
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
    try {
      await fs.rename(target, backup);
      try {
        await fs.rename(temporary, target);
      } catch (error) {
        await fs.rename(backup, target).catch(() => undefined);
        throw error;
      }
      await fs.rm(backup, { force: true }).catch(() => undefined);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

  private async readOperation(operationId: string) {
    await this.assertManagedStoreBoundary();
    await this.assertRegularManagedFileIfExists(
      this.operationFile(operationId),
      "Capture operation receipt",
    );
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(this.operationFile(operationId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new CaptureError("invalid_capture_operation", `cannot read operation ${operationId}`, {
        cause: error,
      });
    }
    const receipt = value as Partial<OperationReceiptV1>;
    if (
      receipt.schema !== CAPTURE_OPERATION_SCHEMA ||
      receipt.operationId !== operationId ||
      typeof receipt.requestedUrl !== "string" ||
      typeof receipt.captureId !== "string" ||
      !SAFE_SEGMENT.test(receipt.captureId) ||
      typeof receipt.rawSha256 !== "string" ||
      !HASH.test(receipt.rawSha256)
    ) {
      throw new CaptureError("invalid_capture_operation", `operation ${operationId} is invalid`);
    }
    return receipt as OperationReceiptV1;
  }

  private async writeOperation(receipt: OperationReceiptV1, deadline: CaptureDeadline) {
    await this.assertManagedStoreBoundary();
    const file = this.operationFile(receipt.operationId);
    await this.assertRegularManagedFileIfExists(file, "Capture operation receipt");
    let handle: fs.FileHandle | undefined;
    let created = false;
    try {
      deadline.throwIfAborted();
      try {
        // Holding the exclusive handle tells rollback that this invocation, rather than a
        // concurrent replay, created the receipt path. The full write is awaited before use.
        handle = await fs.open(file, "wx");
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.readOperation(receipt.operationId);
        if (
          !existing ||
          existing.requestedUrl !== receipt.requestedUrl ||
          existing.captureId !== receipt.captureId ||
          existing.rawSha256 !== receipt.rawSha256
        ) {
          throw new CaptureError(
            "capture_operation_conflict",
            `operationId ${receipt.operationId} was already used for another capture`,
          );
        }
        return false;
      }
      deadline.throwIfAborted();
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      await handle.sync();
      deadline.throwIfAborted();
      return true;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (created) await fs.rm(file, { force: true });
      if (deadline.signal.aborted) throw deadline.error();
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async rollbackOperation(receipt: OperationReceiptV1) {
    const existing = await this.readOperation(receipt.operationId).catch(() => undefined);
    if (
      existing?.requestedUrl === receipt.requestedUrl &&
      existing.captureId === receipt.captureId &&
      existing.rawSha256 === receipt.rawSha256 &&
      existing.completedAt === receipt.completedAt
    ) {
      await fs.rm(this.operationFile(receipt.operationId), { force: true });
    }
  }

  async captureArticle(input: CaptureArticleInput): Promise<CaptureRecord> {
    const deadline = new CaptureDeadline(this.captureTimeoutMs, input.signal);
    try {
      return await this.captureArticleWithinDeadline(input, deadline);
    } finally {
      deadline.dispose();
    }
  }

  private async captureArticleWithinDeadline(
    input: CaptureArticleInput,
    deadline: CaptureDeadline,
  ): Promise<CaptureRecord> {
    deadline.throwIfAborted();
    await deadline.race(this.ensureStore());
    const requested = normalizeFetchUrl(input.url);
    const requestedUrl = requested.toString();
    const operationId = input.operationId
      ? assertSafeSegment(input.operationId, "operationId")
      : undefined;
    if (operationId) {
      const existingOperation = await deadline.race(this.readOperation(operationId));
      if (existingOperation) {
        if (existingOperation.requestedUrl !== requestedUrl) {
          throw new CaptureError(
            "capture_operation_conflict",
            `operationId ${operationId} was already used for another URL`,
          );
        }
        const existing = await deadline.race(this.get(existingOperation.captureId));
        if (!existing || existing.source.rawSha256 !== existingOperation.rawSha256) {
          throw new CaptureError(
            "capture_operation_incomplete",
            `operationId ${operationId} refers to a missing or inconsistent capture`,
          );
        }
        return existing;
      }
    }

    const { response, finalUrl } = await this.fetchFollowingRedirects(
      requested,
      "text/html,application/xhtml+xml;q=0.9,*/*;q=0.2",
      deadline,
    );
    const rawBytes = await boundedResponseBytes(
      response,
      MAX_ARTICLE_BYTES,
      this.requestTimeoutMs,
      deadline,
    );
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLocaleLowerCase() || "text/html";
    const html = new TextDecoder("utf-8", { fatal: false }).decode(rawBytes);
    const challenge = challengeKind(response.status, html);
    if (challenge) {
      throw new CaptureError(
        challenge,
        challenge === "capture_login_required"
          ? "article capture requires authentication; no capture was stored"
          : "article capture encountered a challenge, CAPTCHA, or rate limit; no capture was stored",
      );
    }
    if (!response.ok) {
      throw new CaptureError(
        "capture_http_error",
        `article request returned HTTP ${response.status}; no capture was stored`,
      );
    }
    if (!mediaType.includes("html") && !/^\s*(?:<!doctype\s+html|<html|<article|<div)/iu.test(html)) {
      throw new CaptureError(
        "capture_not_html",
        `article response is not HTML (${mediaType}); no capture was stored`,
      );
    }

    const parsed = parseArticle(html);
    deadline.throwIfAborted();
    const warnings: CaptureWarning[] = [];
    if (!parsed.bodyText) {
      warnings.push({ code: "article_body_empty", message: "No readable article body text was found" });
    }
    if (parsed.images.length > MAX_VISUAL_ASSETS) {
      warnings.push({
        code: "visual_asset_limit",
        message: `Only the first ${MAX_VISUAL_ASSETS} image references were considered`,
      });
    }
    if (parsed.codes.length > MAX_CODE_BLOCKS) {
      warnings.push({
        code: "code_block_limit",
        message: `Only the first ${MAX_CODE_BLOCKS} code blocks were stored`,
      });
    }
    if (parsed.contexts.length >= MAX_CONTEXT_BLOCKS) {
      warnings.push({
        code: "context_block_limit",
        message: `Article context was limited to ${MAX_CONTEXT_BLOCKS} blocks`,
      });
    }

    const payloads = new Map<string, Uint8Array>();
    const rawDigest = sha256(rawBytes);
    const rawPayload: CaptureRawPayload = {
      assetId: `raw-${rawDigest.slice(0, 20)}`,
      file: "raw/article.html",
      bytes: rawBytes.byteLength,
      sha256: rawDigest,
      mediaType: "text/html",
      sourceUrl: finalUrl.toString(),
    };
    payloads.set(rawPayload.file, rawBytes);

    const context: CaptureContextBlock[] = [];
    const positionedContext: Array<{ position: number; blockId: string }> = [];
    for (const candidate of parsed.contexts.slice(0, MAX_CONTEXT_BLOCKS)) {
      const bytes = new TextEncoder().encode(`${candidate.text}\n`);
      if (bytes.byteLength > MAX_CONTEXT_BYTES) continue;
      const digest = sha256(bytes);
      const blockId = `context-${digest.slice(0, 20)}`;
      positionedContext.push({ position: candidate.position, blockId });
      if (context.some((item) => item.blockId === blockId)) continue;
      const file = `context/${blockId}.txt`;
      context.push({
        blockId,
        file,
        bytes: bytes.byteLength,
        sha256: digest,
        mediaType: "text/plain",
        sourceUrl: finalUrl.toString(),
        text: candidate.text,
      });
      payloads.set(file, bytes);
    }

    const codeBlocks: CaptureCodeBlock[] = [];
    for (const candidate of parsed.codes.slice(0, MAX_CODE_BLOCKS)) {
      const bytes = new TextEncoder().encode(`${candidate.text}\n`);
      const digest = sha256(bytes);
      const blockId = `code-${digest.slice(0, 20)}`;
      const contextBlockIds = nearestContextIds(candidate.position, positionedContext);
      const existing = codeBlocks.find((item) => item.blockId === blockId);
      if (existing) {
        existing.contextBlockIds = [...new Set([...existing.contextBlockIds, ...contextBlockIds])];
        continue;
      }
      const format = codeMedia(candidate.language);
      const file = `code/${blockId}.${format.extension}`;
      codeBlocks.push({
        blockId,
        file,
        bytes: bytes.byteLength,
        sha256: digest,
        mediaType: format.mediaType,
        sourceUrl: finalUrl.toString(),
        language: candidate.language,
        excerpt: candidate.text.slice(0, 280),
        contextBlockIds,
      });
      payloads.set(file, bytes);
    }

    const visualAssets: CaptureVisualAsset[] = [];
    let totalImageBytes = 0;
    const fetchedByUrl = new Map<string, CaptureVisualAsset>();
    for (const candidate of parsed.images.slice(0, MAX_VISUAL_ASSETS)) {
      deadline.throwIfAborted();
      let imageUrl: URL;
      try {
        imageUrl = normalizeFetchUrl(candidate.url, finalUrl.toString());
      } catch (error) {
        warnings.push({
          code: (error as CaptureError).code ?? "invalid_image_url",
          message: `Skipped image reference: ${(error as Error).message}`,
          sourceUrl: candidate.url.slice(0, 1_000),
        });
        continue;
      }
      const normalizedImageUrl = imageUrl.toString();
      const contextBlockIds = nearestContextIds(candidate.position, positionedContext);
      const previouslyFetched = fetchedByUrl.get(normalizedImageUrl);
      if (previouslyFetched) {
        previouslyFetched.contextBlockIds = [
          ...new Set([...previouslyFetched.contextBlockIds, ...contextBlockIds]),
        ];
        continue;
      }
      try {
        const imageResponse = await this.fetchFollowingRedirects(
          imageUrl,
          "image/*,*/*;q=0.2",
          deadline,
        );
        if (!imageResponse.response.ok) {
          await imageResponse.response.body?.cancel().catch(() => undefined);
          throw new CaptureError(
            "image_http_error",
            `image request returned HTTP ${imageResponse.response.status}`,
          );
        }
        const bytes = await boundedResponseBytes(
          imageResponse.response,
          MAX_IMAGE_BYTES,
          this.requestTimeoutMs,
          deadline,
        );
        if (totalImageBytes + bytes.byteLength > MAX_TOTAL_IMAGE_BYTES) {
          throw new CaptureError(
            "visual_asset_total_limit",
            `stored images would exceed ${MAX_TOTAL_IMAGE_BYTES} bytes`,
          );
        }
        const format = imageFormat(
          bytes,
          imageResponse.response.headers.get("content-type") ?? "",
          imageResponse.finalUrl.toString(),
        );
        if (!format) {
          throw new CaptureError("image_media_invalid", "response is not a recognized image");
        }
        const digest = sha256(bytes);
        const assetId = `visual-${digest.slice(0, 20)}`;
        const duplicate = visualAssets.find((item) => item.assetId === assetId);
        if (duplicate) {
          duplicate.contextBlockIds = [...new Set([...duplicate.contextBlockIds, ...contextBlockIds])];
          fetchedByUrl.set(normalizedImageUrl, duplicate);
          continue;
        }
        const file = `visual/${assetId}.${format.extension}`;
        const asset: CaptureVisualAsset = {
          assetId,
          file,
          bytes: bytes.byteLength,
          sha256: digest,
          mediaType: format.mediaType,
          sourceUrl: imageResponse.finalUrl.toString(),
          ...(imageResponse.finalUrl.toString() !== normalizedImageUrl
            ? { requestedSourceUrl: normalizedImageUrl }
            : {}),
          ...(candidate.alt ? { alt: candidate.alt } : {}),
          contextBlockIds,
        };
        visualAssets.push(asset);
        fetchedByUrl.set(normalizedImageUrl, asset);
        payloads.set(file, bytes);
        totalImageBytes += bytes.byteLength;
      } catch (error) {
        if (isCaptureAbort(error)) throw error;
        const captureError = error as CaptureError;
        warnings.push({
          code: captureError.code ?? "image_fetch_failed",
          message: `Image was not stored: ${(error as Error).message}`,
          sourceUrl: normalizedImageUrl,
        });
      }
    }

    deadline.throwIfAborted();

    const capturedAt = new Date().toISOString();
    const captureId = `capture-${sha256(`${finalUrl.toString()}\0${rawDigest}`).slice(0, 24)}`;
    const assetDigests = [
      rawPayload.sha256,
      ...visualAssets.map((item) => item.sha256),
      ...codeBlocks.map((item) => item.sha256),
      ...context.map((item) => item.sha256),
    ].sort();
    const captureDigest = sha256(
      canonicalJson({
        finalUrl: finalUrl.toString(),
        rawSha256: rawDigest,
        article: parsed.title,
        assetDigests,
      }),
    );
    const storedBytes = [...payloads.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
    const manifest: CaptureManifestV1 = {
      schema: CAPTURE_MANIFEST_SCHEMA,
      captureId,
      captureDigest,
      createdAt: capturedAt,
      ...(operationId ? { operationId } : {}),
      source: {
        url: requestedUrl,
        finalUrl: finalUrl.toString(),
        host: finalUrl.hostname,
        sourceKind: /(?:^|\.)mp\.weixin\.qq\.com$/iu.test(finalUrl.hostname)
          ? "wechat"
          : "web",
        fetchMode: "http-first",
        capturedAt,
        httpStatus: response.status,
        mediaType,
        rawSha256: rawDigest,
      },
      article: {
        title: parsed.title,
        ...(parsed.author ? { author: parsed.author } : {}),
        ...(parsed.publishedAt ? { publishedAt: parsed.publishedAt } : {}),
        ...(parsed.description ? { description: parsed.description } : {}),
        bodyTextSha256: sha256(parsed.bodyText),
      },
      rawPayload,
      visualAssets,
      codeBlocks,
      context,
      warnings,
      totals: {
        visualAssets: visualAssets.length,
        codeBlocks: codeBlocks.length,
        contextBlocks: context.length,
        storedBytes,
      },
    };

    const root = await deadline.race(this.ensureStore());
    const capturesRoot = path.join(root, "captures");
    const target = path.join(capturesRoot, captureId);
    const staging = path.join(capturesRoot, `.staging-${captureId}-${randomUUID()}`);
    const operationReceipt: OperationReceiptV1 | undefined = operationId
      ? {
          schema: CAPTURE_OPERATION_SCHEMA,
          operationId,
          requestedUrl,
          captureId,
          rawSha256: rawDigest,
          completedAt: new Date().toISOString(),
        }
      : undefined;
    let createdTarget = false;
    let createdOperation = false;
    deadline.throwIfAborted();
    await fs.mkdir(staging, { recursive: false });
    try {
      for (const [file, bytes] of payloads) {
        deadline.throwIfAborted();
        const destination = resolveStoredFile(staging, file);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        deadline.throwIfAborted();
        await fs.writeFile(destination, bytes, { flag: "wx", signal: deadline.signal });
      }
      const state: CaptureStateV1 = {
        schema: CAPTURE_STATE_SCHEMA,
        captureId,
        status: "active",
        updatedAt: capturedAt,
      };
      deadline.throwIfAborted();
      await fs.writeFile(
        path.join(staging, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { flag: "wx", signal: deadline.signal },
      );
      deadline.throwIfAborted();
      await fs.writeFile(
        path.join(staging, "state.json"),
        `${JSON.stringify(state, null, 2)}\n`,
        { flag: "wx", signal: deadline.signal },
      );
      deadline.throwIfAborted();
      try {
        await fs.rename(staging, target);
        createdTarget = true;
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY", "EPERM"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        ) {
          throw error;
        }
        await fs.rm(staging, { recursive: true, force: true });
        const existing = await this.get(captureId);
        if (!existing || existing.source.rawSha256 !== rawDigest) {
          throw new CaptureError("capture_id_collision", `captureId collision for ${captureId}`);
        }
      }
      // The commit boundary remains abortable after staging -> target. If cancellation wins
      // here, only the target created by this exact rename is rolled back below.
      deadline.throwIfAborted();
      if (operationReceipt) {
        createdOperation = await this.writeOperation(operationReceipt, deadline);
      }
      const stored = await deadline.race(this.get(captureId));
      if (!stored) {
        throw new CaptureError("capture_write_failed", `capture ${captureId} was not stored`);
      }
      deadline.complete();
      return stored;
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      if (createdOperation && operationReceipt) {
        await this.rollbackOperation(operationReceipt);
      }
      if (createdTarget) {
        await fs.rm(target, { recursive: true, force: true });
      }
      if (deadline.signal.aborted) throw deadline.error();
      throw error;
    }
  }

  async list(input: CaptureListInput = {}): Promise<CaptureSummary[]> {
    if (!this.root) return [];
    const status = await this.status();
    if (!status.isolated || !status.exists || !status.readable) return [];
    const capturesRoot = path.join(this.root, "captures");
    let entries;
    try {
      entries = await fs.readdir(capturesRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries: CaptureSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || !SAFE_SEGMENT.test(entry.name)) continue;
      const record = await this.get(entry.name);
      if (!record || (!input.includeArchived && record.state === "archived")) continue;
      summaries.push({
        captureId: record.captureId,
        state: record.state,
        title: record.article.title,
        sourceUrl: record.source.finalUrl,
        capturedAt: record.source.capturedAt,
        visualAssetCount: record.visualAssets.length,
        codeBlockCount: record.codeBlocks.length,
        contextBlockCount: record.context.length,
        warningCount: record.warnings.length,
      });
    }
    return summaries.sort(
      (left, right) =>
        right.capturedAt.localeCompare(left.capturedAt) || left.captureId.localeCompare(right.captureId),
    );
  }

  async get(captureId: string): Promise<CaptureRecord | undefined> {
    assertSafeSegment(captureId, "captureId");
    if (!this.root) return undefined;
    const manifest = await this.loadManifest(captureId);
    if (!manifest) return undefined;
    const state = await this.loadState(captureId);
    return recordFrom(manifest, state);
  }

  private async checkedAsset(captureId: string, assetId: string) {
    assertSafeSegment(assetId, "assetId");
    const safeCaptureId = assertSafeSegment(captureId, "captureId");
    const recordDirectory = this.captureDirectory(safeCaptureId);
    const recordStat = await fs.lstat(recordDirectory);
    if (!recordStat.isDirectory() || recordStat.isSymbolicLink()) {
      throw new CaptureError(
        "capture_record_invalid",
        `capture record is not a real directory: ${captureId}`,
      );
    }
    const canonicalRecordDirectory = await fs.realpath(recordDirectory);
    const manifest = await this.loadManifest(safeCaptureId);
    if (!manifest) throw new CaptureError("capture_not_found", `unknown capture: ${captureId}`);
    const assets: Array<{
      id: string;
      asset: CaptureRawPayload | CaptureVisualAsset | CaptureCodeBlock | CaptureContextBlock;
    }> = [
      { id: manifest.rawPayload.assetId, asset: manifest.rawPayload },
      ...manifest.visualAssets.map((asset) => ({ id: asset.assetId, asset })),
      ...manifest.codeBlocks.map((asset) => ({ id: asset.blockId, asset })),
      ...manifest.context.map((asset) => ({ id: asset.blockId, asset })),
    ];
    const selected = assets.find((item) => item.id === assetId)?.asset;
    if (!selected) {
      throw new CaptureError("capture_asset_not_found", `unknown capture asset: ${assetId}`);
    }
    const sourcePath = resolveStoredFile(recordDirectory, selected.file);
    let canonicalSourcePath: string;
    try {
      canonicalSourcePath = await fs.realpath(sourcePath);
    } catch (error) {
      throw new CaptureError(
        "capture_asset_invalid",
        `cannot resolve capture asset: ${assetId}`,
        { cause: error },
      );
    }
    if (
      canonicalSourcePath === canonicalRecordDirectory ||
      !pathContains(canonicalRecordDirectory, canonicalSourcePath)
    ) {
      throw new CaptureError(
        "capture_asset_path_escape",
        `capture asset resolves outside its capture record: ${assetId}`,
      );
    }

    // The stored manifest permits only nested portable paths. Reject a symlink in any parent
    // component even when it currently points back inside the record: immutable Capture assets
    // must not depend on a mutable directory indirection.
    const normalizedFile = validateRelativeFile(selected.file);
    let parent = recordDirectory;
    for (const segment of normalizedFile.split("/").slice(0, -1)) {
      parent = path.join(parent, segment);
      const parentStat = await fs.lstat(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        throw new CaptureError(
          "capture_asset_parent_invalid",
          `capture asset parent is not a real directory: ${assetId}`,
        );
      }
    }

    const stat = await fs.lstat(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new CaptureError("capture_asset_invalid", `capture asset is not a regular file: ${assetId}`);
    }
    if (stat.size !== selected.bytes) {
      throw new CaptureError("capture_asset_size_mismatch", `capture asset size mismatch: ${assetId}`);
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    let handle;
    try {
      handle = await fs.open(sourcePath, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      throw new CaptureError(
        "capture_asset_invalid",
        `cannot securely open capture asset: ${assetId}`,
        { cause: error },
      );
    }
    let bytes: Uint8Array;
    try {
      const openedStat = await handle.stat();
      if (
        !openedStat.isFile() ||
        openedStat.dev !== stat.dev ||
        openedStat.ino !== stat.ino
      ) {
        throw new CaptureError(
          "capture_asset_changed",
          `capture asset changed while it was being opened: ${assetId}`,
        );
      }
      const [recordAfterOpen, sourceAfterOpen] = await Promise.all([
        fs.realpath(recordDirectory),
        fs.realpath(sourcePath),
      ]);
      if (
        recordAfterOpen !== canonicalRecordDirectory ||
        sourceAfterOpen !== canonicalSourcePath ||
        !pathContains(recordAfterOpen, sourceAfterOpen)
      ) {
        throw new CaptureError(
          "capture_asset_changed",
          `capture asset path changed while it was being opened: ${assetId}`,
        );
      }
      bytes = new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
    if (bytes.byteLength !== selected.bytes) {
      throw new CaptureError("capture_asset_size_mismatch", `capture asset size mismatch: ${assetId}`);
    }
    if (sha256(bytes) !== selected.sha256) {
      throw new CaptureError("capture_asset_checksum_mismatch", `capture asset checksum mismatch: ${assetId}`);
    }
    return { asset: selected, bytes, sourcePath };
  }

  async readAsset(captureId: string, assetId: string) {
    const { asset, bytes } = await this.checkedAsset(captureId, assetId);
    return { asset, bytes };
  }

  /** Internal handoff for immutable Revision planning; never expose sourcePath through MCP. */
  async verifiedAssetSource(captureId: string, assetId: string) {
    const { asset, sourcePath } = await this.checkedAsset(captureId, assetId);
    return { asset, sourcePath };
  }

  async archive(captureId: string) {
    await this.ensureStore();
    const record = await this.get(captureId);
    if (!record) throw new CaptureError("capture_not_found", `unknown capture: ${captureId}`);
    if (record.state === "archived") return record;
    const previous = await this.loadState(captureId);
    const now = new Date().toISOString();
    await this.writeState(captureId, {
      ...previous,
      status: "archived",
      updatedAt: now,
      lastArchivedAt: now,
    });
    return (await this.get(captureId)) as CaptureRecord;
  }

  async restore(captureId: string) {
    await this.ensureStore();
    const record = await this.get(captureId);
    if (!record) throw new CaptureError("capture_not_found", `unknown capture: ${captureId}`);
    if (record.state === "active") return record;
    const previous = await this.loadState(captureId);
    const now = new Date().toISOString();
    await this.writeState(captureId, {
      ...previous,
      status: "active",
      updatedAt: now,
      lastRestoredAt: now,
    });
    return (await this.get(captureId)) as CaptureRecord;
  }

  async planCleanup(input: CaptureCleanupInput): Promise<CaptureCleanupPlanV1> {
    if (!(["prune_payload", "full_purge"] as const).includes(input.mode)) {
      throw new CaptureError("invalid_cleanup_mode", `unsupported cleanup mode: ${String(input.mode)}`);
    }
    const record = await this.get(assertSafeSegment(input.captureId, "captureId"));
    if (!record) throw new CaptureError("capture_not_found", `unknown capture: ${input.captureId}`);
    const payloadAssets = [
      record.rawPayload,
      ...record.visualAssets,
      ...record.codeBlocks,
      ...record.context,
    ];
    const captureHashes = new Set(payloadAssets.map((asset) => asset.sha256));
    const matchedReceipts = (input.durableReceipts ?? [])
      .map((receipt) => receiptMatch(receipt, record.captureId, captureHashes))
      .filter((receipt): receipt is NonNullable<typeof receipt> => Boolean(receipt))
      .sort((left, right) => left.receiptId.localeCompare(right.receiptId));
    const blockers: CaptureCleanupBlocker[] = [];
    if (!matchedReceipts.length) {
      blockers.push({
        code: "materialization_receipt_required",
        message:
          "No durable self-contained SFL materialization receipt covers the selected Capture assets",
      });
    }
    const selectedAssetSha256 = [
      ...new Set(matchedReceipts.flatMap((receipt) => receipt.requiredAssetSha256)),
    ].sort();
    const selectedHashes = new Set(selectedAssetSha256);
    const selectedPayloads = [
      { id: record.rawPayload.assetId, asset: record.rawPayload },
      ...record.visualAssets.map((asset) => ({ id: asset.assetId, asset })),
      ...record.codeBlocks.map((asset) => ({ id: asset.blockId, asset })),
      ...record.context.map((asset) => ({ id: asset.blockId, asset })),
    ].filter(({ asset }) => selectedHashes.has(asset.sha256));
    for (const selected of selectedPayloads) {
      try {
        await this.checkedAsset(record.captureId, selected.id);
      } catch (error) {
        blockers.push({
          code: "selected_capture_payload_integrity_failed",
          message:
            `A selected Capture payload no longer matches its recorded size/SHA-256 (${selected.id}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        });
        break;
      }
    }
    const payloadFiles = [...new Set(payloadAssets.map((asset) => asset.file))].sort();
    const planWithoutDigest = {
      schema: CAPTURE_CLEANUP_PLAN_SCHEMA,
      captureId: record.captureId,
      mode: input.mode,
      createdAt: new Date().toISOString(),
      state: record.state,
      ready: blockers.length === 0,
      blockers,
      matchedReceipts,
      selectedAssetSha256,
      payload: {
        files: payloadFiles,
        bytes: payloadAssets.reduce((total, asset) => total + asset.bytes, 0),
      },
      preservedMetadataFiles:
        input.mode === "prune_payload"
          ? ["manifest.json", "state.json", "future-cleanup-tombstone.json"]
          : ["future-cleanup-receipt.json", "future-capture-id-tombstone.json"],
      deletionEnabled: false as const,
      written: false as const,
    };
    return {
      ...planWithoutDigest,
      planDigest: sha256(canonicalJson(planWithoutDigest)),
    };
  }

  async applyCleanup(_input: {
    captureId: string;
    mode: CleanupMode;
    operationId?: string;
    planDigest?: string;
  }): Promise<never> {
    throw new CaptureError(
      "cleanup_not_enabled",
      "cleanup_not_enabled: physical Capture deletion is intentionally disabled in this release",
    );
  }
}
