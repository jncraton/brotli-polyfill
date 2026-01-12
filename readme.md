# Brotli Polyfill

A pure-JS Brotli compression and decompressor for browsers that do not fully support the `brotli` mode in [CompressionStream](https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream).

## Spec

This package is implemented as a single-file, zero-dependency library that fully implements a brotli compressor and decompressor. It is byte-for-byte compatible with CompressionStream and DecompressionStream as implemented in NodeJS 24.7+.

The package provides two functions. They are equivalent to the following, but implement in pure JS rather than using CompressionStream and DecompressionStream.

```js
async function BrotliCompress(text) {
    let stream = new Blob([text]).stream()

    stream = stream.pipeThrough(new CompressionStream('brotli'))
    const res = await new Response(stream)

    const blob = await res.blob()

    const buffer = await blob.arrayBuffer()

    return new Uint8Array(buffer)
}

async function BrotliDecompress(compressed_text) {
    let stream = new Blob([binary]).stream()

    stream = stream.pipeThrough(new DecompressionStream('brotli'))

    const res = await new Response(stream)
    const blob = await res.blob()

    return await blob.text()
}
```

## Testing

This software is implemented as a single file, `brotli.js`. It includes simple tests that can be run in NodeJS 24.7+. It does not use NPM or install any other packages for either deployment or testing.

Test can be run as:

```sh
node test.js
```
