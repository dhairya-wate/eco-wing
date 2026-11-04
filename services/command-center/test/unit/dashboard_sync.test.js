const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Dashboard Single Source of Truth & Zero-Drift Guarantee', async (t) => {
  const canonicalPath = path.resolve(__dirname, '../../index.html');
  const dashboardPath = path.resolve(__dirname, '../../../../dashboard/index.html');
  const rootPath = path.resolve(__dirname, '../../../../index.html');
  const sensorDashboardPath = path.resolve(__dirname, '../../../sensor/index.html');
  const legacyScriptPath = path.resolve(__dirname, '../../../../update_dashboard.py');

  await t.test('canonical dashboard file services/command-center/index.html exists and is non-empty', () => {
    assert.ok(fs.existsSync(canonicalPath), `Canonical index.html must exist at ${canonicalPath}`);
    const content = fs.readFileSync(canonicalPath, 'utf8');
    assert.ok(content.length > 1000, 'Canonical index.html must be a populated HTML document');
  });

  await t.test('every copy of the dashboard is identical to canonical services/command-center/index.html', () => {
    const canonicalContent = fs.readFileSync(canonicalPath, 'utf8');

    // dashboard/index.html
    assert.ok(fs.existsSync(dashboardPath), `dashboard/index.html must exist at ${dashboardPath}`);
    assert.equal(fs.readFileSync(dashboardPath, 'utf8'), canonicalContent, 'dashboard/index.html must be identical to canonical index.html');

    // root index.html (if present for static deployments)
    if (fs.existsSync(rootPath)) {
      assert.equal(fs.readFileSync(rootPath, 'utf8'), canonicalContent, 'root index.html must be identical to canonical index.html');
    }

    // services/sensor/index.html
    if (fs.existsSync(sensorDashboardPath)) {
      assert.equal(fs.readFileSync(sensorDashboardPath, 'utf8'), canonicalContent, 'services/sensor/index.html must be identical to canonical index.html');
    }
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

  await t.test('no *.vercel.app URL appears in any HTML or JS file served to phone or dashboard', () => {
    const phoneFacingAllowlist = []; // Strict empty allowlist for phone-facing and dashboard assets

    const repoRoot = path.resolve(__dirname, '../../../../');
    const filesToCheck = [
      canonicalPath,
      dashboardPath,
      rootPath,
      sensorDashboardPath,
      path.resolve(repoRoot, 'services/sensor/templates/mobile.html'),
      path.resolve(repoRoot, 'services/sensor/templates/index.html'),
      path.resolve(repoRoot, 'config.js'),
      path.resolve(repoRoot, 'dashboard/config.js'),
      path.resolve(repoRoot, 'services/sensor/config.js'),
      path.resolve(repoRoot, 'services/sensor/static/js/main.js')
    ];

    const vercelRegex = /https?:\/\/[a-zA-Z0-9.\-_]+\.vercel\.app[a-zA-Z0-9/\-_]*/gi;

    for (const filePath of filesToCheck) {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const matches = content.match(vercelRegex) || [];
      const unallowed = matches.filter(url => !phoneFacingAllowlist.includes(url));
      assert.equal(
        unallowed.length,
        0,
        `File ${path.relative(repoRoot, filePath)} contains unallowed vercel.app URLs: ${unallowed.join(', ')}`
      );
    }
  });
});
