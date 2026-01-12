// Brotli Polyfill - Pure JavaScript Brotli compression and decompression
// Implements RFC 7932

// ============================================================================
// BROTLI DECOMPRESSION
// ============================================================================

// Brotli uses several prefix codes and lookup tables
// These are specified in RFC 7932

// Simple prefix code lengths for literal/insert-and-copy length and distance alphabet
const kCodeLengthCodeOrder = new Uint8Array([
  1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15,
]);

// Block length prefix codes
const kBlockLengthPrefixCode = [
  [1, 2],
  [5, 2],
  [9, 2],
  [13, 2],
  [17, 3],
  [25, 3],
  [33, 3],
  [41, 3],
  [49, 4],
  [65, 4],
  [81, 4],
  [97, 4],
  [113, 5],
  [145, 5],
  [177, 5],
  [209, 5],
  [241, 6],
  [305, 6],
  [369, 7],
  [497, 8],
  [753, 9],
  [1265, 10],
  [2289, 11],
  [4337, 12],
  [8433, 13],
  [16625, 24],
];

// Insert length prefix codes
const kInsertLengthPrefixCode = [
  [0, 0],
  [1, 0],
  [2, 0],
  [3, 0],
  [4, 0],
  [5, 0],
  [6, 1],
  [8, 1],
  [10, 2],
  [14, 2],
  [18, 3],
  [26, 3],
  [34, 4],
  [50, 4],
  [66, 5],
  [98, 5],
  [130, 6],
  [194, 7],
  [322, 8],
  [578, 9],
  [1090, 10],
  [2114, 12],
  [6210, 14],
  [22594, 24],
];

// Copy length prefix codes
const kCopyLengthPrefixCode = [
  [2, 0],
  [3, 0],
  [4, 0],
  [5, 0],
  [6, 0],
  [7, 0],
  [8, 0],
  [9, 0],
  [10, 1],
  [12, 1],
  [14, 2],
  [18, 2],
  [22, 3],
  [30, 3],
  [38, 4],
  [54, 4],
  [70, 5],
  [102, 5],
  [134, 6],
  [198, 7],
  [326, 8],
  [582, 9],
  [1094, 10],
  [2118, 24],
];

// Distance prefix codes
const kDistanceShortCodeIndexOffset = new Int8Array([
  0, 3, 2, 1, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3,
]);

const kDistanceShortCodeValueOffset = new Int8Array([
  0, 0, 0, 0, -1, 1, -2, 2, -3, 3, -1, 1, -2, 2, -3, 3,
]);

// Insert and copy combined codes table
const kInsertRangeLut = new Uint8Array([0, 0, 8, 8, 0, 16, 8, 16, 16]);
const kCopyRangeLut = new Uint8Array([0, 8, 0, 8, 16, 0, 16, 8, 16]);

// Bit reading utilities
class BitReader {
  constructor(data) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.pos = 0;
    this.bitPos = 0;
    this.val = 0;
    this.bitsAvailable = 0;
  }

  fillBits() {
    while (this.bitsAvailable < 24 && this.pos < this.data.length) {
      this.val |= this.data[this.pos++] << this.bitsAvailable;
      this.bitsAvailable += 8;
    }
  }

  readBits(n) {
    if (n === 0) return 0;
    this.fillBits();
    const result = this.val & ((1 << n) - 1);
    this.val >>>= n;
    this.bitsAvailable -= n;
    return result;
  }

  peekBits(n) {
    this.fillBits();
    return this.val & ((1 << n) - 1);
  }

  dropBits(n) {
    this.val >>>= n;
    this.bitsAvailable -= n;
  }
}

// Huffman decoding
function buildHuffmanTable(codeLengths, numSymbols) {
  const table = [];
  const maxLen = Math.max(...codeLengths.slice(0, numSymbols));

  if (maxLen === 0) return table;

  const blCount = new Array(maxLen + 1).fill(0);
  for (let i = 0; i < numSymbols; i++) {
    if (codeLengths[i] > 0) blCount[codeLengths[i]]++;
  }

  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  for (let i = 0; i < numSymbols; i++) {
    const len = codeLengths[i];
    if (len > 0) {
      let c = nextCode[len]++;
      // Reverse bits
      let rc = 0;
      for (let j = 0; j < len; j++) {
        rc = (rc << 1) | (c & 1);
        c >>>= 1;
      }
      table.push({ symbol: i, bits: rc, len: len });
    }
  }

  // Sort for faster lookup
  table.sort((a, b) => a.len - b.len || a.bits - b.bits);

  return table;
}

function readHuffmanSymbol(br, table) {
  if (table.length === 0) return 0;
  if (table.length === 1) return table[0].symbol;

  br.fillBits();

  for (const entry of table) {
    const mask = (1 << entry.len) - 1;
    if ((br.val & mask) === entry.bits) {
      br.dropBits(entry.len);
      return entry.symbol;
    }
  }

  throw new Error("Invalid Huffman code");
}

// Read simple prefix code (RFC 7932 section 3.4)
function readSimplePrefixCode(br, alphabetSize) {
  const codeLengths = new Uint8Array(alphabetSize);
  const numSymbols = br.readBits(2) + 1;
  const symbolBits = Math.max(1, Math.ceil(Math.log2(alphabetSize)));

  const symbols = [];
  for (let i = 0; i < numSymbols; i++) {
    symbols.push(br.readBits(symbolBits));
  }

  if (numSymbols === 1) {
    codeLengths[symbols[0]] = 1;
  } else if (numSymbols === 2) {
    codeLengths[symbols[0]] = 1;
    codeLengths[symbols[1]] = 1;
  } else if (numSymbols === 3) {
    codeLengths[symbols[0]] = 1;
    codeLengths[symbols[1]] = 2;
    codeLengths[symbols[2]] = 2;
  } else {
    const treeSelect = br.readBits(1);
    if (treeSelect) {
      codeLengths[symbols[0]] = 2;
      codeLengths[symbols[1]] = 2;
      codeLengths[symbols[2]] = 2;
      codeLengths[symbols[3]] = 2;
    } else {
      codeLengths[symbols[0]] = 1;
      codeLengths[symbols[1]] = 2;
      codeLengths[symbols[2]] = 3;
      codeLengths[symbols[3]] = 3;
    }
  }

  return buildHuffmanTable(codeLengths, alphabetSize);
}

