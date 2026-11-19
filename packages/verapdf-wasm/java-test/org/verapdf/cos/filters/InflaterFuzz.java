package org.verapdf.cos.filters;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.Random;
import java.util.zip.DataFormatException;
import java.util.zip.Deflater;
import java.util.zip.Inflater;

import org.verapdf.as.io.ASMemoryInStream;

/**
 * Differential test of PureInflater, run on the JVM by tools/check-verapdf-inflater.ts. Not part of the image.
 *
 *   InflaterFuzz inflater <seed> <cases>   drives PureInflater and java.util.zip.Inflater with the same calls and
 *                                          fails on the first difference in a result, an exception, the bytes
 *                                          written or the remaining input
 *   InflaterFuzz filter <seed> <cases>     prints a digest of what COSFilterFlateDecode decodes for each case; the
 *                                          tool runs it with veraPDF's own class and with the shadowed one and
 *                                          compares the output
 *
 * The streams are zlib streams of varied data at varied levels, left intact or damaged: bit flips, truncation,
 * overwritten and inserted bytes, trailing bytes, a preset-dictionary flag, raw deflate without a header, and
 * random bytes behind a valid header (which reach the block and table errors that damage rarely hits).
 */
public final class InflaterFuzz {
  public static void main(String[] args) throws Exception {
    long seed = Long.parseLong(args[1]);
    int cases = Integer.parseInt(args[2]);
    if (args[0].equals("inflater")) {
      int errors = 0;
      long written = 0;
      for (int i = 0; i < cases; i++) {
        Random random = new Random(seed * 1_000_003L + i);
        byte[] stream = stream(random);
        Outcome outcome = compare(stream, random);
        if (outcome.difference != null) {
          System.out.println("DIFFERENT case " + i + " (seed " + seed + "): " + outcome.difference);
          System.exit(1);
        }
        if (outcome.failed) errors++;
        written += outcome.written;
      }
      System.out.println(cases + " cases identical: " + errors + " ended in a data error, " + written + " bytes decoded");
    } else {
      for (int i = 0; i < cases; i++) {
        Random random = new Random(seed * 1_000_003L + i);
        System.out.println(i + " " + throughFilter(stream(random), random));
      }
    }
  }

  private static final class Outcome {
    String difference;
    boolean failed;
    long written;
  }

  private static byte[] plain(Random random) {
    int[] sizes = {0, 1, 5, 40, 300, 2000, 9000, 40000, 70000, 150000};
    int size = sizes[random.nextInt(sizes.length)];
    if (size > 5) size = size / 2 + random.nextInt(size);
    byte[] data = new byte[size];
    switch (random.nextInt(5)) {
      case 0: random.nextBytes(data); break;
      case 1: break;
      case 2: for (int i = 0; i < size; i++) data[i] = (byte) ("the quick brown fox ".charAt(i % 20) + (random.nextInt(50) == 0 ? 1 : 0)); break;
      case 3: for (int i = 0; i < size; i++) data[i] = (byte) random.nextInt(4); break;
      default: {
        // Long repeats at long distances.
        byte[] phrase = new byte[1 + random.nextInt(3000)];
        random.nextBytes(phrase);
        for (int i = 0; i < size; i++) data[i] = phrase[i % phrase.length];
      }
    }
    return data;
  }

  private static byte[] stream(Random random) {
    if (random.nextInt(12) == 0) {
      // Random bytes behind a valid zlib header.
      byte[] garbage = new byte[2 + random.nextInt(600)];
      random.nextBytes(garbage);
      garbage[0] = 0x78;
      garbage[1] = (byte) 0x9c;
      return garbage;
    }
    int[] levels = {0, 1, 6, 9};
    Deflater deflater = new Deflater(levels[random.nextInt(levels.length)], random.nextInt(10) == 0);
    int[] strategies = {Deflater.DEFAULT_STRATEGY, Deflater.DEFAULT_STRATEGY, Deflater.FILTERED, Deflater.HUFFMAN_ONLY};
    deflater.setStrategy(strategies[random.nextInt(strategies.length)]);
    deflater.setInput(plain(random));
    deflater.finish();
    ByteArrayOutputStream packed = new ByteArrayOutputStream();
    byte[] chunk = new byte[8192];
    while (!deflater.finished()) packed.write(chunk, 0, deflater.deflate(chunk));
    deflater.end();
    byte[] bytes = packed.toByteArray();
    switch (random.nextInt(10)) {
      case 0: case 1: case 2: break;
      case 3: case 4: {
        int flips = 1 + random.nextInt(3);
        for (int i = 0; i < flips && bytes.length > 0; i++) bytes[random.nextInt(bytes.length)] ^= (byte) (1 << random.nextInt(8));
        break;
      }
      case 5: bytes = java.util.Arrays.copyOf(bytes, random.nextInt(bytes.length + 1)); break;
      case 6: if (bytes.length > 0) bytes[random.nextInt(bytes.length)] = (byte) random.nextInt(256); break;
      case 7: {
        int at = random.nextInt(bytes.length + 1);
        byte[] inserted = new byte[1 + random.nextInt(8)];
        random.nextBytes(inserted);
        byte[] joined = new byte[bytes.length + inserted.length];
        System.arraycopy(bytes, 0, joined, 0, at);
        System.arraycopy(inserted, 0, joined, at, inserted.length);
        System.arraycopy(bytes, at, joined, at + inserted.length, bytes.length - at);
        bytes = joined;
        break;
      }
      case 8: {
        byte[] longer = java.util.Arrays.copyOf(bytes, bytes.length + 1 + random.nextInt(40));
        for (int i = bytes.length; i < longer.length; i++) longer[i] = (byte) random.nextInt(256);
        bytes = longer;
        break;
      }
      default:
        if (bytes.length > 1) {
          // Set the preset-dictionary flag and repair the header check.
          bytes[1] |= 0x20;
          int rest = (((bytes[0] & 0xff) << 8) | (bytes[1] & 0xe0)) % 31;
          bytes[1] = (byte) ((bytes[1] & 0xe0) | (rest == 0 ? 0 : 31 - rest));
        }
    }
    return bytes;
  }

