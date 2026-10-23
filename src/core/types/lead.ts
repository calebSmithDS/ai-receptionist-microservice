export type LeadUrgency = 'LOW' | 'MEDIUM' | 'HIGH' | 'EMERGENCY';

export interface ExtractedLead {
  tenantId: string;
  callerPhone: string;
  customerName?: string;
  serviceRequested?: string;
  location?: string;
  urgency: LeadUrgency;
  jobDescription?: string;
  transcript: Array<{ role: 'customer' | 'assistant'; text: string; timestamp: string }>;
  isWithinServiceArea: boolean;
}

export interface LeadSubmissionResponse {
  success: boolean;
  leadId?: string;
  error?: string;
}
