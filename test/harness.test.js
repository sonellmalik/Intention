// Test harness smoke check for the Electron sync work (iOS Focus Companion spec).
// Uses the built-in node:test runner (no extra test-framework dependency).
// Real tests for DesktopSyncServer / mergePhoneDistractions are added in later tasks.
const test = require('node:test');
const assert = require('node:assert');

test('node:test harness runs', () => {
  assert.strictEqual(1 + 1, 2);
});

test('sync dependencies resolve', () => {
  // Confirms ws, bonjour-service, and qrcode are installed and loadable,
  // which the main.js sync server (task 8.2) and pairing QR (task 9.2) rely on.
  assert.doesNotThrow(() => require('ws'), 'ws should be installed');
  assert.doesNotThrow(() => require('bonjour-service'), 'bonjour-service should be installed');
  assert.doesNotThrow(() => require('qrcode'), 'qrcode should be installed');
});
