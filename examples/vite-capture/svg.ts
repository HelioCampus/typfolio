import { captureAssets, captureProps } from '@typfolio/core/capture';
import { svgCapture } from '@typfolio/core/capture/svg';

window.typfolioCapture = {
  props: captureProps({ id: 'chart', kind: 'svg', altText: 'Chart' }),
  capture: root => captureAssets(root, { adapters: { svg: svgCapture() } }),
};
