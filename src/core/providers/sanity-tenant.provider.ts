import { createClient, type SanityClient } from '@sanity/client';
import { ITenantProvider, TenantContext } from '../types/tenant.js';

export interface SanityProviderConfig {
  projectId: string;
  dataset: string;
  apiVersion?: string;
  token?: string;
  useCdn?: boolean;
}

export class SanityTenantProvider implements ITenantProvider {
  private client: SanityClient;
  // In-memory cache: phone -> { data, expiresAt }
  private cache = new Map<string, { data: TenantContext; expiresAt: number }>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(config: SanityProviderConfig) {
    this.client = createClient({
      projectId: config.projectId,
      dataset: config.dataset,
      apiVersion: config.apiVersion || '2024-01-01',
      token: config.token,
      useCdn: config.useCdn ?? true,
    });
  }

  /**
   * Normalizes a phone number to digits and leading plus.
   * e.g. "0412 345 678" -> "0412345678", "+61 412-345-678" -> "+61412345678"
   */
  private normalizePhone(phone: string): string {
    return phone.replace(/[^\d+]/g, '').trim();
  }

  /**
   * Generates both domestic (04...) and international (+61...) variations
   * of an Australian phone number to ensure a hit in Sanity.
   */
  private getPhoneVariations(phone: string): { primary: string; alternate: string } {
    const clean = this.normalizePhone(phone);
    if (clean.startsWith('+61')) {
      return { primary: clean, alternate: '0' + clean.slice(3) };
    }
    if (clean.startsWith('0')) {
      return { primary: clean, alternate: '+61' + clean.slice(1) };
    }
    return { primary: clean, alternate: clean };
  }

  async getTenantByPhoneNumber(phoneNumber: string): Promise<TenantContext | null> {
    const { primary, alternate } = this.getPhoneVariations(phoneNumber);

    // 1. Check in-memory cache
    const cached = this.cache.get(primary) || this.cache.get(alternate);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    // 2. GROQ Query against Sanity
    // Matches twilioForwardingNumber against primary or alternate format
    const query = `*[_type == "tenant" && (twilioForwardingNumber == $primary || twilioForwardingNumber == $alternate)][0]{
      tenantId,
      businessName,
      ownerFirstName,
      tradeType,
      publicPhone,
      twilioForwardingNumber,
      serviceArea,
      businessHours,
      aiCustomInstructions,
      emergencyTriageAdvice,
      excludedServices,
      customDomain,
      "services": *[_type == "service" && references(^._id)]{
        title,
        shortDescription,
        startingPrice
      }
    }`;

    try {
      const tenant = await this.client.fetch<TenantContext | null>(query, {
        primary,
        alternate,
      });

      if (tenant) {
        // Cache under both variations
        const expiresAt = Date.now() + this.CACHE_TTL_MS;
        this.cache.set(primary, { data: tenant, expiresAt });
        this.cache.set(alternate, { data: tenant, expiresAt });
      }

      return tenant;
    } catch (error) {
      console.error('[SanityTenantProvider] Error querying tenant by phone:', error);
      return null;
    }
  }
}

