import { Redis } from '@upstash/redis';

export interface TenantConfig {
  businessId: string;
  companyName: string;
  twilioNumber: string;
  serviceM8Enabled?: boolean;
}

/**
 * TenantResolverService
 *
 * ARCHITECTURAL WHY: Read-Through Cache Pattern (Cache-Aside)
 * Every incoming SMS arrives via a dialed Twilio Number (`To`). Resolving the business tenant
 * configuration must happen in < 50ms before QStash queueing.
 *
 * Direct Sanity CMS queries take 150-400ms and have rate limits.
 * We cache tenant mapping in Upstash Redis with a TTL (e.g. 1 hour).
 */
export class TenantResolverService {
  private redis: Redis | null = null;
  private readonly CACHE_TTL_SECONDS = 3600; // 1 Hour TTL

  constructor() {
    // Gracefully initialize Redis if credentials exist in environment
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      this.redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
    }
  }

  /**
   * Resolves tenant configuration given the destination Twilio phone number.
   *
   * @param twilioNumber - The recipient phone number formatted in E.164 (e.g. +61480000000)
   */
  async resolveTenantByTwilioNumber(twilioNumber: string): Promise<TenantConfig | null> {
    const cacheKey = `tenant:phone:${twilioNumber}`;

    // 1. Try Cache First (L1 / Upstash Redis)
    if (this.redis) {
      try {
        const cached = await this.redis.get<TenantConfig>(cacheKey);
        if (cached) {
          return cached;
        }
      } catch (cacheErr) {
        // Cache failures must never bring down our ingress pipeline (fail-open)
        console.warn(`[TenantResolver] Redis cache read failed for ${twilioNumber}:`, cacheErr);
      }
    }

    // 2. Cache Miss: Fetch from Origin (Sanity CMS)
    // NOTE: In production, this runs a GROQ query against your Sanity client:
    // `*[_type == "tradieClient" && twilioNumber == $twilioNumber][0]{ businessId, companyName }`
    const tenantFromSanity = await this.fetchMockSanityDocument(twilioNumber);

    if (!tenantFromSanity) {
      return null;
    }

    // 3. Populate Cache on Read-Miss (Fire-and-forget or awaited)
    if (this.redis) {
      try {
        await this.redis.set(cacheKey, tenantFromSanity, { ex: this.CACHE_TTL_SECONDS });
      } catch (cacheSetErr) {
        console.warn(`[TenantResolver] Redis cache write failed for ${twilioNumber}:`, cacheSetErr);
      }
    }

    return tenantFromSanity;
  }

  /**
   * Mocked Sanity Origin fetcher simulating upstream CMS latency and document structure.
   */
  private async fetchMockSanityDocument(twilioNumber: string): Promise<TenantConfig | null> {
    // Simulate ~30ms network round-trip to Sanity API CDN
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Provide default fallback mapping for development/testing
    return {
      businessId: `tenant_${twilioNumber.replace(/\D/g, '').slice(-4) || 'default'}`,
      companyName: 'Apex Plumbing & Electrical',
      twilioNumber,
      serviceM8Enabled: true,
    };
  }
}

