// Brotli Polyfill - Pure JavaScript Brotli compression and decompression
// Implements RFC 7932

// ============================================================================
// BROTLI DECOMPRESSION
// ============================================================================

// Brotli uses several prefix codes and lookup tables
// These are specified in RFC 7932

// Simple prefix code lengths for literal/insert-and-copy length and distance alphabet
const kCodeLengthCodeOrder = new Uint8Array([
  1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15
]);

// Block length prefix codes
const kBlockLengthPrefixCode = [
  [1, 2], [5, 2], [9, 2], [13, 2], [17, 3], [25, 3], [33, 3], [41, 3],
  [49, 4], [65, 4], [81, 4], [97, 4], [113, 5], [145, 5], [177, 5], [209, 5],
  [241, 6], [305, 6], [369, 7], [497, 8], [753, 9], [1265, 10], [2289, 11],
  [4337, 12], [8433, 13], [16625, 24]
];

// Insert length prefix codes
const kInsertLengthPrefixCode = [
  [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 1], [8, 1],
  [10, 2], [14, 2], [18, 3], [26, 3], [34, 4], [50, 4], [66, 5], [98, 5],
  [130, 6], [194, 7], [322, 8], [578, 9], [1090, 10], [2114, 12], [6210, 14],
  [22594, 24]
];

// Copy length prefix codes
const kCopyLengthPrefixCode = [
  [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0],
  [10, 1], [12, 1], [14, 2], [18, 2], [22, 3], [30, 3], [38, 4], [54, 4],
  [70, 5], [102, 5], [134, 6], [198, 7], [326, 8], [582, 9], [1094, 10],
  [2118, 24]
];

// Distance prefix codes
const kDistanceShortCodeIndexOffset = new Int8Array([
  0, 3, 2, 1, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3
]);

const kDistanceShortCodeValueOffset = new Int8Array([
  0, 0, 0, 0, -1, 1, -2, 2, -3, 3, -1, 1, -2, 2, -3, 3
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
  
  throw new Error('Invalid Huffman code');
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
(function() {
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
    const literalContextMap = readContextMap(br, numLiteralBlockTypes * 64, numLiteralTrees);
    
    // Read context map for distances
    const numDistanceTrees = readVarInt(br) + 1;
    const distanceContextMap = readContextMap(br, numDistanceBlockTypes * 4, numDistanceTrees);
    
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
        commandBlockType = readBlockSwitch(br, commandBlockTypeTable, prevType, numCommandBlockTypes);
        commandBlockLength = readBlockLength(br, commandBlockLengthTable);
      }
      commandBlockLength--;
      
      // Read insert-and-copy command
      const cmdCode = readHuffmanSymbol(br, commandTables[commandBlockType]);
      
      // Decode insert and copy lengths
      const { insertLen, copyLen, distanceCode } = decodeInsertAndCopy(br, cmdCode);
      
      // Insert literals
      for (let i = 0; i < insertLen && metaBlockBytesWritten < metaBlockLen; i++) {
        // Update literal block
        if (literalBlockLength === 0) {
          const prevType = literalBlockType;
          literalBlockType = readBlockSwitch(br, literalBlockTypeTable, prevType, numLiteralBlockTypes);
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
          context = (kContextLookup[256 + prevByte1] << 3) | kContextLookup[256 + prevByte2];
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
        const idx = (distRingBufferIdx - kDistanceShortCodeIndexOffset[distanceCode]) & 3;
        distance = distRingBuffer[idx] + kDistanceShortCodeValueOffset[distanceCode];
        if (distance <= 0) distance = distRingBuffer[(distRingBufferIdx - 1) & 3];
      } else {
        // Update distance block
        if (distanceBlockLength === 0) {
          const prevType = distanceBlockType;
          distanceBlockType = readBlockSwitch(br, distanceBlockTypeTable, prevType, numDistanceBlockTypes);
          distanceBlockLength = readBlockLength(br, distanceBlockLengthTable);
        }
        distanceBlockLength--;
        
        // Calculate distance context
        const distContext = copyLen > 4 ? 3 : copyLen - 2;
        const distTreeIdx = distanceContextMap[distanceBlockType * 4 + distContext];
        
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
      for (let i = 0; i < copyLen && metaBlockBytesWritten < metaBlockLen; i++) {
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
    return ((offset + br.readBits(extraBits)) << npostfix) + lcode + ndirect + 1;
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
    this.bitBuffer |= (value << this.bitsUsed);
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
}

// Brotli compressor - produces uncompressed but valid Brotli streams
// This matches the output format of Node's brotli with quality=0
function brotliCompress(input) {
  if (!(input instanceof Uint8Array)) {
    input = new TextEncoder().encode(input);
  }
  
  const bw = new BitWriter();
  
  // Empty input case
  if (input.length === 0) {
    // WBITS = 22: first bit = 1, then 3 bits = 5 (17+5=22)
    bw.writeBits(1, 1);  // Use extended WBITS
    bw.writeBits(5, 3);  // WBITS = 17 + 5 = 22
    // ISLAST = 1
    bw.writeBits(1, 1);
    // ISEMPTY = 1
    bw.writeBits(1, 1);
    bw.alignToByte();
    return bw.toUint8Array();
  }
  
  // Write WBITS = 22
  bw.writeBits(1, 1);  // Use extended WBITS
  bw.writeBits(5, 3);  // WBITS = 17 + 5 = 22
  
  // Write non-last uncompressed meta-block with data
  // ISLAST = 0
  bw.writeBits(0, 1);
  
  // MNIBBLES = 0 (4 nibbles = 16 bits for MLEN)
  bw.writeBits(0, 2);
  
  // MLEN - 1 (16 bits)
  bw.writeBits(input.length - 1, 16);
  
  // ISUNCOMPRESSED = 1
  bw.writeBits(1, 1);
  
  // Align to byte boundary
  bw.alignToByte();
  
  // Write raw data
  bw.writeBytes(input);
  
  // Write final empty meta-block
  // ISLAST = 1
  bw.writeBits(1, 1);
  // ISEMPTY = 1
  bw.writeBits(1, 1);
  bw.alignToByte();
  
  return bw.toUint8Array();
}

// ============================================================================
// PUBLIC API
// ============================================================================

async function BrotliCompress(text) {
  const input = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return brotliCompress(input);
}

async function BrotliDecompress(compressed_text) {
  const input = compressed_text instanceof Uint8Array ? compressed_text : new Uint8Array(compressed_text);
  const decompressed = brotliDecompress(input);
  return new TextDecoder().decode(decompressed);
}