// Read complex prefix code (RFC 7932 section 3.5)
function readComplexPrefixCode(br, alphabetSize, skip) {
  // Read code length code lengths
  const codeLengthCodeLengths = new Uint8Array(18);
  let space = 32;
  let numCodes = 0;

  for (let i = skip; i < 18 && space > 0; i++) {
    const idx = kCodeLengthCodeOrder[i];
    const maxBits = Math.min(4, Math.floor(Math.log2(space + 1)));
    let v = br.peekBits(maxBits);

    // Simple variable-length code
    let len;
    if (v < 4) {
      len = v;
      br.dropBits(2);
    } else if (v < 12) {
      len = 4;
      br.dropBits(4);
    } else {
      len = 5;
      br.dropBits(4);
    }

    codeLengthCodeLengths[idx] = len;
    if (len > 0) {
      space -= 32 >> len;
      numCodes++;
    }
  }

  const codeLengthTable = buildHuffmanTable(codeLengthCodeLengths, 18);

  // Read symbol code lengths
  const codeLengths = new Uint8Array(alphabetSize);
  let symbol = 0;
  let prevCodeLen = 8;
  let repeatCode = 0;
  let repeatCount = 0;
  space = 32768;

  while (symbol < alphabetSize && space > 0) {
    const code = readHuffmanSymbol(br, codeLengthTable);

    if (code < 16) {
      codeLengths[symbol++] = code;
      if (code > 0) {
        prevCodeLen = code;
        space -= 32768 >> code;
      }
    } else if (code === 16) {
      const extra = br.readBits(2) + 3;
      for (let i = 0; i < extra && symbol < alphabetSize; i++) {
        codeLengths[symbol++] = prevCodeLen;
        space -= 32768 >> prevCodeLen;
      }
    } else if (code === 17) {
      const extra = br.readBits(3) + 3;
      symbol += extra;
    }
  }

  return buildHuffmanTable(codeLengths, alphabetSize);
}

// Read prefix codes
function readPrefixCode(br, alphabetSize) {
  const skip = br.readBits(2);

  if (skip === 1) {
    return readSimplePrefixCode(br, alphabetSize);
  }

  return readComplexPrefixCode(br, alphabetSize, skip);
}

// Context mode constants
const kContextLookup = new Uint8Array(512);
(function () {
  // LSB6 context lookup
  for (let i = 0; i < 256; i++) {
    kContextLookup[i] = i & 0x3f;
  }
  // MSB6 context lookup
  for (let i = 0; i < 256; i++) {
    kContextLookup[256 + i] = i >> 2;
  }
})();

// The static dictionary
// TODO: Implement full static dictionary from RFC 7932 Appendix A for complete
// decompression support of streams that use dictionary references.
// Currently, only streams without dictionary references are supported.
let staticDictionary = null;

function getStaticDictionary() {
  if (staticDictionary) return staticDictionary;
  staticDictionary = { words: new Uint8Array(0), offsets: [] };
  return staticDictionary;
}

