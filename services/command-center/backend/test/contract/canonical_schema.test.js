const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.ECOWING_OPERATOR_TOKEN = 'secure_test_operator_token_9xK2mP7qR4vL8wZ1';
process.env.DRONE_DEVICE_TOKENS = JSON.stringify({
  'Drone-Alpha': 'drone_alpha_token_12345678901234567890',
  'Drone-Beta': 'drone_beta_token_12345678901234567890'
});

const rootDir = path.resolve(__dirname, '../../..');

const {
  validateCanonicalDetectionEvent,
  validateDetectionPayload
} = require('../../validators/detectionValidator');
const detectionStore = require('../../detectionStore');
const express = require('express');
const droneRoutes = require('../../routes/drone');
const crypto = require('crypto');
test('Canonical Detection Event Schema Validation', async (t) => {
  const validEvent = {
    event_id: '12345678-1234-4234-8234-123456789abc',
    drone_id: 'Drone-Alpha',
    source: 'camera',
    observed_at: '2026-11-01T04:00:00.000Z',
    taxonomy_version: '1.0.0',
    classification_method: 'coco_mapping',
    items: [
      {
        class_id: 'bottle',
        coco_label: 'bottle',
        confidence: 0.95,
        bbox: [100, 150, 200, 300],
        category: 'Container',
        material: 'plastic',
        recyclable: 'yes',
        biodegradable: 'no'
      }
    ]
  };

  await t.test('accepts valid canonical detection event', () => {
    const res = validateCanonicalDetectionEvent(validEvent);
    assert.equal(res.valid, true);
    assert.equal(res.errors.length, 0);

    const payloadRes = validateDetectionPayload(validEvent);
    assert.equal(payloadRes.valid, true);
    assert.equal(payloadRes.isCanonical, true);
  });

  await t.test('rejects missing required event_id', () => {
    const bad = { ...validEvent };
    delete bad.event_id;
    const res = validateCanonicalDetectionEvent(bad);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('event_id')));
  });

  await t.test('rejects non-UUIDv4 event_id', () => {
    const bad = { ...validEvent, event_id: 'not-a-valid-uuid' };
    const res = validateCanonicalDetectionEvent(bad);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('UUIDv4')));
  });

  await t.test('rejects confidence outside [0.0, 1.0] and non-finite values', () => {
    const badHigh = {
      ...validEvent,
      items: [{ ...validEvent.items[0], confidence: 1.5 }]
    };
    assert.equal(validateCanonicalDetectionEvent(badHigh).valid, false);

    const badNegative = {
      ...validEvent,
      items: [{ ...validEvent.items[0], confidence: -0.1 }]
    };
    assert.equal(validateCanonicalDetectionEvent(badNegative).valid, false);

    const badPct = {
      ...validEvent,
      items: [{ ...validEvent.items[0], confidence: 50 }]
    };
    assert.equal(validateCanonicalDetectionEvent(badPct).valid, false);

    const badNaN = {
      ...validEvent,
      items: [{ ...validEvent.items[0], confidence: NaN }]
    };
    assert.equal(validateCanonicalDetectionEvent(badNaN).valid, false);
  });

  await t.test('rejects unknown class_id not in canonical taxonomy', () => {
    const bad = {
      ...validEvent,
      items: [{ ...validEvent.items[0], class_id: 'plastic_wrapper' }]
    };
    const res = validateCanonicalDetectionEvent(bad);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('canonical taxonomy identifier')));
  });

  await t.test('rejects invalid source enum', () => {
    const bad = { ...validEvent, source: 'satellite' };
    const res = validateCanonicalDetectionEvent(bad);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('source')));
  });

  await t.test('rejects invalid bbox format', () => {
    const bad = {
      ...validEvent,
      items: [{ ...validEvent.items[0], bbox: [10, 20] }]
    };
    const res = validateCanonicalDetectionEvent(bad);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('bbox')));
  });

  await t.test('detectionStore deduplicates identical canonical_event_id', () => {
    const origCount = detectionStore.events.length;
    const testId = 'idemp-uuid-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    const first = detectionStore.addDetection({
      canonical_event_id: testId,
      class_name: 'bottle',
      confidence: 0.95
    });
    const afterFirst = detectionStore.events.length;
    assert.equal(afterFirst, origCount + 1);

    const second = detectionStore.addDetection({
      canonical_event_id: testId,
      class_name: 'bottle',
      confidence: 0.95
    });
    const afterSecond = detectionStore.events.length;
    assert.equal(afterSecond, origCount + 1, 'Store length must not grow on duplicate canonical_event_id');
    assert.equal(second.event_id, first.event_id, 'Duplicate must return existing event object');
  });

  await t.test('POST /api/drone/detection endpoint is strictly idempotent on duplicate event_id', async () => {
    const express = require('express');
    const http = require('http');
    const droneRouter = require('../../routes/drone');
    const testApp = express();
    testApp.use(express.json());
    testApp.use('/api/drone', droneRouter);

    const srv = http.createServer(testApp);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    const dupEvent = {
      event_id: require('crypto').randomUUID(),
      drone_id: 'Drone-Alpha',
      source: 'camera',
      observed_at: new Date().toISOString(),
      taxonomy_version: '1.0.0',
      classification_method: 'coco_mapping',
      items: [{
        class_id: 'bottle',
        coco_label: 'bottle',
        confidence: 0.92,
        bbox: [10, 10, 100, 100]
      }]
    };

    const headers = {
      'Content-Type': 'application/json',
      'X-Drone-Id': 'Drone-Alpha',
      'X-Drone-Token': 'drone_alpha_token_12345678901234567890',
      'Connection': 'close'
    };

    const countBefore = detectionStore.events.length;

    // First push
    const res1 = await fetch('http://127.0.0.1:' + port + '/api/drone/detection', {
      method: 'POST',
      headers,
      body: JSON.stringify(dupEvent)
    });
    assert.equal(res1.status, 200);
    const json1 = await res1.json();
    assert.equal(json1.success, true);
    assert.equal(json1.count, 1);
    assert.equal(detectionStore.events.length, countBefore + 1);

    // Second push with identical event_id (idempotence verification)
    const res2 = await fetch('http://127.0.0.1:' + port + '/api/drone/detection', {
      method: 'POST',
      headers,
      body: JSON.stringify(dupEvent)
    });
    assert.equal(res2.status, 200);
    const json2 = await res2.json();
    assert.equal(json2.success, true);
    assert.equal(json2.duplicate, true, 'Second push must flag duplicate');
    assert.equal(detectionStore.events.length, countBefore + 1, 'Second push must NOT create additional document');

    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise(r => srv.close(r));
  });
});

const { CommandManager } = require('../../services/commandManager');

