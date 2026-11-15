package org.verapdf.cos.filters;

import java.util.Arrays;

/**
 * One-shot zlib/deflate decoder in plain Java (the "puff" reference algorithm from zlib's contrib directory,
 * re-expressed). java.util.zip.Inflater is backed by native zlib, which a Web Image build does not have.
 * Not tuned for speed: it reads one bit at a time while decoding Huffman codes.
 */
final class PureInflate {
  private static final int MAXBITS = 15;
  private static final short[] LENGTH_BASE = {3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51,
    59, 67, 83, 99, 115, 131, 163, 195, 227, 258};
  private static final short[] LENGTH_EXTRA = {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4,
    4, 5, 5, 5, 5, 0};
  private static final int[] DIST_BASE = {1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
    769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577};
  private static final short[] DIST_EXTRA = {0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10,
    10, 11, 11, 12, 12, 13, 13};
  private static final short[] CODE_LENGTH_ORDER = {16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15};

  /** Thrown for malformed or truncated data; `partial` is what was decoded before the error. */
  static final class FormatException extends Exception {
    final byte[] partial;

    FormatException(String message, byte[] partial) {
      super(message);
      this.partial = partial;
    }
  }

  private static final class Huffman {
    final short[] count = new short[MAXBITS + 1];
    final short[] symbol;

    Huffman(int symbols) {
      symbol = new short[symbols];
    }
  }

  private final byte[] in;
  private int inPos;
  private int bitBuffer;
  private int bitCount;
  private byte[] out;
  private int outLength;

  private PureInflate(byte[] in, int start, int sizeHint) {
    this.in = in;
    this.inPos = start;
    this.out = new byte[Math.max(256, sizeHint)];
  }

  /** Decodes a zlib stream (or raw deflate when there is no valid zlib header). */
  static byte[] inflate(byte[] data, int length) throws FormatException {
    byte[] input = data.length == length ? data : Arrays.copyOf(data, length);
    boolean zlib = length >= 2 && (input[0] & 0x0f) == 8 && (((input[0] & 0xff) << 8) | (input[1] & 0xff)) % 31 == 0
      && (input[1] & 0x20) == 0;
    PureInflate state = new PureInflate(input, zlib ? 2 : 0, length * 4);
    try {
      state.run();
    } catch (IllegalStateException | ArrayIndexOutOfBoundsException error) {
      throw new FormatException(String.valueOf(error.getMessage()), Arrays.copyOf(state.out, state.outLength));
    }
    return Arrays.copyOf(state.out, state.outLength);
  }

  private void run() {
    int last;
    do {
      last = bits(1);
      int type = bits(2);
      if (type == 0) stored();
      else if (type == 1) fixed();
      else if (type == 2) dynamic();
      else throw new IllegalStateException("invalid block type");
    } while (last == 0);
  }

  private int bits(int need) {
    int value = bitBuffer;
    while (bitCount < need) {
      if (inPos >= in.length) throw new IllegalStateException("unexpected end of data");
      value |= (in[inPos++] & 0xff) << bitCount;
      bitCount += 8;
    }
    bitBuffer = value >>> need;
    bitCount -= need;
    return value & ((1 << need) - 1);
  }

  private void put(byte value) {
    if (outLength == out.length) out = Arrays.copyOf(out, out.length * 2);
    out[outLength++] = value;
  }

  private void stored() {
    bitBuffer = 0;
    bitCount = 0;
    if (inPos + 4 > in.length) throw new IllegalStateException("unexpected end of data");
    int length = (in[inPos] & 0xff) | ((in[inPos + 1] & 0xff) << 8);
    int check = (in[inPos + 2] & 0xff) | ((in[inPos + 3] & 0xff) << 8);
    inPos += 4;
    if (length != (~check & 0xffff)) throw new IllegalStateException("stored block length mismatch");
    if (inPos + length > in.length) throw new IllegalStateException("unexpected end of data");
    for (int i = 0; i < length; i++) put(in[inPos++]);
  }

