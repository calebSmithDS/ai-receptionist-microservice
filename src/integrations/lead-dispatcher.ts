import { ExtractedLead } from '../agent/gemini-receptionist.agent.js';
import { TenantContext } from '../core/types/tenant.js';

export interface LeadDispatchResult {
  success: boolean;
  message?: string;
  error?: string;
}

export class LeadDispatcher {
  /**
   * Dispatches a qualified AI lead directly to the tenant's Astro SSR website
   * endpoint: POST https://<tenant.customDomain>/api/submit-lead
   */
  async dispatchToWaaS(
    tenant: TenantContext,
    callerPhone: string,
    lead: ExtractedLead,
    transcript?: Array<{ role: 'user' | 'model'; text: string }>
  ): Promise<LeadDispatchResult> {
    if (!tenant.customDomain) {
      console.log(`[LeadDispatcher] Tenant ${tenant.businessName} has no customDomain; logged locally.`);
      return { success: true, message: 'Logged locally (no custom domain)' };
    }

    const endpoint = `https://${tenant.customDomain}/api/submit-lead`;

    // 1. Build the formatted details text (including urgency & conversation transcript)
    const transcriptText = transcript && transcript.length > 0
      ? '\n\n--- SMS Conversation Transcript ---\n' +
        transcript.map(t => `${t.role === 'user' ? 'Customer' : 'AI'}: ${t.text}`).join('\n')
      : '';

    const fullDetails = `[AI SMS Receptionist Lead]
Urgency: ${lead.urgency}
Location: ${lead.suburb} (In Service Area: ${lead.isWithinServiceArea ? 'Yes' : 'No'})
Issue: ${lead.jobDescription}
${transcriptText}`;

    // 2. Prepare FormData to match Astro's request.formData() parser
    const formData = new FormData();
    formData.append('name', lead.customerName);
    formData.append('phone', callerPhone);
    // Provide email fallback so Astro's (!name || !phone || !email) check passes
    const cleanPhone = callerPhone.replace(/[^\d]/g, '');
    formData.append('email', `${cleanPhone}@sms.customer.lead`);
    formData.append('service', lead.jobDescription.slice(0, 50));
    formData.append('details', fullDetails);
    // Leave honeypot empty to pass Astro's honeypot check
    formData.append('company_homepage', '');

    try {
      console.log(`[LeadDispatcher] Sending lead to Astro endpoint: ${endpoint}`);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'User-Agent': 'AI-Receptionist-Microservice/1.0',
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[LeadDispatcher] Dispatch failed with HTTP ${response.status}:`, errorText);
        return { success: false, error: `HTTP ${response.status}: ${errorText}` };
      }

      const result = await response.json();
      console.log(`[LeadDispatcher] Successfully delivered lead to ${tenant.customDomain}:`, result);
      return { success: true, message: 'Lead delivered to Astro website' };
    } catch (err: any) {
      console.error('[LeadDispatcher] Network error contacting Astro endpoint:', err);
      return { success: false, error: err.message };
    }
  }
}
