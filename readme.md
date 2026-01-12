# Brotli Polyfill

A pure-JS Brotli compression and decompressor for browsers that do not fully support the `brotli` mode in [CompressionStream](https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream).

## Spec

This package is implemented as a single-file, zero-dependency library that fully implements a brotli compressor and decompressor. It is byte-for-byte compatible with CompressionStream and DecompressionStream as implemented in NodeJS 24.7+.