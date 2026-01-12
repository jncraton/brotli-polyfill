const fs = require('node:fs')

const src = fs.readFileSync('main.js', 'utf-8')

eval(src + ';globalThis.BrotliCompress = BrotliCompress;globalThis.BrotliDecompress = BrotliDecompress')

const BrotliCompress = globalThis.BrotliCompress
const BrotliDecompress = globalThis.BrotliDecompress

function expect(src) {
  return {
    toBe: val => {
      const res = e(src)

      if (res != val) {
        console.error('Assertion failed', src, res, '!=', val)
        process.exit(1)
      }
    },
  }
}

// Confirm that native implementation from CompressionStream and DecompressionStream match our implementation
expect(/* TODO */).toBe(/* TODO */)
