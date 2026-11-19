import java.nio.charset.StandardCharsets;
import java.util.function.Function;

import org.graalvm.webimage.api.JS;
import org.graalvm.webimage.api.JSObject;
import org.graalvm.webimage.api.JSString;

/**
 * Web Image entry: hands JavaScript one function, ({ pdf, flavour, maxChecksPerRule }) -> JSON report, or, for the
 * flavour "detect", the flavours the file declares.
 *
 * The Web Image API cannot turn a JavaScript typed array into a Java byte[] (JSObject.as(byte[].class) throws
 * ClassCastException for Uint8Array, Int8Array and ArrayBuffer alike, checked with GraalVM 25.5), and a proxied
 * array would cost one call per byte. Strings cross in one piece, so the loader passes the PDF as a string with one
 * UTF-16 code unit per byte (0 to 255), which ISO-8859-1 maps back to the same bytes.
 */
public final class WasmMain {
  // `typfolioVerapdfExport` is not a global: tools/build-verapdf.ts wraps GraalVM's launcher, which this snippet is
  // emitted into, in a function that declares it. The build fails if the launcher is no longer wrapped that way.
  @JS(args = {"fn"}, value = "typfolioVerapdfExport(fn);")
  private static native void export(Function<JSObject, JSString> fn);

  public static void main(String[] args) {
    export(request -> {
      byte[] pdf = request.get("pdf", String.class).getBytes(StandardCharsets.ISO_8859_1);
      String flavour = request.get("flavour", String.class);
      // "detect" is not a flavour: it asks which flavours the file declares.
      return JSString.of(flavour.equals("detect") ? Validate.detect(pdf) : Validate.validate(pdf, flavour, request.get("maxChecksPerRule", Integer.class)));
    });
  }
}
