import { createRouter } from '@tanstack/react-router';
import { PendingDemo } from './PendingDemo.tsx';
import { routeTree } from './routeTree.gen.ts';

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPendingComponent: PendingDemo,
    defaultPendingMinMs: 0,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
