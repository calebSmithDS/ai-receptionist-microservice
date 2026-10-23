export interface TenantService {
  title: string;
  shortDescription?: string;
  startingPrice?: string | number;
}

export interface TenantContext {
  tenantId: string;
  businessName: string;
  publicPhone: string;
  twilioForwardingNumber: string;
  serviceArea: string;
  businessHours?: string;
  aiCustomInstructions?: string;
  services: TenantService[];
  customDomain?: string; // Optional domain for parent WaaS webhook dispatch
}

export interface ITenantProvider {
  /**
   * Resolves tenant metadata using the inbound/assigned virtual phone number.
   * Standardizes across E.164 formats (e.g. +614..., 04...).
   */
  getTenantByPhoneNumber(phoneNumber: string): Promise<TenantContext | null>;
}