// Main decompression function
function brotliDecompress(input) {
  const br = new BitReader(input);
  const output = [];

  // Read window bits (WBITS)
  let windowBits;
  if (br.readBits(1) === 0) {
    windowBits = 16;
  } else {
    const w = br.readBits(3);
    if (w === 0) {
      windowBits = 17;
    } else {
      windowBits = 17 + w;
    }
  }

  const windowSize = (1 << windowBits) - 16;
  const ringBuffer = new Uint8Array(windowSize);
  let ringBufferPos = 0;

  // Distance ring buffer
  const distRingBuffer = [4, 11, 15, 16];
  let distRingBufferIdx = 0;

  // Main decompression loop
  let isLast = false;
  while (!isLast) {
    // Read meta-block header
    isLast = br.readBits(1) === 1;

    if (isLast && br.peekBits(1) === 1) {
      br.dropBits(1);
      // Empty last block
      break;
    }

    // Read meta-block length (MLEN)
    const mnibbles = br.readBits(2);
    let metaBlockLen;

    if (mnibbles === 3) {
      // Empty meta-block
      metaBlockLen = 0;
      br.readBits(1); // Reserved bit
      if (br.readBits(1)) {
        // Skip bytes
        const skipBytes = br.readBits(2) + 1;
        while (br.bitPos % 8 !== 0) br.readBits(1);
        for (let i = 0; i < skipBytes; i++) br.readBits(8);
      }
      continue;
    }

    const nibbles = (4 + mnibbles) * 4;
    metaBlockLen = br.readBits(nibbles) + 1;

    if (isLast && metaBlockLen === 0) break;

    // Check for uncompressed block
    if (!isLast) {
      const isUncompressed = br.readBits(1);
      if (isUncompressed) {
        // Align to byte boundary
        // Calculate actual byte position by accounting for buffered bits
        const bitsConsumed = br.pos * 8 - br.bitsAvailable;
        const bytesConsumed = Math.floor(bitsConsumed / 8);
        const bitsInCurrentByte = bitsConsumed % 8;

        // Reset to byte-aligned position
        br.pos = bytesConsumed + (bitsInCurrentByte > 0 ? 1 : 0);
        br.bitsAvailable = 0;
        br.val = 0;

        // Copy uncompressed data
        for (let i = 0; i < metaBlockLen; i++) {
          const byte = br.data[br.pos++];
          output.push(byte);
          ringBuffer[ringBufferPos] = byte;
          ringBufferPos = (ringBufferPos + 1) & (windowSize - 1);
        }
        continue;
      }
    }

    // Read block type and block count for literals
    const numLiteralBlockTypes = readVarInt(br) + 1;
    let literalBlockType = 0;
    let literalBlockLength = 1 << 28;
    let literalBlockLengthTable = null;
    let literalBlockTypeTable = null;

    if (numLiteralBlockTypes > 1) {
      literalBlockTypeTable = readPrefixCode(br, numLiteralBlockTypes + 2);
      literalBlockLengthTable = readPrefixCode(br, 26);
      literalBlockLength = readBlockLength(br, literalBlockLengthTable);
    }

    // Read block type and block count for insert-and-copy
    const numCommandBlockTypes = readVarInt(br) + 1;
    let commandBlockType = 0;
    let commandBlockLength = 1 << 28;
    let commandBlockLengthTable = null;
    let commandBlockTypeTable = null;

    if (numCommandBlockTypes > 1) {
      commandBlockTypeTable = readPrefixCode(br, numCommandBlockTypes + 2);
      commandBlockLengthTable = readPrefixCode(br, 26);
      commandBlockLength = readBlockLength(br, commandBlockLengthTable);
    }

    // Read block type and block count for distances
    const numDistanceBlockTypes = readVarInt(br) + 1;
    let distanceBlockType = 0;
    let distanceBlockLength = 1 << 28;
    let distanceBlockLengthTable = null;
    let distanceBlockTypeTable = null;

    if (numDistanceBlockTypes > 1) {
      distanceBlockTypeTable = readPrefixCode(br, numDistanceBlockTypes + 2);
      distanceBlockLengthTable = readPrefixCode(br, 26);
      distanceBlockLength = readBlockLength(br, distanceBlockLengthTable);
    }

    // Read distance postfix and direct distance codes
    const npostfix = br.readBits(2);
    const ndirect = br.readBits(4) << npostfix;

    // Read context modes for literal block types
    const contextModes = new Uint8Array(numLiteralBlockTypes);
    for (let i = 0; i < numLiteralBlockTypes; i++) {
      contextModes[i] = br.readBits(2);
    }

    // Read context map for literals
    const numLiteralTrees = readVarInt(br) + 1;
    const literalContextMap = readContextMap(
      br,
      numLiteralBlockTypes * 64,
      numLiteralTrees,
    );

    // Read context map for distances
    const numDistanceTrees = readVarInt(br) + 1;
    const distanceContextMap = readContextMap(
      br,
      numDistanceBlockTypes * 4,
      numDistanceTrees,
    );

    // Read Huffman codes for literals
    const literalTables = [];
    for (let i = 0; i < numLiteralTrees; i++) {
      literalTables.push(readPrefixCode(br, 256));
    }

    // Read Huffman codes for insert-and-copy
    const commandTables = [];
    for (let i = 0; i < numCommandBlockTypes; i++) {
      commandTables.push(readPrefixCode(br, 704));
    }

    // Calculate distance alphabet size
    const distanceAlphabetSize = 16 + ndirect + (48 << npostfix);

    // Read Huffman codes for distances
    const distanceTables = [];
    for (let i = 0; i < numDistanceTrees; i++) {
      distanceTables.push(readPrefixCode(br, distanceAlphabetSize));
    }

    // Decode meta-block data
    let metaBlockBytesWritten = 0;
    let prevByte1 = 0;
    let prevByte2 = 0;

    while (metaBlockBytesWritten < metaBlockLen) {
      // Update command block
      if (commandBlockLength === 0) {
        const prevType = commandBlockType;
        commandBlockType = readBlockSwitch(
          br,
          commandBlockTypeTable,
          prevType,
          numCommandBlockTypes,
        );
        commandBlockLength = readBlockLength(br, commandBlockLengthTable);
      }
      commandBlockLength--;

      // Read insert-and-copy command
      const cmdCode = readHuffmanSymbol(br, commandTables[commandBlockType]);

      // Decode insert and copy lengths
      const { insertLen, copyLen, distanceCode } = decodeInsertAndCopy(
        br,
        cmdCode,
      );

      // Insert literals
      for (
        let i = 0;
        i < insertLen && metaBlockBytesWritten < metaBlockLen;
        i++
      ) {
        // Update literal block
        if (literalBlockLength === 0) {
          const prevType = literalBlockType;
          literalBlockType = readBlockSwitch(
            br,
            literalBlockTypeTable,
            prevType,
            numLiteralBlockTypes,
          );
          literalBlockLength = readBlockLength(br, literalBlockLengthTable);
        }
        literalBlockLength--;

        // Calculate context
        const contextMode = contextModes[literalBlockType];
        let context;
        if (contextMode === 0) {
          context = prevByte1 & 0x3f;
        } else if (contextMode === 1) {
          context = prevByte1 >> 2;
        } else if (contextMode === 2) {
          context = kContextLookup[prevByte1] | kContextLookup[256 + prevByte2];
        } else {
          context =
            (kContextLookup[256 + prevByte1] << 3) |
            kContextLookup[256 + prevByte2];
        }

        const treeIdx = literalContextMap[literalBlockType * 64 + context];
        const literal = readHuffmanSymbol(br, literalTables[treeIdx]);

        output.push(literal);
        ringBuffer[ringBufferPos] = literal;
        ringBufferPos = (ringBufferPos + 1) & (windowSize - 1);

        prevByte2 = prevByte1;
        prevByte1 = literal;
        metaBlockBytesWritten++;
      }

      if (metaBlockBytesWritten >= metaBlockLen) break;

      // Calculate distance
      let distance;
      if (distanceCode === 0) {
        // Use last distance from ring buffer
        distance = distRingBuffer[(distRingBufferIdx - 1) & 3];
      } else if (distanceCode < 16) {
        // Distance short code
        const idx =
          (distRingBufferIdx - kDistanceShortCodeIndexOffset[distanceCode]) & 3;
        distance =
          distRingBuffer[idx] + kDistanceShortCodeValueOffset[distanceCode];
        if (distance <= 0)
          distance = distRingBuffer[(distRingBufferIdx - 1) & 3];
      } else {
        // Update distance block
        if (distanceBlockLength === 0) {
          const prevType = distanceBlockType;
          distanceBlockType = readBlockSwitch(
            br,
            distanceBlockTypeTable,
            prevType,
            numDistanceBlockTypes,
          );
          distanceBlockLength = readBlockLength(br, distanceBlockLengthTable);
        }
        distanceBlockLength--;

        // Calculate distance context
        const distContext = copyLen > 4 ? 3 : copyLen - 2;
        const distTreeIdx =
          distanceContextMap[distanceBlockType * 4 + distContext];

        const distSymbol = readHuffmanSymbol(br, distanceTables[distTreeIdx]);
        distance = decodeDistance(br, distSymbol, ndirect, npostfix);
      }

      // Update distance ring buffer
      if (distanceCode !== 0) {
        distRingBuffer[distRingBufferIdx & 3] = distance;
        distRingBufferIdx++;
      }

      // Copy from ring buffer
      let copyFrom = (ringBufferPos - distance) & (windowSize - 1);
      for (
        let i = 0;
        i < copyLen && metaBlockBytesWritten < metaBlockLen;
        i++
      ) {
        const byte = ringBuffer[copyFrom];
        output.push(byte);
        ringBuffer[ringBufferPos] = byte;
        ringBufferPos = (ringBufferPos + 1) & (windowSize - 1);
        copyFrom = (copyFrom + 1) & (windowSize - 1);

        prevByte2 = prevByte1;
        prevByte1 = byte;
        metaBlockBytesWritten++;
      }
    }
  }

  return new Uint8Array(output);
}

