import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CaptureError,
  CaptureStore,
  type CaptureRequestTransport,
  type CaptureResolver,
} from "../src/capture.ts";

const PUBLIC_RESOLVER: CaptureResolver = async () => [
  { address: "93.184.216.34", family: 4 },
];
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function errorCode(expected: string) {
  return (error: unknown) => error instanceof CaptureError && error.code === expected;
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("an intermediate symlink into FIGURE_LIBRARY_DIR is not treated as an isolated Capture root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-symlink-isolation-"));
  const previousLibrary = process.env.FIGURE_LIBRARY_DIR;
  try {
    const library = path.join(root, "canonical-library");
    const alias = path.join(root, "library-alias");
    await fs.mkdir(library);
    await fs.symlink(library, alias, process.platform === "win32" ? "junction" : "dir");
    process.env.FIGURE_LIBRARY_DIR = library;

    let fetchCalls = 0;
    const store = new CaptureStore(
      path.join(alias, "raw-capture"),
      async () => {
        fetchCalls += 1;
        return new Response("must not be fetched");
      },
      PUBLIC_RESOLVER,
    );
    const status = await store.status();
    assert.equal(status.source, "constructor");
    assert.equal(status.isolated, false);
    assert.equal(status.available, false);
    assert.match(status.reason ?? "", /separate|overlap/iu);

    await assert.rejects(
      store.captureArticle({ url: "https://article.example.test/symlink" }),
      errorCode("capture_directory_conflict"),
    );
    assert.equal(fetchCalls, 0, "network fetch ran despite Capture/Library alias overlap");
  } finally {
    if (previousLibrary === undefined) delete process.env.FIGURE_LIBRARY_DIR;
    else process.env.FIGURE_LIBRARY_DIR = previousLibrary;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTML with a forged image/png header remains raw HTML rather than a visual image", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-forged-image-"));
  try {
    const html = "<!doctype html><html><article><p>Untrusted article body.</p></article></html>";
    const store = new CaptureStore(
      path.join(root, "capture"),
      async () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      PUBLIC_RESOLVER,
    );
    const capture = await store.captureArticle({
      url: "https://article.example.test/forged-image",
    });

    assert.equal(capture.visualAssets.length, 0);
    assert.equal(capture.rawPayload.file, "raw/article.html");
    assert.equal(
      capture.rawPayload.mediaType,
      "text/html",
      "a remote Content-Type header mislabeled raw HTML as an exposable raster image",
    );
    const raw = await store.readAsset(capture.captureId, capture.rawPayload.assetId);
    assert.match(new TextDecoder().decode(raw.bytes), /Untrusted article body/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verifiedAssetSource returns the already hash-checked stored file while public reads omit its path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-verified-source-"));
  try {
    const html =
      '<!doctype html><html><article><p>Figure context.</p><img src="https://asset.example.test/figure.png"></article></html>';
    const store = new CaptureStore(
      path.join(root, "capture"),
      async (input) =>
        input.toString().includes("asset.example.test")
          ? new Response(PNG, {
              status: 200,
              headers: { "content-type": "image/png" },
            })
          : new Response(html, {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
      PUBLIC_RESOLVER,
    );
    const capture = await store.captureArticle({
      url: "https://article.example.test/verified-source",
    });
    const visual = capture.visualAssets[0];
    assert.ok(visual, "fixture image was not captured");

    const internal = await store.verifiedAssetSource(capture.captureId, visual.assetId);
    assert.equal(internal.asset.sha256, visual.sha256);
    assert.equal(path.isAbsolute(internal.sourcePath), true);
    const [captureRoot, sourcePath] = await Promise.all([
      fs.realpath(path.join(root, "capture")),
      fs.realpath(internal.sourcePath),
    ]);
    const relative = path.relative(captureRoot, sourcePath);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    const stat = await fs.lstat(internal.sourcePath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(digest(new Uint8Array(await fs.readFile(internal.sourcePath))), visual.sha256);

    const publicRead = await store.readAsset(capture.captureId, visual.assetId);
    assert.equal("sourcePath" in publicRead, false, "host-local path leaked through public readAsset");

    await fs.appendFile(internal.sourcePath, new Uint8Array([1]));
    await assert.rejects(
      store.verifiedAssetSource(capture.captureId, visual.assetId),
      errorCode("capture_asset_size_mismatch"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("raw, visual, code, and context assets reject parent-directory symlink escapes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-asset-parent-symlink-"));
  try {
    const html = await fs.readFile(
      path.join(import.meta.dirname, "fixtures", "wechat-article.html"),
      "utf8",
    );
    const store = new CaptureStore(
      path.join(root, "capture"),
      async (input) =>
        input.toString().startsWith("https://mp.weixin.qq.com/")
          ? new Response(html, {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          : new Response(PNG, {
              status: 200,
              headers: { "content-type": "image/png" },
            }),
      PUBLIC_RESOLVER,
    );
    const capture = await store.captureArticle({
      url: "https://mp.weixin.qq.com/s/asset-parent-symlink",
    });
    const visual = capture.visualAssets[0];
    const code = capture.codeBlocks[0];
    const context = capture.context[0];
    assert.ok(visual && code && context, "fixture did not produce every Capture asset class");

    const candidates = [
      { kind: "raw", assetId: capture.rawPayload.assetId, asset: capture.rawPayload },
      { kind: "visual", assetId: visual.assetId, asset: visual },
      { kind: "code", assetId: code.blockId, asset: code },
      { kind: "context", assetId: context.blockId, asset: context },
    ];
    const recordDirectory = path.join(root, "capture", "captures", capture.captureId);

    for (const candidate of candidates) {
      const sourcePath = path.join(recordDirectory, ...candidate.asset.file.split("/"));
      const parentDirectory = path.dirname(sourcePath);
      const backupDirectory = `${parentDirectory}.symlink-test-backup-${candidate.kind}`;
      const externalDirectory = path.join(root, `outside-record-${candidate.kind}`);
      const originalBytes = new Uint8Array(await fs.readFile(sourcePath));
      assert.equal(originalBytes.byteLength, candidate.asset.bytes);
      assert.equal(digest(originalBytes), candidate.asset.sha256);

      let parentMoved = false;
      let symlinkCreated = false;
      try {
        await fs.rename(parentDirectory, backupDirectory);
        parentMoved = true;
        await fs.mkdir(externalDirectory);
        const externalFile = path.join(externalDirectory, path.basename(sourcePath));
        await fs.writeFile(externalFile, originalBytes);
        const externalBytes = new Uint8Array(await fs.readFile(externalFile));
        assert.equal(externalBytes.byteLength, candidate.asset.bytes);
        assert.equal(digest(externalBytes), candidate.asset.sha256);
        await fs.symlink(
          externalDirectory,
          parentDirectory,
          process.platform === "win32" ? "junction" : "dir",
        );
        symlinkCreated = true;

        await assert.rejects(
          store.readAsset(capture.captureId, candidate.assetId),
          errorCode("capture_asset_path_escape"),
          `${candidate.kind} asset followed a parent-directory symlink outside its Capture record`,
        );
      } finally {
        if (symlinkCreated) await fs.unlink(parentDirectory);
        if (parentMoved) await fs.rename(backupDirectory, parentDirectory);
      }

      const restored = await store.readAsset(capture.captureId, candidate.assetId);
      assert.equal(restored.bytes.byteLength, candidate.asset.bytes);
      assert.equal(digest(restored.bytes), candidate.asset.sha256);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resolved loopback, private, link-local, metadata, and non-global IPv6 targets never reach transport", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-non-public-"));
  try {
    const blocked: Array<{ address: string; family: 4 | 6 }> = [
      { address: "127.0.0.1", family: 4 },
      { address: "10.42.0.5", family: 4 },
      { address: "168.63.129.16", family: 4 },
      { address: "169.254.169.254", family: 4 },
      { address: "192.168.1.20", family: 4 },
      { address: "::1", family: 6 },
      { address: "::ffff:127.0.0.1", family: 6 },
      { address: "64:ff9b::a9fe:a9fe", family: 6 },
      { address: "fc00::1", family: 6 },
      { address: "fe80::1", family: 6 },
    ];
    for (const [index, answer] of blocked.entries()) {
      let transportCalls = 0;
      const store = new CaptureStore(
        path.join(root, `capture-${index}`),
        async () => {
          transportCalls += 1;
          return new Response("must not be reached");
        },
        async () => [answer],
      );
      await assert.rejects(
        store.captureArticle({ url: `https://resolved-${index}.example.test/article` }),
        errorCode("unsafe_capture_address"),
      );
      assert.equal(transportCalls, 0, `transport reached blocked address ${answer.address}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("response body timeout cancels a stalled stream and stores no partial Capture", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-body-timeout-"));
  try {
    let cancelled = false;
    const transport: CaptureRequestTransport = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<html><article>partial"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/html" } },
      );
    const store = new CaptureStore(
      path.join(root, "capture"),
      undefined,
      PUBLIC_RESOLVER,
      transport,
      25,
    );
    await assert.rejects(
      store.captureArticle({ url: "https://slow.example.test/article" }),
      errorCode("capture_fetch_timeout"),
    );
    assert.equal(cancelled, true, "timed-out response stream was not cancelled");
    assert.deepEqual(await store.list({ includeArchived: true }), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("one monotonic total deadline ignores wall-clock jumps and stops late writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-total-deadline-"));
  const originalDateNow = Date.now;
  try {
    const images = Array.from(
      { length: 20 },
      (_item, index) => `<img src="https://asset.example.test/slow-${index}.png">`,
    ).join("");
    const html = `<!doctype html><html><article><p>Context.</p>${images}</article></html>`;
    let imageRequests = 0;
    let wallClockJumped = false;
    const transport: CaptureRequestTransport = async ({ url }) => {
      if (url.hostname === "article.example.test") {
        return new Response(html, { headers: { "content-type": "text/html" } });
      }
      imageRequests += 1;
      if (!wallClockJumped) {
        const jumpedTo = originalDateNow() + 24 * 60 * 60 * 1_000;
        Date.now = () => jumpedTo;
        wallClockJumped = true;
      }
      // Deliberately ignore requestOptions.signal: the capture-wide race must still stop the
      // pipeline, and this late response must never resume iteration or reach durable storage.
      await new Promise((resolve) => setTimeout(resolve, 120));
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    };
    const store = new CaptureStore(
      path.join(root, "capture"),
      undefined,
      PUBLIC_RESOLVER,
      transport,
      1_000,
      900,
    );
    const startedAt = performance.now();
    await assert.rejects(
      store.captureArticle({
        url: "https://article.example.test/many-slow-images",
        operationId: "deadline-many-images",
      }),
      errorCode("capture_deadline_exceeded"),
    );
    const elapsed = performance.now() - startedAt;
    assert.ok(elapsed < 2_500, `total deadline was not enforced promptly (${elapsed} ms)`);
    assert.equal(wallClockJumped, true, "fixture did not simulate a forward wall-clock jump");
    assert.ok(imageRequests >= 2, "fixture did not exercise a sequence of image requests");
    assert.ok(imageRequests < 20, "capture continued starting images after its total deadline");
    const requestsAtFailure = imageRequests;

    assert.deepEqual(await store.list({ includeArchived: true }), []);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(imageRequests, requestsAtFailure, "a late transport resumed the image loop");
    assert.deepEqual(await store.list({ includeArchived: true }), []);
    assert.deepEqual(
      await fs.readdir(path.join(root, "capture", "operations")),
      [],
      "deadline failure left an operation receipt or temporary operation file",
    );
  } finally {
    Date.now = originalDateNow;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("host cancellation aborts a stalled image body and records no Capture or operation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-host-cancel-"));
  try {
    const html =
      '<!doctype html><html><article><p>Context.</p><img src="https://asset.example.test/stalled.png"></article></html>';
    let bodyCancelled = false;
    let imageStarted!: () => void;
    const imageStartedPromise = new Promise<void>((resolve) => {
      imageStarted = resolve;
    });
    const transport: CaptureRequestTransport = async ({ url }) => {
      if (url.hostname === "article.example.test") {
        return new Response(html, { headers: { "content-type": "text/html" } });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(PNG);
            imageStarted();
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        { headers: { "content-type": "image/png" } },
      );
    };
    const controller = new AbortController();
    const store = new CaptureStore(
      path.join(root, "capture"),
      undefined,
      PUBLIC_RESOLVER,
      transport,
      1_000,
      2_000,
    );
    const capture = store.captureArticle({
      url: "https://article.example.test/host-cancel",
      operationId: "host-cancel-operation",
      signal: controller.signal,
    });
    await imageStartedPromise;
    controller.abort();
    await assert.rejects(capture, errorCode("capture_cancelled"));
    assert.equal(bodyCancelled, true, "host cancellation did not cancel the active image stream");
    assert.deepEqual(await store.list({ includeArchived: true }), []);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(await store.list({ includeArchived: true }), []);
    assert.deepEqual(
      await fs.readdir(path.join(root, "capture", "operations")),
      [],
      "cancelled capture left an operation receipt or temporary operation file",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the total deadline also bounds DNS resolution before transport", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-capture-dns-deadline-"));
  try {
    let transportCalls = 0;
    const resolver: CaptureResolver = async () => new Promise(() => undefined);
    const transport: CaptureRequestTransport = async () => {
      transportCalls += 1;
      return new Response("must not be reached");
    };
    const store = new CaptureStore(
      path.join(root, "capture"),
      undefined,
      resolver,
      transport,
      1_000,
      35,
    );
    await assert.rejects(
      store.captureArticle({ url: "https://dns-stall.example.test/article" }),
      errorCode("capture_deadline_exceeded"),
    );
    assert.equal(transportCalls, 0);
    assert.deepEqual(await store.list({ includeArchived: true }), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
