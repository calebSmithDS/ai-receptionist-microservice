import dotenv from 'dotenv';
dotenv.config();
import { getDb } from '../core/db/index.js';
import { sql } from 'drizzle-orm';

/**
 * Admin Purge Script for Demo & Simulated Test Records
 * 
 * Safely removes test data from Neon DB without touching real production contacts:
 * - Contacts where business_id LIKE 'demo_%' or phone_number LIKE '+61499%'
 * - Intent sessions for demo callers
 * - Eligibility decisions logged for demo callers
 * - Magic mute links created for demo callers
 * - Conversation ledgers for demo callers
 */
async function purgeDemoData() {
  console.log('🧹 Connecting to Neon to purge demo test records...');
  const db = getDb();
  if (!db) {
    console.error('❌ Failed: DATABASE_URL not set in .env');
    process.exit(1);
  }

  try {
    const decisionsRes = await db.execute(
      sql`DELETE FROM eligibility_decisions WHERE business_id LIKE 'demo_%' OR caller_phone LIKE '+61499%';`
    );
    console.log(`✅ Deleted demo eligibility decisions:`, decisionsRes.rowCount ?? 'Done');

    const sessionsRes = await db.execute(
      sql`DELETE FROM intent_sessions WHERE business_id LIKE 'demo_%' OR caller_phone LIKE '+61499%';`
    );
    console.log(`✅ Deleted demo intent sessions:`, sessionsRes.rowCount ?? 'Done');

    const linksRes = await db.execute(
      sql`DELETE FROM mute_magic_links WHERE business_id LIKE 'demo_%' OR target_phone LIKE '+61499%';`
    );
    console.log(`✅ Deleted demo mute magic links:`, linksRes.rowCount ?? 'Done');

    const contactsRes = await db.execute(
      sql`DELETE FROM contacts WHERE business_id LIKE 'demo_%' OR phone_number LIKE '+61499%';`
    );
    console.log(`✅ Deleted demo contacts:`, contactsRes.rowCount ?? 'Done');

    // Purge demo rows from conversation_ledgers
    const ledgerRes = await db.execute(
      sql`DELETE FROM conversation_ledgers WHERE business_id LIKE 'demo_%' OR caller_phone LIKE '+61499%';`
    );
    console.log(`✅ Deleted demo conversation ledgers:`, ledgerRes.rowCount ?? 'Done');

    console.log('🎉 Neon DB is completely clean of demo test records!');
  } catch (err: any) {
    console.error('❌ Error purging demo data:', err.message);
    process.exit(1);
  }
}

purgeDemoData();
