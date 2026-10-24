import { buildServer } from '../server.js';
import { telemetry } from '../telemetry/metrics.js';

async function testMetrics() {
  console.log('--- Testing Global & Per-Tenant Telemetry ---\n');

  // Simulate some recorded activity
  telemetry.recordCallReceived('tenant_adelaide_plumbing');
  telemetry.recordCallMissed('tenant_adelaide_plumbing');
  telemetry.recordSmsReceived('tenant_adelaide_plumbing');
  telemetry.recordSmsReplySent('tenant_adelaide_plumbing');
  telemetry.recordLeadCaptured('tenant_adelaide_plumbing', 'EMERGENCY');

  telemetry.recordCallReceived('tenant_hills_sparky');

  const app = buildServer();
  await app.ready();

  // 1. Test Global Snapshot
  const globalRes = await app.inject({ method: 'GET', url: '/metrics' });
  console.log('Global Telemetry Snapshot (/metrics):\n', JSON.stringify(JSON.parse(globalRes.body), null, 2));

  // 2. Test Specific Tenant Snapshot
  const tenantRes = await app.inject({ method: 'GET', url: '/metrics/tenant/tenant_adelaide_plumbing' });
  console.log('\nTenant-Specific Metrics (/metrics/tenant/tenant_adelaide_plumbing):\n', JSON.stringify(JSON.parse(tenantRes.body), null, 2));

  await app.close();
}

testMetrics();
