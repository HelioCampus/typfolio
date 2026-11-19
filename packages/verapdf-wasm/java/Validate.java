import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogManager;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

import org.verapdf.gf.foundry.VeraGreenfieldFoundryProvider;
import org.verapdf.pdfa.Foundries;
import org.verapdf.pdfa.PDFAParser;
import org.verapdf.pdfa.PDFAValidator;
import org.verapdf.pdfa.VeraPDFFoundry;
import org.verapdf.pdfa.flavours.PDFAFlavour;
import org.verapdf.pdfa.results.TestAssertion;
import org.verapdf.pdfa.results.ValidationResult;
import org.verapdf.pdfa.validation.profiles.Rule;
import org.verapdf.pdfa.validation.profiles.RuleId;
import org.verapdf.pdfa.validation.profiles.ValidationProfile;
import org.verapdf.pdfa.validation.validators.ValidatorFactory;

/**
 * Spike entry: PDF bytes and a flavour in, a JSON report out. No CLI, no report XML, no Jackson: the JSON is
 * written by hand so that the only reflection left is what veraPDF itself needs (JAXB for the profiles).
 */
public final class Validate {
  private static boolean initialised;

  /**
   * The flavours the file declares in its metadata, as veraPDF's parser reads them: {"flavours":["2a","ua1"]}, empty
   * when it declares none. Not PDFAParser.getFlavour(), which throws IndexOutOfBoundsException for such a file.
   */
  public static String detect(byte[] pdf) {
    try {
      initialise();
      // Nothing is reported from here, but nothing should be printed either.
      LogManager.getLogManager().reset();
      StringBuilder json = new StringBuilder("{\"flavours\":[");
      try (VeraPDFFoundry foundry = Foundries.defaultInstance();
           PDFAParser parser = foundry.createParser(new ByteArrayInputStream(pdf))) {
        boolean first = true;
        for (PDFAFlavour flavour : parser.getFlavours()) {
          if (flavour == null || flavour == PDFAFlavour.NO_FLAVOUR) continue;
          if (!first) json.append(',');
          first = false;
          json.append(quote(flavour.getId()));
        }
      }
      return json.append("]}").toString();
    } catch (Throwable error) {
      return failure(error);
    }
  }

  private static void initialise() {
    if (!initialised) {
      VeraGreenfieldFoundryProvider.initialise();
      initialised = true;
    }
  }

  private static String failure(Throwable error) {
    java.io.StringWriter trace = new java.io.StringWriter();
    error.printStackTrace(new java.io.PrintWriter(trace));
    return "{\"error\":" + quote(String.valueOf(error)) + ",\"trace\":" + quote(trace.toString()) + "}";
  }

  /** How many failed checks of one rule are listed when the caller does not say. */
  public static final int DEFAULT_MAX_CHECKS_PER_RULE = 20;

  public static String validate(byte[] pdf, String flavourId) {
    return validate(pdf, flavourId, DEFAULT_MAX_CHECKS_PER_RULE);
  }

  /**
   * @param maxChecksPerRule how many failed checks of one rule to list with their place and error text; the count
   *                         of failed checks is exact whatever this is
   */
  public static String validate(byte[] pdf, String flavourId, int maxChecksPerRule) {
    try {
      initialise();
      // Not PDFAFlavour.fromString: it matches loosely, and turns "wt1a" into PDF/A-1a.
      PDFAFlavour flavour = PDFAFlavour.byFlavourId(flavourId);
      if (flavour == null || flavour == PDFAFlavour.NO_FLAVOUR || !flavour.getId().equals(flavourId)) {
        return "{\"error\":" + quote("unknown flavour: " + flavourId) + "}";
      }
      LogCollector logs = LogCollector.start();
      try (VeraPDFFoundry foundry = Foundries.defaultInstance();
           PDFAParser parser = foundry.createParser(new ByteArrayInputStream(pdf), flavour);
           // In the factory's order: no passed checks, no limit on failures (a limit makes it stop early), at most
           // this many failed checks listed per rule, each with its own error message, no progress output.
           PDFAValidator validator = ValidatorFactory.createValidator(flavour, false, 0, Math.max(1, Math.min(maxChecksPerRule, 10000)), true, false)) {
        ValidationResult result = validator.validate(parser);
        return report(flavour, result, logs.stop());
      } finally {
        logs.stop();
      }
    } catch (Throwable error) {
      return failure(error);
    }
  }

  /**
   * What veraPDF logs while it reads and validates a file, at WARNING and above: a font program it cannot parse, a
   * broken content stream. Its own reports list these as "Logs information". The log manager is reset first, which
   * takes off the console handler, also the one that is only set up at the first message (taking the root logger's
   * handlers off one by one left that one printing in the image). So the messages are in the report and nowhere else.
   */
  private static final class LogCollector extends Handler {
    private final Map<String, int[]> counts = new LinkedHashMap<>();
    private final Logger root = Logger.getLogger("");

    static LogCollector start() {
      LogManager.getLogManager().reset();
      LogCollector collector = new LogCollector();
      collector.setLevel(Level.WARNING);
      collector.root.addHandler(collector);
      return collector;
    }

