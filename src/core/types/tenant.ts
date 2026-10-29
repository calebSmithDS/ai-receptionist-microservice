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
  tradeType?: string; // e.g. 'plumber', 'electrician', 'locksmith', 'builder'
  publicPhone: string;
  twilioForwardingNumber: string;
  serviceArea: string;
  businessHours?: string;
  aiCustomInstructions?: string;
  emergencyTriageAdvice?: string; // e.g. "Advise customer to turn off mains water meter" or "Turn off main safety switch"
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

