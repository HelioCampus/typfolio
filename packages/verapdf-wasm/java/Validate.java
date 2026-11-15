import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Map;

import org.verapdf.gf.foundry.VeraGreenfieldFoundryProvider;
import org.verapdf.pdfa.Foundries;
import org.verapdf.pdfa.PDFAParser;
import org.verapdf.pdfa.PDFAValidator;
import org.verapdf.pdfa.VeraPDFFoundry;
import org.verapdf.pdfa.flavours.PDFAFlavour;
import org.verapdf.pdfa.results.TestAssertion;
import org.verapdf.pdfa.results.ValidationResult;
import org.verapdf.pdfa.validation.profiles.RuleId;

/**
 * Spike entry: PDF bytes and a flavour in, a JSON report out. No CLI, no report XML, no Jackson: the JSON is
 * written by hand so that the only reflection left is what veraPDF itself needs (JAXB for the profiles).
 */
public final class Validate {
  private static boolean initialised;

  public static String validate(byte[] pdf, String flavourId) {
    try {
      if (!initialised) {
        VeraGreenfieldFoundryProvider.initialise();
        initialised = true;
      }
      // Not PDFAFlavour.fromString: it matches loosely, and turns "wt1a" into PDF/A-1a.
      PDFAFlavour flavour = PDFAFlavour.byFlavourId(flavourId);
      if (flavour == null || flavour == PDFAFlavour.NO_FLAVOUR || !flavour.getId().equals(flavourId)) {
        return "{\"error\":" + quote("unknown flavour: " + flavourId) + "}";
      }
      try (VeraPDFFoundry foundry = Foundries.defaultInstance();
           PDFAParser parser = foundry.createParser(new ByteArrayInputStream(pdf), flavour);
           PDFAValidator validator = foundry.createValidator(flavour, false)) {
        ValidationResult result = validator.validate(parser);
        return report(flavour, result);
      }
    } catch (Throwable error) {
      java.io.StringWriter trace = new java.io.StringWriter();
      error.printStackTrace(new java.io.PrintWriter(trace));
      return "{\"error\":" + quote(String.valueOf(error)) + ",\"trace\":" + quote(trace.toString()) + "}";
    }
  }

  private static String report(PDFAFlavour flavour, ValidationResult result) {
    // One entry per failed rule, with the number of failed checks and the first message and context.
    Map<String, String[]> failed = new LinkedHashMap<>();
    Map<String, Integer> counts = new LinkedHashMap<>();
    for (TestAssertion assertion : result.getTestAssertions()) {
      if (assertion.getStatus() != TestAssertion.Status.FAILED) continue;
      RuleId id = assertion.getRuleId();
      String key = id.getSpecification().getId() + "|" + id.getClause() + "|" + id.getTestNumber();
      counts.merge(key, 1, Integer::sum);
      failed.putIfAbsent(key, new String[] {
        id.getSpecification().getId(), id.getClause(), String.valueOf(id.getTestNumber()),
        assertion.getMessage(), assertion.getLocation() == null ? "" : assertion.getLocation().getContext()
      });
    }
    StringBuilder json = new StringBuilder();
    json.append("{\"flavour\":").append(quote(flavour.getId()))
        .append(",\"compliant\":").append(result.isCompliant())
        .append(",\"totalAssertions\":").append(result.getTotalAssertions())
        .append(",\"failedRules\":[");
    boolean first = true;
    for (Map.Entry<String, String[]> entry : failed.entrySet()) {
      String[] rule = entry.getValue();
      if (!first) json.append(',');
      first = false;
      json.append("{\"specification\":").append(quote(rule[0]))
          .append(",\"clause\":").append(quote(rule[1]))
          .append(",\"test\":").append(rule[2])
          .append(",\"failedChecks\":").append(counts.get(entry.getKey()))
          .append(",\"message\":").append(quote(rule[3]))
          .append(",\"context\":").append(quote(rule[4]))
          .append('}');
    }
    return json.append("]}").toString();
  }

  private static String quote(String text) {
    StringBuilder out = new StringBuilder("\"");
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      switch (c) {
        case '"': out.append("\\\""); break;
        case '\\': out.append("\\\\"); break;
        case '\n': out.append("\\n"); break;
        case '\r': out.append("\\r"); break;
        case '\t': out.append("\\t"); break;
        default:
          if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
          else out.append(c);
      }
    }
    return out.append('"').toString();
  }

  /** JVM entry, for tracing and for the parity baseline: Validate <flavour> <file.pdf>... prints one report per line. */
  public static void main(String[] args) throws Exception {
    if (args.length < 2) {
      System.err.println("usage: Validate <flavour> <file.pdf>...");
      System.exit(2);
    }
    for (int i = 1; i < args.length; i++) {
      System.out.println(validate(Files.readAllBytes(Paths.get(args[i])), args[0]));
    }
  }
}
