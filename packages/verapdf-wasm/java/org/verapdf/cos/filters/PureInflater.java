package org.verapdf.cos.filters;

import java.util.Arrays;
import java.util.zip.DataFormatException;

/**
 * A zlib stream decoder in plain Java with the part of java.util.zip.Inflater's interface that veraPDF's Flate
 * filter uses: setInput, inflate, getRemaining, reset. java.util.zip.Inflater is backed by native zlib, which a
 * Web Image build does not have.
 *
 * The filter's handling of damaged streams depends on exactly when the inflater reports an error, how much it has
 * written by then and how much input it has taken, so this follows zlib's inflate() state by state (the non-fast
 * path, which is the reference for the fast one):
 * - it keeps decoding after the output is full until it actually has to write, so an error in the next symbol is
 *   reported by the call before, as zlib does;
 * - "distance too far back" is only detected when the match is about to be copied;
 * - an incomplete Huffman code is accepted only when its longest code is one bit, and an empty one behaves like
 *   zlib's table of invalid entries;
 * - an error is sticky until reset().
 * tools/check-verapdf-inflater.ts compares it with java.util.zip.Inflater on valid, damaged and random streams.
 *
 * Not tuned for speed: Huffman codes are read one bit at a time.
 */
final class PureInflater {
  private static final int HEAD = 0, DICTID = 1, DICT = 2, TYPE = 3, STORED = 4, COPY = 5, TABLE = 6, LENLENS = 7,
    CODELENS = 8, LEN = 9, LENEXT = 10, DIST = 11, DISTEXT = 12, MATCH = 13, LIT = 14, CHECK = 15, DONE = 16, BAD = 17;
  private static final int MAXBITS = 15;
  private static final int WINDOW = 32768;
  private static final int NEED_INPUT = -1;
  private static final int INVALID = -2;
  private static final short[] LENGTH_BASE = {3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51,
    59, 67, 83, 99, 115, 131, 163, 195, 227, 258};
  private static final short[] LENGTH_EXTRA = {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4,
    4, 5, 5, 5, 5, 0};
  private static final int[] DIST_BASE = {1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
    769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577};
  private static final short[] DIST_EXTRA = {0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10,
    10, 11, 11, 12, 12, 13, 13};
  private static final short[] CODE_LENGTH_ORDER = {16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15};
  private static final byte[] EMPTY = new byte[0];
  private static final Huffman FIXED_LENGTHS;
  private static final Huffman FIXED_DISTANCES;

  static {
    short[] lengths = new short[288];
    Arrays.fill(lengths, 0, 144, (short) 8);
    Arrays.fill(lengths, 144, 256, (short) 9);
    Arrays.fill(lengths, 256, 280, (short) 7);
    Arrays.fill(lengths, 280, 288, (short) 8);
    FIXED_LENGTHS = new Huffman(lengths, 0, 288);
    // 32 five-bit codes: 30 and 31 are never valid distances, but they are part of the code.
    short[] distances = new short[32];
    Arrays.fill(distances, (short) 5);
    FIXED_DISTANCES = new Huffman(distances, 0, 32);
  }

  /** A canonical Huffman code: how many codes there are of each length, and the symbols in code order. */
  private static final class Huffman {
    final short[] count = new short[MAXBITS + 1];
    final short[] symbol;
    /** The longest code length; 0 when there are no codes. */
    final int max;
    /** Unused code space: 0 for a complete code, negative when over-subscribed, positive when incomplete. */
    final int left;

    Huffman(short[] lengths, int offset, int n) {
      symbol = new short[n];
      for (int i = 0; i < n; i++) count[lengths[offset + i]]++;
      int longest = 0;
      for (int length = 1; length <= MAXBITS; length++) if (count[length] != 0) longest = length;
      max = longest;
      int space = 1;
      for (int length = 1; length <= MAXBITS; length++) {
        space <<= 1;
        space -= count[length];
        if (space < 0) break;
      }
      left = max == 0 ? 0 : space;
      if (space < 0) return;
      short[] offsets = new short[MAXBITS + 2];
      for (int length = 1; length <= MAXBITS; length++) offsets[length + 1] = (short) (offsets[length] + count[length]);
      for (int i = 0; i < n; i++) {
        if (lengths[offset + i] != 0) symbol[offsets[lengths[offset + i]]++] = (short) i;
      }
    }

    /** zlib's inflate_table verdict: over-subscribed never; incomplete only for a lone one-bit code, and not at all
     *  for the code of code lengths. */
    boolean usable(boolean codeLengths) {
      if (max == 0) return true;
      return left == 0 || (left > 0 && !codeLengths && max == 1);
    }
  }

  private byte[] input = EMPTY;
  private int inputPosition;
  private int inputEnd;
  private long hold;
  private int bits;

  private int mode = HEAD;
  private String error;
  private boolean lastBlock;
  private final byte[] window = new byte[WINDOW];
  private int windowPosition;
  private long total;
  private int adlerA = 1;
  private int adlerB;

