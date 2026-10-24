import { buildServer } from '../server.js';

async function testMetrics() {
  console.log('--- Testing /metrics Endpoint ---\n');

  const app = buildServer();
  await app.ready();

  const response = await app.inject({
    method: 'GET',
    url: '/metrics',
  });

  console.log(`Status Code: ${response.statusCode}`);
  console.log('Live Telemetry Snapshot:\n', JSON.stringify(JSON.parse(response.body), null, 2));

  await app.close();
}

testMetrics();

