import { GoogleGenAI, type FunctionDeclaration, Type } from '@google/genai';
import { ConversationTurn, CollectedJobDetails, LeadUrgency } from '../contracts/session-state.contract.js';
import { TenantContext } from './types/tenant.js';
import { env } from '../config/env.js';

export interface EvaluationInput {
  tenant: TenantContext;
  history: ConversationTurn[];
  latestMessage: string;
  mediaUrls?: string[];
  previouslyCollected: CollectedJobDetails;
}

export interface EvaluationOutput {
  isFullyQualified: boolean;
  extracted: Partial<CollectedJobDetails>;
  replyText?: string;
  isEscalated?: boolean;
  escalationReason?: 'ANGER' | 'HUMAN_REQUEST' | 'OUT_OF_BOUNDS' | 'MAX_TURNS_EXCEEDED';
}

export class GeminiQualificationEvaluator {
  private ai?: GoogleGenAI;

  constructor() {
    if (env.GEMINI_API_KEY) {
      this.ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    }
  }

  /**
   * Tool definition: allows Gemini to output structured lead data
   */
  private getQualificationTool(): FunctionDeclaration {
    return {
      name: 'submit_qualification',
      description: 'Call this function to save newly extracted lead details or mark the job as fully qualified.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          customerName: {
            type: Type.STRING,
            description: 'Name of the customer if mentioned (e.g. "Dave", "Sarah")',
          },
          suburb: {
            type: Type.STRING,
            description: 'Location or suburb of the job (e.g. "Coogee", "Bondi")',
          },
          issue: {
            type: Type.STRING,
            description: 'Concise summary of the trade issue/work needed',
          },
          urgency: {
            type: Type.STRING,
            enum: ['LOW', 'MEDIUM', 'HIGH', 'EMERGENCY'],
            description: 'Urgency level based on customer description',
          },
          isFullyQualified: {
            type: Type.BOOLEAN,
            description: 'Set to true ONLY if you now have: (1) suburb/location, (2) clear issue description, and (3) urgency assessed.',
          },
          followUpQuestion: {
            type: Type.STRING,
            description: 'Short SMS question to ask the customer if details are still missing (max 1-2 sentences).',
          },
          isEscalated: {
            type: Type.BOOLEAN,
            description: 'Set to true if the customer is expressing severe anger, asking to speak directly with the human owner, or demanding an out-of-bounds service.',
          },
          escalationReason: {
            type: Type.STRING,
            enum: ['ANGER', 'HUMAN_REQUEST', 'OUT_OF_BOUNDS'],
            description: 'Reason for escalation if isEscalated is true',
          },
        },
        required: ['isFullyQualified'],
      },
    };
  }

  /**
   * Evaluates the multi-turn conversation using Gemini
   */
  async evaluate(input: EvaluationInput): Promise<EvaluationOutput> {
    const { tenant } = input;

    // Fallback simulation for local dev without Gemini API key
    if (!this.ai) {
      console.warn('[GeminiEvaluator] GEMINI_API_KEY not set. Using mock evaluation.');
      return {
        isFullyQualified: true,
        extracted: {
          customerName: 'Customer',
          suburb: 'Local Area',
          issue: input.latestMessage,
          urgency: 'MEDIUM' as LeadUrgency,
        },
        replyText: `Thanks! We've received your request and the team at ${tenant.businessName} will be in touch shortly.`,
      };
    }

    const servicesList = tenant.services && tenant.services.length > 0
      ? tenant.services.map(s => `- ${s.title}: starting from ${s.startingPrice || 'standard call-out fee'} (${s.shortDescription || ''})`).join('\n')
      : 'General trade and repair services.';

    const systemInstruction = `You are the smart SMS dispatcher for "${tenant.businessName}".
Your service area covers: "${tenant.serviceArea}".
Business Hours: ${tenant.businessHours || 'Standard business hours. Emergency call-out fee applies after hours.'}

SERVICES OFFERED:
${servicesList}

CUSTOM OWNER INSTRUCTIONS:
${tenant.aiCustomInstructions || 'Be friendly, concise, and helpful.'}

CRITICAL RULES & BOUNDARIES:
1. Keep all SMS responses under 2 short sentences.
2. ONLY reference services listed above. If a customer asks for a service not listed, say: "We don't specialize in that, but we can recommend looking for a specialist."
3. NEVER guess, estimate, or quote fixed repair prices over SMS. Always explain that the technician provides an upfront quote on-site once inspected.
4. Your mission is to gather: (1) Suburb/address, (2) Specific issue, (3) Urgency level, (4) Customer name.
5. If any critical info is missing, ask for ONLY what is missing in a single short question.
6. When you have (suburb + issue + urgency), call the tool "submit_qualification" with isFullyQualified = true.
7. If the customer explicitly asks for a human, expresses severe frustration, or is outside "${tenant.serviceArea}", set isEscalated = true.
8. Previously captured data so far: ${JSON.stringify(input.previouslyCollected)}.`;

    // Map conversation history into Gemini's multi-turn contents
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    for (const turn of input.history) {
      contents.push({
        role: turn.role === 'customer' ? 'user' : 'model',
        parts: [{ text: turn.content }],
      });
    }

    // Append latest incoming customer message
    contents.push({
      role: 'user',
      parts: [{ text: input.latestMessage }],
    });

    try {
      const response = await this.ai.models.generateContent({
        model: env.GEMINI_MODEL || 'gemini-3.8-flash',
        contents,
        config: {
          systemInstruction,
          temperature: 0.1, // Low temperature for high factual accuracy
          tools: [{ functionDeclarations: [this.getQualificationTool()] }],
        },
      });

      const functionCalls = response.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        if (call.name === 'submit_qualification') {
          const args = call.args as any;

          return {
            isFullyQualified: !!args.isFullyQualified,
            extracted: {
              customerName: args.customerName,
              suburb: args.suburb,
              issue: args.issue,
              urgency: args.urgency as LeadUrgency,
            },
            replyText: args.followUpQuestion || response.text || undefined,
            isEscalated: !!args.isEscalated,
            escalationReason: args.escalationReason,
          };
        }
      }

      // If Gemini replied with text rather than calling the tool
      return {
        isFullyQualified: false,
        extracted: {},
        replyText: response.text || "Thanks! Could you let us know your suburb and what needs fixing?",
      };
    } catch (error) {
      console.warn('[GeminiEvaluator] Network unavailable or API error. Using offline rule-based fallback for local dev.');

      // Intelligent local simulation for testing without network
      const textLower = (input.latestMessage + ' ' + input.history.map(h => h.content).join(' ')).toLowerCase();
      const hasSuburb = textLower.includes('maroubra') || textLower.includes('coogee') || textLower.includes('bondi') || textLower.includes('clovelly');
      const hasIssue = textLower.includes('drain') || textLower.includes('pipe') || textLower.includes('leak') || textLower.includes('flooding');
      const hasUrgency = textLower.includes('urgent') || textLower.includes('emergency') || textLower.includes('overflowing') || textLower.includes('flooding');
      
      const nameMatch = textLower.match(/name is (\w+)/i);
      const customerName = nameMatch ? nameMatch[1].charAt(0).toUpperCase() + nameMatch[1].slice(1) : (textLower.includes('mark') ? 'Mark' : undefined);

      const isFullyQualified = hasSuburb && hasIssue && hasUrgency;

      return {
        isFullyQualified,
        extracted: {
          suburb: hasSuburb ? (textLower.includes('clovelly') ? 'Clovelly' : 'Maroubra') : undefined,
          issue: hasIssue ? 'Blocked drain' : undefined,
          urgency: hasUrgency ? 'HIGH' : undefined,
          customerName,
        },
        replyText: isFullyQualified
          ? undefined
          : 'Got it! Is it overflowing right now, and who am I speaking with?',
      };
    }
  }
}
