#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";

const root = path.resolve(import.meta.dirname, "..");
const materializeAt = process.argv[2];
const serverEntry =
  process.env.FIGURE_LIBRARY_SMOKE_SERVER ?? path.join(root, "dist", "index.js");
const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-smoke-"));
const libraryDirectory = path.join(smokeRoot, "library");
const projectDirectory = path.join(smokeRoot, "plot-project");
const captureDirectory = path.join(projectDirectory, ".wisp", "figure-captures");
const sourceDirectory = path.join(smokeRoot, "source");
await Promise.all([fs.mkdir(sourceDirectory), fs.mkdir(projectDirectory)]);
const codePath = path.join(sourceDirectory, "smoke-plot.R");
await fs.writeFile(codePath, "# unique-smoke-ridge-reference\n");
const plannedCodePath = path.join(sourceDirectory, "planned-smoke-plot.R");
await fs.writeFile(plannedCodePath, "# planned-smoke-lifecycle-reference\n");
const transferImage = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const transferPackagePath = path.join(sourceDirectory, "figure-transfer-package.zip");
const transferManifest = {
  schema: "figure-transfer-package.v1",
  version: 1,
  producer: { name: "CiteBox", version: "smoke" },
  exportedAt: "2026-08-01T00:00:00Z",
  source: {
    sourceId: "smoke-paper",
    figureId: "1",
    parentFigureId: null,
    figureLabel: "Fig 1",
    subfigureLabels: [],
    caption: "MCP smoke transfer figure",
    page: 1,
    paper: {
      title: "MCP Smoke Paper",
      authors: [],
      year: 2026,
      journal: null,
      doi: null,
      url: null,
    },
    license: { scope: "unknown", text: null },
  },
  figure: {
    file: "figure.png",
    mediaType: "image/png",
    bytes: transferImage.byteLength,
    sha256: createHash("sha256").update(transferImage).digest("hex"),
  },
};
await fs.writeFile(
  transferPackagePath,
  zipSync({
    "manifest.json": strToU8(JSON.stringify(transferManifest)),
    "figure.png": transferImage,
  }),
);

const captureFixtureHtml = await fs.readFile(
  path.join(root, "tests", "fixtures", "wechat-article.html"),
);
const capturePng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const captureWebp = new Uint8Array([
  82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32,
]);
const fixtureServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/s/smoke") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(captureFixtureHtml);
    return;
  }
  if (url.pathname === "/test/figure.png") {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(capturePng);
    return;
  }
  if (url.pathname === "/test/figure.webp") {
    response.writeHead(200, { "content-type": "image/webp" });
    response.end(captureWebp);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("missing fixture");
});
await new Promise((resolve, reject) => {
  fixtureServer.once("error", reject);
  fixtureServer.listen(0, "127.0.0.1", resolve);
});
const fixtureAddress = fixtureServer.address();
if (!fixtureAddress || typeof fixtureAddress === "string") {
  throw new Error("capture fixture server did not expose a TCP address");
}
const fixtureOrigin = `http://127.0.0.1:${fixtureAddress.port}`;
const captureTransportShimPath = path.join(sourceDirectory, "capture-transport-shim.mjs");
await fs.writeFile(
  captureTransportShimPath,
  `import dnsPromises from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const fixtureOrigin = process.env.FIGURE_CAPTURE_SMOKE_ORIGIN;
const fixtureHosts = new Set(["mp.weixin.qq.com", "mmbiz.qpic.cn"]);
if (!fixtureOrigin) throw new Error("FIGURE_CAPTURE_SMOKE_ORIGIN is required by the test shim");
const fixture = new URL(fixtureOrigin);
const nativeLookup = dnsPromises.lookup.bind(dnsPromises);
const nativeHttpRequest = http.request.bind(http);
const nativeHttpsRequest = https.request.bind(https);

function normalizedHostname(value) {
  return String(value ?? "").toLocaleLowerCase().replace(/^\\[|\\]$/gu, "");
}

function requestHostname(first, second) {
  let value;
  if (first instanceof URL || typeof first === "string") {
    value = new URL(first).hostname;
  } else if (first && typeof first === "object") {
    value = first.hostname ?? first.host;
  }
  if (second && typeof second === "object") value = second.hostname ?? second.host ?? value;
  return normalizedHostname(String(value ?? "").split(":", 1)[0]);
}

dnsPromises.lookup = async (hostname, options) => {
  if (!fixtureHosts.has(normalizedHostname(hostname))) return nativeLookup(hostname, options);
  const answer = { address: "93.184.216.34", family: 4 };
  return options && typeof options === "object" && options.all ? [answer] : answer;
};

function mappedRequest(nativeRequest, args) {
  const first = args[0];
  const second = args[1];
  const callback = args.findLast((value) => typeof value === "function");
  if (!fixtureHosts.has(requestHostname(first, second))) return nativeRequest(...args);
  const sourceOptions =
    first instanceof URL || typeof first === "string"
      ? second && typeof second === "object"
        ? second
        : {}
      : first;
  const mappedOptions = {
    ...sourceOptions,
    protocol: fixture.protocol,
    hostname: fixture.hostname,
    port: Number(fixture.port),
    agent: false,
    lookup: undefined,
    family: undefined,
    autoSelectFamily: undefined,
    servername: undefined,
    rejectUnauthorized: undefined,
  };
  return callback
    ? nativeHttpRequest(mappedOptions, callback)
    : nativeHttpRequest(mappedOptions);
}

http.request = (...args) => mappedRequest(nativeHttpRequest, args);
https.request = (...args) => mappedRequest(nativeHttpsRequest, args);
syncBuiltinESMExports();
`,
);

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);
childEnvironment.FIGURE_LIBRARY_DIR = libraryDirectory;
delete childEnvironment.FIGURE_CAPTURE_DIR;
childEnvironment.FIGURE_CAPTURE_SMOKE_ORIGIN = fixtureOrigin;

const client = new Client({ name: "scientific-figure-library-smoke", version: "0.4.2" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", captureTransportShimPath, serverEntry],
  stderr: "pipe",
  env: childEnvironment,
});
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function structuredPayload(result) {
  return isRecord(result.structuredContent) ? result.structuredContent : {};
}

function nestedRecord(value, ...keys) {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    if (isRecord(value[key])) return value[key];
  }
  return undefined;
}

function lifecyclePlan(result) {
  const output = structuredPayload(result);
  return nestedRecord(output, "plan", "lifecyclePlan") ?? output;
}

function lifecycleApplyResult(result) {
  const output = structuredPayload(result);
  return nestedRecord(output, "result", "applyResult", "receipt") ?? output;
}

function captureRecord(result) {
  const output = structuredPayload(result);
  return nestedRecord(output, "capture", "record", "item") ?? output;
}

function captureStatus(result) {
  const output = structuredPayload(result);
  return nestedRecord(output, "captureStatus", "status", "directoryStatus") ?? output;
}

function reviewDetail(result) {
  const output = structuredPayload(result);
  return nestedRecord(output, "detail", "reviewDetail") ?? output;
}

