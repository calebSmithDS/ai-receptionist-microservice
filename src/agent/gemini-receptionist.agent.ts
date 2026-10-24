import { GoogleGenAI, type FunctionDeclaration, Type } from '@google/genai';
import { env } from '../config/env.js';
import { TenantContext } from '../core/types/tenant.js';

export type LeadUrgency = 'LOW' | 'MEDIUM' | 'HIGH' | 'EMERGENCY';

export interface ExtractedLead {
  customerName: string;
  suburb: string;
  jobDescription: string;
  urgency: LeadUrgency;
  isWithinServiceArea: boolean;
}

export interface ConversationTurn {
  role: 'user' | 'model';
  text: string;
  timestamp: string;
}

export interface AgentSession {
  turns: ConversationTurn[];
  isCompleted: boolean;
  extractedLead?: ExtractedLead;
}

export class GeminiReceptionistAgent {
  private ai?: GoogleGenAI;
  // In-memory conversation session store: `${tenantId}:${fromPhone}` -> AgentSession
  private sessions = new Map<string, AgentSession>();

  // Guardrails
  private readonly MAX_TURNS = 6;
  private readonly MAX_INPUT_CHARS = 500;

  constructor() {
    if (env.GEMINI_API_KEY) {
      this.ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    }
  }

  private getSessionKey(tenantId: string, phone: string): string {
    return `${tenantId}:${phone}`;
  }

  getSession(tenantId: string, phone: string): AgentSession {
    const key = this.getSessionKey(tenantId, phone);
    let session = this.sessions.get(key);
    if (!session) {
      session = { turns: [], isCompleted: false };
      this.sessions.set(key, session);
    }
    return session;
  }

  /**
   * System instruction with strict grounding and anti-hallucination boundaries
   */
  private buildSystemInstruction(tenant: TenantContext): string {
    const servicesList = tenant.services && tenant.services.length > 0
      ? tenant.services.map(s => `- ${s.title}: starting from ${s.startingPrice || 'standard call-out fee'} (${s.shortDescription || ''})`).join('\n')
      : 'General trade services.';

    return `You are the SMS receptionist for "${tenant.businessName}".
Your tone is friendly, professional, concise, and helpful (Australian trades tone).
Keep all responses under 2-3 short sentences. Remember, this is SMS text messaging!

BUSINESS DETAILS:
- Business Name: ${tenant.businessName}
- Service Area: ${tenant.serviceArea}
- Business Hours & Rates: ${tenant.businessHours || 'Standard daytime rates. Emergency call-out fee applies after hours.'}
- Services Offered:
${servicesList}

CUSTOM INSTRUCTIONS FROM OWNER:
${tenant.aiCustomInstructions || 'Be helpful and gather their details.'}

CRITICAL RULES & HALLUCINATION SAFEGUARDS:
1. ONLY reference services listed above. If a customer asks for a service not listed, say: "We don't specialize in that, but we can recommend looking for a specialist."
2. NEVER guess, estimate, or quote fixed repair prices over SMS. Always explain that the tradesperson provides an upfront, exact quote on-site once inspected.
3. Check if the customer's suburb falls inside "${tenant.serviceArea}". If outside, politely inform them we cannot travel there.
4. Your goal is to gather: (1) Customer name, (2) Suburb/address, (3) Brief description of the issue.
5. As soon as the customer provides their name, suburb, and issue (or if they confirm an active emergency), call the "complete_lead_capture" tool immediately!
6. Never agree to exact arrival times. State that the technician will call to confirm their arrival window.`;
  }

  /**
   * The tool declaration allowing Gemini to extract structured lead data
   */
  private getLeadCaptureTool(): FunctionDeclaration {
    return {
      name: 'complete_lead_capture',
      description: 'Call this when you have captured the customer name, suburb/location, issue details, and urgency level.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          customerName: { type: Type.STRING, description: 'Full name or first name of the customer' },
          suburb: { type: Type.STRING, description: 'Suburb or location given by the customer' },
          jobDescription: { type: Type.STRING, description: 'Summary of the job or problem described' },
          urgency: {
            type: Type.STRING,
            enum: ['LOW', 'MEDIUM', 'HIGH', 'EMERGENCY'],
            description: 'Urgency rating of the customer request',
          },
          isWithinServiceArea: {
            type: Type.BOOLEAN,
            description: 'Whether the suburb falls inside the tenant service area',
          },
        },
        required: ['customerName', 'suburb', 'jobDescription', 'urgency', 'isWithinServiceArea'],
      },
    };
  }

  /**
   * Processes an incoming customer SMS and returns the AI reply and any captured lead
   */
  async processMessage(
    tenant: TenantContext,
    fromPhone: string,
    rawText: string
  ): Promise<{ replyText: string; completedLead?: ExtractedLead }> {
    const session = this.getSession(tenant.tenantId, fromPhone);
    const cleanText = rawText.slice(0, this.MAX_INPUT_CHARS).trim();

    // Record customer message in session
    session.turns.push({
      role: 'user',
      text: cleanText,
      timestamp: new Date().toISOString(),
    });

    // Guardrail: Max turn limit reached
    if (session.turns.length > this.MAX_TURNS * 2 || session.isCompleted) {
      session.isCompleted = true;
      const closing = `Thanks! I've forwarded all your messages directly to our on-call team. They will call you shortly.`;
      return { replyText: closing };
    }

    // Fallback if GEMINI_API_KEY is not configured
    if (!this.ai) {
      const fallback = `Thanks for contacting ${tenant.businessName}! We've received your message and our team will get back to you shortly.`;
      return { replyText: fallback };
    }

    try {
      // Build conversation contents for Gemini
      const contents = session.turns.map(turn => ({
        role: turn.role,
        parts: [{ text: turn.text }],
      }));

      const response = await this.ai.models.generateContent({
        model: env.GEMINI_MODEL,
        contents,
        config: {
          systemInstruction: this.buildSystemInstruction(tenant),
          temperature: 0.1, // Low temperature for high factual accuracy
          maxOutputTokens: 800, // Sufficient budget for tool calls and SMS replies
          tools: [{ functionDeclarations: [this.getLeadCaptureTool()] }],
        },
      });

      let replyText = response.text || '';
      let completedLead: ExtractedLead | undefined;

      // Check if Gemini invoked our complete_lead_capture tool
      const functionCalls = response.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        if (call.name === 'complete_lead_capture') {
          const args = call.args as any;
          session.isCompleted = true;
          session.extractedLead = args;
          completedLead = args;

          if (!replyText) {
            replyText = `Thanks ${args.customerName}! I've logged your request and alerted our on-call technician. They will call you shortly to confirm timing.`;
          }
        }
      }

      // Record model response in session
      session.turns.push({
        role: 'model',
        text: replyText,
        timestamp: new Date().toISOString(),
      });

      return { replyText, completedLead };
    } catch (error) {
      console.error('[GeminiReceptionistAgent] Generation error:', error);
      const errReply = `Thanks for reaching out! We've logged your message and our technician will be in touch shortly.`;
      return { replyText: errReply };
    }
  }
}

