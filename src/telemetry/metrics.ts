export interface TenantMetrics {
  callsReceived: number;
  callsMissed: number;
  smsReceived: number;
  smsRepliesSent: number;
  leadsCaptured: number;
  leadsByUrgency: {
    LOW: number;
    MEDIUM: number;
    HIGH: number;
    EMERGENCY: number;
  };
}

export interface TelemetrySnapshot {
  uptimeSeconds: number;
  global: {
    totalCallsReceived: number;
    totalCallsMissed: number;
    totalSmsReceived: number;
    totalSmsRepliesSent: number;
    totalLeadsCaptured: number;
    totalFallbacksTriggered: number;
  };
  tenants: Record<string, TenantMetrics>;
}

class TelemetryService {
  private startTime = Date.now();
  private global = {
    totalCallsReceived: 0,
    totalCallsMissed: 0,
    totalSmsReceived: 0,
    totalSmsRepliesSent: 0,
    totalLeadsCaptured: 0,
    totalFallbacksTriggered: 0,
  };

  // Per-tenant metrics store: tenantId -> TenantMetrics
  private tenantMetrics = new Map<string, TenantMetrics>();

  private getOrCreateTenant(tenantId: string): TenantMetrics {
    let m = this.tenantMetrics.get(tenantId);
    if (!m) {
      m = {
        callsReceived: 0,
        callsMissed: 0,
        smsReceived: 0,
        smsRepliesSent: 0,
        leadsCaptured: 0,
        leadsByUrgency: { LOW: 0, MEDIUM: 0, HIGH: 0, EMERGENCY: 0 },
      };
      this.tenantMetrics.set(tenantId, m);
    }
    return m;
  }

  recordCallReceived(tenantId?: string) {
    this.global.totalCallsReceived += 1;
    if (tenantId) {
      this.getOrCreateTenant(tenantId).callsReceived += 1;
    }
  }

  recordCallMissed(tenantId?: string) {
    this.global.totalCallsMissed += 1;
    if (tenantId) {
      this.getOrCreateTenant(tenantId).callsMissed += 1;
    }
  }

  recordSmsReceived(tenantId?: string) {
    this.global.totalSmsReceived += 1;
    if (tenantId) {
      this.getOrCreateTenant(tenantId).smsReceived += 1;
    }
  }

  recordSmsReplySent(tenantId?: string) {
    this.global.totalSmsRepliesSent += 1;
    if (tenantId) {
      this.getOrCreateTenant(tenantId).smsRepliesSent += 1;
    }
  }

  recordLeadCaptured(tenantId: string, urgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'EMERGENCY') {
    this.global.totalLeadsCaptured += 1;
    const t = this.getOrCreateTenant(tenantId);
    t.leadsCaptured += 1;
    t.leadsByUrgency[urgency] += 1;
  }

  recordFallbackTriggered() {
    this.global.totalFallbacksTriggered += 1;
  }

  getTenantMetrics(tenantId: string): TenantMetrics | null {
    return this.tenantMetrics.get(tenantId) || null;
  }

  getSnapshot(): TelemetrySnapshot {
    const tenantsObj: Record<string, TenantMetrics> = {};
    for (const [id, m] of this.tenantMetrics.entries()) {
      tenantsObj[id] = m;
    }

    return {
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      global: this.global,
      tenants: tenantsObj,
    };
  }
}

export const telemetry = new TelemetryService();
