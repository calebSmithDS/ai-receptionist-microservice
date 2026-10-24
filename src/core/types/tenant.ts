export interface TenantService {
  title: string;
  shortDescription?: string;
  startingPrice?: string | number;
}

/**
 * The standardized data structure representing any business tenant,
 * regardless of whether they were stored in Sanity, Postgres, or an external API.
 */
export interface TenantContext {
  tenantId: string;
  businessName: string;
  publicPhone: string;
  twilioForwardingNumber: string;
  serviceArea: string;
  businessHours?: string;
  aiCustomInstructions?: string;
  services: TenantService[];
  customDomain?: string; // Optional domain for Astro WaaS webhook dispatch
}

/**
 * Contract that every Tenant Provider must satisfy.
 */
export interface ITenantProvider {
  /**
   * Resolves tenant metadata using the virtual phone number dialed/texted.
   */
  getTenantByPhoneNumber(phoneNumber: string): Promise<TenantContext | null>;
}

