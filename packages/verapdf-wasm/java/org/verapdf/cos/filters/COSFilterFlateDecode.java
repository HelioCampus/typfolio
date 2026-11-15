package org.verapdf.cos.filters;

import java.io.ByteArrayOutputStream;
import java.io.IOException;

import org.verapdf.as.filters.io.ASBufferedInFilter;
import org.verapdf.as.io.ASInputStream;

/**
 * Shadows veraPDF's Flate filter (same class name and public API; must come before the veraPDF jar on the class
 * path). The original streams through java.util.zip.Inflater, which needs native zlib. This one reads the whole
 * encoded stream on the first read, decodes it with PureInflate and serves the result.
 *
 * Spike limitation: on malformed data the original retries byte by byte and keeps what it can; this keeps the
 * bytes decoded before the error, and fails only when there are none.
 */
public class COSFilterFlateDecode extends ASBufferedInFilter {
  private byte[] decoded;
  private int position;

  public COSFilterFlateDecode(ASInputStream stream) throws IOException {
    super(stream);
  }

  @Override
  public int read(byte[] target, int size) throws IOException {
    if (decoded == null) decoded = decodeAll();
    if (position >= decoded.length) return -1;
    int count = Math.min(Math.min(size, target.length), decoded.length - position);
    System.arraycopy(decoded, position, target, 0, count);
    position += count;
    return count;
  }

  private byte[] decodeAll() throws IOException {
    ByteArrayOutputStream encoded = new ByteArrayOutputStream();
    int read;
    while ((read = this.feedBuffer(getBufferCapacity())) != -1) {
      if (read > 0) encoded.write(this.buffer, 0, read);
    }
    try {
      return PureInflate.inflate(encoded.toByteArray(), encoded.size());
    } catch (PureInflate.FormatException error) {
      if (error.partial.length == 0) throw new IOException("Can't decode Flate encoded data", error);
      return error.partial;
    }
  }

  @Override
  public void reset() throws IOException {
    super.reset();
    position = 0;
  }
}
