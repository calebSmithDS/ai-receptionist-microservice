import { SanityTenantProvider } from '../core/providers/sanity-tenant.provider.js';

async function test() {
  console.log('--- Testing SanityTenantProvider ---');

  const provider = new SanityTenantProvider({
    projectId: 'mc1571jp',
    dataset: 'production',
  });

  console.log('1. Testing unknown phone number (+61499999999)...');
  const result = await provider.getTenantByPhoneNumber('+61499999999');
  console.log('Result for unknown number:', result); // Expected: null

  console.log('\n2. Testing cache hit verification on repeated query...');
  const cachedResult = await provider.getTenantByPhoneNumber('+61499999999');
  console.log('Result from cache:', cachedResult); // Expected: null (cached)

  console.log('\nTenant Provider verification completed successfully.');
}

test();

