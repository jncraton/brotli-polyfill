const fs = require('node:fs')
const zlib = require('node:zlib')

const src = fs.readFileSync('main.js', 'utf-8')

eval(src + ';globalThis.BrotliCompress = BrotliCompress;globalThis.BrotliDecompress = BrotliDecompress')

// Test helper - asserts two values are equal
function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    console.error('Assertion failed:', message)
    console.error('  Expected:', expected)
    console.error('  Actual:', actual)
    process.exit(1)
  }
}

// Test helper - asserts arrays are equal
function assertArrayEqual(actual, expected, message) {
  if (actual.length !== expected.length) {
    console.error('Assertion failed:', message)
    console.error('  Expected length:', expected.length)
    console.error('  Actual length:', actual.length)
    process.exit(1)
  }
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      console.error('Assertion failed:', message)
      console.error('  Mismatch at index', i)
      console.error('  Expected:', expected[i])
      console.error('  Actual:', actual[i])
      process.exit(1)
    }
  }
}

async function runTests() {
  const BrotliCompress = globalThis.BrotliCompress
  const BrotliDecompress = globalThis.BrotliDecompress
  
  let passed = 0
  let failed = 0
  
  // Test cases with various shapes and sizes
  const testCases = [
    // Basic strings
    '',
    'a',
    'ab',
    'abc',
    'Hello',
    'Hello, World!',
    
    // Longer text
    'The quick brown fox jumps over the lazy dog.',
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    
    // Repetitive patterns
    'A'.repeat(100),
    'AB'.repeat(50),
    ' '.repeat(1000),
    'xyz'.repeat(333),
    
    // Unicode text
    '🎉 Unicode test: αβγδ 中文 日本語 한국어',
    'Ελληνικά Русский العربية עברית',
    
    // Binary-like data
    '\x00\x01\x02\xff\xfe\xfd',
    String.fromCharCode(...Array.from({length: 256}, (_, i) => i)),
    
    // Large data
    'x'.repeat(10000),
    'Hello, World! '.repeat(1000),
  ]
  
  for (const testCase of testCases) {
    const label = testCase.length > 30 
      ? `"${testCase.substring(0, 30)}..." (len=${testCase.length})`
      : `"${testCase}" (len=${testCase.length})`
    
    try {
      // Test 1: Round-trip with our implementation
      const compressed = await BrotliCompress(testCase)
      const decompressed = await BrotliDecompress(compressed)
      assertEqual(decompressed, testCase, `Round-trip failed for ${label}`)
      
      // Test 2: Native can decompress our output
      const nativeDecompressed = zlib.brotliDecompressSync(Buffer.from(compressed)).toString()
      assertEqual(nativeDecompressed, testCase, `Native decompress failed for ${label}`)
      
      // Test 3: Compressed output matches native for uncompressed blocks (small inputs)
      // Native uses uncompressed blocks for small inputs, so we should match exactly
      const nativeCompressed = zlib.brotliCompressSync(Buffer.from(testCase))
      if (testCase.length > 0 && testCase.length <= 65536) {
        // Check if native also uses uncompressed format (same length)
        if (nativeCompressed.length === compressed.length) {
          assertArrayEqual(
            Array.from(compressed),
            Array.from(nativeCompressed),
            `Byte-for-byte mismatch with native for ${label}`
          )
        }
      }
      
      console.log(`✓ ${label}`)
      passed++
    } catch (e) {
      console.log(`✗ ${label}`)
      console.log(`  Error: ${e.message}`)
      failed++
    }
  }
  
  console.log(`\n${passed} tests passed, ${failed} tests failed`)
  
  if (failed > 0) {
    process.exit(1)
  }
}

// Run tests
runTests().catch(e => {
  console.error('Test suite error:', e)
  process.exit(1)
})