function reviewSeries(detail) {
  return nestedRecord(detail, "series", "templateSeries") ?? detail;
}

function contentBlockText(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function assertSuccessful(result, label) {
  if (result.isError) {
    throw new Error(`${label} failed: ${contentBlockText(result)}`);
  }
  return result;
}

const legacyTools = [
  "figure_library_open",
  "figure_library_search",
  "figure_library_import",
  "figure_library_plan_import",
  "figure_library_apply_import",
  "figure_library_diff",
  "figure_library_upsert",
  "figure_library_sync",
  "figure_library_archive",
  "figure_library_preview",
  "figure_library_source_status",
  "figure_library_audit",
  "figure_library_reconcile",
  "figure_library_describe",
  "figure_library_materialize",
];

const captureTools = [
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
];

const versionedTools = [
  "figure_library_plan_working_revision",
  "figure_library_apply_working_revision",
  "figure_library_review_open",
  "figure_library_plan_review_gate_update",
  "figure_library_apply_review_gate_update",
  "figure_library_plan_publish_working_revision",
  "figure_library_apply_publish_working_revision",
  "figure_library_plan_discard_working_revision",
  "figure_library_apply_discard_working_revision",
  "figure_library_plan_restore_release",
  "figure_library_apply_restore_release",
  "figure_library_plan_adopt_versioning",
  "figure_library_apply_adopt_versioning",
  "figure_library_template_history",
  "figure_library_diff_revisions",
];

const projectTools = [
  "figure_library_plan_bind_global",
  "figure_library_apply_bind_global",
  "figure_library_plan_recover_write_lock",
  "figure_library_apply_recover_write_lock",
  "figure_library_project_status",
  "figure_library_plan_project_use",
  "figure_library_apply_project_use",
];

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const required of [...legacyTools, ...captureTools, ...versionedTools, ...projectTools]) {
    if (!names.includes(required)) throw new Error(`missing tool ${required}`);
  }
  const appCallableTools = [
    "figure_library_open",
    "figure_library_search",
    "figure_capture_open",
    "figure_capture_article",
    "figure_capture_list",
    "figure_capture_get",
    "figure_capture_annotation_open",
    "figure_capture_asset",
    "figure_capture_plan_cleanup",
    "figure_library_review_open",
    "figure_library_template_history",
    "figure_library_diff_revisions",
  ];
  for (const toolName of appCallableTools) {
    const listed = tools.tools.find((tool) => tool.name === toolName);
    const visibility = listed?._meta?.ui?.visibility;
    if (JSON.stringify(visibility) !== JSON.stringify(["model", "app"])) {
      throw new Error(
        `${toolName} is not explicitly App-callable: ${JSON.stringify(listed?._meta)}`,
      );
    }
  }

  const initialSourceStatus = assertSuccessful(
    await client.callTool({
      name: "figure_library_source_status",
      arguments: { projectDirectory },
    }),
    "project-bound source status smoke call",
  );
  const initialCaptureStatus = initialSourceStatus.structuredContent?.captureStatus;
  if (
    initialSourceStatus.structuredContent?.serverVersion !== "0.4.2" ||
    initialCaptureStatus?.source !== "project" ||
    initialCaptureStatus?.projectDirectory !== projectDirectory ||
    initialCaptureStatus?.root !== captureDirectory ||
    initialCaptureStatus?.available !== true
  ) {
    throw new Error(
      `source status did not bind project-local Capture: ${JSON.stringify(
        initialSourceStatus.structuredContent,
      )}`,
    );
  }

  const captureOpened = assertSuccessful(
    await client.callTool({
      name: "figure_capture_open",
      arguments: { projectDirectory },
    }),
    "capture open smoke call",
  );
  const openedCaptureStatus = captureStatus(captureOpened);
  const effectiveCaptureRoot =
    openedCaptureStatus.root ?? openedCaptureStatus.captureDirectory;
  if (
    openedCaptureStatus.configured !== true ||
    openedCaptureStatus.available !== true ||
    effectiveCaptureRoot !== captureDirectory
  ) {
    throw new Error(
      `capture open did not report the isolated temporary directory: ${JSON.stringify(
        captureOpened.structuredContent,
      )}`,
    );
  }

  const captureArticleResult = assertSuccessful(
    await client.callTool({
      name: "figure_capture_article",
      arguments: {
        projectDirectory,
        url: "https://mp.weixin.qq.com/s/smoke",
        operationId: "smoke-capture-article",
      },
    }),
    "offline capture article smoke call",
  );
  const captured = captureRecord(captureArticleResult);
  const captureId = captured.captureId;
  const captureVisuals = Array.isArray(captured.visualAssets) ? captured.visualAssets : [];
  const captureCodes = Array.isArray(captured.codeBlocks) ? captured.codeBlocks : [];
  const captureContexts = Array.isArray(captured.context) ? captured.context : [];
  if (
    typeof captureId !== "string" ||
    captured.state !== "active" ||
    captured.article?.title !== "单细胞科研绘图实例" ||
    captureVisuals.length !== 2 ||
    captureCodes.length !== 2 ||
    captureContexts.length < 4
  ) {
    throw new Error(
      `offline capture did not preserve the fixture assets and context: ${JSON.stringify(
        captureArticleResult.structuredContent,
      )}`,
    );
  }

  const captureReplay = assertSuccessful(
    await client.callTool({
      name: "figure_capture_article",
      arguments: {
        projectDirectory,
        url: "https://mp.weixin.qq.com/s/smoke",
        operationId: "smoke-capture-article",
      },
    }),
    "capture operation replay",
  );
  if (captureRecord(captureReplay).captureId !== captureId) {
    throw new Error("capture operation replay returned a different captureId");
  }

  const captureListed = assertSuccessful(
    await client.callTool({
      name: "figure_capture_list",
      arguments: { projectDirectory, includeArchived: false },
    }),
    "capture list smoke call",
  );
  const captureListOutput = structuredPayload(captureListed);
  const captureItems = Array.isArray(captureListOutput.captures)
    ? captureListOutput.captures
    : Array.isArray(captureListOutput.items)
      ? captureListOutput.items
      : [];
  if (!captureItems.some((item) => item.captureId === captureId)) {
    throw new Error("capture list did not return the offline fixture capture");
  }

  const captureGot = assertSuccessful(
    await client.callTool({
      name: "figure_capture_get",
      arguments: { projectDirectory, captureId },
    }),
    "capture get smoke call",
  );
  if (captureRecord(captureGot).source?.fetchMode !== "http-first") {
    throw new Error("capture get did not preserve HTTP-first provenance");
  }

  const primaryVisualId = captureVisuals[0]?.assetId;
  const primaryCodeId = captureCodes[0]?.blockId;
  const primaryContextId = captureContexts[0]?.blockId;
  if (!primaryVisualId || !primaryCodeId || !primaryContextId) {
    throw new Error("capture fixture did not expose stable visual/code/context IDs");
  }
  const captureAsset = assertSuccessful(
    await client.callTool({
      name: "figure_capture_asset",
      arguments: { projectDirectory, captureId, assetId: primaryVisualId },
    }),
    "capture asset smoke call",
  );
  if (!captureAsset.content?.some((item) => item.type === "image")) {
    throw new Error("capture asset fallback tool did not return standard MCP image content");
  }

  const annotationDraft = {
    schema: "figure-library.annotation-draft.v1",
    title: "Smoke annotation draft",
    assetKind: "plot_template",
    visualAssetIds: [primaryVisualId],
    primaryVisualAssetId: primaryVisualId,
    codeBlockIds: [primaryCodeId],
    contextBlockIds: [primaryContextId],
    canonicalCodeBlockId: primaryCodeId,
    figureCodeLinks: [
      {
        visualAssetId: primaryVisualId,
        codeBlockIds: [primaryCodeId],
        evidence: "The offline fixture keeps the code adjacent to this figure.",
      },
    ],
  };
  const annotationPage1 = assertSuccessful(
    await client.callTool({
      name: "figure_capture_annotation_open",
      arguments: {
        projectDirectory,
        captureId,
        page: 1,
        pageSize: 1,
        annotationDraft,
      },
    }),
    "annotation standard-image fallback page 1",
  );
  if (
    annotationPage1.structuredContent?.draftPersisted !== false ||
    annotationPage1.structuredContent?.imagePage?.pageCount !== 2 ||
    annotationPage1.structuredContent?.imagePage?.nextPage !== 2 ||
    !annotationPage1.content?.some((item) => item.type === "image") ||
    annotationPage1.structuredContent?.annotationDraft?.primaryVisualAssetId !== primaryVisualId
  ) {
    throw new Error("annotation_open did not return its bounded image page and draft echo");
  }
  const annotationPage2 = assertSuccessful(
    await client.callTool({
      name: "figure_capture_annotation_open",
      arguments: {
        projectDirectory,
        captureId,
        page: 2,
        pageSize: 1,
        annotationDraft: annotationPage1.structuredContent.annotationDraft,
      },
    }),
    "annotation standard-image fallback page 2",
  );
  if (
    annotationPage2.structuredContent?.imagePage?.page !== 2 ||
    annotationPage2.structuredContent?.imagePage?.hasNextPage !== false ||
    !annotationPage2.content?.some((item) => item.type === "image") ||
    annotationPage2.structuredContent?.annotationDraft?.canonicalCodeBlockId !== primaryCodeId
  ) {
    throw new Error("annotation_open did not carry the validated non-persisted draft across pages");
  }

  const captureIgnore = await fs.readFile(path.join(captureDirectory, ".gitignore"), "utf8");
  if (!captureIgnore.includes("ScientificFigureLibrary project-local Raw Capture")) {
    throw new Error("project-local Capture did not create its protective local .gitignore");
  }
  try {
    await fs.access(path.join(projectDirectory, ".gitignore"));
    throw new Error("Capture unexpectedly modified the project-root .gitignore");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const captureArchived = assertSuccessful(
    await client.callTool({
      name: "figure_capture_archive",
      arguments: { projectDirectory, captureId },
    }),
    "capture archive smoke call",
  );
  if (captureRecord(captureArchived).state !== "archived") {
    throw new Error("capture archive did not set the logical archived state");
  }
  const captureRestored = assertSuccessful(
    await client.callTool({
      name: "figure_capture_restore",
      arguments: { projectDirectory, captureId },
    }),
    "capture restore smoke call",
  );
  if (captureRecord(captureRestored).state !== "active") {
    throw new Error("capture restore did not reactivate the capture");
  }

  const cleanupBeforeMaterialization = assertSuccessful(
    await client.callTool({
      name: "figure_capture_plan_cleanup",
      arguments: { projectDirectory, captureId, mode: "prune_payload" },
    }),
    "capture cleanup readiness before materialization",
  );
  const cleanupBeforePlan = lifecyclePlan(cleanupBeforeMaterialization);
  if (
    cleanupBeforePlan.ready !== false ||
    cleanupBeforePlan.deletionEnabled !== false ||
    typeof cleanupBeforePlan.planDigest !== "string"
  ) {
    throw new Error("capture cleanup became ready without a durable versioned receipt");
  }

  const versionedTemplateId = "smoke-capture-series";
  const selectionV1 = {
    visualAssetIds: [primaryVisualId],
    primaryVisualAssetId: primaryVisualId,
    codeBlockIds: [primaryCodeId],
    contextBlockIds: [primaryContextId],
    canonicalCodeBlockId: primaryCodeId,
    figureCodeLinks: [
      {
        visualAssetId: primaryVisualId,
        codeBlockIds: [primaryCodeId],
        evidence: "The fixture keeps the canonical code in an explicit Figure/code relationship.",
      },
    ],
  };
  const spoofedRuleAssessment = await client.callTool({
    name: "figure_library_plan_working_revision",
    arguments: {
      projectDirectory,
      templateId: "smoke-spoofed-rule-source",
      mode: "create",
      captureId,
      title: "Rejected source spoof",
      assetKind: "visual_reference",
      selection: {
        visualAssetIds: [primaryVisualId],
        primaryVisualAssetId: primaryVisualId,
      },
      assessment: {
        warnings: [
          {
            code: "spoofed_system_finding",
            message: "Public callers must not label Agent input as a server rule.",
            source: "system",
          },
        ],
      },
    },
  });
  if (!spoofedRuleAssessment.isError) {
    throw new Error("public Capture plan accepted a spoofed system/rule assessment source");
  }
  const workingPlanV1Result = assertSuccessful(
    await client.callTool({
      name: "figure_library_plan_working_revision",
      arguments: {
        projectDirectory,
        templateId: versionedTemplateId,
        mode: "create",
        captureId,
        title: "Capture lifecycle smoke v1",
        description: "Offline capture-backed Figure Unit smoke revision.",
        tags: ["smoke", "capture"],
        visualProfile: "one scientific figure with adjacent code",
        dataProfile: "fixture only; no original research data",
        packages: ["ggplot2"],
        license: "Published scientific figure reference",
        assetKind: "plot_template",
        plotFamily: "boxplot",
        selection: selectionV1,
        assessment: {
          blockingGates: [
            {
              gateId: "review-figure-code-pairing",
              code: "explicit_pairing_review_required",
              message: "Smoke requires a separate human review decision for the fixture pairing.",
              source: "agent",
            },
          ],
        },
      },
    }),
    "working revision v1 plan",
  );
  const workingPlanV1 = lifecyclePlan(workingPlanV1Result);
  const workingPlanV1Output = structuredPayload(workingPlanV1Result);
  const plannedReviewV1 =
    workingPlanV1.review ?? workingPlanV1Output.review ?? workingPlanV1Output.reviewSnapshot;
  if (
    workingPlanV1.action !== "create_working" ||
    workingPlanV1.templateId !== versionedTemplateId ||
    typeof workingPlanV1.planDigest !== "string"
  ) {
    throw new Error(
      `working revision v1 plan returned an invalid contract: ${JSON.stringify(
        workingPlanV1Result.structuredContent,
      )}`,
    );
  }
  const pairingGate = plannedReviewV1?.blockingGates?.find(
    (gate) => gate.gateId === "review-figure-code-pairing",
  );
  if (!pairingGate || pairingGate.status !== "open") {
    throw new Error("working revision plan did not preserve the unresolved figure-code pairing gate");
  }

  const missingExpectedState = await client.callTool({
    name: "figure_library_apply_working_revision",
    arguments: {
      projectDirectory,
      planDigest: workingPlanV1.planDigest,
      operationId: "smoke-working-v1-missing-expected-state",
      expectedAction: "create_working",
      expectedTemplateId: versionedTemplateId,
    },
  });
  if (!missingExpectedState.isError) {
    throw new Error("public lifecycle Apply accepted a request without expectedSeriesDigest");
  }

  const workingAppliedV1Result = assertSuccessful(
    await client.callTool({
      name: "figure_library_apply_working_revision",
      arguments: {
        projectDirectory,
        planDigest: workingPlanV1.planDigest,
        operationId: "smoke-working-v1",
        expectedAction: "create_working",
        expectedTemplateId: versionedTemplateId,
        expectedSeriesDigest: workingPlanV1.expectedSeriesDigest,
      },
    }),
    "working revision v1 apply",
  );
  const workingAppliedV1 = lifecycleApplyResult(workingAppliedV1Result);
  const plannedContentV1 = workingPlanV1.content ?? workingPlanV1Output.content;
  const revisionV1 = workingAppliedV1.revisionId ?? plannedContentV1?.revisionId;
  const digestV1 = workingAppliedV1.contentDigest ?? plannedContentV1?.contentDigest;
  if (
    workingAppliedV1.action !== "create_working" ||
    typeof revisionV1 !== "string" ||
    typeof digestV1 !== "string" ||
    !workingAppliedV1.captureReceiptId
  ) {
    throw new Error("working revision v1 apply did not commit a self-contained capture receipt");
  }

  const reviewOpenV1 = assertSuccessful(
    await client.callTool({
      name: "figure_library_review_open",
      arguments: { templateId: versionedTemplateId },
    }),
    "review open v1",
  );
  const reviewV1 = reviewDetail(reviewOpenV1);
  const seriesV1 = reviewSeries(reviewV1);
  const reviewSnapshotV1 =
    reviewV1.review ??
    reviewV1.reviewSnapshot ??
    reviewV1.workingReview ??
    reviewV1.working?.review;
  if (
    seriesV1.publishedHead !== undefined ||
    seriesV1.workingHead?.revisionId !== revisionV1 ||
    !reviewSnapshotV1?.blockingGates?.some(
      (gate) => gate.gateId === "review-figure-code-pairing" && gate.status === "open",
    )
  ) {
    throw new Error("review open did not expose the unpublished Working Head and open gate");
  }

  const gatePlanResult = assertSuccessful(
    await client.callTool({
      name: "figure_library_plan_review_gate_update",
      arguments: {
        templateId: versionedTemplateId,
        decisions: [
          {
            gateId: "review-figure-code-pairing",
            decision: "resolved",
            note: "Smoke user explicitly reviewed the fixture figure-code relationship.",
          },
        ],
      },
    }),
    "review gate update plan",
  );
  const gatePlan = lifecyclePlan(gatePlanResult);
  if (gatePlan.action !== "update_gates" || typeof gatePlan.planDigest !== "string") {
    throw new Error("review gate update plan returned an invalid contract");
  }
  const gateApplied = assertSuccessful(
    await client.callTool({
      name: "figure_library_apply_review_gate_update",
      arguments: {
        planDigest: gatePlan.planDigest,
        operationId: "smoke-review-gate-v1",
        expectedTemplateId: versionedTemplateId,
        expectedSeriesDigest: gatePlan.expectedSeriesDigest,
      },
    }),
    "review gate update apply",
  );
  if (lifecycleApplyResult(gateApplied).action !== "update_gates") {
    throw new Error("review gate update apply did not commit a distinct review snapshot");
  }

  const publishPlanV1Result = assertSuccessful(
    await client.callTool({
      name: "figure_library_plan_publish_working_revision",
      arguments: { templateId: versionedTemplateId },
    }),
    "publish v1 plan",
  );
  const publishPlanV1 = lifecyclePlan(publishPlanV1Result);
  if (publishPlanV1.action !== "publish" || typeof publishPlanV1.planDigest !== "string") {
    throw new Error("publish v1 plan returned an invalid contract");
  }
  const publishAppliedV1 = assertSuccessful(
    await client.callTool({
      name: "figure_library_apply_publish_working_revision",
      arguments: {
        planDigest: publishPlanV1.planDigest,
        operationId: "smoke-publish-v1",
        expectedTemplateId: versionedTemplateId,
        expectedSeriesDigest: publishPlanV1.expectedSeriesDigest,
      },
    }),
    "publish v1 apply",
  );
  const publishedV1 = lifecycleApplyResult(publishAppliedV1);
  const releaseV1 = publishedV1.releaseId ?? publishPlanV1.release?.releaseId;
  if (
    publishedV1.action !== "publish" ||
    typeof releaseV1 !== "string" ||
    publishedV1.revisionId !== revisionV1
  ) {
    throw new Error("publish v1 did not atomically promote the reviewed Working Head");
  }

  const cleanupAfterMaterialization = assertSuccessful(
    await client.callTool({
      name: "figure_capture_plan_cleanup",
      arguments: { projectDirectory, captureId, mode: "prune_payload" },
    }),
    "capture cleanup readiness after versioned materialization",
  );
  const cleanupReadyPlan = lifecyclePlan(cleanupAfterMaterialization);
  if (cleanupReadyPlan.ready !== true || typeof cleanupReadyPlan.planDigest !== "string") {
    throw new Error("capture cleanup did not recognize the durable self-contained revision receipt");
  }
  const cleanupApply = await client.callTool({
    name: "figure_capture_apply_cleanup",
    arguments: {
      projectDirectory,
      captureId,
      mode: "prune_payload",
      operationId: "smoke-cleanup-disabled",
      planDigest: cleanupReadyPlan.planDigest,
    },
  });
  if (
    !cleanupApply.isError ||
    !contentBlockText(cleanupApply).toLocaleLowerCase().includes("cleanup_not_enabled")
  ) {
    throw new Error("capture cleanup apply did not enforce cleanup_not_enabled");
  }

  const workingPlanV2Result = assertSuccessful(
    await client.callTool({
      name: "figure_library_plan_working_revision",
      arguments: {
        projectDirectory,
        templateId: versionedTemplateId,
        mode: "create",
        captureId,
        title: "Capture lifecycle smoke v2",
        description: "A second immutable Working Revision for Published/Working diff coverage.",
        tags: ["smoke", "capture", "v2"],
        visualProfile: "one scientific figure with user-confirmed adjacent code",
        dataProfile: "fixture only; no original research data",
        packages: ["ggplot2"],
        license: "Published scientific figure reference",
        assetKind: "plot_template",
        plotFamily: "boxplot",
        selection: {
          ...selectionV1,
          figureCodeLinks: [
            {
              visualAssetId: primaryVisualId,
              codeBlockIds: [primaryCodeId],
              evidence: "The smoke user confirmed the adjacent fixture code belongs to this visual.",
              confidence: 1,
            },
          ],
        },
      },
    }),
    "working revision v2 plan",
  );
  const workingPlanV2 = lifecyclePlan(workingPlanV2Result);
  const workingPlanV2Output = structuredPayload(workingPlanV2Result);
  const plannedReviewV2 =
    workingPlanV2.review ?? workingPlanV2Output.review ?? workingPlanV2Output.reviewSnapshot;
  if (
    workingPlanV2.action !== "create_working" ||
    plannedReviewV2?.blockingGates?.some((gate) => gate.status === "open")
  ) {
    throw new Error("working revision v2 did not preserve explicit evidence-backed pairing");
  }
  const workingAppliedV2Result = assertSuccessful(
    await client.callTool({
      name: "figure_library_apply_working_revision",
      arguments: {
        projectDirectory,
        planDigest: workingPlanV2.planDigest,
        operationId: "smoke-working-v2",
        expectedAction: "create_working",
        expectedTemplateId: versionedTemplateId,
        expectedSeriesDigest: workingPlanV2.expectedSeriesDigest,
      },
    }),
    "working revision v2 apply",
  );
  const workingAppliedV2 = lifecycleApplyResult(workingAppliedV2Result);
  const plannedContentV2 = workingPlanV2.content ?? workingPlanV2Output.content;
  const revisionV2 = workingAppliedV2.revisionId ?? plannedContentV2?.revisionId;
  const digestV2 = workingAppliedV2.contentDigest ?? plannedContentV2?.contentDigest;
  if (
    typeof revisionV2 !== "string" ||
    revisionV2 === revisionV1 ||
    typeof digestV2 !== "string"
  ) {
    throw new Error("working revision v2 was not a new immutable revision");
  }

  const reviewOpenV2 = assertSuccessful(
    await client.callTool({
      name: "figure_library_review_open",
      arguments: { templateId: versionedTemplateId },
    }),
    "review open v2",
  );
  const reviewV2 = reviewDetail(reviewOpenV2);
  const seriesV2 = reviewSeries(reviewV2);
  if (
    seriesV2.publishedHead?.revisionId !== revisionV1 ||
    seriesV2.workingHead?.revisionId !== revisionV2
  ) {
    throw new Error("Published v1 was not kept live while Working v2 was under review");
  }

  const revisionDiff = assertSuccessful(
    await client.callTool({
      name: "figure_library_diff_revisions",
      arguments: {
        templateId: versionedTemplateId,
        fromRevisionId: revisionV1,
        toRevisionId: revisionV2,
      },
    }),
    "published-working revision diff",
  );
  const diffOutput = nestedRecord(structuredPayload(revisionDiff), "diff", "revisionDiff") ??
    structuredPayload(revisionDiff);
  if (
    !diffOutput.fieldChanges?.some(
      (change) => change.field === "title" && change.before !== change.after,
    )
  ) {
    throw new Error("Published/Working diff did not report the immutable title change");
  }

  const publishPlanV2Result = assertSuccessful(
    await client.callTool({
      name: "figure_library_plan_publish_working_revision",
      arguments: { templateId: versionedTemplateId },
    }),
    "publish v2 plan",
  );
  const publishPlanV2 = lifecyclePlan(publishPlanV2Result);
  const publishAppliedV2 = assertSuccessful(
    await client.callTool({
      name: "figure_library_apply_publish_working_revision",
      arguments: {
        planDigest: publishPlanV2.planDigest,
        operationId: "smoke-publish-v2",
        expectedTemplateId: versionedTemplateId,
        expectedSeriesDigest: publishPlanV2.expectedSeriesDigest,
      },
    }),
    "publish v2 apply",
  );
  if (lifecycleApplyResult(publishAppliedV2).revisionId !== revisionV2) {
    throw new Error("publish v2 did not atomically switch the Published Head");
  }

  const projectStatusBefore = assertSuccessful(
    await client.callTool({
      name: "figure_library_project_status",
      arguments: { projectDirectory },
    }),
    "empty project template status",
  );
  if (
    projectStatusBefore.structuredContent?.status?.status !== "missing" ||
    projectStatusBefore.structuredContent?.status?.templates?.length !== 0
  ) {
    throw new Error("new plotting project did not begin with an explicit missing project lock");
  }

  const projectUsePlanResult = assertSuccessful(
    await client.callTool({
      name: "figure_library_plan_project_use",
      arguments: {
        projectDirectory,
        templateId: versionedTemplateId,
        revisionId: revisionV2,
        contentDigest: digestV2,
        allowNetwork: false,
      },
    }),
    "exact Published project-use plan",
  );
  const projectUsePlan = lifecyclePlan(projectUsePlanResult);
  if (
    projectUsePlan.action !== "create" ||
    projectUsePlan.desired?.templateId !== versionedTemplateId ||
    projectUsePlan.desired?.revisionId !== revisionV2 ||
    projectUsePlan.desired?.contentDigest !== digestV2 ||
    projectUsePlan.expectedProjectLockDigest !== null ||
    typeof projectUsePlan.planDigest !== "string"
  ) {
    throw new Error(
      `project-use plan did not lock the exact Published revision: ${JSON.stringify(
        projectUsePlanResult.structuredContent,
      )}`,
    );
  }
  const projectUseAppliedResult = assertSuccessful(
    await client.callTool({
      name: "figure_library_apply_project_use",
      arguments: {
        projectDirectory,
        plan: projectUsePlan,
        planDigest: projectUsePlan.planDigest,
        expectedAction: projectUsePlan.action,
        expectedProjectLockDigest: projectUsePlan.expectedProjectLockDigest,
        operationId: "smoke-project-use-v2",
        allowNetwork: false,
      },
    }),
    "exact Published project-use apply",
  );
  const projectUseApplied = lifecycleApplyResult(projectUseAppliedResult);
  if (
    projectUseApplied.action !== "create" ||
    projectUseApplied.templateId !== versionedTemplateId ||
    projectUseApplied.revisionId !== revisionV2 ||
    projectUseApplied.contentDigest !== digestV2 ||
    projectUseApplied.reused !== false ||
    !String(projectUseApplied.target ?? "").startsWith(
      path.join(projectDirectory, ".wisp", "figure-library", "templates"),
    )
  ) {
    throw new Error("project-use Apply did not materialize the exact immutable Published snapshot");
  }

  const projectLockPath = path.join(
    projectDirectory,
    ".wisp",
    "figure-library",
    "project.lock.json",
  );
  const projectLockBeforeReuse = await fs.readFile(projectLockPath, "utf8");
  const projectLockBeforeReuseStat = await fs.stat(projectLockPath);
  const projectLock = JSON.parse(projectLockBeforeReuse);
  const activeProjectPin = projectLock.templates?.find(
    (item) => item.templateId === versionedTemplateId,
  )?.active;
  if (
    activeProjectPin?.revisionId !== revisionV2 ||
    activeProjectPin?.contentDigest !== digestV2 ||
    projectLockBeforeReuse.includes(projectDirectory) ||
    projectLockBeforeReuse.includes(libraryDirectory)
  ) {
    throw new Error("project.lock.json did not contain only the portable exact Published pin");
  }

  const projectStatusAfter = assertSuccessful(
    await client.callTool({
      name: "figure_library_project_status",
      arguments: { projectDirectory },
    }),
    "ready project template status",
  );
  const pinnedStatus = projectStatusAfter.structuredContent?.status;
  const pinnedTemplate = pinnedStatus?.templates?.find(
    (item) => item.templateId === versionedTemplateId,
  );
  if (
    pinnedStatus?.status !== "ready" ||
    pinnedTemplate?.active?.revisionId !== revisionV2 ||
    pinnedTemplate?.active?.contentDigest !== digestV2 ||
    pinnedTemplate?.snapshots?.[0]?.integrity !== "ready" ||
    pinnedTemplate?.updateAvailable !== false
  ) {
    throw new Error("project status did not verify the exact active snapshot and current Published pin");
  }

  const projectReusePlanResult = assertSuccessful(
    await client.callTool({
      name: "figure_library_plan_project_use",
      arguments: {
        projectDirectory,
        templateId: versionedTemplateId,
        revisionId: revisionV2,
        contentDigest: digestV2,
        allowNetwork: false,
      },
    }),
    "exact project pin reuse plan",
  );
  const projectReusePlan = lifecyclePlan(projectReusePlanResult);
  if (
    projectReusePlan.action !== "reuse" ||
    projectReusePlan.expectedProjectLockDigest !== pinnedStatus.projectLockDigest
  ) {
    throw new Error("same exact active project pin was not planned as zero-write reuse");
  }
  const projectReuseResult = assertSuccessful(
    await client.callTool({
      name: "figure_library_apply_project_use",
      arguments: {
        projectDirectory,
        plan: projectReusePlan,
        planDigest: projectReusePlan.planDigest,
        expectedAction: "reuse",
        expectedProjectLockDigest: projectReusePlan.expectedProjectLockDigest,
        operationId: "smoke-project-reuse-v2",
        allowNetwork: false,
      },
    }),
    "exact project pin reuse apply",
  );
  const projectReuse = lifecycleApplyResult(projectReuseResult);
  if (
    projectReuse.action !== "reuse" ||
    projectReuse.reused !== true ||
    projectReuse.revisionId !== revisionV2 ||
    projectReuse.contentDigest !== digestV2 ||
    (await fs.readFile(projectLockPath, "utf8")) !== projectLockBeforeReuse ||
    (await fs.stat(projectLockPath)).mtimeMs !== projectLockBeforeReuseStat.mtimeMs
  ) {
    throw new Error("project reuse unexpectedly rewrote or changed the exact active pin");
  }

  const versionHistory = assertSuccessful(
    await client.callTool({
      name: "figure_library_template_history",
      arguments: { templateId: versionedTemplateId },
    }),
    "versioned template history",
  );
  const historyOutput = nestedRecord(
    structuredPayload(versionHistory),
    "history",
    "templateHistory",
  ) ?? structuredPayload(versionHistory);
  if (
    !Array.isArray(historyOutput.releases) ||
    historyOutput.releases.length !== 2 ||
    !historyOutput.releases.some((release) => release.releaseId === releaseV1)
  ) {
    throw new Error("versioned history did not retain both immutable releases");
  }

  const historicalDescription = assertSuccessful(
    await client.callTool({
      name: "figure_library_describe",
      arguments: {
        templateId: versionedTemplateId,
        revisionId: revisionV1,
        contentDigest: digestV1,
      },
    }),
    "exact historical describe",
  );
  if (
    historicalDescription.structuredContent?.revisionId !== revisionV1 ||
    historicalDescription.structuredContent?.contentDigest !== digestV1 ||
    historicalDescription.structuredContent?.historical !== true ||
    historicalDescription.structuredContent?.executionStatus !== "not_run"
  ) {
    throw new Error("exact describe did not return the historical not_run revision");
  }

  const historicalPreviewDirectory = path.join(smokeRoot, "historical-previews");
  const historicalPreview = assertSuccessful(
    await client.callTool({
      name: "figure_library_preview",
      arguments: {
        templateId: versionedTemplateId,
        revisionId: revisionV1,
        contentDigest: digestV1,
        destination: historicalPreviewDirectory,
      },
    }),
    "exact historical preview",
  );
  if (
    historicalPreview.structuredContent?.revisionId !== revisionV1 ||
    historicalPreview.structuredContent?.contentDigest !== digestV1 ||
    !historicalPreview.content?.some((item) => item.type === "image")
  ) {
    throw new Error("exact historical preview did not return standard MCP image content");
  }

  const historicalMaterialized = assertSuccessful(
    await client.callTool({
      name: "figure_library_materialize",
      arguments: {
        templateId: versionedTemplateId,
        revisionId: revisionV1,
        contentDigest: digestV1,
        destination: path.join(smokeRoot, "historical-materialized"),
        mode: "template",
      },
    }),
    "exact historical materialization",
  );
  if (
    historicalMaterialized.structuredContent?.revisionId !== revisionV1 ||
    historicalMaterialized.structuredContent?.contentDigest !== digestV1 ||
    !historicalMaterialized.structuredContent?.target
  ) {
    throw new Error("exact historical materialization did not preserve the revision lock");
  }

  const restorePlanResult = assertSuccessful(
    await client.callTool({
      name: "figure_library_plan_restore_release",
      arguments: { templateId: versionedTemplateId, releaseId: releaseV1 },
    }),
    "historical Release restore plan",
  );
  const restorePlan = lifecyclePlan(restorePlanResult);
  if (restorePlan.action !== "restore_release" || typeof restorePlan.planDigest !== "string") {
    throw new Error("historical Release restore plan returned an invalid contract");
  }
  const restoreAppliedResult = assertSuccessful(
    await client.callTool({
      name: "figure_library_apply_restore_release",
      arguments: {
        planDigest: restorePlan.planDigest,
        operationId: "smoke-restore-v1-as-working",
        expectedTemplateId: versionedTemplateId,
        expectedSeriesDigest: restorePlan.expectedSeriesDigest,
      },
    }),
    "historical Release restore apply",
  );
  const restoredWorking = lifecycleApplyResult(restoreAppliedResult);
  if (
    restoredWorking.action !== "restore_release" ||
    typeof restoredWorking.revisionId !== "string" ||
    restoredWorking.revisionId === revisionV1 ||
    restoredWorking.revisionId === revisionV2
  ) {
    throw new Error("historical restore did not create a new immutable Working Revision");
  }
  const restoredReviewResult = assertSuccessful(
    await client.callTool({
      name: "figure_library_review_open",
      arguments: { templateId: versionedTemplateId },
    }),
    "restored Working review open",
  );
  const restoredDetail = reviewDetail(restoredReviewResult);
  const restoredSeries = reviewSeries(restoredDetail);
  const restoredReview = restoredDetail.review ?? restoredDetail.reviewSnapshot;
  if (
    restoredSeries.publishedHead?.revisionId !== revisionV2 ||
    restoredSeries.workingHead?.revisionId !== restoredWorking.revisionId ||
    !restoredReview?.blockingGates?.some(
      (gate) => gate.gateId === "review-restored-release" && gate.status === "open",
    )
  ) {
    throw new Error("restore rewound Published or omitted mandatory re-review");
  }
  const discardPlanResult = assertSuccessful(
    await client.callTool({
      name: "figure_library_plan_discard_working_revision",
      arguments: { templateId: versionedTemplateId },
    }),
    "restored Working discard plan",
  );
  const discardPlan = lifecyclePlan(discardPlanResult);
  const discardApplied = assertSuccessful(
    await client.callTool({
      name: "figure_library_apply_discard_working_revision",
      arguments: {
        planDigest: discardPlan.planDigest,
        operationId: "smoke-discard-restored-working",
        expectedTemplateId: versionedTemplateId,
        expectedSeriesDigest: discardPlan.expectedSeriesDigest,
      },
    }),
    "restored Working discard apply",
  );
  if (lifecycleApplyResult(discardApplied).action !== "discard_working") {
    throw new Error("discard plan did not remove only the restored Working Head");
  }

  const opened = await client.callTool({
    name: "figure_library_open",
    arguments: {},
  });
  if (opened.isError || opened.structuredContent?.candidates?.length !== 0) {
    throw new Error("open smoke call did not return an empty workbench");
  }

  const volcanoResult = await client.callTool({
    name: "figure_library_search",
    arguments: {
      query: "volcano differential expression",
      dataProfile: "gene; log2FC; pvalue; padj",
      visualProfile:
        "single panel; x=log2FC; y=-log10(padj); threshold lines; up/down colors; labels",
      sourceIds: ["figureya", "user"],
      limit: 6,
    },
  });
  if (
    volcanoResult.isError ||
    volcanoResult.structuredContent?.candidates?.[0]?.templateId !==
      "FigureYa59volcanoV2" ||
    volcanoResult.structuredContent?.reviewRequired !== true
  ) {
    throw new Error("volcano retrieval did not return the expected review candidate");
  }

  const previewDirectory = path.join(smokeRoot, "previews");
  const previewed = await client.callTool({
    name: "figure_library_preview",
    arguments: {
      templateId: "FigureYa59volcanoV2",
      destination: previewDirectory,
    },
  });
  const previewPath = previewed.structuredContent?.path;
  if (
    previewed.isError ||
    typeof previewPath !== "string" ||
    !previewed.content?.some((item) => item.type === "image")
  ) {
    throw new Error("preview smoke call did not return image content and a local path");
  }
  const previewStat = await fs.stat(previewPath);
  if (!previewStat.isFile() || path.dirname(previewPath) !== previewDirectory) {
    throw new Error("preview smoke call wrote an unexpected local file");
  }

  const imported = await client.callTool({
    name: "figure_library_import",
    arguments: {
      title: "Unique smoke ridge reference",
      description:
        "A unique-smoke-ridge-reference for MCP verification; explicitly not a volcano plot.",
      tags: ["unique-smoke-ridge-reference"],
      codePaths: [codePath],
    },
  });
  const userTemplateId = imported.structuredContent?.templateId;
  if (imported.isError || typeof userTemplateId !== "string") {
    throw new Error(`user import smoke call failed: ${JSON.stringify(imported.content)}`);
  }

  const planned = await client.callTool({
    name: "figure_library_plan_import",
    arguments: {
      title: "Planned smoke lifecycle reference",
      description: "A direct import that exercises plan, apply, management, archive, and audit.",
      sourceKey: "smoke:planned-lifecycle",
      codePaths: [plannedCodePath],
    },
  });
  const plannedTemplateId = planned.structuredContent?.proposedTemplateId;
  const planDigest = planned.structuredContent?.planDigest;
  if (
    planned.isError ||
    planned.structuredContent?.action !== "create" ||
    planned.structuredContent?.written !== false ||
    typeof plannedTemplateId !== "string" ||
    typeof planDigest !== "string"
  ) {
    throw new Error(`direct import plan smoke call failed: ${JSON.stringify(planned.content)}`);
  }
  const plannedApplied = await client.callTool({
    name: "figure_library_apply_import",
    arguments: {
      title: "Planned smoke lifecycle reference",
      description: "A direct import that exercises plan, apply, management, archive, and audit.",
      sourceKey: "smoke:planned-lifecycle",
      codePaths: [plannedCodePath],
      planDigest,
      expectedAction: "create",
      expectedTemplateId: plannedTemplateId,
      operationId: "smoke-planned-create",
    },
  });
  if (
    plannedApplied.isError ||
    plannedApplied.structuredContent?.templateId !== plannedTemplateId ||
    plannedApplied.structuredContent?.action !== "create"
  ) {
    throw new Error(`direct import apply smoke call failed: ${JSON.stringify(plannedApplied.content)}`);
  }

  const transferImported = await client.callTool({
    name: "figure_library_import",
    arguments: { packagePath: transferPackagePath },
  });
  const transferTemplateId = transferImported.structuredContent?.templateId;
  if (
    transferImported.isError ||
    typeof transferTemplateId !== "string" ||
    transferImported.structuredContent?.reviewStatus !== "draft" ||
    transferImported.structuredContent?.action !== "create"
  ) {
    throw new Error(`transfer import smoke call failed: ${JSON.stringify(transferImported.content)}`);
  }
  const transferDiff = await client.callTool({
    name: "figure_library_diff",
    arguments: { packagePath: transferPackagePath },
  });
  if (transferDiff.isError || transferDiff.structuredContent?.action !== "unchanged") {
    throw new Error("transfer diff smoke call was not idempotent");
  }
  const transferUpsert = await client.callTool({
    name: "figure_library_upsert",
    arguments: { packagePath: transferPackagePath },
  });
  if (transferUpsert.isError || transferUpsert.structuredContent?.action !== "unchanged") {
    throw new Error("transfer upsert smoke call was not idempotent");
  }
  const emptyGallery = path.join(smokeRoot, "empty-gallery");
  await fs.mkdir(emptyGallery);
  const galleryDryRun = await client.callTool({
    name: "figure_library_sync",
    arguments: { galleryDirectory: emptyGallery, dryRun: true },
  });
  if (galleryDryRun.isError || galleryDryRun.structuredContent?.entries !== 0) {
    throw new Error("empty Gallery dry-run smoke call failed");
  }

  const mergedResult = await client.callTool({
    name: "figure_library_search",
    arguments: {
      query: "volcano differential expression",
      sourceIds: ["figureya", "user"],
      limit: 3,
    },
  });
  if (
    mergedResult.isError ||
    mergedResult.structuredContent?.candidates?.[0]?.templateId !==
      "FigureYa59volcanoV2"
  ) {
    throw new Error("cross-source retrieval scores were not globally comparable");
  }

  const result = await client.callTool({
    name: "figure_library_search",
    arguments: {
      query: "unique smoke ridge reference",
      sourceIds: ["user"],
      limit: 3,
    },
  });
  if (
    result.isError ||
    result.structuredContent?.candidates?.[0]?.templateId !== userTemplateId
  ) {
    throw new Error("search smoke call did not return the imported user template");
  }

  const described = await client.callTool({
    name: "figure_library_describe",
    arguments: { templateId: userTemplateId },
  });
  if (described.isError || described.structuredContent?.sourceId !== "user") {
    throw new Error("describe smoke call failed for the imported user template");
  }

  const userMaterialized = await client.callTool({
    name: "figure_library_materialize",
    arguments: {
      templateId: userTemplateId,
      destination: path.join(smokeRoot, "user-output"),
    },
  });
  if (userMaterialized.isError || !userMaterialized.structuredContent?.target) {
    throw new Error("user template materialization smoke call failed");
  }

  const sourceStatus = await client.callTool({
    name: "figure_library_source_status",
    arguments: { projectDirectory },
  });
  if (
    sourceStatus.isError ||
    sourceStatus.structuredContent?.userTemplateCount !== 3 ||
    sourceStatus.structuredContent?.captureStatus?.source !== "project" ||
    sourceStatus.structuredContent?.captureStatus?.root !== captureDirectory
  ) {
    throw new Error("source status smoke call failed");
  }

  const plannedArchive = await client.callTool({
    name: "figure_library_archive",
    arguments: { templateId: plannedTemplateId },
  });
  if (
    plannedArchive.isError ||
    plannedArchive.structuredContent?.changed !== true ||
    plannedArchive.structuredContent?.filesRetained !== true
  ) {
    throw new Error(`template archive smoke call failed: ${JSON.stringify(plannedArchive.content)}`);
  }
  const audit = await client.callTool({
    name: "figure_library_audit",
    arguments: { scope: "all", includeArchived: true },
  });
  if (
    audit.isError ||
    audit.structuredContent?.userTemplateCount !== 3 ||
    !audit.structuredContent?.templates?.some(
      (item) => item.templateId === plannedTemplateId && item.reviewStatus === "archived",
    )
  ) {
    throw new Error(`user-library audit smoke call failed: ${JSON.stringify(audit.content)}`);
  }

  const adoptionPlanResult = assertSuccessful(
    await client.callTool({
      name: "figure_library_plan_adopt_versioning",
      arguments: { templateId: transferTemplateId },
    }),
    "explicit flat-v1 adoption plan",
  );
  const adoptionPlan = lifecyclePlan(adoptionPlanResult);
  if (adoptionPlan.action !== "adopt_legacy" || typeof adoptionPlan.planDigest !== "string") {
    throw new Error("legacy adoption plan returned an invalid contract");
  }
  const adoptionAppliedResult = assertSuccessful(
    await client.callTool({
      name: "figure_library_apply_adopt_versioning",
      arguments: {
        planDigest: adoptionPlan.planDigest,
        operationId: "smoke-adopt-transfer-draft",
        expectedTemplateId: transferTemplateId,
        expectedSeriesDigest: adoptionPlan.expectedSeriesDigest,
      },
    }),
    "explicit flat-v1 adoption apply",
  );
  const adoptionApplied = lifecycleApplyResult(adoptionAppliedResult);
  if (
    adoptionApplied.action !== "adopt_legacy" ||
    typeof adoptionApplied.migrationId !== "string" ||
    typeof adoptionApplied.revisionId !== "string"
  ) {
    throw new Error("legacy adoption did not return a migration receipt and immutable revision");
  }
  await fs.access(path.join(libraryDirectory, "templates", transferTemplateId, "template.json"));
  const adoptedReviewResult = assertSuccessful(
    await client.callTool({
      name: "figure_library_review_open",
      arguments: { templateId: transferTemplateId },
    }),
    "adopted draft review open",
  );
  if (!reviewSeries(reviewDetail(adoptedReviewResult)).workingHead) {
    throw new Error("adopted draft did not become an explicit Working candidate");
  }

  const resource = await client.readResource({
    uri: "ui://figure-library/candidates.html",
  });
  if (!resource.contents[0]?.mimeType?.startsWith("text/html")) {
    throw new Error("MCP App resource was not returned as HTML");
  }

  const stopped = await client.callTool({
    name: "figure_library_materialize",
    arguments: {
      templateId: "FigureYa59volcanoV2",
      destination: path.join(smokeRoot, "hard-stop-output"),
      sourcePackDir: path.join(smokeRoot, "missing-pack"),
      allowNetwork: false,
    },
  });
  const stopText = stopped.content?.find((item) => item.type === "text")?.text ?? "";
  const stopNormalized = stopText.toLocaleLowerCase();
  if (
    !stopped.isError ||
    !stopText.startsWith("STOP:") ||
    !stopNormalized.includes("do not retry") ||
    !stopNormalized.includes("substitute/demo plot")
  ) {
    throw new Error("materialization failure did not enforce the hard-stop policy");
  }

  let materialized = "";
  if (materializeAt) {
    const downloaded = await client.callTool({
      name: "figure_library_materialize",
      arguments: {
        templateId: "FigureYa59volcanoV2",
        destination: path.resolve(materializeAt),
        mode: "template",
        sourcePackDir: process.env.FIGUREYA_SOURCE_PACK_DIR,
        allowNetwork: !process.env.FIGUREYA_SOURCE_PACK_DIR,
      },
    });
    if (downloaded.isError || !downloaded.structuredContent?.target) {
      throw new Error(`FigureYa materialization failed: ${JSON.stringify(downloaded.content)}`);
    }
    materialized = `; materialized ${downloaded.structuredContent.target}`;
  }

  console.log(
    `OK: ${names.join(", ")}; project-bound source status and project-local Capture open/article/list/get/asset/annotation pages/archive/restore/cleanup guard; immutable Working/Review Gate/Publish v1-v2 lifecycle; exact Published project plan/apply/status/zero-write reuse pin; Published/Working diff and history; exact historical describe/preview/materialize; restore-as-new-Working/discard; explicit non-destructive legacy adoption; legacy import plus plan/apply/archive/audit lifecycle; diff/upsert/sync; user search/materialization; app resource; hard stop${materialized}`,
  );
} finally {
  await client.close().catch(() => undefined);
  await new Promise((resolve) => fixtureServer.close(resolve));
  await fs.rm(smokeRoot, { recursive: true, force: true });
}