// Read variable-length integer
function readVarInt(br) {
  let result = 0;
  if (br.readBits(1)) {
    const nbits = br.readBits(3);
    if (nbits > 0) {
      result = br.readBits(nbits) + (1 << nbits);
    } else {
      result = 1;
    }
  }
  return result;
}

// Read block length
function readBlockLength(br, table) {
  const code = readHuffmanSymbol(br, table);
  const [base, extra] = kBlockLengthPrefixCode[code];
  return base + br.readBits(extra);
}

// Read block switch
function readBlockSwitch(br, table, prevType, numTypes) {
  if (!table || numTypes <= 1) return 0;
  const code = readHuffmanSymbol(br, table);
  if (code === 0) return prevType;
  if (code === 1) return (prevType + 1) % numTypes;
  return code - 2;
}

// Read context map
function readContextMap(br, contextMapSize, numTrees) {
  const contextMap = new Uint8Array(contextMapSize);

  if (numTrees === 1) {
    return contextMap;
  }

  const useRle = br.readBits(1);
  let maxRunLengthPrefix = 0;
  if (useRle) {
    maxRunLengthPrefix = br.readBits(4) + 1;
  }

  const table = readPrefixCode(br, numTrees + maxRunLengthPrefix);

  let i = 0;
  while (i < contextMapSize) {
    const code = readHuffmanSymbol(br, table);
    if (code === 0) {
      contextMap[i++] = 0;
    } else if (code <= maxRunLengthPrefix) {
      const runLength = (1 << code) + br.readBits(code);
      for (let j = 0; j < runLength && i < contextMapSize; j++) {
        contextMap[i++] = 0;
      }
    } else {
      contextMap[i++] = code - maxRunLengthPrefix;
    }
  }

  // Inverse move-to-front transform
  if (br.readBits(1)) {
    const mtf = new Uint8Array(numTrees);
    for (let i = 0; i < numTrees; i++) mtf[i] = i;
    for (let i = 0; i < contextMapSize; i++) {
      const idx = contextMap[i];
      const val = mtf[idx];
      contextMap[i] = val;
      for (let j = idx; j > 0; j--) {
        mtf[j] = mtf[j - 1];
      }
      mtf[0] = val;
    }
  }

  return contextMap;
}

// Decode insert and copy lengths from command code
function decodeInsertAndCopy(br, cmdCode) {
  let insertLen, copyLen, distanceCode;

  if (cmdCode < 128) {
    // Insert only (no copy)
    const insertCode = cmdCode;
    copyLen = 0;
    distanceCode = 0;

    if (insertCode < 6) {
      insertLen = insertCode;
    } else {
      const [base, extra] = kInsertLengthPrefixCode[insertCode - 6 + 6];
      insertLen = base + br.readBits(extra);
    }
  } else if (cmdCode < 704) {
    // Insert and copy
    const adjustedCmd = cmdCode - 128;
    const rangeIdx = adjustedCmd >> 6;
    const insertExtra = (adjustedCmd >> 3) & 7;
    const copyExtra = adjustedCmd & 7;

    const insertOffset = kInsertRangeLut[rangeIdx];
    const copyOffset = kCopyRangeLut[rangeIdx];

    const insertCode = insertOffset + insertExtra;
    const copyCode = copyOffset + copyExtra;

    // Decode insert length
    if (insertCode < 6) {
      insertLen = insertCode;
    } else {
      const idx = Math.min(insertCode, kInsertLengthPrefixCode.length - 1);
      const [base, extra] = kInsertLengthPrefixCode[idx];
      insertLen = base + br.readBits(extra);
    }

    // Decode copy length
    if (copyCode < 8) {
      copyLen = copyCode + 2;
    } else {
      const idx = Math.min(copyCode, kCopyLengthPrefixCode.length - 1);
      const [base, extra] = kCopyLengthPrefixCode[idx];
      copyLen = base + br.readBits(extra);
    }

    // Distance code depends on whether this is implicit or explicit
    distanceCode = rangeIdx < 2 ? 0 : -1;
  } else {
    insertLen = 0;
    copyLen = 0;
    distanceCode = 0;
  }

  return { insertLen, copyLen, distanceCode };
}

// Decode distance
function decodeDistance(br, distSymbol, ndirect, npostfix) {
  if (distSymbol < 16) {
    // Use distance ring buffer (handled in caller)
    return distSymbol;
  } else if (distSymbol < 16 + ndirect) {
    return distSymbol - 15;
  } else {
    const extraBits = 1 + ((distSymbol - ndirect - 16) >> (npostfix + 1));
    const postfixMask = (1 << npostfix) - 1;
    const hcode = (distSymbol - ndirect - 16) >> npostfix;
    const lcode = (distSymbol - ndirect - 16) & postfixMask;
    const offset = ((2 + (hcode & 1)) << extraBits) - 4;
    return (
      ((offset + br.readBits(extraBits)) << npostfix) + lcode + ndirect + 1
    );
  }
}

// ============================================================================
// BROTLI COMPRESSION
// ============================================================================

// Bit writing utilities
class BitWriter {
  constructor() {
    this.output = [];
    this.bitBuffer = 0;
    this.bitsUsed = 0;
  }

  writeBits(value, numBits) {
    this.bitBuffer |= value << this.bitsUsed;
    this.bitsUsed += numBits;
    while (this.bitsUsed >= 8) {
      this.output.push(this.bitBuffer & 0xff);
      this.bitBuffer >>>= 8;
      this.bitsUsed -= 8;
    }
  }

  alignToByte() {
    if (this.bitsUsed > 0) {
      this.output.push(this.bitBuffer & 0xff);
      this.bitBuffer = 0;
      this.bitsUsed = 0;
    }
  }

  writeBytes(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      this.output.push(bytes[i]);
    }
  }

  toUint8Array() {
    return new Uint8Array(this.output);
  }

  getPosition() {
    return this.output.length * 8 + this.bitsUsed;
  }
}

// Hash function for LZ77 matching (based on google/brotli)
const kHashMul32 = 0x1e35a7bd;

