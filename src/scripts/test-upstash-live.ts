import { Redis } from '@upstash/redis';
import { Client } from '@upstash/qstash';
import dotenv from 'dotenv';

dotenv.config();

async function testLiveUpstash() {
  console.log('🔌 Testing Live Upstash Credentials...\n');

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const qstashToken = process.env.QSTASH_TOKEN;

  // 1. Verify Redis
  console.log('1️⃣ Testing Upstash Redis Connection...');
  if (!redisUrl || !redisToken) {
    console.error('❌ UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing in .env');
  } else {
    try {
      const redis = new Redis({ url: redisUrl, token: redisToken });
      const testKey = 'test:ping:' + Date.now();
      
      const setStart = performance.now();
      await redis.set(testKey, { ping: 'pong', timestamp: new Date().toISOString() }, { ex: 60 });
      const setDuration = (performance.now() - setStart).toFixed(2);
      console.log(`   ✅ SET test key in ${setDuration}ms`);

      const getStart = performance.now();
      const value = await redis.get<{ ping: string }>(testKey);
      const getDuration = (performance.now() - getStart).toFixed(2);
      console.log(`   ✅ GET test key in ${getDuration}ms:`, value);

      await redis.del(testKey);
      console.log('   ✅ DEL test key cleaned up cleanly');
      console.log('   🎉 Upstash Redis is ONLINE and working perfectly!\n');
    } catch (err: any) {
      console.error('   ❌ Redis connection failed:', err.message || err);
    }
  }

  // 2. Verify QStash
  console.log('2️⃣ Testing Upstash QStash Connection...');
  if (!qstashToken) {
    console.error('❌ QSTASH_TOKEN missing in .env');
  } else {
    try {
      const qstash = new Client({ token: qstashToken });
      // Fetch QStash schedules or endpoints to verify authentication
      const schedules = await qstash.schedules.list();
      console.log(`   ✅ Authenticated with QStash successfully! (Active schedules: ${schedules.length})`);
      console.log('   🎉 Upstash QStash is ONLINE and ready to queue messages!\n');
    } catch (err: any) {
      console.error('   ❌ QStash connection failed:', err.message || err);
    }
  }
}

testLiveUpstash().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

