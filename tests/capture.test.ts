import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CAPTURE_CLEANUP_PLAN_SCHEMA,
  CaptureError,
  CaptureStore,
  type CaptureRequestTransport,
  type CaptureResolver,
} from "../src/capture.ts";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const WEBP = new Uint8Array([
  82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32,
]);
const publicResolver: CaptureResolver = async () => [
  { address: "93.184.216.34", family: 4 },
  { address: "2606:4700:4700::1111", family: 6 },
];

function captureErrorCode(code: string) {
  return (error: unknown) => error instanceof CaptureError && error.code === code;
}

async function fixture() {
  return fs.readFile(path.join(import.meta.dirname, "fixtures", "wechat-article.html"), "utf8");
}

test("Capture stays disabled when unconfigured and rejects overlap with the canonical library", async () => {
  const previousCapture = process.env.FIGURE_CAPTURE_DIR;
  const previousLibrary = process.env.FIGURE_LIBRARY_DIR;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-status-"));
  try {
    delete process.env.FIGURE_CAPTURE_DIR;
    delete process.env.FIGURE_LIBRARY_DIR;
    const disabled = await new CaptureStore().status();
    assert.equal(disabled.configured, false);
    assert.equal(disabled.available, false);
    assert.match(disabled.reason ?? "", /disabled without affecting the library/iu);

    const defaultLibraryRoot = path.join(os.homedir(), ".figure-library");
    const defaultOverlapping = await new CaptureStore(
      path.join(defaultLibraryRoot, "capture"),
    ).status();
    assert.equal(defaultOverlapping.source, "constructor");
    assert.equal(defaultOverlapping.libraryRoot, path.resolve(defaultLibraryRoot));
    assert.equal(defaultOverlapping.isolated, false);
    assert.equal(defaultOverlapping.available, false);

    const libraryRoot = path.join(root, "library");
    process.env.FIGURE_LIBRARY_DIR = libraryRoot;
    const overlapping = await new CaptureStore(path.join(libraryRoot, "capture")).status();
    assert.equal(overlapping.isolated, false);
    assert.equal(overlapping.available, false);
    assert.match(overlapping.reason ?? "", /completely separate/iu);

    const independentRoot = path.join(root, "capture");
    const independent = await new CaptureStore(independentRoot).status();
    assert.equal(independent.isolated, true);
    assert.equal(independent.exists, false);
    assert.equal(independent.creatable, true);
    assert.equal(independent.available, true);
  } finally {
    if (previousCapture === undefined) delete process.env.FIGURE_CAPTURE_DIR;
    else process.env.FIGURE_CAPTURE_DIR = previousCapture;
    if (previousLibrary === undefined) delete process.env.FIGURE_LIBRARY_DIR;
    else process.env.FIGURE_LIBRARY_DIR = previousLibrary;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTTP-first WeChat capture persists provenance, original assets, code, and context idempotently", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-store-"));
  const html = await fixture();
  let articleRequests = 0;
  let imageRequests = 0;
  const fetchImpl = async (input: string | URL) => {
    const url = input.toString();
    if (url.startsWith("https://mp.weixin.qq.com/")) {
      articleRequests += 1;
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.includes("figure.png")) {
      imageRequests += 1;
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url.includes("figure.webp")) {
      imageRequests += 1;
      return new Response(WEBP, { status: 200, headers: { "content-type": "image/webp" } });
    }
    return new Response("missing", { status: 404 });
  };

  try {
    const resolvedHosts: string[] = [];
    const resolver: CaptureResolver = async (hostname) => {
      resolvedHosts.push(hostname);
      return publicResolver(hostname);
    };
    const store = new CaptureStore(path.join(root, "capture"), fetchImpl, resolver);
    const captured = await store.captureArticle({
      url: "https://mp.weixin.qq.com/s/example#ignored-fragment",
      operationId: "capture-test-operation",
    });
    assert.match(captured.captureId, /^capture-[a-f0-9]{24}$/u);
    assert.equal(captured.state, "active");
    assert.equal(captured.source.sourceKind, "wechat");
    assert.equal(captured.source.fetchMode, "http-first");
    assert.equal(captured.source.url, "https://mp.weixin.qq.com/s/example");
    assert.equal(captured.article.title, "单细胞科研绘图实例");
    assert.equal(captured.article.author, "科研绘图实验室");
    assert.equal(captured.article.publishedAt, "2026-08-01T19:04:05.000Z");
    assert.equal(captured.article.description, "演示微信公众号科研图像与代码的确定性抓取。");
    assert.equal(captured.visualAssets.length, 2);
    assert.deepEqual(
      captured.visualAssets.map((asset) => asset.mediaType).sort(),
      ["image/png", "image/webp"],
    );
    assert.ok(captured.visualAssets.every((asset) => asset.contextBlockIds.length > 0));
    assert.ok(captured.visualAssets.every((asset) => !asset.file.includes("..")));
    assert.equal(captured.codeBlocks.length, 2);
    assert.deepEqual(
      captured.codeBlocks.map((block) => block.language).sort(),
      ["Python", "R"],
    );
    assert.ok(captured.codeBlocks.every((block) => block.contextBlockIds.length > 0));
    assert.ok(captured.context.length >= 4);
    assert.ok(captured.context.some((block) => block.text.includes("不应自动与图 1 拼接或裁切")));
    assert.equal(captured.warnings.length, 0);
    assert.equal(articleRequests, 1);
    assert.equal(imageRequests, 2);
    assert.deepEqual(
      [...new Set(resolvedHosts)].sort(),
      ["mmbiz.qpic.cn", "mp.weixin.qq.com"],
      "fake fetch unexpectedly bypassed the injected public DNS resolver",
    );

    const raw = await store.readAsset(captured.captureId, captured.rawPayload.assetId);
    assert.equal(raw.asset.sha256, captured.source.rawSha256);
    assert.match(new TextDecoder().decode(raw.bytes), /id="js_content"/u);
    const visual = await store.readAsset(captured.captureId, captured.visualAssets[0]!.assetId);
    assert.equal(visual.bytes.byteLength, captured.visualAssets[0]!.bytes);
    const code = await store.readAsset(captured.captureId, captured.codeBlocks[0]!.blockId);
    assert.match(new TextDecoder().decode(code.bytes), /ggplot|seaborn/u);

    const replay = await store.captureArticle({
      url: "https://mp.weixin.qq.com/s/example",
      operationId: "capture-test-operation",
    });
    assert.equal(replay.captureId, captured.captureId);
    assert.equal(articleRequests, 1, "operation replay unexpectedly repeated the network fetch");
    assert.equal((await store.list()).length, 1);

    await assert.rejects(
      store.captureArticle({
        url: "https://mp.weixin.qq.com/s/different",
        operationId: "capture-test-operation",
      }),
      captureErrorCode("capture_operation_conflict"),
    );

    const archived = await store.archive(captured.captureId);
    assert.equal(archived.state, "archived");
    assert.equal((await store.list()).length, 0);
    assert.equal((await store.list({ includeArchived: true }))[0]?.state, "archived");
    const restored = await store.restore(captured.captureId);
    assert.equal(restored.state, "active");
    assert.ok(restored.archivedAt);
    assert.ok(restored.restoredAt);

    const noReceipt = await store.planCleanup({
      captureId: captured.captureId,
      mode: "prune_payload",
    });
    assert.equal(noReceipt.schema, CAPTURE_CLEANUP_PLAN_SCHEMA);
    assert.equal(noReceipt.ready, false);
    assert.deepEqual(noReceipt.blockers.map((blocker) => blocker.code), [
      "materialization_receipt_required",
    ]);
    assert.equal(noReceipt.deletionEnabled, false);
    assert.equal(noReceipt.written, false);

    const selected = [
      captured.visualAssets[0]!,
      captured.codeBlocks[0]!,
      captured.context[0]!,
    ];
    const receipt = {
      schema: "figure-library.capture-materialization-receipt.v1",
      receiptId: "receipt-capture-test",
      captureId: captured.captureId,
      templateId: "template-capture-test",
      revisionId: "revision-capture-test",
      contentDigest: "a".repeat(64),
      requiredAssetSha256: selected.map((asset) => asset.sha256),
      assetInventory: selected.map((asset) => ({
        logicalPath: asset.file,
        role: asset === selected[0] ? "visual" : asset === selected[1] ? "code" : "context",
        bytes: asset.bytes,
        sha256: asset.sha256,
      })),
      selectionDigest: "b".repeat(64),
      committedAt: "2026-08-05T00:00:00.000Z",
      selfContained: true,
    };
    const ready = await store.planCleanup({
      captureId: captured.captureId,
      mode: "full_purge",
      durableReceipts: [receipt],
    });
    assert.equal(ready.ready, true);
    assert.equal(ready.matchedReceipts[0]?.receiptId, "receipt-capture-test");
    assert.deepEqual(ready.selectedAssetSha256, selected.map((asset) => asset.sha256).sort());
    assert.match(ready.planDigest, /^[a-f0-9]{64}$/u);
    await assert.rejects(
      store.applyCleanup({
        captureId: captured.captureId,
        mode: "full_purge",
        operationId: "cleanup-test",
        planDigest: ready.planDigest,
      }),
      captureErrorCode("cleanup_not_enabled"),
    );

    const visualFile = path.join(
      root,
      "capture",
      "captures",
      captured.captureId,
      ...captured.visualAssets[0]!.file.split("/"),
    );
    await fs.appendFile(visualFile, new Uint8Array([1]));
    await assert.rejects(
      store.readAsset(captured.captureId, captured.visualAssets[0]!.assetId),
      captureErrorCode("capture_asset_size_mismatch"),
    );
    const corruptCleanup = await store.planCleanup({
      captureId: captured.captureId,
      mode: "full_purge",
      durableReceipts: [receipt],
    });
    assert.equal(corruptCleanup.ready, false);
    assert.ok(
      corruptCleanup.blockers.some(
        (blocker) => blocker.code === "selected_capture_payload_integrity_failed",
      ),
      "cleanup readiness ignored a corrupted selected Capture payload",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("DNS validation blocks private answers and validates every redirect before transport", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-dns-"));
  try {
    let privateFetchCalls = 0;
    const mixedResolver: CaptureResolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.20.30.40", family: 4 },
    ];
    const privateTarget = new CaptureStore(
      path.join(root, "private"),
      async () => {
        privateFetchCalls += 1;
        return new Response("must not be reached");
      },
      mixedResolver,
    );
    await assert.rejects(
      privateTarget.captureArticle({ url: "https://public-name.example.test/article" }),
      captureErrorCode("unsafe_capture_address"),
    );
    assert.equal(privateFetchCalls, 0, "fetch ran despite a private address in lookup-all results");

    let redirectFetchCalls = 0;
    const redirectResolver: CaptureResolver = async (hostname) =>
      hostname === "private-redirect.example.test"
        ? [{ address: "192.168.10.5", family: 4 }]
        : [{ address: "93.184.216.34", family: 4 }];
    const redirectTarget = new CaptureStore(
      path.join(root, "redirect"),
      async () => {
        redirectFetchCalls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "http://private-redirect.example.test/internal" },
        });
      },
      redirectResolver,
    );
    await assert.rejects(
      redirectTarget.captureArticle({ url: "https://public-redirect.example.test/article" }),
      captureErrorCode("unsafe_capture_address"),
    );
    assert.equal(redirectFetchCalls, 1, "redirect target was fetched before private DNS rejection");

  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("controlled socket lookup pins a validated IP and preserves HTTPS identity across DNS rebinding", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-dns-pin-"));
  try {
    let resolverCalls = 0;
    let transportCalls = 0;
    const observedLookups: Array<{ address: string; family: number }> = [];
    let observedAllLookup: Array<{ address: string; family: number }> = [];
    const transport: CaptureRequestTransport = async ({
      url,
      resolvedAddresses,
      requestOptions,
    }) => {
      transportCalls += 1;
      assert.equal(url.toString(), "https://rebind.example.test/article");
      assert.deepEqual(resolvedAddresses, [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ]);
      assert.equal(requestOptions.hostname, "rebind.example.test");
      assert.equal(requestOptions.servername, "rebind.example.test");
      assert.equal(requestOptions.rejectUnauthorized, true);
      assert.equal(requestOptions.agent, false);
      assert.equal(requestOptions.family, 0);
      assert.equal(requestOptions.autoSelectFamily, true);
      assert.equal(requestOptions.path, "/article");
      assert.equal(
        (requestOptions.headers as Record<string, string>).Host,
        "rebind.example.test",
      );
      const lookup = requestOptions.lookup;
      assert.ok(lookup, "controlled Node lookup was not supplied to the transport");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
          lookup(
            "rebind.example.test",
            { all: false, family: 0 },
            (error, address, family) => {
              if (error) reject(error);
              else if (typeof address !== "string") reject(new Error("expected one pinned address"));
              else resolve({ address, family: family ?? 0 });
            },
          );
        });
        observedLookups.push(result);
      }
      observedAllLookup = await new Promise<Array<{ address: string; family: number }>>(
        (resolve, reject) => {
          lookup(
            "rebind.example.test",
            { all: true, family: 0 },
            (error, addresses) => {
              if (error) reject(error);
              else if (!Array.isArray(addresses)) reject(new Error("expected all pinned addresses"));
              else resolve(addresses);
            },
          );
        },
      );
      await assert.rejects(
        new Promise<void>((resolve, reject) => {
          lookup(
            "different.example.test",
            { all: false, family: 0 },
            (error) => (error ? reject(error) : resolve()),
          );
        }),
        /refused unexpected hostname/u,
      );
      return new Response("<html><article>socket stayed on the validated peer</article></html>", {
        headers: { "content-type": "text/html" },
      });
    };
    const rebindingTarget = new CaptureStore(
      path.join(root, "rebinding"),
      undefined,
      async () => {
        resolverCalls += 1;
        return resolverCalls === 1
          ? [
              { address: "93.184.216.34", family: 4 },
              { address: "2606:4700:4700::1111", family: 6 },
            ]
          : [{ address: "127.0.0.1", family: 4 }];
      },
      transport,
    );
    const captured = await rebindingTarget.captureArticle({
      url: "https://rebind.example.test/article",
    });
    assert.equal(captured.source.finalUrl, "https://rebind.example.test/article");
    assert.equal(resolverCalls, 1, "socket lookup unexpectedly re-entered the DNS resolver");
    assert.equal(transportCalls, 1);
    assert.deepEqual(observedLookups, [
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.34", family: 4 },
    ]);
    assert.deepEqual(observedAllLookup, [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("each public redirect hop receives a newly validated and independently pinned address set", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-redirect-pin-"));
  try {
    const resolutions: string[] = [];
    const requests: Array<{
      hostname: string;
      addresses: readonly { address: string; family: 4 | 6 }[];
      hostHeader: string;
      servername?: string;
    }> = [];
    const resolver: CaptureResolver = async (hostname) => {
      resolutions.push(hostname);
      return hostname === "first.example.test"
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "8.8.8.8", family: 4 }];
    };
    const transport: CaptureRequestTransport = async ({
      url,
      resolvedAddresses,
      requestOptions,
    }) => {
      requests.push({
        hostname: url.hostname,
        addresses: resolvedAddresses,
        hostHeader: (requestOptions.headers as Record<string, string>).Host!,
        ...(requestOptions.servername ? { servername: requestOptions.servername } : {}),
      });
      return url.hostname === "first.example.test"
        ? new Response(null, {
            status: 302,
            headers: { location: "https://second.example.test/final?from=redirect" },
          })
        : new Response("<html><article>final public hop</article></html>", {
            headers: { "content-type": "text/html" },
          });
    };
    const target = new CaptureStore(path.join(root, "capture"), undefined, resolver, transport);
    const captured = await target.captureArticle({
      url: "https://first.example.test/start",
    });
    assert.equal(captured.source.finalUrl, "https://second.example.test/final?from=redirect");
    assert.deepEqual(resolutions, ["first.example.test", "second.example.test"]);
    assert.deepEqual(requests, [
      {
        hostname: "first.example.test",
        addresses: [{ address: "93.184.216.34", family: 4 }],
        hostHeader: "first.example.test",
        servername: "first.example.test",
      },
      {
        hostname: "second.example.test",
        addresses: [{ address: "8.8.8.8", family: 4 }],
        hostHeader: "second.example.test",
        servername: "second.example.test",
      },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("challenge, login, non-HTML, and unsafe URLs fail explicitly without a stored capture", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-errors-"));
  try {
    const challenge = new CaptureStore(
      path.join(root, "challenge"),
      async () =>
        new Response('<html><div class="weui-msg">当前网络环境异常，请完成验证</div></html>', {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      publicResolver,
    );
    await assert.rejects(
      challenge.captureArticle({ url: "https://mp.weixin.qq.com/s/challenge" }),
      captureErrorCode("capture_challenge"),
    );
    assert.deepEqual(await challenge.list({ includeArchived: true }), []);

    const login = new CaptureStore(
      path.join(root, "login"),
      async () =>
        new Response('<html><form id="login">请先登录</form></html>', {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      publicResolver,
    );
    await assert.rejects(
      login.captureArticle({ url: "https://mp.weixin.qq.com/s/login" }),
      captureErrorCode("capture_login_required"),
    );

    const nonHtml = new CaptureStore(
      path.join(root, "non-html"),
      async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
      publicResolver,
    );
    await assert.rejects(
      nonHtml.captureArticle({ url: "https://mp.weixin.qq.com/s/not-html" }),
      captureErrorCode("capture_not_html"),
    );

    const unsafe = new CaptureStore(
      path.join(root, "unsafe"),
      async () => new Response("never reached"),
      publicResolver,
    );
    await assert.rejects(
      unsafe.captureArticle({ url: "http://127.0.0.1/internal" }),
      captureErrorCode("unsafe_capture_url"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