  private int decode(Huffman h) {
    int code = 0;
    int first = 0;
    int index = 0;
    for (int length = 1; length <= MAXBITS; length++) {
      code |= bits(1);
      int count = h.count[length];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new IllegalStateException("invalid Huffman code");
  }

  /** Returns 0 for a complete code, negative for an over-subscribed one, positive for an incomplete one. */
  private static int construct(Huffman h, short[] lengths, int offset, int n) {
    Arrays.fill(h.count, (short) 0);
    for (int symbol = 0; symbol < n; symbol++) h.count[lengths[offset + symbol]]++;
    if (h.count[0] == n) return 0;
    int left = 1;
    for (int length = 1; length <= MAXBITS; length++) {
      left <<= 1;
      left -= h.count[length];
      if (left < 0) return left;
    }
    short[] offsets = new short[MAXBITS + 1];
    for (int length = 1; length < MAXBITS; length++) offsets[length + 1] = (short) (offsets[length] + h.count[length]);
    for (int symbol = 0; symbol < n; symbol++) {
      if (lengths[offset + symbol] != 0) h.symbol[offsets[lengths[offset + symbol]]++] = (short) symbol;
    }
    return left;
  }

  private void codes(Huffman lengthCode, Huffman distanceCode) {
    while (true) {
      int symbol = decode(lengthCode);
      if (symbol < 256) {
        put((byte) symbol);
      } else if (symbol == 256) {
        return;
      } else {
        symbol -= 257;
        if (symbol >= 29) throw new IllegalStateException("invalid length symbol");
        int length = LENGTH_BASE[symbol] + bits(LENGTH_EXTRA[symbol]);
        symbol = decode(distanceCode);
        if (symbol >= 30) throw new IllegalStateException("invalid distance symbol");
        int distance = DIST_BASE[symbol] + bits(DIST_EXTRA[symbol]);
        if (distance > outLength) throw new IllegalStateException("distance too far back");
        for (int i = 0; i < length; i++) put(out[outLength - distance]);
      }
    }
  }

  private void fixed() {
    short[] lengths = new short[288 + 30];
    Arrays.fill(lengths, 0, 144, (short) 8);
    Arrays.fill(lengths, 144, 256, (short) 9);
    Arrays.fill(lengths, 256, 280, (short) 7);
    Arrays.fill(lengths, 280, 288, (short) 8);
    Arrays.fill(lengths, 288, 318, (short) 5);
    Huffman lengthCode = new Huffman(288);
    Huffman distanceCode = new Huffman(30);
    construct(lengthCode, lengths, 0, 288);
    construct(distanceCode, lengths, 288, 30);
    codes(lengthCode, distanceCode);
  }

  private void dynamic() {
    int lengthCount = bits(5) + 257;
    int distanceCount = bits(5) + 1;
    int codeCount = bits(4) + 4;
    if (lengthCount > 286 || distanceCount > 30) throw new IllegalStateException("too many length or distance codes");
    short[] lengths = new short[316];
    for (int i = 0; i < codeCount; i++) lengths[CODE_LENGTH_ORDER[i]] = (short) bits(3);
    Huffman lengthCode = new Huffman(286);
    Huffman distanceCode = new Huffman(30);
    if (construct(lengthCode, lengths, 0, 19) != 0) throw new IllegalStateException("incomplete code length code");
    int index = 0;
    while (index < lengthCount + distanceCount) {
      int symbol = decode(lengthCode);
      if (symbol < 16) {
        lengths[index++] = (short) symbol;
      } else {
        short repeated = 0;
        int repeat;
        if (symbol == 16) {
          if (index == 0) throw new IllegalStateException("no previous length to repeat");
          repeated = lengths[index - 1];
          repeat = 3 + bits(2);
        } else if (symbol == 17) {
          repeat = 3 + bits(3);
        } else {
          repeat = 11 + bits(7);
        }
        if (index + repeat > lengthCount + distanceCount) throw new IllegalStateException("too many lengths");
        while (repeat-- > 0) lengths[index++] = repeated;
      }
    }
    if (lengths[256] == 0) throw new IllegalStateException("no end-of-block code");
    int result = construct(lengthCode, lengths, 0, lengthCount);
    if (result < 0 || (result > 0 && lengthCount - lengthCode.count[0] != 1)) {
      throw new IllegalStateException("invalid literal/length code");
    }
    result = construct(distanceCode, lengths, lengthCount, distanceCount);
    if (result < 0 || (result > 0 && distanceCount - distanceCode.count[0] != 1)) {
      throw new IllegalStateException("invalid distance code");
    }
    codes(lengthCode, distanceCode);
  }
}