  private int length;
  private int distance;
  private int extra;
  private int literal;
  private int lengthCount;
  private int distanceCount;
  private int codeCount;
  private int have;
  private int pendingCodeLength = -1;
  private final short[] lengths = new short[320];
  private Huffman lengthCode;
  private Huffman distanceCode;
  private Huffman codeLengthCode;
  // A symbol being decoded, kept across calls when the input runs out in the middle of a code.
  private int decodeCode;
  private int decodeFirst;
  private int decodeIndex;
  private int decodeLength;

  void setInput(byte[] bytes, int offset, int count) {
    input = bytes;
    inputPosition = offset;
    inputEnd = offset + count;
  }

  /** The input bytes not taken yet. Bits of a byte that was taken stay with the inflater. */
  int getRemaining() {
    return inputEnd - inputPosition;
  }

  void reset() {
    input = EMPTY;
    inputPosition = 0;
    inputEnd = 0;
    hold = 0;
    bits = 0;
    mode = HEAD;
    error = null;
    lastBlock = false;
    windowPosition = 0;
    total = 0;
    adlerA = 1;
    adlerB = 0;
    pendingCodeLength = -1;
    decodeCode = 0;
    decodeFirst = 0;
    decodeIndex = 0;
    decodeLength = 0;
  }

  private boolean need(int n) {
    while (bits < n) {
      if (inputPosition >= inputEnd) return false;
      hold |= (long) (input[inputPosition++] & 0xff) << bits;
      bits += 8;
    }
    return true;
  }

  private int take(int n) {
    int value = (int) (hold & ((1L << n) - 1));
    hold >>>= n;
    bits -= n;
    return value;
  }

  private DataFormatException bad(String message) {
    mode = BAD;
    error = message;
    return new DataFormatException(message);
  }

  /** The next symbol of a code, NEED_INPUT (the bits read so far are kept), or INVALID. */
  private int decode(Huffman h) {
    if (h.max == 0) {
      // zlib's table for a code without codes: every entry is one bit long. As a code of code lengths it reads as
      // length 0; as a distance code it is an invalid code.
      if (!need(1)) return NEED_INPUT;
      take(1);
      return h == codeLengthCode ? 0 : INVALID;
    }
    while (true) {
      if (!need(1)) return NEED_INPUT;
      decodeCode |= take(1);
      decodeLength++;
      int count = h.count[decodeLength];
      if (decodeCode - count < decodeFirst) {
        int symbol = h.symbol[decodeIndex + (decodeCode - decodeFirst)];
        decodeCode = decodeFirst = decodeIndex = decodeLength = 0;
        return symbol;
      }
      if (decodeLength == h.max) {
        decodeCode = decodeFirst = decodeIndex = decodeLength = 0;
        return INVALID;
      }
      decodeIndex += count;
      decodeFirst += count;
      decodeFirst <<= 1;
      decodeCode <<= 1;
    }
  }

  private void write(byte[] output, int position, byte value) {
    output[position] = value;
    window[windowPosition] = value;
    windowPosition = (windowPosition + 1) & (WINDOW - 1);
    total++;
    adlerA += value & 0xff;
    if (adlerA >= 65521) adlerA -= 65521;
    adlerB += adlerA;
    if (adlerB >= 65521) adlerB -= 65521;
  }