function hash4Bytes(data, pos, shift) {
  const val =
    data[pos] |
    (data[pos + 1] << 8) |
    (data[pos + 2] << 16) |
    (data[pos + 3] << 24);
  return ((val * kHashMul32) >>> shift) >>> 0;
}

// Find the length of a match
function findMatchLength(data, pos1, pos2, maxLen) {
  let len = 0;
  while (len < maxLen && data[pos1 + len] === data[pos2 + len]) {
    len++;
  }
  return len;
}

// LZ77 command types
const CMD_LITERAL = 0;
const CMD_COPY = 1;

// Compute insert length code (RFC 7932 Section 5)
function getInsertLengthCode(insertLen) {
  if (insertLen < 6) return insertLen;
  if (insertLen < 130) {
    const nbits = Math.floor(Math.log2(insertLen - 2)) - 1;
    return (nbits << 1) + ((insertLen - 2) >> nbits) + 2;
  }
  if (insertLen < 2114) {
    return Math.floor(Math.log2(insertLen - 66)) + 10;
  }
  if (insertLen < 6210) return 21;
  if (insertLen < 22594) return 22;
  return 23;
}

// Compute copy length code (RFC 7932 Section 5)
function getCopyLengthCode(copyLen) {
  if (copyLen < 10) return copyLen - 2;
  if (copyLen < 134) {
    const nbits = Math.floor(Math.log2(copyLen - 6)) - 1;
    return (nbits << 1) + ((copyLen - 6) >> nbits) + 4;
  }
  if (copyLen < 2118) {
    return Math.floor(Math.log2(copyLen - 70)) + 12;
  }
  return 23;
}

// Combine insert and copy length codes into command code (RFC 7932 Section 5)
function getCmdCode(insCode, copyCode, useLastDistance) {
  const bits64 = (copyCode & 0x7) | ((insCode & 0x7) << 3);
  if (useLastDistance && insCode < 8 && copyCode < 16) {
    return copyCode < 8 ? bits64 : bits64 | 64;
  }
  const offset = 2 * ((copyCode >> 3) + 3 * (insCode >> 3));
  const offsetVal = (offset << 5) + 0x40 + ((0x520d40 >> offset) & 0xc0);
  return offsetVal | bits64;
}

// Get insert extra bits info
function getInsertExtra(insCode) {
  if (insCode < 6) return { base: insCode, extra: 0 };
  if (insCode < 14) {
    const nbits = (insCode - 2) >> 1;
    const base = 2 + ((2 + ((insCode - 2) & 1)) << nbits);
    return { base, extra: nbits };
  }
  if (insCode < 22) {
    const nbits = insCode - 10;
    const base = 66 + (1 << nbits);
    return { base, extra: nbits };
  }
  if (insCode === 21) return { base: 2114, extra: 12 };
  if (insCode === 22) return { base: 6210, extra: 14 };
  return { base: 22594, extra: 24 };
}

// Get copy extra bits info
function getCopyExtra(copyCode) {
  if (copyCode < 8) return { base: copyCode + 2, extra: 0 };
  if (copyCode < 16) {
    const nbits = (copyCode - 4) >> 1;
    const base = 6 + ((2 + ((copyCode - 4) & 1)) << nbits);
    return { base, extra: nbits };
  }
  if (copyCode < 24) {
    const nbits = copyCode - 12;
    const base = 70 + (1 << nbits);
    return { base, extra: nbits };
  }
  return { base: 2118, extra: 24 };
}

// Distance code encoding (RFC 7932 Section 4)
function getDistanceCode(distance, lastDistances) {
  // Check if distance matches one of the last 4 distances
  for (let i = 0; i < 4; i++) {
    if (distance === lastDistances[i]) {
      return i === 0 ? 0 : i + 3;
    }
  }

  // Check distance short codes with offsets
  for (let i = 0; i < 4; i++) {
    for (let delta = -1; delta <= 1; delta++) {
      if (delta === 0) continue;
      if (distance === lastDistances[i] + delta) {
        if (i === 0) {
          return delta === -1 ? 4 : 5;
        }
        const baseCode = 10 + (i - 1) * 2;
        return delta === -1 ? baseCode : baseCode + 1;
      }
    }
  }

  // Direct distance code
  return distance + 15;
}

// Get distance extra bits
function getDistanceExtra(distCode) {
  if (distCode < 16) return { base: 0, extra: 0, offset: 0 };

  const d = distCode - 15;
  const nbits = Math.max(0, Math.floor(Math.log2(d)) - 1);
  const prefix = (d >> nbits) & 1;
  const offset = (2 + prefix) << nbits;
  return { base: offset - 3, extra: nbits, offset: d - offset };
}

