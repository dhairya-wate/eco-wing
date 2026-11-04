const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Dashboard Single Source of Truth & Zero-Drift Guarantee', async (t) => {
  const canonicalPath = path.resolve(__dirname, '../../index.html');
  const dashboardPath = path.resolve(__dirname, '../../../../dashboard/index.html');
  const legacyScriptPath = path.resolve(__dirname, '../../../../update_dashboard.py');

  await t.test('canonical dashboard file services/command-center/index.html exists and is non-empty', () => {
    assert.ok(fs.existsSync(canonicalPath), `Canonical index.html must exist at ${canonicalPath}`);
    const content = fs.readFileSync(canonicalPath, 'utf8');
    assert.ok(content.length > 1000, 'Canonical index.html must be a populated HTML document');
  });

  await t.test('dashboard/index.html is strictly identical to canonical services/command-center/index.html', () => {
    assert.ok(fs.existsSync(dashboardPath), `dashboard/index.html must exist at ${dashboardPath}`);
    const canonicalContent = fs.readFileSync(canonicalPath, 'utf8');
    const dashboardContent = fs.readFileSync(dashboardPath, 'utf8');
    assert.equal(dashboardContent, canonicalContent, 'dashboard/index.html must be identical to canonical index.html');
  });

  await t.test('update_dashboard.py is completely deleted and not present in the workspace', () => {
    assert.equal(fs.existsSync(legacyScriptPath), false, 'update_dashboard.py must not exist in repo');
  });

  await t.test('neither canonical nor dashboard index.html contains deprecated endpoints or hardcoded hosts', () => {
    const canonicalContent = fs.readFileSync(canonicalPath, 'utf8');
    assert.equal(
      canonicalContent.includes('detection-system-flax.vercel.app'),
      false,
      'Canonical index.html must not contain detection-system-flax.vercel.app'
    );
    assert.equal(
      canonicalContent.includes('/api/device/command'),
      false,
      'Canonical index.html must not contain /api/device/command'
    );
  });
});
