import OpenAI from 'openai';
import { env } from '../config/env.js';
import { TenantContext } from '../core/types/tenant.js';
import { ExtractedLead, LeadUrgency } from '../core/types/lead.js';

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface ConversationState {
  tenantId: string;
  callerPhone: string;
  turnCount: number;
  isCompleted: boolean;
  messages: Array<{ role: 'customer' | 'assistant'; text: string; timestamp: string }>;
  extractedData?: {
    customerName?: string;
    suburb?: string;
    jobDescription?: string;
    urgency?: LeadUrgency;
  };
}

export class ReceptionistEngine {
  private openai?: OpenAI;
  // In-memory conversation state store (keyed by `${tenantId}:${callerPhone}`)
  // Can easily be swapped with Upstash Redis
  private sessions: Map<string, ConversationState> = new Map();

  // Safety limits to prevent token abuse and infinite script loops
  private readonly MAX_TURNS = 6;
  private readonly MAX_INPUT_CHARS = 500;

  constructor() {
    if (env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    }
  }

  private getSessionKey(tenantId: string, callerPhone: string): string {
    return `${tenantId}:${callerPhone}`;
  }

  getSession(tenantId: string, callerPhone: string): ConversationState {
    const key = this.getSessionKey(tenantId, callerPhone);
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        tenantId,
        callerPhone,
        turnCount: 0,
        isCompleted: false,
        messages: [],
      };
      this.sessions.set(key, session);
    }
    return session;
  }

  /**
   * Generates the initial text-back message when a missed call occurs.
   */
  generateInitialMissedCallMessage(tenant: TenantContext): string {
    return `Hi, thanks for calling ${tenant.businessName}! Sorry we missed your call, we're currently on a job. How can we help you today? Feel free to reply here.`;
  }

  /**
   * Constructs strict, hallucination-resistant system instructions
   */
  private buildSystemPrompt(tenant: TenantContext): string {
    const servicesList = tenant.services && tenant.services.length > 0
      ? tenant.services.map(s => `- ${s.title}: starting from ${s.startingPrice || 'standard fee'} (${s.shortDescription || ''})`).join('\n')
      : 'General trade services.';

    return `You are the SMS receptionist for "${tenant.businessName}".
Your tone is friendly, professional, concise, and helpful (Australian trades tone).
Keep all responses under 2-3 short sentences. Remember, this is SMS!

BUSINESS DETAILS:
- Business Name: ${tenant.businessName}
- Service Area: ${tenant.serviceArea}
- Business Hours & Rates: ${tenant.businessHours || 'Standard daytime rates. Emergency call-out fee applies after hours.'}
- Services Offered:
${servicesList}

CUSTOM INSTRUCTIONS FROM OWNER:
${tenant.aiCustomInstructions || 'Be helpful and get their details.'}

CRITICAL RULES & HALLUCINATION SAFEGUARDS:
1. NEVER guess or invent prices beyond the baseline call-out or stated starting fees. Always explain that the tradesperson provides an upfront, exact quote on-site.
2. Verify if the customer's suburb/location is inside "${tenant.serviceArea}". If outside, politely let them know we cannot travel there.
3. Your primary goal is to gather: (1) Customer name, (2) Suburb/address, (3) Brief description of the issue.
4. As soon as you have gathered their name, suburb, and issue (or if they confirm it's an emergency), call the "complete_lead_capture" tool immediately!
5. Never agree to exact arrival times. State that the technician will call to confirm their arrival window.`;
  }

  /**
   * Processes an incoming customer SMS and returns the bot's reply and any completed lead.
   */
  async handleIncomingSms(
    tenant: TenantContext,
    callerPhone: string,
    rawText: string
  ): Promise<{ reply: string; completedLead?: ExtractedLead }> {
    const session = this.getSession(tenant.tenantId, callerPhone);

    // Safeguard 1: Input truncation
    const cleanText = rawText.slice(0, this.MAX_INPUT_CHARS).trim();

    // Append to transcript
    session.messages.push({
      role: 'customer',
      text: cleanText,
      timestamp: new Date().toISOString(),
    });
    session.turnCount += 1;

    // Safeguard 2: Max turn limit reached
    if (session.turnCount >= this.MAX_TURNS || session.isCompleted) {
      session.isCompleted = true;
      const closingMsg = `Thanks! I've forwarded all your details directly to our team. Someone will be in touch shortly.`;
      session.messages.push({
        role: 'assistant',
        text: closingMsg,
        timestamp: new Date().toISOString(),
      });
      return { reply: closingMsg };
    }

    if (!this.openai) {
      // Fallback if OpenAI key is not configured
      const fallbackMsg = `Thanks for reaching out to ${tenant.businessName}! We have logged your request and our team will get back to you shortly.`;
      return { reply: fallbackMsg };
    }

    // Build chat history for OpenAI
    const openAiMessages: Message[] = [
      { role: 'system', content: this.buildSystemPrompt(tenant) },
    ];

    for (const msg of session.messages) {
      openAiMessages.push({
        role: msg.role === 'customer' ? 'user' : 'assistant',
        content: msg.text,
      });
    }

    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'complete_lead_capture',
          description: 'Call this when you have captured the customer name, suburb/location, issue details, and urgency level.',
          parameters: {
            type: 'object',
            properties: {
              customerName: { type: 'string', description: 'Name of the customer' },
              suburb: { type: 'string', description: 'Suburb or location given' },
              jobDescription: { type: 'string', description: 'Summary of the work needed' },
              urgency: {
                type: 'string',
                enum: ['LOW', 'MEDIUM', 'HIGH', 'EMERGENCY'],
                description: 'Urgency of the job',
              },
              isWithinServiceArea: {
                type: 'boolean',
                description: 'Whether the suburb falls inside the tenant service area',
              },
            },
            required: ['customerName', 'suburb', 'jobDescription', 'urgency', 'isWithinServiceArea'],
          },
        },
      },
    ];

    try {
      const response = await this.openai.chat.completions.create({
        model: env.OPENAI_MODEL,
        messages: openAiMessages as any,
        tools,
        tool_choice: 'auto',
        temperature: 0.2, // Low temperature for deterministic behavior
        max_tokens: 150,  // Keep SMS responses concise
      });

      const choice = response.choices[0];
      const message = choice.message;
      let replyText = message.content || '';
      let completedLead: ExtractedLead | undefined;

      // Handle function tool call
      if (message.tool_calls && message.tool_calls.length > 0) {
        const toolCall = message.tool_calls[0];
        if ('function' in toolCall && toolCall.function && toolCall.function.name === 'complete_lead_capture') {
          const args = JSON.parse(toolCall.function.arguments);
          session.isCompleted = true;
          session.extractedData = args;

          completedLead = {
            tenantId: tenant.tenantId,
            callerPhone,
            customerName: args.customerName,
            location: args.suburb,
            serviceRequested: args.jobDescription,
            urgency: args.urgency,
            jobDescription: args.jobDescription,
            transcript: session.messages,
            isWithinServiceArea: args.isWithinServiceArea,
          };

          // Generate closing reply if model didn't return text alongside tool call
          if (!replyText) {
            replyText = `Thanks ${args.customerName}! I've logged your request and alerted our on-call team. They will call you shortly to confirm timing.`;
          }
        }
      }

      session.messages.push({
        role: 'assistant',
        text: replyText,
        timestamp: new Date().toISOString(),
      });

      return { reply: replyText, completedLead };
    } catch (err: any) {
      console.error('[ReceptionistEngine] OpenAI completion error:', err);
      const errReply = `Thanks for your message! Our team has received your inquiry and will call you back as soon as we finish this job.`;
      return { reply: errReply };
    }
  }
}
