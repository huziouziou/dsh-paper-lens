import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyFlow, bodySizeOf, columnsFromLines, columnsFromSamples, furnitureBands, isFurniture, linesFromItems, orderLines, selectionText } from '../src/client/layout.js';

const line = (text, { size = 10, x0 = 0.06, x1 = 0.47, top = 0.2, bottom = 0.212 } = {}) => ({ text, size, x0, x1, top, bottom });

/** A page-fraction viewport stub: pdf.js coordinates grow upwards. */
function viewportOf(width = 600, height = 800) {
  return { width, height, convertToViewportPoint: (x, y) => [x, height - y] };
}

const item = (str, { size = 10, x = 50, y = 700, width = 100 } = {}) => ({
  str,
  transform: [1, 0, 0, size, x, y],
  width,
  height: size,
});

test('bodySizeOf follows the characters, not the number of lines', () => {
  const lines = [];
  for (let i = 0; i < 6; i += 1) lines.push(line('x'.repeat(120)));
  for (let i = 0; i < 12; i += 1) lines.push(line('caption', { size: 7 }));
  assert.equal(bodySizeOf(lines), 10);
});

test('bodySizeOf refines half-point buckets to the real size', () => {
  const lines = [line('x'.repeat(100), { size: 8.25 }), line('y'.repeat(100), { size: 8.25 })];
  assert.ok(Math.abs(bodySizeOf(lines) - 8.25) < 0.01);
});

test('linesFromItems joins items on one baseline and keeps the font size', () => {
  const lines = linesFromItems([item('hello', { x: 50, width: 100 }), item('world', { x: 155, width: 100 })], viewportOf());
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'hello world');
  assert.equal(lines[0].size, 10);
});

test('linesFromItems splits a row at a column gutter', () => {
  const lines = linesFromItems([item('left column', { x: 50, width: 200 }), item('right column', { x: 320, width: 200 })], viewportOf());
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((entry) => entry.text), ['left column', 'right column']);
});

test('linesFromItems keeps two baselines apart even though the padded boxes overlap', () => {
  const lines = linesFromItems([item('first', { y: 700 }), item('second', { y: 712 })], viewportOf());
  assert.equal(lines.length, 2);
});

test('linesFromItems drops stamps that sit outside the page', () => {
  const lines = linesFromItems([item('Downloaded from example.org', { x: 560, width: 300 })], viewportOf());
  assert.equal(lines.length, 0);
});

test('columnsFromSamples finds two columns on a two-column document', () => {
  const samples = [];
  for (let page = 1; page <= 3; page += 1) {
    const lines = [];
    for (let i = 0; i < 12; i += 1) {
      lines.push(line('left text here', { x0: 0.06, x1: 0.47, top: 0.1 + i * 0.05, bottom: 0.11 + i * 0.05 }));
      lines.push(line('right text here', { x0: 0.52, x1: 0.93, top: 0.1 + i * 0.05, bottom: 0.11 + i * 0.05 }));
    }
    samples.push({ page, lines });
  }
  const columns = columnsFromSamples(samples, 10);
  assert.equal(columns.length, 2);
  assert.ok(columns[0].x1 > 0.46 && columns[0].x1 < 0.53);
});

test('columnsFromSamples leaves a single-column document alone', () => {
  const samples = [];
  for (let page = 1; page <= 2; page += 1) {
    const lines = [];
    for (let i = 0; i < 10; i += 1) lines.push(line('one long body line', { x0: 0.06, x1: 0.94, top: 0.1 + i * 0.05, bottom: 0.11 + i * 0.05 }));
    samples.push({ page, lines });
  }
  assert.deepEqual(columnsFromSamples(samples, 10), [{ x0: 0, x1: 1 }]);
});

test('columnsFromLines returns the gutters as well as the bands', () => {
  const lines = [];
  for (let i = 0; i < 10; i += 1) {
    lines.push(line('left text here', { x0: 0.06, x1: 0.47, top: 0.1 + i * 0.05, bottom: 0.11 + i * 0.05 }));
    lines.push(line('right text here', { x0: 0.52, x1: 0.93, top: 0.1 + i * 0.05, bottom: 0.11 + i * 0.05 }));
  }
  const { columns, gutters } = columnsFromLines(lines, 10);
  assert.equal(columns.length, 2);
  assert.equal(gutters.length, 1);
  assert.ok(gutters[0].at > 0.46 && gutters[0].at < 0.53);
});

test('furnitureBands keeps a band that repeats on most pages', () => {
  const samples = [1, 2, 3, 4].map((page) => ({
    page,
    lines: [line('bioRxiv preprint doi: x', { size: 8, top: 0.018, bottom: 0.03 }), line('body text here', { top: 0.3, bottom: 0.312 })],
  }));
  const bands = furnitureBands(samples);
  assert.equal(bands.length, 1);
  assert.ok(bands[0].y0 > 0.01 && bands[0].y1 < 0.035);
  assert.ok(bands[0].share >= 0.99);
});