    /** The messages so far as JSON, each once with how often it came; stops collecting. Safe to call twice. */
    String stop() {
      root.removeHandler(this);
      StringBuilder json = new StringBuilder("[");
      boolean first = true;
      for (Map.Entry<String, int[]> entry : counts.entrySet()) {
        if (!first) json.append(',');
        first = false;
        int split = entry.getKey().indexOf('\n');
        json.append("{\"level\":").append(quote(entry.getKey().substring(0, split)))
            .append(",\"message\":").append(quote(entry.getKey().substring(split + 1)))
            .append(",\"occurrences\":").append(entry.getValue()[0]).append('}');
      }
      return json.append(']').toString();
    }

    @Override
    public void publish(LogRecord record) {
      if (record == null || record.getLevel().intValue() < Level.WARNING.intValue()) return;
      String message = record.getMessage() == null ? "" : record.getMessage();
      if (record.getThrown() != null) message = message.isEmpty() ? String.valueOf(record.getThrown()) : message + ": " + record.getThrown();
      // At most 200 different messages: a damaged file can produce one per object.
      String key = record.getLevel().getName() + "\n" + message;
      int[] count = counts.get(key);
      if (count != null) count[0]++;
      else if (counts.size() < 200) counts.put(key, new int[] {1});
    }

    @Override
    public void flush() {}

    @Override
    public void close() {}
  }

  private static String report(PDFAFlavour flavour, ValidationResult result, String logs) {
    // One entry per failed rule, in the order of the first failed check. The listed checks are the ones veraPDF kept
    // (up to the limit given to the validator); the number of failed checks comes from its own count.
    Map<RuleId, List<TestAssertion>> failed = new LinkedHashMap<>();
    for (TestAssertion assertion : result.getTestAssertions()) {
      if (assertion.getStatus() != TestAssertion.Status.FAILED) continue;
      failed.computeIfAbsent(assertion.getRuleId(), id -> new ArrayList<>()).add(assertion);
    }
    Map<RuleId, Integer> counts = result.getFailedChecks();
    ValidationProfile profile = result.getValidationProfile();
    StringBuilder json = new StringBuilder();
    json.append("{\"flavour\":").append(quote(flavour.getId()))
        .append(",\"compliant\":").append(result.isCompliant())
        .append(",\"totalAssertions\":").append(result.getTotalAssertions())
        .append(",\"profile\":{\"name\":").append(quote(text(profile.getDetails().getName())))
        .append(",\"description\":").append(quote(text(profile.getDetails().getDescription())))
        .append(",\"rules\":").append(profile.getRules().size()).append('}')
        .append(",\"logs\":").append(logs)
        .append(",\"failedRules\":[");
    boolean firstRule = true;
    for (Map.Entry<RuleId, List<TestAssertion>> entry : failed.entrySet()) {
      RuleId id = entry.getKey();
      List<TestAssertion> checks = entry.getValue();
      Rule rule = profile.getRuleByRuleId(id);
      Integer count = counts == null ? null : counts.get(id);
      if (!firstRule) json.append(',');
      firstRule = false;
      json.append("{\"specification\":").append(quote(id.getSpecification().getId()))
          .append(",\"clause\":").append(quote(id.getClause()))
          .append(",\"test\":").append(id.getTestNumber())
          .append(",\"failedChecks\":").append(count == null ? checks.size() : Math.max(count, checks.size()))
          .append(",\"message\":").append(quote(text(checks.get(0).getMessage())))
          .append(",\"context\":").append(quote(context(checks.get(0))))
          .append(",\"object\":").append(quote(rule == null ? "" : text(rule.getObject())))
          .append(",\"condition\":").append(quote(rule == null ? "" : text(rule.getTest())))
          .append(",\"tags\":[");
      boolean firstTag = true;
      if (rule != null && rule.getTagsSet() != null) {
        for (String tag : new TreeSet<>(rule.getTagsSet())) {
          if (!firstTag) json.append(',');
          firstTag = false;
          json.append(quote(tag));
        }
      }
      json.append("],\"checks\":[");
      boolean firstCheck = true;
      for (TestAssertion check : checks) {
        if (!firstCheck) json.append(',');
        firstCheck = false;
        json.append("{\"context\":").append(quote(context(check)))
            .append(",\"error\":").append(quote(text(check.getErrorMessage()))).append('}');
      }
      json.append("]}");
    }
    return json.append("]}").toString();
  }

  private static String text(String value) {
    return value == null ? "" : value;
  }

  private static String context(TestAssertion assertion) {
    return assertion.getLocation() == null ? "" : text(assertion.getLocation().getContext());
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

  /** JVM entry, for tracing and for the parity baseline: Validate <flavour | detect> <file.pdf>... prints one report per line. */
  public static void main(String[] args) throws Exception {
    if (args.length < 2) {
      System.err.println("usage: Validate <flavour> <file.pdf>...");
      System.exit(2);
    }
    for (int i = 1; i < args.length; i++) {
      byte[] pdf = Files.readAllBytes(Paths.get(args[i]));
      System.out.println(args[0].equals("detect") ? detect(pdf) : validate(pdf, args[0]));
    }
  }
}