  /**
   * Decodes into output[offset, offset + count) and returns how many bytes were written: 0 when more input is
   * needed, the stream has ended, or it asks for a preset dictionary. Bytes written by a call that ends in an
   * exception are not reported, as with java.util.zip.Inflater.
   */
  int inflate(byte[] output, int offset, int count) throws DataFormatException {
    if (mode == BAD) throw new DataFormatException(error);
    int position = offset;
    int end = offset + count;
    while (true) {
      switch (mode) {
        case HEAD: {
          if (!need(16)) return position - offset;
          int cmf = (int) (hold & 0xff);
          int flg = (int) ((hold >>> 8) & 0xff);
          if (((cmf << 8) + flg) % 31 != 0) throw bad("incorrect header check");
          if ((cmf & 0x0f) != 8) throw bad("unknown compression method");
          if ((cmf >>> 4) + 8 > 15) throw bad("invalid window size");
          take(16);
          mode = (flg & 0x20) != 0 ? DICTID : TYPE;
          break;
        }
        case DICTID:
          if (!need(32)) return position - offset;
          take(32);
          mode = DICT;
          break;
        case DICT:
          return position - offset;
        case TYPE: {
          if (lastBlock) {
            take(bits & 7);
            mode = CHECK;
            break;
          }
          if (!need(3)) return position - offset;
          lastBlock = take(1) == 1;
          int type = take(2);
          if (type == 0) {
            mode = STORED;
          } else if (type == 1) {
            lengthCode = FIXED_LENGTHS;
            distanceCode = FIXED_DISTANCES;
            mode = LEN;
          } else if (type == 2) {
            mode = TABLE;
          } else {
            throw bad("invalid block type");
          }
          break;
        }
        case STORED: {
          take(bits & 7);
          if (!need(32)) return position - offset;
          int stored = (int) (hold & 0xffff);
          if (stored != (((int) (hold >>> 16) & 0xffff) ^ 0xffff)) throw bad("invalid stored block lengths");
          take(32);
          length = stored;
          mode = COPY;
          break;
        }
        case COPY: {
          if (length == 0) {
            mode = TYPE;
            break;
          }
          int copy = Math.min(length, Math.min(inputEnd - inputPosition, end - position));
          if (copy == 0) return position - offset;
          for (int i = 0; i < copy; i++) write(output, position++, input[inputPosition++]);
          length -= copy;
          break;
        }
        case TABLE:
          if (!need(14)) return position - offset;
          lengthCount = take(5) + 257;
          distanceCount = take(5) + 1;
          codeCount = take(4) + 4;
          if (lengthCount > 286 || distanceCount > 30) throw bad("too many length or distance symbols");
          have = 0;
          mode = LENLENS;
          break;
        case LENLENS:
          while (have < codeCount) {
            if (!need(3)) return position - offset;
            lengths[CODE_LENGTH_ORDER[have++]] = (short) take(3);
          }
          while (have < 19) lengths[CODE_LENGTH_ORDER[have++]] = 0;
          codeLengthCode = new Huffman(lengths, 0, 19);
          if (!codeLengthCode.usable(true)) throw bad("invalid code lengths set");
          have = 0;
          mode = CODELENS;
          break;
        case CODELENS: {
          while (have < lengthCount + distanceCount) {
            if (pendingCodeLength < 0) {
              int symbol = decode(codeLengthCode);
              if (symbol == NEED_INPUT) return position - offset;
              // An invalid entry cannot come up here: the code of code lengths is complete or empty.
              pendingCodeLength = symbol;
            }
            if (pendingCodeLength < 16) {
              lengths[have++] = (short) pendingCodeLength;
            } else {
              int extraBits = pendingCodeLength == 16 ? 2 : pendingCodeLength == 17 ? 3 : 7;
              if (!need(extraBits)) return position - offset;
              short repeated = 0;
              int repeat;
              if (pendingCodeLength == 16) {
                if (have == 0) throw bad("invalid bit length repeat");
                repeated = lengths[have - 1];
                repeat = 3 + take(2);
              } else if (pendingCodeLength == 17) {
                repeat = 3 + take(3);
              } else {
                repeat = 11 + take(7);
              }
              if (have + repeat > lengthCount + distanceCount) throw bad("invalid bit length repeat");
              while (repeat-- > 0) lengths[have++] = repeated;
            }
            pendingCodeLength = -1;
          }
          if (lengths[256] == 0) throw bad("invalid code -- missing end-of-block");
          lengthCode = new Huffman(lengths, 0, lengthCount);
          if (!lengthCode.usable(false)) throw bad("invalid literal/lengths set");
          distanceCode = new Huffman(lengths, lengthCount, distanceCount);
          if (!distanceCode.usable(false)) throw bad("invalid distances set");
          mode = LEN;
          break;
        }
        case LEN: {
          int symbol = decode(lengthCode);
          if (symbol == NEED_INPUT) return position - offset;
          if (symbol == INVALID) throw bad("invalid literal/length code");
          if (symbol < 256) {
            literal = symbol;
            mode = LIT;
          } else if (symbol == 256) {
            mode = TYPE;
          } else {
            symbol -= 257;
            if (symbol >= 29) throw bad("invalid literal/length code");
            length = LENGTH_BASE[symbol];
            extra = LENGTH_EXTRA[symbol];
            mode = LENEXT;
          }
          break;
        }
        case LENEXT:
          if (extra != 0) {
            if (!need(extra)) return position - offset;
            length += take(extra);
          }
          mode = DIST;
          break;
        case DIST: {
          int symbol = decode(distanceCode);
          if (symbol == NEED_INPUT) return position - offset;
          if (symbol == INVALID || symbol >= 30) throw bad("invalid distance code");
          distance = DIST_BASE[symbol];
          extra = DIST_EXTRA[symbol];
          mode = DISTEXT;
          break;
        }
        case DISTEXT:
          if (extra != 0) {
            if (!need(extra)) return position - offset;
            distance += take(extra);
          }
          mode = MATCH;
          break;
        case MATCH: {
          if (position == end) return position - offset;
          if (distance > total) throw bad("invalid distance too far back");
          int copy = Math.min(length, end - position);
          for (int i = 0; i < copy; i++) write(output, position++, window[(windowPosition - distance) & (WINDOW - 1)]);
          length -= copy;
          if (length == 0) mode = LEN;
          break;
        }
        case LIT:
          if (position == end) return position - offset;
          write(output, position++, (byte) literal);
          mode = LEN;
          break;
        case CHECK: {
          if (!need(32)) return position - offset;
          long stored = ((hold & 0xff) << 24) | ((hold & 0xff00) << 8) | ((hold >>> 8) & 0xff00) | ((hold >>> 24) & 0xff);
          if (stored != (((long) adlerB << 16) | adlerA)) throw bad("incorrect data check");
          take(32);
          mode = DONE;
          break;
        }
        case DONE:
          return position - offset;
        default:
          throw new DataFormatException(error);
      }
    }
  }
}
