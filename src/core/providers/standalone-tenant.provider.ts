import { ITenantProvider, TenantContext } from '../types/tenant.js';

export interface DatabaseAdapter {
  findTenantByPhone(phone: string): Promise<TenantContext | null>;
}

/**
 * Standalone Tenant Provider for external SaaS clients not using Sanity CMS.
 * Can be connected to PostgreSQL, Supabase, Prisma, or DynamoDB.
 */
export class StandaloneTenantProvider implements ITenantProvider {
  constructor(private dbAdapter?: DatabaseAdapter) {}

  async getTenantByPhoneNumber(phoneNumber: string): Promise<TenantContext | null> {
    if (!this.dbAdapter) {
      console.warn('[StandaloneTenantProvider] No DB adapter configured.');
      return null;
    }
    return this.dbAdapter.findTenantByPhone(phoneNumber);
  }
}
