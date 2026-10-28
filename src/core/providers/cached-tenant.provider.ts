import { Redis } from '@upstash/redis';
import { ITenantProvider, TenantContext } from '../types/tenant.js';

export interface CachedTenantProviderOptions {
  underlyingProvider: ITenantProvider;
  redis?: Redis | null;
  ttlSeconds?: number;
}

export class CachedTenantProvider implements ITenantProvider {
  private underlying: ITenantProvider;
  private redis: Redis | null;
  private memoryCache = new Map<string, { tenant: TenantContext; expiresAt: number }>();
  private readonly ttlSeconds: number;

  constructor(options: CachedTenantProviderOptions) {
    this.underlying = options.underlyingProvider;
    this.redis = options.redis || null;
    this.ttlSeconds = options.ttlSeconds || 3600; // 1 hour default TTL
  }

  private normalizePhone(phone: string): string {
    return phone.replace(/[^\d+]/g, '').trim();
  }

  private getCacheKey(phone: string): string {
    return `tenant:config:${this.normalizePhone(phone)}`;
  }

  async getTenantByPhoneNumber(phoneNumber: string): Promise<TenantContext | null> {
    const cacheKey = this.getCacheKey(phoneNumber);

    // 1. Try to read from Upstash Redis (or in-memory cache in dev)
    if (this.redis) {
      try {
        const cached = await this.redis.get<TenantContext>(cacheKey);
        if (cached) {
          return cached;
        }
      } catch (err) {
        console.warn(`[CachedTenantProvider] Redis read failed for ${cacheKey}, falling back to source:`, err);
      }
    } else {
      const memoryItem = this.memoryCache.get(cacheKey);
      if (memoryItem && memoryItem.expiresAt > Date.now()) {
        return memoryItem.tenant;
      }
    }

    // 2. Fetch from source of truth (Sanity CMS)
    const tenant = await this.underlying.getTenantByPhoneNumber(phoneNumber);
    if (!tenant) {
      return null;
    }

    // 3. Cache the resolved tenant in Upstash Redis
    if (this.redis) {
      try {
        await this.redis.set(cacheKey, tenant, { ex: this.ttlSeconds });
      } catch (err) {
        console.warn(`[CachedTenantProvider] Redis write failed for ${cacheKey}:`, err);
      }
    } else {
      this.memoryCache.set(cacheKey, {
        tenant,
        expiresAt: Date.now() + this.ttlSeconds * 1000,
      });
    }

    return tenant;
  }
}

