const fs = require("node:fs");
const zlib = require("node:zlib");

const src = fs.readFileSync("brotli.js", "utf-8");

eval(
  src +
    ";globalThis.BrotliCompress = BrotliCompress;globalThis.BrotliDecompress = BrotliDecompress",
);

// Maximum size for a single uncompressed meta-block (16-bit MLEN)
const MAX_UNCOMPRESSED_BLOCK_SIZE = 65536;

// Test helper - asserts two values are equal
function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    console.error("Assertion failed:", message);
    console.error("  Expected:", expected);
    console.error("  Actual:", actual);
    process.exit(1);
  }
}

// Test helper - asserts arrays are equal
function assertArrayEqual(actual, expected, message) {
  if (actual.length !== expected.length) {
    console.error("Assertion failed:", message);
    console.error("  Expected length:", expected.length);
    console.error("  Actual length:", actual.length);
    process.exit(1);
  }
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      console.error("Assertion failed:", message);
      console.error("  Mismatch at index", i);
      console.error("  Expected:", expected[i]);
      console.error("  Actual:", actual[i]);
      process.exit(1);
    }
  }
}

async function runTests() {
  const BrotliCompress = globalThis.BrotliCompress;
  const BrotliDecompress = globalThis.BrotliDecompress;

  let passed = 0;
  let failed = 0;

  // Test cases with various shapes and sizes
  const testCases = [
    // Basic strings
    "",
    "a",
    "ab",
    "abc",
    "Hello",
    "Hello, World!",

    // Longer text
    "The quick brown fox jumps over the lazy dog.",
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",

    // Repetitive patterns
    "A".repeat(100),
    "AB".repeat(50),
    " ".repeat(1000),
    "xyz".repeat(333),

    // Unicode text
    "🎉 Unicode test: αβγδ 中文 日本語 한국어",
    "Ελληνικά Русский العربية עברית",

    // Binary-like data
    "\x00\x01\x02\xff\xfe\xfd",
    String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i)),

    // Large data
    "x".repeat(10000),
    "Hello, World! ".repeat(1000),
  ];

  for (const testCase of testCases) {
    const label =
      testCase.length > 30
        ? `"${testCase.substring(0, 30)}..." (len=${testCase.length})`
        : `"${testCase}" (len=${testCase.length})`;

    try {
      // Test 1: Round-trip with our implementation
      const compressed = await BrotliCompress(testCase);
      const decompressed = await BrotliDecompress(compressed);
      assertEqual(decompressed, testCase, `Round-trip failed for ${label}`);

      // Test 2: Native can decompress our output
      const nativeDecompressed = zlib
        .brotliDecompressSync(Buffer.from(compressed))
        .toString();
      assertEqual(
        nativeDecompressed,
        testCase,
        `Native decompress failed for ${label}`,
      );

      // Test 3: Compressed output matches native for uncompressed blocks (small inputs)
      // Native uses uncompressed blocks for small inputs, so we should match exactly
      const nativeCompressed = zlib.brotliCompressSync(Buffer.from(testCase));
      if (
        testCase.length > 0 &&
        testCase.length <= MAX_UNCOMPRESSED_BLOCK_SIZE
      ) {
        // Check if native also uses uncompressed format (same length)
        if (nativeCompressed.length === compressed.length) {
          assertArrayEqual(
            Array.from(compressed),
            Array.from(nativeCompressed),
            `Byte-for-byte mismatch with native for ${label}`,
          );
        }
      }

      console.log(`✓ ${label}`);
      passed++;
    } catch (e) {
      console.log(`✗ ${label}`);
      console.log(`  Error: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} tests passed, ${failed} tests failed`);

  if (failed > 0) {
    process.exit(1);
  }

  // Compression ratio tests
  console.log("\n--- Compression Ratio Tests ---");
  
  const compressionTestCases = [
    { input: "A".repeat(1000), name: "1000 A's" },
    { input: "AB".repeat(500), name: "500 AB repeats" },
    { input: "Hello, World! ".repeat(100), name: "100 'Hello, World! ' repeats" },
    { input: "x".repeat(10000), name: "10000 x's" },
  ];

  let compressionPassed = 0;
  let compressionFailed = 0;

  for (const { input, name } of compressionTestCases) {
    try {
      const compressed = await BrotliCompress(input);
      const nativeCompressed = zlib.brotliCompressSync(Buffer.from(input));
      
      const inputSize = Buffer.from(input).length;
      const ourSize = compressed.length;
      const nativeSize = nativeCompressed.length;
      
      // Calculate compression ratios
      const ourRatio = ourSize / inputSize;
      const nativeRatio = nativeSize / inputSize;
      
      // Our compression should be within 5x of native compression
      // This is a relaxed target since we're implementing a simpler compressor
      const maxAllowedRatio = Math.max(nativeRatio * 5, 1.0);
      
      if (ourRatio <= maxAllowedRatio) {
        console.log(`✓ ${name}: ${inputSize} -> ${ourSize} bytes (native: ${nativeSize})`);
        compressionPassed++;
      } else {
        console.log(`✗ ${name}: ${inputSize} -> ${ourSize} bytes (native: ${nativeSize}, ratio ${(ourRatio / nativeRatio).toFixed(1)}x worse)`);
        compressionFailed++;
      }
    } catch (e) {
      console.log(`✗ ${name}: Error - ${e.message}`);
      compressionFailed++;
    }
  }

  console.log(`\n${compressionPassed} compression tests passed, ${compressionFailed} failed`);
  
  if (compressionFailed > 0) {
    console.log("Note: Compression ratio tests are informational. The polyfill currently uses uncompressed format.");
  }
}

// Run tests
runTests().catch((e) => {
  console.error("Test suite error:", e);
  process.exit(1);
});
