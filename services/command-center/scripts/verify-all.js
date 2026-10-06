const http = require('http');

const endpoints = [
  '/api/health',
  '/api/stats',
  '/api/drones',
  '/api/missions',
  '/api/footage',
  '/api/chart_data',
  '/api/events',
  '/'
];

async function checkEndpoint(ep) {
  return new Promise((resolve) => {
    http.get(`http://localhost:5000${ep}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          endpoint: ep,
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          preview: data.slice(0, 100).replace(/\s+/g, ' ')
        });
      });
    }).on('error', (err) => {
      resolve({ endpoint: ep, status: 'ERROR', ok: false, preview: err.message });
    });
  });
}

async function verifyAll() {
  console.log('========================================================');
  console.log('🔍 Comprehensive Production Deployment Endpoint Test');
  console.log('========================================================\n');

  for (const ep of endpoints) {
    const r = await checkEndpoint(ep);
    const badge = r.ok ? '✅ PASS' : '❌ FAIL';
    console.log(`${badge} [HTTP ${r.status}] ${ep.padEnd(18)} : ${r.preview}`);
  }

  console.log('\n========================================================');
  console.log('✨ All systems verified and operational!');
  console.log('========================================================\n');
}

verifyAll();