test('furnitureBands ignores a line that appears on one page only', () => {
  const samples = [1, 2, 3].map((page) => ({
    page,
    lines: page === 2 ? [line('a one-off note', { size: 8, top: 0.018, bottom: 0.03 })] : [line('body text here', { top: 0.3, bottom: 0.312 })],
  }));
  assert.deepEqual(furnitureBands(samples), []);
});

test('isFurniture drops a repeated band whatever its font size', () => {
  const bands = [{ y0: 0.04, y1: 0.048, share: 1 }];
  // NAR prints its running head at body size; size alone cannot catch it.
  const runningHead = line('Nucleic Acids Research, 2020', { size: 10, top: 0.041, bottom: 0.049 });
  assert.equal(isFurniture(runningHead, { body: 10, bands, flowTop: 0.1, flowBottom: 0.9 }), true);
});

test('isFurniture keeps the first page title that happens to sit in the top band', () => {
  const bands = [{ y0: 0.055, y1: 0.075, share: 1 }];
  const title = line('ProteinMPNN', { size: 18, top: 0.06, bottom: 0.075 });
  assert.equal(isFurniture(title, { body: 10, first: true, bands, flowTop: 0.1, flowBottom: 0.9 }), false);
  assert.equal(isFurniture(title, { body: 10, first: false, bands, flowTop: 0.1, flowBottom: 0.9 }), true);
});

test('isFurniture drops a licence strip below the body flow by its markers', () => {
  const licence = line('© The Author(s) 2020. Published by Oxford University Press.', { size: 8, top: 0.87, bottom: 0.88 });
  assert.equal(isFurniture(licence, { body: 10, last: true, flowTop: 0.1, flowBottom: 0.86 }), true);
});

test('isFurniture keeps an ordinary last line of body text', () => {
  const last = line('and then the authors conclude something.', { size: 10, top: 0.87, bottom: 0.88 });
  assert.equal(isFurniture(last, { body: 10, last: true, flowTop: 0.1, flowBottom: 0.86 }), false);
});

test('orderLines reads the left column before the right one', () => {
  const columns = [{ x0: 0.05, x1: 0.5 }, { x0: 0.5, x1: 0.95 }];
  const right = line('right one', { x0: 0.52, x1: 0.93, top: 0.12, bottom: 0.13 });
  const left = line('left one', { x0: 0.06, x1: 0.47, top: 0.2, bottom: 0.21 });
  assert.deepEqual(orderLines([right, left], columns).map((entry) => entry.text), ['left one', 'right one']);
});

test('orderLines keeps a full-width heading above both columns', () => {
  const columns = [{ x0: 0.05, x1: 0.5 }, { x0: 0.5, x1: 0.95 }];
  const body = line('body', { x0: 0.06, x1: 0.47, top: 0.3, bottom: 0.31 });
  const heading = line('Results', { x0: 0.06, x1: 0.9, top: 0.1, bottom: 0.12 });
  assert.deepEqual(orderLines([body, heading], columns).map((entry) => entry.text), ['Results', 'body']);
});

/* selectionText: the crossing-page case the reader complained about. */

const piece = (text, { size = 10, top = 0.3, bottom = 0.312, left = 0.06, right = 0.47, rotated = false } = {}) => ({ text, size, top, bottom, left, right, rotated });

const profile = (extra = {}) => ({
  body: 10,
  bands: [],
  columns: [{ x0: 0.05, x1: 0.5 }, { x0: 0.5, x1: 0.95 }],
  flows: new Map([[1, { flowTop: 0.1, flowBottom: 0.9 }], [2, { flowTop: 0.1, flowBottom: 0.86 }], [3, { flowTop: 0.1, flowBottom: 0.9 }]]),
  ...extra,
});

test('selectionText drops a repeated top band even at body size', () => {
  const pages = [
    { page: 1, first: true, pieces: [piece('page one body')] },
    {
      page: 2,
      last: true,
      pieces: [piece('Nucleic Acids Research, 2020', { size: 10, top: 0.041, bottom: 0.049 }), piece('page two body', { top: 0.15, bottom: 0.162 })],
    },
  ];
  const bands = [{ y0: 0.038, y1: 0.052, share: 1 }];
  assert.equal(selectionText(pages, profile({ bands })), 'page one body\npage two body');
});

test('selectionText drops a licence strip below the body flow', () => {
  const pages = [
    { page: 1, first: true, pieces: [piece('page one body')] },
    {
      page: 2,
      last: true,
      pieces: [piece('last body line', { top: 0.84, bottom: 0.852 }), piece('© The Author(s) 2020. Open Access.', { size: 8, top: 0.871, bottom: 0.883 })],
    },
  ];
  assert.equal(selectionText(pages, profile()), 'page one body\nlast body line');
});

