export interface TelemetryMetrics {
  uptimeSeconds: number;
  totalCallsReceived: number;
  totalCallsMissed: number;
  totalSmsReceived: number;
  totalSmsRepliesSent: number;
  totalLeadsCaptured: number;
  totalFallbacksTriggered: number;
  leadsByUrgency: {
    LOW: number;
    MEDIUM: number;
    HIGH: number;
    EMERGENCY: number;
  };
}

class TelemetryService {
  private startTime = Date.now();
  private metrics = {
    totalCallsReceived: 0,
    totalCallsMissed: 0,
    totalSmsReceived: 0,
    totalSmsRepliesSent: 0,
    totalLeadsCaptured: 0,
    totalFallbacksTriggered: 0,
    leadsByUrgency: {
      LOW: 0,
      MEDIUM: 0,
      HIGH: 0,
      EMERGENCY: 0,
    },
  };

  recordCallReceived() {
    this.metrics.totalCallsReceived += 1;
  }

  recordCallMissed() {
    this.metrics.totalCallsMissed += 1;
  }

  recordSmsReceived() {
    this.metrics.totalSmsReceived += 1;
  }

  recordSmsReplySent() {
    this.metrics.totalSmsRepliesSent += 1;
  }

  recordLeadCaptured(urgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'EMERGENCY') {
    this.metrics.totalLeadsCaptured += 1;
    this.metrics.leadsByUrgency[urgency] += 1;
  }

  recordFallbackTriggered() {
    this.metrics.totalFallbacksTriggered += 1;
  }

  getSnapshot(): TelemetryMetrics {
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      ...this.metrics,
    };
  }
}

export const telemetry = new TelemetryService();

