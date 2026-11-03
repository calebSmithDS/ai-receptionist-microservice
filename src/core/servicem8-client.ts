import { CollectedJobDetails } from '../contracts/session-state.contract.js';
import { env } from '../config/env.js';

export interface ServiceM8JobPayload {
  job_description: string;
  job_address: string;
  contact_name: string;
  contact_phone: string;
  urgency_note: string;
  source: 'tradie_ai_receptionist';
}

/**
 * ServiceM8RestClient
 *
 * Pushes a qualified lead to the ServiceM8 inbox via their REST API.
 * ServiceM8 uses Basic Auth (UUID:password or UUID:API key).
 *
 * We POST to /api/job.json to create a new job in the inbox (unscheduled).
 * This is intentionally NOT a calendar booking — the tradie reviews and
 * schedules manually so they retain full control over their diary.
 *
 * In development (no SERVICEM8_EMAIL set), the client logs the payload
 * and simulates a successful dispatch.
 */
export class ServiceM8RestClient {
  private readonly baseUrl = 'https://api.servicem8.com/api_1.0';
  private readonly authHeader: string | null;

  constructor() {
    const email = env.SERVICEM8_EMAIL;
    const apiKey = env.SERVICEM8_API_KEY;

    if (email && apiKey) {
      const credentials = Buffer.from(`${email}:${apiKey}`).toString('base64');
      this.authHeader = `Basic ${credentials}`;
    } else {
      this.authHeader = null;
    }
  }

  async dispatchLead(params: {
    lead: CollectedJobDetails;
    callerPhone: string;
    businessName: string;
  }): Promise<{ success: boolean; jobUuid?: string; error?: string }> {
    const { lead, callerPhone, businessName } = params;

    const jobDescription = [
      `[AI Receptionist Lead — ${businessName}]`,
      `Issue: ${lead.issue || 'Not specified'}`,
      `Urgency: ${lead.urgency || 'Not specified'}`,
      `Customer Phone: ${callerPhone}`,
    ].join('\n');

    const payload: Record<string, string> = {
      job_description: jobDescription,
      job_address: lead.suburb || '',
      status: 'Inbox',
      // ServiceM8 uses a flat structure; contact is attached via a separate
      // contact upsert in production. For now we embed in description.
    };

    // ── Simulation mode (no credentials) ─────────────────────────────────────
    if (!this.authHeader) {
      console.log('[ServiceM8Client] ⚠️  No credentials — simulating dispatch:');
      console.log(JSON.stringify({ ...payload, callerPhone, customerName: lead.customerName }, null, 2));
      return { success: true, jobUuid: `sim_${Date.now()}` };
    }

    // ── Live POST to ServiceM8 REST API ───────────────────────────────────────
    try {
      const response = await fetch(`${this.baseUrl}/job.json`, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[ServiceM8Client] API error ${response.status}: ${errorText}`);
        return { success: false, error: `HTTP ${response.status}: ${errorText}` };
      }

      // ServiceM8 returns the new job UUID in the x-record-uuid header
      const jobUuid = response.headers.get('x-record-uuid') ?? undefined;
      console.log(`[ServiceM8Client] ✅ Job created in inbox. UUID: ${jobUuid}`);
      return { success: true, jobUuid };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ServiceM8Client] Network error: ${message}`);
      return { success: false, error: message };
    }
  }
}

