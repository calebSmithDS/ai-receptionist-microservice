import { createClient } from '@sanity/client';

const client = createClient({
  projectId: 'mc1571jp',
  dataset: 'production',
  apiVersion: '2024-01-01',
  useCdn: true,
});

async function main() {
  console.log('Querying Sanity dataset [mc1571jp / production] for tenants...\n');

  try {
    const tenants = await client.fetch(`*[_type == "tenant"]{
      _id,
      tenantId,
      businessName,
      publicPhone,
      twilioForwardingNumber,
      serviceArea
    }`);

    console.log(`Found ${tenants.length} tenant document(s):\n`);
    console.log(JSON.stringify(tenants, null, 2));
  } catch (error) {
    console.error('Error querying Sanity:', error);
  }
}

main();

