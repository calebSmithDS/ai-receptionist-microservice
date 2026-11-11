import dotenv from 'dotenv';
dotenv.config();
import { getDb } from '../core/db/index.js';
import { sql } from 'drizzle-orm';
import { contacts, intentSessions, muteMagicLinks, eligibilityDecisions } from '../core/db/schema.js';
import { DrizzleEligibilityRepository } from '../core/eligibility/drizzle-eligibility.repository.js';
import { EligibilityEngine } from '../core/eligibility/eligibility-engine.js';

async function main() {
  console.log('Testing connection to Neon PostgreSQL...');
  const db = getDb();
  if (!db) {
    console.error('❌ Failed: getDb() returned null. Is DATABASE_URL set in .env?');
    process.exit(1);
  }

  try {
    const tablesRes = await db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';`);
    console.log('✅ Connected successfully!');
    const tableNames = tablesRes.rows.map((r: any) => r.table_name);
    console.log('Existing tables in DB:', tableNames);

    const requiredTables = ['contacts', 'intent_sessions', 'mute_magic_links', 'eligibility_decisions'];
    const missing = requiredTables.filter(t => !tableNames.includes(t));
    if (missing.length > 0) {
      console.warn(`⚠️ Warning: Missing schema tables: ${missing.join(', ')}. Have you run 'npx drizzle-kit push'?`);
    } else {
      console.log('✅ All 4 schema tables exist in Neon!');
    }

    // Insert a test contact and test the real repository
    console.log('\n--- Testing Real DrizzleEligibilityRepository with Neon ---');
    const repo = new DrizzleEligibilityRepository(db);
    const engine = new EligibilityEngine(repo);

    const testBusinessId = 'test_biz_' + Date.now();
    const testPhone = '+61499998888';

    // 1. Create a muted contact directly in Neon
    console.log(`1. Upserting test contact ${testPhone} into Neon (isMuted: true)...`);
    await repo.upsertContact({
      businessId: testBusinessId,
      phoneNumber: testPhone,
      displayName: 'Uncle Dave',
      category: 'explicit_excluded',
      isMuted: true,
      lastMissedCallAt: new Date(Date.now() - 3600000),
    });

    // 2. Query contact back
    const fetched = await repo.getContact(testBusinessId, testPhone);
    console.log('2. Fetched from Neon:', fetched ? `Found: ${fetched.displayName}, isMuted=${fetched.isMuted}` : 'Not found');

    // 3. Evaluate eligibility using the live Neon repository
    console.log('3. Running EligibilityEngine against real Neon record...');
    const decision = await engine.evaluateMissedCall(testBusinessId, testPhone);
    console.log('Decision from live Neon data:', decision);

    if (decision.action === 'suppress' && decision.reason === 'personal_exclusion') {
      console.log('✅ SUCCESS: Live Neon DB successfully gatekept the missed call (Action: suppress, $0 cost)!');
    } else {
      console.log('❌ Unexpected decision:', decision);
    }

    // 4. Check decisions table
    const decisionsCount = await db.execute(sql`SELECT count(*) FROM eligibility_decisions WHERE business_id = ${testBusinessId};`);
    console.log('4. Decisions logged in Neon:', decisionsCount.rows[0]);

    // Clean up test data
    console.log('\nCleaning up test records...');
    await db.execute(sql`DELETE FROM eligibility_decisions WHERE business_id = ${testBusinessId};`);
    await db.execute(sql`DELETE FROM contacts WHERE business_id = ${testBusinessId};`);
    console.log('🧹 Cleanup complete!');

  } catch (err: any) {
    console.error('❌ Database error:', err.message);
    if (err.cause) {
      console.error('Error cause:', err.cause);
    }
  }
}

main();
