import {
  TypfolioCaptureError,
  type CaptureAdapter,
  type CaptureAdapterContext,
} from '../capture.js';

const svgNamespace = 'http://www.w3.org/2000/svg';
const encoder = new TextEncoder();
const svgStyles = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'visibility',
  'display',
  'color',
] as const;

interface StyledElement extends Element {
  readonly style: CSSStyleDeclaration;
}

function isElement(node: Node): node is Element {
  return node.nodeType === node.ELEMENT_NODE;
}

function isSvg(node: Node): node is SVGSVGElement {
  return isElement(node) && node.namespaceURI === svgNamespace && node.localName === 'svg';
}

function hasStyle(element: Element): element is StyledElement {
  return 'style' in element;
}

function findSvg(element: Element, selector: string, context: CaptureAdapterContext): SVGSVGElement {
  const matches: SVGSVGElement[] = [];
  if (isSvg(element) && element.matches(selector)) matches.push(element);
  for (const candidate of element.querySelectorAll(selector)) {
    if (isSvg(candidate)) matches.push(candidate);
  }
  if (matches.length === 0) {
    throw new TypfolioCaptureError(
      'NOT_FOUND',
      `Capture ${context.captureId} does not contain an SVG matching ${selector}`,
      context.captureId,
      context.path,
    );
  }
  if (matches.length > 1) {
    throw new TypfolioCaptureError(
      'AMBIGUOUS',
      `Capture ${context.captureId} contains more than one SVG matching ${selector}`,
      context.captureId,
      context.path,
    );
  }
  return matches[0];
}

export interface SvgSerializeOptions {
  /** Overrides text/tspan fonts only in the serialized clone. */
  readonly fontFamily?: string;
  /**
   * Runs on the clone just before it is serialized, after its styles are inlined and its size
   * is set: remove transient parts such as tooltips, add a `<title>`, rewrite labels. The live
   * SVG on the page is never passed here.
   */
  readonly beforeSerialize?: (svg: SVGSVGElement) => void;
}

export interface SvgCaptureOptions extends SvgSerializeOptions {
  /** Selects exactly one SVG inside the marked region. Defaults to `svg`. */
  readonly selector?: string;
}

function checkSerializeOptions({ fontFamily, beforeSerialize }: SvgSerializeOptions): void {
  if (fontFamily !== undefined && !fontFamily.trim()) {
    throw new TypfolioCaptureError('INVALID_OPTIONS', 'SVG fontFamily must be non-empty');
  }
  if (beforeSerialize !== undefined && typeof beforeSerialize !== 'function') {
    throw new TypfolioCaptureError('INVALID_OPTIONS', 'SVG beforeSerialize must be a function');
  }
}

/**
 * Serializes a drawn SVG as a standalone file: a clone with the computed paint and text styles
 * inlined (chart libraries often style SVGs from document CSS, which a standalone file does not
 * have), local `url(#id)` references, and the size it was drawn at. The SVG must be in a
 * document and have a rendered size.
 */
export function serializeSvg(svg: SVGSVGElement, options: SvgSerializeOptions = {}): Uint8Array {
  checkSerializeOptions(options);
  const { fontFamily, beforeSerialize } = options;
  const view = svg.ownerDocument.defaultView;
  if (view === null) {
    throw new TypfolioCaptureError('NOT_READY', 'The SVG document is no longer available');
  }
  const bounds = svg.getBoundingClientRect();
  if (!(bounds.width > 0) || !(bounds.height > 0)) {
    throw new TypfolioCaptureError('NOT_READY', 'The SVG has no rendered size');
  }

  const cloned = svg.cloneNode(true);
  if (!isSvg(cloned)) {
    throw new TypfolioCaptureError('CAPTURE_FAILED', 'The SVG could not be cloned');
  }
  const originals: Element[] = [svg, ...svg.querySelectorAll('*')];
  const copies: Element[] = [cloned, ...cloned.querySelectorAll('*')];
  originals.forEach((original, index) => {
    const copy = copies[index];
    const computed = view.getComputedStyle(original);
    const isText = original.localName === 'text' || original.localName === 'tspan';
    if (hasStyle(copy)) {
      for (const property of svgStyles) {
        const value = computed.getPropertyValue(property);
        if (value) copy.style.setProperty(property, value);
      }
      if (fontFamily && isText) copy.style.setProperty('font-family', fontFamily);
    }
    if (fontFamily && isText) copy.setAttribute('font-family', fontFamily);
    for (const attribute of copy.attributes) {
      copy.setAttribute(
        attribute.name,
        attribute.value.replace(/url\(["']?[^)#]*#([^)"' ]+)["']?\)/g, 'url(#$1)'),
      );
    }
  });

  for (const removable of cloned.querySelectorAll('script, foreignObject')) removable.remove();
  cloned.setAttribute('width', String(bounds.width));
  cloned.setAttribute('height', String(bounds.height));
  if (!cloned.hasAttribute('viewBox')) {
    cloned.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
  }
  beforeSerialize?.(cloned);
  // The serializer declares the SVG namespace itself. An `xmlns` attribute on the clone (chart
  // libraries such as Highcharts set one) can be written a second time: invalid XML.
  cloned.removeAttribute('xmlns');
  return encoder.encode(new view.XMLSerializer().serializeToString(cloned));
}

export function svgCapture({
  selector = 'svg',
  fontFamily,
  beforeSerialize,
}: SvgCaptureOptions = {}): CaptureAdapter {
  if (!selector.trim()) {
    throw new TypfolioCaptureError('INVALID_OPTIONS', 'SVG selector must be non-empty');
  }
  const serializeOptions: SvgSerializeOptions = { fontFamily, beforeSerialize };
  checkSerializeOptions(serializeOptions);

  return Object.freeze({
    name: 'SVG capture',
    extensions: Object.freeze(['.svg']),
    capture(element: Element, context: CaptureAdapterContext): Uint8Array {
      const svg = findSvg(element, selector, context);
      if (svg.ownerDocument.defaultView === null) {
        throw new TypfolioCaptureError(
          'NOT_READY',
          'The SVG document is no longer available',
          context.captureId,
          context.path,
        );
      }
      const bounds = svg.getBoundingClientRect();
      if (!(bounds.width > 0) || !(bounds.height > 0)) {
        throw new TypfolioCaptureError(
          'NOT_READY',
          `Capture ${context.captureId} has no rendered size`,
          context.captureId,
          context.path,
        );
      }
      return serializeSvg(svg, serializeOptions);
    },
  });
}
