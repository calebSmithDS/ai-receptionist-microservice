import { ExtractedLead, LeadSubmissionResponse } from '../core/types/lead.js';
import { env } from '../config/env.js';

export class LeadDispatcher {
  /**
   * Dispatches the captured lead to the parent Astro SSR website endpoint:
   * POST https://<tenant-custom-domain>/api/submit-lead
   */
  async dispatchLead(targetDomain: string | undefined, lead: ExtractedLead): Promise<LeadSubmissionResponse> {
    if (!targetDomain) {
      console.log('[LeadDispatcher] No custom domain specified. Lead captured locally:', lead);
      return { success: true, leadId: 'local-' + Date.now() };
    }

    const endpoint = `https://${targetDomain}/api/submit-lead`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-waas-signature': env.LEAD_WEBHOOK_SECRET || '',
        },
        body: JSON.stringify({
          source: 'AI_RECEPTIONIST_SMS',
          tenantId: lead.tenantId,
          callerPhone: lead.callerPhone,
          customerName: lead.customerName,
          serviceRequested: lead.serviceRequested,
          location: lead.location,
          urgency: lead.urgency,
          jobDescription: lead.jobDescription,
          transcript: lead.transcript,
          isWithinServiceArea: lead.isWithinServiceArea,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[LeadDispatcher] Lead dispatch failed (${response.status}):`, errorText);
        return { success: false, error: `HTTP ${response.status}: ${errorText}` };
      }

      const result = (await response.json()) as any;
      console.log(`[LeadDispatcher] Lead successfully sent to ${targetDomain}`);
      return { success: true, leadId: result.id || 'dispatched' };
    } catch (err: any) {
      console.error('[LeadDispatcher] Network exception during lead dispatch:', err);
      return { success: false, error: err.message };
    }
  }
}
