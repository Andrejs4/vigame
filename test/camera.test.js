import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Camera } from '../src/client/camera.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} != ${b}`);

test('toWorld and toScreen are inverses', () => {
  const cam = new Camera();
  cam.x = 120; cam.y = -40; cam.zoom = 1.7;
  const w = cam.toWorld(33, 250);
  const s = cam.toScreen(w.x, w.y);
  near(s.x, 33);
  near(s.y, 250);
});

test('pan moves the view by a screen distance at any zoom', () => {
  const cam = new Camera();
  cam.zoom = 2;
  const before = cam.toWorld(100, 100);
  cam.pan(40, -20);
  const after = cam.toWorld(140, 80);
  near(after.x, before.x);
  near(after.y, before.y);
});

test('zoomAt keeps the anchor point fixed and clamps', () => {
  const cam = new Camera({ minZoom: 0.5, maxZoom: 2 });
  cam.x = 10; cam.y = 20;
  const anchor = cam.toWorld(300, 200);
  cam.zoomAt(1.5, 300, 200);
  near(cam.zoom, 1.5);
  const again = cam.toWorld(300, 200);
  near(again.x, anchor.x);
  near(again.y, anchor.y);

  cam.zoomAt(100, 0, 0);
  assert.equal(cam.zoom, 2);
  cam.zoomAt(0.0001, 0, 0);
  assert.equal(cam.zoom, 0.5);
});

test('fit centres the box in the viewport', () => {
  const cam = new Camera();
  const box = { minX: 100, minY: 50, width: 400, height: 200 };
  cam.fit(box, 800, 600, 0);
  near(cam.zoom, 2);
  const c = cam.toScreen(box.minX + box.width / 2, box.minY + box.height / 2);
  near(c.x, 400);
  near(c.y, 300);
});

test('fit ignores an empty box', () => {
  const cam = new Camera();
  cam.fit({ minX: 0, minY: 0, width: 0, height: 0 }, 800, 600);
  assert.deepEqual([cam.x, cam.y, cam.zoom], [0, 0, 1]);
});

test('centreOn puts a point mid-view and keeps the zoom', () => {
  const cam = new Camera();
  cam.zoom = 1.5;
  cam.centreOn(400, -90, 800, 600);
  const mid = cam.toWorld(400, 300);
  near(mid.x, 400);
  near(mid.y, -90);
  near(cam.zoom, 1.5);
});
