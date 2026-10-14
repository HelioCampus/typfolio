import { captureProps, type CaptureMarker } from '@typfolio/core/capture';
import {
  createElement,
  type ComponentPropsWithoutRef,
  type ElementType,
  type ReactElement,
} from 'react';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type CaptureRegionProps<C extends ElementType = 'div'> = {
  readonly as?: C;
  readonly captureId: string;
} & DistributiveOmit<CaptureMarker, 'id'> &
  Omit<ComponentPropsWithoutRef<C>, 'as' | 'captureId' | 'kind' | 'altText' | 'decorative'>;

/**
 * A semantic-neutral marker for `captureAssets` from `@typfolio/core/capture`.
 * It does not alter the accessibility tree itself.
 */
export function CaptureRegion<C extends ElementType = 'div'>({
  as,
  captureId,
  kind,
  altText,
  decorative,
  ...props
}: CaptureRegionProps<C>): ReactElement {
  const marker: CaptureMarker = decorative === true
    ? { id: captureId, kind, decorative: true }
    : { id: captureId, kind, altText: altText ?? '' };
  return createElement(as ?? 'div', { ...props, ...captureProps(marker) });
}
