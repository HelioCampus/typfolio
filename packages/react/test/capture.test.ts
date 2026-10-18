import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TypfolioCaptureError, captureAssets } from '@typfolio/core/capture';
import type { CaptureAdapter } from '@typfolio/core/capture';
import { CaptureRegion } from '../dist/capture.js';

const adapter: CaptureAdapter = {
  name: 'fake',
  extensions: ['.bin'],
  capture: () => new Uint8Array([1]),
};

test('CaptureRegion marks an arbitrary element without changing its accessibility semantics', () => {
  const markup = renderToStaticMarkup(createElement(
    CaptureRegion,
    {
      as: 'section',
      captureId: 'summary',
      kind: 'svg',
      altText: '72% met the goal.',
      className: 'report-section',
    },
    createElement('span', null, 'Visible content'),
  ));
  assert.match(markup, /^<section /);
  assert.match(markup, /data-typfolio-capture="summary"/);
  assert.match(markup, /data-typfolio-capture-kind="svg"/);
  assert.match(markup, /data-typfolio-capture-alt="72% met the goal\."/);
  assert.match(markup, /class="report-section"/);
  assert.doesNotMatch(markup, /aria-label|role=|decorative/);
  assert.doesNotMatch(markup, /captureId|altText/);

  const decorative = renderToStaticMarkup(createElement(CaptureRegion, {
    captureId: 'divider',
    kind: 'png',
    decorative: true,
  }));
  assert.match(decorative, /^<div /);
  assert.match(decorative, /data-typfolio-capture-decorative=""/);
  assert.doesNotMatch(decorative, /capture-alt|aria-label|role=/);
});

test('CaptureRegion rejects an invalid id', () => {
  assert.throws(
    () => renderToStaticMarkup(createElement(CaptureRegion, {
      captureId: 'not valid',
      kind: 'svg',
      altText: 'x',
    })),
    error => error instanceof TypfolioCaptureError && error.code === 'INVALID_OPTIONS',
  );
});

test('core captureAssets finds rendered CaptureRegion elements', async () => {
  const markup = renderToStaticMarkup(createElement(
    'main',
    null,
    createElement(CaptureRegion, { captureId: 'chart', kind: 'bin', altText: ' Chart summary. ' }),
    createElement(CaptureRegion, { captureId: 'rule', kind: 'bin', decorative: true }),
  ));
  const root = new JSDOM(`<!doctype html><body>${markup}</body>`).window.document.body;
  const captured = await captureAssets(root, {
    adapters: { bin: adapter },
    require: ['chart', 'rule'],
  });
  assert.deepEqual(captured.references, {
    chart: { path: 'captures/chart.bin', decorative: false, altText: 'Chart summary.' },
    rule: { path: 'captures/rule.bin', decorative: true },
  });
});
