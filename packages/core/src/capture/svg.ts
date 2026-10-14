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

export interface SvgCaptureOptions {
  /** Selects exactly one SVG inside the marked region. Defaults to `svg`. */
  readonly selector?: string;
  /** Overrides text/tspan fonts only in the exported clone. */
  readonly fontFamily?: string;
  /** Removes transient descendants such as chart tooltips from the clone. */
  readonly removeSelectors?: readonly string[];
}

export function svgCapture({
  selector = 'svg',
  fontFamily,
  removeSelectors = [],
}: SvgCaptureOptions = {}): CaptureAdapter {
  if (!selector.trim()) {
    throw new TypfolioCaptureError('INVALID_OPTIONS', 'SVG selector must be non-empty');
  }
  if (fontFamily !== undefined && !fontFamily.trim()) {
    throw new TypfolioCaptureError('INVALID_OPTIONS', 'SVG fontFamily must be non-empty');
  }
  if (removeSelectors.some(value => !value.trim())) {
    throw new TypfolioCaptureError('INVALID_OPTIONS', 'SVG removeSelectors must be non-empty');
  }
  const selectors = [...removeSelectors];

  return Object.freeze({
    name: 'SVG capture',
    extensions: Object.freeze(['.svg']),
    capture(element: Element, context: CaptureAdapterContext): Uint8Array {
      const svg = findSvg(element, selector, context);
      const view = svg.ownerDocument.defaultView;
      if (view === null) {
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

      const cloned = svg.cloneNode(true);
      if (!isSvg(cloned)) {
        throw new TypfolioCaptureError(
          'CAPTURE_FAILED',
          `Capture ${context.captureId} could not clone its SVG`,
          context.captureId,
          context.path,
        );
      }
      const originals: Element[] = [svg, ...svg.querySelectorAll('*')];
      const copies: Element[] = [cloned, ...cloned.querySelectorAll('*')];
      originals.forEach((original, index) => {
        const copy = copies[index];
        const computed = view.getComputedStyle(original);
        if (hasStyle(copy)) {
          for (const property of svgStyles) {
            const value = computed.getPropertyValue(property);
            if (value) copy.style.setProperty(property, value);
          }
          if (fontFamily && (original.localName === 'text' || original.localName === 'tspan')) {
            copy.style.setProperty('font-family', fontFamily);
          }
        }
        if (fontFamily && (original.localName === 'text' || original.localName === 'tspan')) {
          copy.setAttribute('font-family', fontFamily);
        }
        for (const attribute of copy.attributes) {
          copy.setAttribute(
            attribute.name,
            attribute.value.replace(/url\(["']?[^)#]*#([^)"' ]+)["']?\)/g, 'url(#$1)'),
          );
        }
      });

      for (const removable of cloned.querySelectorAll('script, foreignObject')) removable.remove();
      for (const removableSelector of selectors) {
        for (const removable of cloned.querySelectorAll(removableSelector)) removable.remove();
      }
      cloned.setAttribute('xmlns', svgNamespace);
      cloned.setAttribute('width', String(bounds.width));
      cloned.setAttribute('height', String(bounds.height));
      if (!cloned.hasAttribute('viewBox')) {
        cloned.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
      }
      return encoder.encode(new view.XMLSerializer().serializeToString(cloned));
    },
  });
}
