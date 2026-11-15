package com.sun.xml.bind;

import java.util.logging.Logger;

/**
 * Shadows the JAXB runtime's Util (same public API). The original names its logger after
 * `new Exception().getStackTrace()[1]`, and a Web Image build has no Java stack frames, so it throws
 * ArrayIndexOutOfBoundsException in every JAXB class initialiser. This copy must come before the veraPDF jar on
 * the class path.
 */
public final class Util {
  private Util() {}

  public static Logger getClassLogger() {
    StackTraceElement[] trace = new Exception().getStackTrace();
    return Logger.getLogger(trace.length > 1 ? trace[1].getClassName() : "com.sun.xml.bind");
  }

  public static String getSystemProperty(String name) {
    try {
      return System.getProperty(name);
    } catch (SecurityException e) {
      return null;
    }
  }
}
