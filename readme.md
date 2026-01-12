# Brotli Polyfill

[![Lint](https://github.com/jncraton/brotli-polyfill/actions/workflows/lint.yml/badge.svg)](https://github.com/jncraton/brotli-polyfill/actions/workflows/lint.yml)
[![Test](https://github.com/jncraton/brotli-polyfill/actions/workflows/test.yml/badge.svg)](https://github.com/jncraton/brotli-polyfill/actions/workflows/test.yml)
[![Deploy](https://github.com/jncraton/brotli-polyfill/actions/workflows/deploy.yml/badge.svg)](https://github.com/jncraton/brotli-polyfill/actions/workflows/deploy.yml)

Drop-in Brotli support everywhere—even when browsers ship without it. This polyfill brings RFC 7932 Brotli compression and decompression to environments where `CompressionStream`/`DecompressionStream` lack `"brotli"` support, while staying byte-for-byte compatible with modern runtimes (Node.js 24.7+).

> [!IMPORTANT]
> **Single file. Vanilla JavaScript. Zero dependencies.** Ship `brotli.js` or the minified build without touching your package.json.

## Why this library?

- Fill the gap in browsers and workers that do not ship Brotli streaming primitives.
- Keep payloads small with a minified, self-contained build.
- Interop with native implementations: compressed bytes round-trip between this polyfill and Node’s built-ins.
- Works anywhere classic scripts run: main thread, Service Workers, Web Workers, and headless environments.

## API surface

- `async BrotliCompress(input: string | Uint8Array): Promise<Uint8Array>` – Encode text or bytes to Brotli-compressed data.
- `async BrotliDecompress(input: ArrayBuffer | Uint8Array | Buffer): Promise<string>` – Decode Brotli-compressed bytes back to UTF-8 text.

> [!TIP]
> Use these functions wherever you would normally pipe through `new CompressionStream("brotli")` and `new DecompressionStream("brotli")`.

## Quick start

Include the script (classic script, not a module) to expose the globals `BrotliCompress` and `BrotliDecompress`:

```html
<script src="brotli.min.js"></script>
<script>
  (async () => {
    const message = "Hello, Brotli!";
    const compressed = await BrotliCompress(message);
    const restored = await BrotliDecompress(compressed);

    console.log(restored); // "Hello, Brotli!"
  })();
</script>
```

### Worker-friendly

```js
// In a Service Worker or Web Worker
importScripts("brotli.min.js");

self.addEventListener("fetch", (event) => {
  // Forward the request as usual
  event.respondWith(fetch(event.request));

  // Also compress the body for lightweight logging/analytics
  event.waitUntil(
    (async () => {
      const body = await event.request.clone().text();
      const compressed = await BrotliCompress(body);
      await fetch("/log", { method: "POST", body: compressed });
    })(),
  );
});
```

> [!NOTE]
> Need a minified build? Run `make` (or `make brotli.min.js`) to generate `brotli.min.js` with no extra tooling or installs.

## Project preferences

- Vanilla JS only: no transpilers, no bundlers, no runtime dependencies.
- Zero-install workflow: grab `brotli.js`/`brotli.min.js` directly or drop it into your build as-is.
- Minimal surface area: just the two async functions above—keep additions similarly small and dependency-free.

## Testing and quality

Tests verify three things:

1. Round-trip correctness for diverse inputs (ASCII, Unicode, binary-like data, and large strings).
2. Native compatibility: Node can decompress what this polyfill compresses.
3. Byte-for-byte parity with Node for small uncompressed blocks.

Run them with:

```sh
make test
# or
node test.js
```
