import { captureAssets } from '@typfolio/core/capture';
import { domPngCapture } from '@typfolio/core/capture/dom';

window.typfolioCapture = {
  capture: root => captureAssets(root, { adapters: { png: domPngCapture() } }),
};