  private static Outcome compare(byte[] stream, Random random) {
    Outcome outcome = new Outcome();
    Inflater reference = new Inflater();
    PureInflater candidate = new PureInflater();
    int[] outputSizes = {1, 1, 2, 7, 100, 258, 4096, 70000};
    int[] inputSizes = {1, 3, 64, 2048, 4096, 1 << 20};
    int inputSize = inputSizes[random.nextInt(inputSizes.length)];
    boolean mixedOutput = random.nextBoolean();
    int outputSize = outputSizes[random.nextInt(outputSizes.length)];
    int fed = 0;
    int idle = 0;
    int resets = 0;
    byte[] a = new byte[70000];
    byte[] b = new byte[70000];
    try {
      for (int step = 0; step < 400_000 && idle < 4; step++) {
        if (reference.getRemaining() != candidate.getRemaining()) {
          outcome.difference = "step " + step + ": remaining " + reference.getRemaining() + " (zlib) and " + candidate.getRemaining();
          return outcome;
        }
        if (reference.getRemaining() == 0 && fed < stream.length) {
          int count = Math.min(inputSize, stream.length - fed);
          reference.setInput(stream, fed, count);
          candidate.setInput(stream, fed, count);
          fed += count;
        }
        if (mixedOutput) outputSize = outputSizes[random.nextInt(outputSizes.length)];
        // A reset at any point, also in the middle of a block, a symbol or a match: the filter resets when a stream
        // is read again.
        if (resets < 6 && random.nextInt(60) == 0) {
          resets++;
          // From the start half of the time: a restart anywhere else nearly always ends at the header check.
          int from = random.nextBoolean() ? 0 : random.nextInt(fed + 1);
          reference.reset();
          candidate.reset();
          reference.setInput(stream, from, fed - from);
          candidate.setInput(stream, from, fed - from);
        }
        int expected = 0;
        String expectedError = null;
        try { expected = reference.inflate(a, 0, outputSize); } catch (DataFormatException error) { expectedError = "data error"; }
        int actual = 0;
        String actualError = null;
        try { actual = candidate.inflate(b, 0, outputSize); } catch (DataFormatException error) { actualError = "data error"; }
        if (expectedError != null || actualError != null) {
          if (expectedError == null || actualError == null) {
            outcome.difference = "step " + step + ": zlib " + (expectedError == null ? "returned " + expected : "threw") + ", candidate " + (actualError == null ? "returned " + actual : "threw");
            return outcome;
          }
          outcome.failed = true;
          // Like the filter's readByByte: sometimes start again from an offset inside what was fed; otherwise call
          // again to see that the error stays.
          if (resets < 3 && random.nextBoolean()) {
            resets++;
            int from = random.nextInt(fed + 1);
            reference.reset();
            candidate.reset();
            reference.setInput(stream, from, fed - from);
            candidate.setInput(stream, from, fed - from);
          } else {
            idle++;
          }
          continue;
        }
        if (expected != actual) {
          outcome.difference = "step " + step + ": zlib wrote " + expected + ", candidate " + actual;
          return outcome;
        }
        for (int i = 0; i < expected; i++) {
          if (a[i] != b[i]) {
            outcome.difference = "step " + step + ": byte " + i + " of " + expected + " differs";
            return outcome;
          }
        }
        outcome.written += expected;
        idle = expected == 0 && fed >= stream.length ? idle + 1 : 0;
      }
    } finally {
      reference.end();
    }
    return outcome;
  }

  private static String throughFilter(byte[] stream, Random random) throws Exception {
    int[] sizes = {1, 7, 2048, 4096, 70000};
    int size = sizes[random.nextInt(sizes.length)];
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    long totalBytes = 0;
    String end = "eof";
    byte[] buffer = new byte[size];
    // Sometimes the stream is read part of the way, reset and read again, as a parser does.
    int resetAfter = random.nextInt(3) == 0 ? 1 + random.nextInt(40) : -1;
    try (COSFilterFlateDecode filter = new COSFilterFlateDecode(new ASMemoryInStream(stream))) {
      for (int reads = 0; reads < 2_000_000; reads++) {
        if (reads == resetAfter) {
          filter.reset();
          digest.update((byte) 0x52);
        }
        int read = filter.read(buffer, size);
        if (read == -1) break;
        digest.update(buffer, 0, read);
        totalBytes += read;
        if (read == 0 && reads > 1_000_000) { end = "stuck"; break; }
      }
    } catch (IOException error) {
      end = "IOException";
    }
    StringBuilder hex = new StringBuilder();
    for (byte value : digest.digest()) hex.append(String.format("%02x", value));
    return totalBytes + " " + end + " " + hex.substring(0, 16);
  }
}