test('selectionText reads a cross-column selection left column first', () => {
  const pages = [
    {
      page: 1,
      first: true,
      last: true,
      pieces: [
        piece('right top', { left: 0.52, right: 0.93, top: 0.2, bottom: 0.212 }),
        piece('right bottom', { left: 0.52, right: 0.93, top: 0.25, bottom: 0.262 }),
        piece('left top', { left: 0.06, right: 0.47, top: 0.2, bottom: 0.212 }),
        piece('left bottom', { left: 0.06, right: 0.47, top: 0.25, bottom: 0.262 }),
      ],
    },
  ];
  assert.equal(selectionText(pages, profile()), 'left top\nleft bottom\nright top\nright bottom');
});

test('selectionText keeps the pages in order even when a later page is read first', () => {
  const pages = [
    { page: 1, first: true, pieces: [piece('first page line')] },
    { page: 2, last: true, pieces: [piece('second page line')] },
  ];
  assert.equal(selectionText(pages, profile()), 'first page line\nsecond page line');
});

test('selectionText falls back to the page body size when there is no profile', () => {
  // The viewer passes the page's own body size in this case (median of the page,
  // not of the selection, so a licence strip cannot drag it down).
  const pages = [
    { page: 1, first: true, last: true, body: 10, pieces: [piece('body line here'), piece('small footer note', { size: 7, top: 0.92, bottom: 0.93 })] },
  ];
  assert.equal(selectionText(pages, null), 'body line here');
});

test('selectionText drops a sideways download stamp inside an upright passage', () => {
  const pages = [
    {
      page: 1,
      first: true,
      pieces: [
        piece('body line one'),
        piece('Downloaded from academic.oup.com by guest on 18 November 2026', {
          size: 5.8,
          rotated: true,
          top: 0.269,
          bottom: 0.731,
          left: 0.961,
          right: 0.974,
        }),
      ],
    },
    { page: 2, last: true, pieces: [piece('body line two', { top: 0.15, bottom: 0.162 })] },
  ];
  assert.equal(selectionText(pages, profile()), 'body line one\nbody line two');
});

test('selectionText keeps a landscape page whose only text is rotated', () => {
  const pages = [{ page: 1, first: true, last: true, pieces: [piece('landscape table note', { rotated: true })] }];
  assert.equal(selectionText(pages, profile()), 'landscape table note');
});

test('isFurniture drops affiliations that sit just under the last body line', () => {
  const ctx = { body: 8.7, first: false, last: false, flowTop: 0.06, flowBottom: 0.811, bands: [] };
  assert.equal(isFurniture(line('Department of Chemistry, University of Cambridge', { size: 6.7, top: 0.831, bottom: 0.843 }), ctx), true);
  // A caption is small too, but it belongs to the figure the reader selected.
  assert.equal(isFurniture(line('Fig. 1 | Design of the protein library.', { size: 6.7, top: 0.831, bottom: 0.843 }), ctx), false);
});

test('isFurniture keeps body-size text below the flow on the page the selection ends on', () => {
  const base = { body: 10, first: false, flowTop: 0.1, flowBottom: 0.8, bands: [] };
  assert.equal(isFurniture(line('still body text', { size: 10, top: 0.85, bottom: 0.862 }), { ...base, last: true }), false);
  // The page the selection merely passes through keeps nothing under its text block.
  assert.equal(isFurniture(line('still body text', { size: 10, top: 0.85, bottom: 0.862 }), { ...base, last: false }), true);
});

test('linesFromItems ignores a sideways stamp', () => {
  const stamp = { str: 'Downloaded from example.org', transform: [0, 5.8, -5.8, 0, 570, 400], width: 20, height: 5.8 };
  const lines = linesFromItems([item('upright line'), stamp], viewportOf());
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'upright line');
});

test('isFurniture drops a small licence box in the middle of a figure page', () => {
  const ctx = { body: 8.25, first: false, last: false, flowTop: 0.06, flowBottom: 0.9, bands: [] };
  assert.equal(isFurniture(line('4.0 International License, which permits use and distribution', { size: 6, top: 0.487, bottom: 0.496 }), ctx), true);
  assert.equal(isFurniture(line('© The Author(s) 2023', { size: 6, top: 0.588, bottom: 0.598 }), ctx), true);
});

test('isFurniture keeps a reference line that only carries a DOI', () => {
  const ctx = { body: 8.25, first: false, last: false, flowTop: 0.06, flowBottom: 0.9, bands: [] };
  assert.equal(isFurniture(line('1. Jumper, J. et al. Nature 596, 583 (2021). https://doi.org/10.1038/s41586', { size: 6, top: 0.5, bottom: 0.509 }), ctx), false);
});

test('bodyFlow ignores a footer set at almost body size', () => {
  const lines = [
    line('body first', { size: 8.25, top: 0.1, bottom: 0.112 }),
    line('body last', { size: 8.25, top: 0.8, bottom: 0.812 }),
    line('780 | Nature | Vol 614 | 23 February 2023', { size: 8, top: 0.964, bottom: 0.975 }),
  ];
  const bands = [{ y0: 0.968, y1: 0.972, share: 1 }];
  const flow = bodyFlow(lines, 8.25, bands);
  assert.ok(Math.abs(flow.flowBottom - 0.812) < 0.001);
  assert.ok(Math.abs(flow.flowTop - 0.1) < 0.001);
});

