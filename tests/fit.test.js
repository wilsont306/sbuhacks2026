// src/host/fit.js: the viewport clipped to the screen's work area, so the TV frame never fits itself to hidden pixels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleArea } from '../src/host/fit.js';

// A 1920 x 1080 screen with a 48 px taskbar at the bottom; Chrome's tab strip and toolbar take 80 px.
const screen = { width: 1920, height: 1080, availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1032 };
const win = (o) => ({ screenX: 0, screenY: 0, outerWidth: 1920, innerWidth: 1920, ...o });

test('a maximized window keeps its whole viewport', () => {
  assert.deepEqual(visibleArea(win({ outerHeight: 1032, innerHeight: 952 }), screen), { width: 1920, height: 952 });
});

test('a window taller than the screen is cut at the taskbar', () => {
  assert.deepEqual(visibleArea(win({ outerHeight: 1160, innerHeight: 1080 }), screen), { width: 1920, height: 952 });
});

test('fullscreen keeps the whole viewport, taskbar and all', () => {
  assert.deepEqual(visibleArea(win({ outerHeight: 1080, innerHeight: 1080 }), screen), { width: 1920, height: 1080 });
});

test('page zoom is undone: the answer is in page px', () => {
  // 125% zoom: the page sees 1536 x 864 for a 1920 x 1080 viewport that runs 128 px past the work area.
  const a = visibleArea(win({ outerHeight: 1160, innerWidth: 1536, innerHeight: 864 }), screen);
  assert.equal(a.width, 1536);
  assert.equal(Math.round(a.height), 762);
});

test('a window mostly off screen never shrinks the frame below a quarter', () => {
  const a = visibleArea(win({ screenY: 1000, outerHeight: 1032, innerHeight: 952 }), screen);
  assert.equal(a.height, 952 / 4);
});
