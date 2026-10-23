import { createClient, SanityClient } from '@sanity/client';
import { env } from '../../config/env.js';
import { ITenantProvider, TenantContext } from '../types/tenant.js';

export class SanityTenantProvider implements ITenantProvider {
  private client: SanityClient;
  private cache: Map<string, { data: TenantContext; expiresAt: number }> = new Map();
  private cacheTTLMs = 5 * 60 * 1000; // 5 minute cache

  constructor() {
    this.client = createClient({
      projectId: env.SANITY_PROJECT_ID,
      dataset: env.SANITY_DATASET,
      apiVersion: env.SANITY_API_VERSION,
      token: env.SANITY_API_TOKEN,
      useCdn: true,
    });
  }

  private normalizeNumber(phone: string): string {
    return phone.replace(/[^\d+]/g, '').trim();
  }

  async getTenantByPhoneNumber(phoneNumber: string): Promise<TenantContext | null> {
    const normalized = this.normalizeNumber(phoneNumber);

    const cached = this.cache.get(normalized);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    // Query Sanity tenant document matching twilioForwardingNumber
    // Also dereference services or fetch associated service docs
    const query = `*[_type == "tenant" && (twilioForwardingNumber == $phone || twilioForwardingNumber == $altPhone)][0]{
      tenantId,
      businessName,
      publicPhone,
      twilioForwardingNumber,
      serviceArea,
      businessHours,
      aiCustomInstructions,
      customDomain,
      "services": *[_type == "service" && references(^._id)]{
        title,
        shortDescription,
        startingPrice
      }
    }`;

    // Test both international and domestic prefixes
    const altPhone = normalized.startsWith('+61')
      ? '0' + normalized.slice(3)
      : normalized.startsWith('0')
      ? '+61' + normalized.slice(1)
      : normalized;

    try {
      const result = await this.client.fetch<TenantContext | null>(query, {
        phone: normalized,
        altPhone,
      });

      if (result) {
        this.cache.set(normalized, {
          data: result,
          expiresAt: Date.now() + this.cacheTTLMs,
        });
      }

      return result;
    } catch (error) {
      console.error('[SanityTenantProvider] Error querying tenant by phone:', error);
      return null;
    }
  }
}