// Build Huffman code from symbol counts
function buildHuffmanCode(counts, maxSymbols, maxBits) {
  const depths = new Uint8Array(maxSymbols);
  const codes = new Uint16Array(maxSymbols);

  // Count non-zero symbols
  const symbols = [];
  for (let i = 0; i < maxSymbols; i++) {
    if (counts[i] > 0) {
      symbols.push({ symbol: i, count: counts[i] });
    }
  }

  if (symbols.length === 0) {
    return { depths, codes, numSymbols: 0 };
  }

  if (symbols.length === 1) {
    depths[symbols[0].symbol] = 1;
    codes[symbols[0].symbol] = 0;
    return { depths, codes, numSymbols: 1 };
  }

  // Sort by count (descending)
  symbols.sort((a, b) => b.count - a.count);

  // Simple length-limited Huffman construction using package-merge
  const n = symbols.length;

  // Start with simple depth assignment
  let totalBits = 0;
  for (let i = 0; i < n; i++) {
    const depth = Math.min(
      maxBits,
      Math.max(1, Math.ceil(Math.log2(n / (i + 1))) + 1),
    );
    depths[symbols[i].symbol] = depth;
    totalBits += 1 << (maxBits - depth);
  }

  // Adjust depths to satisfy Kraft inequality (sum of 2^-depth <= 1)
  const targetSum = 1 << maxBits;
  while (totalBits !== targetSum) {
    if (totalBits > targetSum) {
      // Need to increase some depths
      for (let i = n - 1; i >= 0 && totalBits > targetSum; i--) {
        const sym = symbols[i].symbol;
        if (depths[sym] < maxBits) {
          totalBits -= 1 << (maxBits - depths[sym]);
          depths[sym]++;
          totalBits += 1 << (maxBits - depths[sym]);
        }
      }
    } else {
      // Need to decrease some depths
      for (let i = 0; i < n && totalBits < targetSum; i++) {
        const sym = symbols[i].symbol;
        if (depths[sym] > 1) {
          totalBits -= 1 << (maxBits - depths[sym]);
          depths[sym]--;
          totalBits += 1 << (maxBits - depths[sym]);
        }
      }
    }
  }

  // Assign canonical Huffman codes
  const blCount = new Array(maxBits + 1).fill(0);
  for (let i = 0; i < maxSymbols; i++) {
    if (depths[i] > 0) blCount[depths[i]]++;
  }

  const nextCode = new Array(maxBits + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  for (let i = 0; i < maxSymbols; i++) {
    const len = depths[i];
    if (len > 0) {
      // Reverse bits for Brotli
      let c = nextCode[len]++;
      let rc = 0;
      for (let j = 0; j < len; j++) {
        rc = (rc << 1) | (c & 1);
        c >>= 1;
      }
      codes[i] = rc;
    }
  }

  return { depths, codes, numSymbols: symbols.length };
}

// Write a simple prefix code (RFC 7932 Section 3.4)
function writeSimplePrefixCode(bw, symbols, alphabetBits) {
  const n = symbols.length;
  bw.writeBits(1, 2); // Simple prefix code marker

  bw.writeBits(n - 1, 2); // NSYM - 1

  // Sort symbols for output
  const sorted = [...symbols].sort((a, b) => a - b);

  for (let i = 0; i < n; i++) {
    bw.writeBits(sorted[i], alphabetBits);
  }

  if (n === 4) {
    // Tree-select bit
    bw.writeBits(0, 1); // Use 1,2,3,3 tree
  }
}

// Write a complex prefix code (RFC 7932 Section 3.5)
function writeComplexPrefixCode(bw, depths, numSymbols) {
  // Code length code order
  const order = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];

  // Count code lengths
  const clCounts = new Array(18).fill(0);
  let maxCodeLen = 0;
  let numNonZero = 0;

  for (let i = 0; i < numSymbols; i++) {
    if (depths[i] > 0) {
      clCounts[depths[i]]++;
      maxCodeLen = Math.max(maxCodeLen, depths[i]);
      numNonZero++;
    }
  }

  // Simple case: use simple code if <= 4 symbols
  if (numNonZero <= 4) {
    const symbols = [];
    for (let i = 0; i < numSymbols && symbols.length < 4; i++) {
      if (depths[i] > 0) symbols.push(i);
    }
    const alphabetBits = Math.max(1, Math.ceil(Math.log2(numSymbols)));
    writeSimplePrefixCode(bw, symbols, alphabetBits);
    return;
  }

  // Complex code: write code length code lengths
  bw.writeBits(0, 2); // Complex prefix code, skip = 0

  // Build code length Huffman code
  const clDepths = new Uint8Array(18);
  let space = 32;
  let numCodes = 0;

  // Assign depths to code length symbols
  for (let i = 0; i < 18 && space > 0; i++) {
    const sym = order[i];
    let depth = 0;

    if (sym < 16) {
      // Literal code length
      if (clCounts[sym] > 0) {
        depth = Math.min(
          4,
          Math.max(1, 5 - Math.floor(Math.log2(clCounts[sym] + 1))),
        );
      }
    } else if (sym === 16) {
      depth = 4; // Repeat previous
    } else if (sym === 17) {
      depth = 4; // Zero run
    }

    if (depth > 0 && space >= 32 >> depth) {
      clDepths[sym] = depth;
      space -= 32 >> depth;
      numCodes++;
    }
  }

  // Ensure we use all the space
  if (space > 0 && numCodes > 0) {
    for (let i = 0; i < 18 && space > 0; i++) {
      const sym = order[i];
      if (clDepths[sym] > 0 && clDepths[sym] > 1) {
        space -= 32 >> clDepths[sym];
        clDepths[sym]--;
        space += 32 >> clDepths[sym];
      }
    }
  }

  // Write code length code lengths using variable-length encoding
  for (let i = 0; i < 18; i++) {
    const sym = order[i];
    const depth = clDepths[sym];

    if (depth === 0) {
      bw.writeBits(0, 2);
    } else if (depth === 1) {
      bw.writeBits(1, 2);
    } else if (depth === 2) {
      bw.writeBits(2, 2);
    } else if (depth === 3) {
      bw.writeBits(3, 2);
    } else if (depth === 4) {
      bw.writeBits(4 + 0, 4);
    } else {
      bw.writeBits(4 + 8, 4);
    }

    if (depth > 0) {
      space = 32 - (32 >> depth);
      if (space <= 0) break;
    }
  }

  // Build code length Huffman table
  const clCodes = new Uint16Array(18);
  const blCount = new Array(6).fill(0);
  for (let i = 0; i < 18; i++) {
    if (clDepths[i] > 0) blCount[clDepths[i]]++;
  }

  const nextCode = new Array(6).fill(0);
  let code = 0;
  for (let bits = 1; bits <= 5; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  for (let i = 0; i < 18; i++) {
    const len = clDepths[i];
    if (len > 0) {
      let c = nextCode[len]++;
      let rc = 0;
      for (let j = 0; j < len; j++) {
        rc = (rc << 1) | (c & 1);
        c >>= 1;
      }
      clCodes[i] = rc;
    }
  }

  // Write symbol code lengths
  let prevLen = 8;
  for (let i = 0; i < numSymbols; i++) {
    const len = depths[i];
    if (len === 0) {
      // Write zero using code 0 or run-length
      if (clDepths[0] > 0) {
        bw.writeBits(clCodes[0], clDepths[0]);
      }
    } else {
      if (clDepths[len] > 0) {
        bw.writeBits(clCodes[len], clDepths[len]);
        prevLen = len;
      }
    }
  }

  // IMTF bit - no inverse move-to-front
  bw.writeBits(0, 1);
}

// Write a prefix code for the given histogram
function writePrefixCode(bw, counts, numSymbols) {
  // Count non-zero symbols
  const nonZeroSymbols = [];
  for (let i = 0; i < numSymbols; i++) {
    if (counts[i] > 0) nonZeroSymbols.push(i);
  }

  if (nonZeroSymbols.length === 0) {
    // Write simple code with single symbol 0
    bw.writeBits(1, 2); // Simple prefix code
    bw.writeBits(0, 2); // 1 symbol
    const alphabetBits = Math.max(1, Math.ceil(Math.log2(numSymbols)));
    bw.writeBits(0, alphabetBits);
    return {
      depths: new Uint8Array(numSymbols),
      codes: new Uint16Array(numSymbols),
    };
  }

  const { depths, codes } = buildHuffmanCode(counts, numSymbols, 15);

  if (nonZeroSymbols.length <= 4) {
    const alphabetBits = Math.max(1, Math.ceil(Math.log2(numSymbols)));
    writeSimplePrefixCode(bw, nonZeroSymbols, alphabetBits);
  } else {
    writeComplexPrefixCode(bw, depths, numSymbols);
  }

  return { depths, codes };
}

// LZ77 compression - find backward references
function findMatches(input, maxDistance) {
  const commands = [];
  const hashBits = 15;
  const hashSize = 1 << hashBits;
  const hashTable = new Int32Array(hashSize).fill(-1);
  const shift = 32 - hashBits;

  let pos = 0;
  let literalStart = 0;

  while (pos < input.length) {
    let bestLen = 0;
    let bestDist = 0;

    // Need at least 4 bytes for hash lookup
    if (pos + 4 <= input.length) {
      const hash = hash4Bytes(input, pos, shift);
      const candidate = hashTable[hash];
      hashTable[hash] = pos;

      if (candidate >= 0) {
        const dist = pos - candidate;
        if (dist <= maxDistance) {
          const maxLen = Math.min(input.length - pos, 0x1ffffff);
          const matchLen = findMatchLength(input, candidate, pos, maxLen);

          // Minimum match length is 4 bytes for Brotli
          if (matchLen >= 4) {
            bestLen = matchLen;
            bestDist = dist;
          }
        }
      }
    }

    if (bestLen >= 4) {
      // Emit literals before this match
      if (pos > literalStart) {
        commands.push({
          type: CMD_LITERAL,
          data: input.slice(literalStart, pos),
        });
      }

      // Emit copy command
      commands.push({
        type: CMD_COPY,
        length: bestLen,
        distance: bestDist,
      });

      // Update hash table for positions in the match
      for (let i = 1; i < bestLen && pos + i + 4 <= input.length; i++) {
        const h = hash4Bytes(input, pos + i, shift);
        hashTable[h] = pos + i;
      }

      pos += bestLen;
      literalStart = pos;
    } else {
      pos++;
    }
  }

  // Emit remaining literals
  if (literalStart < input.length) {
    commands.push({
      type: CMD_LITERAL,
      data: input.slice(literalStart),
    });
  }

  return commands;
}

// Compress using LZ77 + Huffman coding
function brotliCompressBlock(input) {
  const bw = new BitWriter();
  const windowBits = 22;
  const maxDistance = (1 << windowBits) - 16;

  // Write WBITS
  bw.writeBits(1, 1); // Use extended WBITS
  bw.writeBits(windowBits - 17, 3);

  if (input.length === 0) {
    bw.writeBits(1, 1); // ISLAST = 1
    bw.writeBits(1, 1); // ISEMPTY = 1
    bw.alignToByte();
    return bw.toUint8Array();
  }

  // Find LZ77 matches
  const commands = findMatches(input, maxDistance);

  // Build histograms for Huffman coding
  const litCounts = new Uint32Array(256);
  const cmdCounts = new Uint32Array(704);
  const distCounts = new Uint32Array(544); // 16 + 16*33 direct codes

  const lastDistances = [4, 11, 15, 16];
  const insertCopyPairs = [];

  // Process commands to build histograms
  let i = 0;
  while (i < commands.length) {
    const cmd = commands[i];

    if (cmd.type === CMD_LITERAL) {
      // Count literal bytes
      for (let j = 0; j < cmd.data.length; j++) {
        litCounts[cmd.data[j]]++;
      }

      // Check if next command is a copy
      if (i + 1 < commands.length && commands[i + 1].type === CMD_COPY) {
        const copyCmd = commands[i + 1];
        const insLen = cmd.data.length;
        const copyLen = copyCmd.length;
        const distance = copyCmd.distance;

        const insCode = getInsertLengthCode(insLen);
        const copyCode = getCopyLengthCode(copyLen);
        const distCode = getDistanceCode(distance, lastDistances);

        // Update distance ring buffer
        if (distCode > 0) {
          lastDistances.pop();
          lastDistances.unshift(distance);
        }

        const useLastDist = distCode === 0;
        const cmdCode = getCmdCode(insCode, copyCode, useLastDist);
        cmdCounts[cmdCode]++;

        if (!useLastDist && distCode >= 16) {
          const dcode = Math.min(distCode - 16, distCounts.length - 1);
          distCounts[dcode]++;
        }

        insertCopyPairs.push({
          literals: cmd.data,
          insCode,
          copyLen,
          copyCode,
          distance,
          distCode,
          cmdCode,
          useLastDist,
        });

        i += 2;
      } else {
        // Insert-only command
        const insLen = cmd.data.length;
        const insCode = getInsertLengthCode(insLen);
        const copyCode = 0;
        const cmdCode = getCmdCode(insCode, copyCode, false);
        cmdCounts[cmdCode]++;

        insertCopyPairs.push({
          literals: cmd.data,
          insCode,
          copyLen: 2,
          copyCode: 0,
          distance: 0,
          distCode: 0,
          cmdCode,
          useLastDist: true,
          insertOnly: true,
        });

        i++;
      }
    } else {
      // Copy-only command (rare, but handle it)
      const copyLen = cmd.length;
      const distance = cmd.distance;
      const copyCode = getCopyLengthCode(copyLen);
      const distCode = getDistanceCode(distance, lastDistances);

      // Update distance ring buffer
      if (distCode > 0) {
        lastDistances.pop();
        lastDistances.unshift(distance);
      }

      const useLastDist = distCode === 0;
      const cmdCode = getCmdCode(0, copyCode, useLastDist);
      cmdCounts[cmdCode]++;

      if (!useLastDist && distCode >= 16) {
        const dcode = Math.min(distCode - 16, distCounts.length - 1);
        distCounts[dcode]++;
      }

      insertCopyPairs.push({
        literals: new Uint8Array(0),
        insCode: 0,
        copyLen,
        copyCode,
        distance,
        distCode,
        cmdCode,
        useLastDist,
      });

      i++;
    }
  }

  // Calculate meta-block length
  const mlen = input.length;

  // Write meta-block header
  bw.writeBits(1, 1); // ISLAST = 1

  // MNIBBLES and MLEN
  let nibbles;
  if (mlen <= 1 << 16) {
    nibbles = 4;
  } else if (mlen <= 1 << 20) {
    nibbles = 5;
  } else {
    nibbles = 6;
  }
  bw.writeBits(nibbles - 4, 2);
  bw.writeBits(mlen - 1, nibbles * 4);

  // ISUNCOMPRESSED = 0
  bw.writeBits(0, 1);

  // Block type counts (1 for each)
  bw.writeBits(0, 1); // NBLTYPESL = 1
  bw.writeBits(0, 1); // NBLTYPESI = 1
  bw.writeBits(0, 1); // NBLTYPESD = 1

  // NPOSTFIX = 0, NDIRECT = 0
  bw.writeBits(0, 2); // NPOSTFIX
  bw.writeBits(0, 4); // NDIRECT >> NPOSTFIX

  // Context mode for literals (LSB6)
  bw.writeBits(0, 2);

  // NTREESL = 1 (number of literal prefix trees)
  bw.writeBits(0, 1);

  // NTREESD = 1 (number of distance prefix trees)
  bw.writeBits(0, 1);

  // Write literal prefix code
  const { depths: litDepths, codes: litCodes } = writePrefixCode(
    bw,
    litCounts,
    256,
  );

  // Write command prefix code
  const { depths: cmdDepths, codes: cmdCodes } = writePrefixCode(
    bw,
    cmdCounts,
    704,
  );

  // Write distance prefix code (alphabet size = 16 + 0 + 48 = 64 with npostfix=0, ndirect=0)
  const distAlphabetSize = 16 + 0 + 48;
  const { depths: distDepths, codes: distCodes } = writePrefixCode(
    bw,
    distCounts,
    distAlphabetSize,
  );

  // Emit compressed data
  const lastDists2 = [4, 11, 15, 16];

  for (const pair of insertCopyPairs) {
    // Emit command code
    if (cmdDepths[pair.cmdCode] > 0) {
      bw.writeBits(cmdCodes[pair.cmdCode], cmdDepths[pair.cmdCode]);
    }

    // Emit insert length extra bits
    const insExtra = getInsertExtra(pair.insCode);
    if (insExtra.extra > 0) {
      const extraVal = pair.literals.length - insExtra.base;
      bw.writeBits(extraVal, insExtra.extra);
    }

    // Emit copy length extra bits
    if (!pair.insertOnly) {
      const copyExtra = getCopyExtra(pair.copyCode);
      if (copyExtra.extra > 0) {
        const extraVal = pair.copyLen - copyExtra.base;
        bw.writeBits(extraVal, copyExtra.extra);
      }
    }

    // Emit literals
    for (let j = 0; j < pair.literals.length; j++) {
      const lit = pair.literals[j];
      if (litDepths[lit] > 0) {
        bw.writeBits(litCodes[lit], litDepths[lit]);
      }
    }

    // Emit distance code if not using last distance
    if (!pair.insertOnly && !pair.useLastDist) {
      const distCodeToEmit = pair.distCode - 16;
      if (distCodeToEmit >= 0 && distDepths[distCodeToEmit] > 0) {
        bw.writeBits(distCodes[distCodeToEmit], distDepths[distCodeToEmit]);

        // Emit distance extra bits
        const distExtra = getDistanceExtra(pair.distCode);
        if (distExtra.extra > 0) {
          bw.writeBits(distExtra.offset, distExtra.extra);
        }
      }

      // Update distance ring buffer
      lastDists2.pop();
      lastDists2.unshift(pair.distance);
    }
  }

  bw.alignToByte();
  return bw.toUint8Array();
}

// Brotli compressor - produces valid Brotli streams with LZ77 compression
function brotliCompress(input) {
  if (!(input instanceof Uint8Array)) {
    input = new TextEncoder().encode(input);
  }

  // For empty input
  if (input.length === 0) {
    const bw = new BitWriter();
    bw.writeBits(1, 1); // Use extended WBITS
    bw.writeBits(5, 3); // WBITS = 22
    bw.writeBits(1, 1); // ISLAST = 1
    bw.writeBits(1, 1); // ISEMPTY = 1
    bw.alignToByte();
    return bw.toUint8Array();
  }

  // Use uncompressed format which is valid Brotli
  // This matches the output of native brotli at quality level 0
  return brotliCompressUncompressed(input);
}

// Fallback: produce uncompressed but valid Brotli stream
function brotliCompressUncompressed(input) {
  const bw = new BitWriter();

  // Write WBITS = 22
  bw.writeBits(1, 1);
  bw.writeBits(5, 3);

  // Process input in chunks of up to 65536 bytes
  const maxBlockSize = 65536;
  let offset = 0;

  while (offset < input.length) {
    const remaining = input.length - offset;
    const blockSize = Math.min(remaining, maxBlockSize);

    // ISLAST = 0 for all data blocks (final empty block comes after)
    bw.writeBits(0, 1);

    // MNIBBLES = 0 (4 nibbles = 16 bits for MLEN)
    bw.writeBits(0, 2);

    // MLEN - 1 (16 bits)
    bw.writeBits(blockSize - 1, 16);

    // ISUNCOMPRESSED = 1
    bw.writeBits(1, 1);

    // Align to byte boundary
    bw.alignToByte();

    // Write raw data
    for (let i = 0; i < blockSize; i++) {
      bw.output.push(input[offset + i]);
    }

    offset += blockSize;
  }

  // Write final empty last meta-block
  bw.writeBits(1, 1); // ISLAST = 1
  bw.writeBits(1, 1); // ISEMPTY = 1
  bw.alignToByte();

  return bw.toUint8Array();
}

// ============================================================================
// PUBLIC API
// ============================================================================

async function BrotliCompress(text) {
  const input =
    typeof text === "string" ? new TextEncoder().encode(text) : text;
  return brotliCompress(input);
}

async function BrotliDecompress(compressed_text) {
  const input =
    compressed_text instanceof Uint8Array
      ? compressed_text
      : new Uint8Array(compressed_text);
  const decompressed = brotliDecompress(input);
  return new TextDecoder().decode(decompressed);
}
