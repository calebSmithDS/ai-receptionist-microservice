import { CachedTenantProvider } from '../core/providers/cached-tenant.provider.js';
import { ITenantProvider, TenantContext } from '../core/types/tenant.js';

async function testCachedTenant() {
  console.log('🧪 Testing Redis-Cached Tenant Provider...\n');

  let sanityFetchCount = 0;

  // Mock underlying Sanity provider to track fetch invocations
  const mockSanityProvider: ITenantProvider = {
    async getTenantByPhoneNumber(phone: string): Promise<TenantContext | null> {
      sanityFetchCount++;
      return {
        tenantId: 'tenant_coogee_plumbing_88',
        businessName: 'Coogee Emergency Plumbing',
        publicPhone: '+61412000999',
        twilioForwardingNumber: phone,
        serviceArea: 'Coogee, Clovelly, Randwick',
        businessHours: '24/7 Emergency Service',
        aiCustomInstructions: 'Always confirm if water is actively gushing before booking.',
        services: [
          { title: 'Burst Pipes', startingPrice: '$180 call-out' },
          { title: 'Clogged Drains', startingPrice: '$150' },
        ],
      };
    },
  };

  const cachedProvider = new CachedTenantProvider({
    underlyingProvider: mockSanityProvider,
    ttlSeconds: 3600,
  });

  const testPhone = '+61488880000';

  // First call -> Cache miss, queries underlying Sanity provider
  console.log('1️⃣ First Call: Cache Miss (Queries Sanity CMS)...');
  const t1 = performance.now();
  const tenant1 = await cachedProvider.getTenantByPhoneNumber(testPhone);
  const d1 = (performance.now() - t1).toFixed(2);
  console.log(`   Fetched: "${tenant1?.businessName}" in ${d1}ms`);
  console.log(`   Sanity queries executed: ${sanityFetchCount}`);

  if (sanityFetchCount !== 1) {
    throw new Error(`Expected sanityFetchCount = 1, got ${sanityFetchCount}`);
  }

  // Second call -> Cache hit, instant resolution
  console.log('\n2️⃣ Second Call: Cache Hit (Reads from Redis/Memory Cache)...');
  const t2 = performance.now();
  const tenant2 = await cachedProvider.getTenantByPhoneNumber(testPhone);
  const d2 = (performance.now() - t2).toFixed(2);
  console.log(`   Fetched: "${tenant2?.businessName}" in ${d2}ms`);
  console.log(`   Sanity queries executed: ${sanityFetchCount}`);

  if (sanityFetchCount !== 1) {
    throw new Error('Cache hit failed! Sanity was queried a second time.');
  }

  if (tenant1?.businessName !== tenant2?.businessName) {
    throw new Error('Tenant data mismatch between cache miss and hit');
  }

  console.log('\n✅ CachedTenantProvider verified: 100% cache hit rate on repeated calls!');
}

testCachedTenant().catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});

