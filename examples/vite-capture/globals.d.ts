import type { CapturedAssets } from '@typfolio/core/capture';

// The capture entries (svg.ts, dom.ts) publish their API here for the page that loads the bundle.
declare global {
  interface Window {
    typfolioCapture: {
      props?: Readonly<Record<string, string>>;
      capture(root: ParentNode): Promise<CapturedAssets>;
    };
  }
}
