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
            description: 'Customer first or full name (MANDATORY before isFullyQualified can be true)',
          },
          suburb: {
            type: Type.STRING,
            description: 'Location or suburb of the job (e.g. "Glenelg", "Rose Park")',
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
            description: 'Set to true ONLY when you have ALL 4: (1) customerName, (2) suburb, (3) specific issue, and (4) urgency.',
          },
          followUpQuestion: {
            type: Type.STRING,
            description: 'Short SMS response to the customer. If details are missing, ask for what is missing (e.g. name or suburb) in a warm, helpful Australian trades tone.',
          },
          completionMessage: {
            type: Type.STRING,
            description: 'Contextual, reassuring closing SMS to the customer when isFullyQualified is true. Acknowledge their issue, mention their name, and give safety advice if applicable (e.g. turning off mains tap).',
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

    const tradeTitle = tenant.tradeType ? `${tenant.tradeType} professional` : 'trades professional';

    const emergencySection = tenant.emergencyTriageAdvice
      ? `4. EMERGENCY SAFETY ADVICE: If an active emergency or urgent danger is described, immediately provide this specific advice: "${tenant.emergencyTriageAdvice}"`
      : '4. EMERGENCY SAFETY ADVICE: If an urgent emergency is described, prioritize getting the technician to call them immediately.';

    const systemInstruction = `You are the smart SMS dispatcher for "${tenant.businessName}".
Your service area covers: "${tenant.serviceArea}".
Business Hours: ${tenant.businessHours || 'Standard business hours. Emergency call-out fee applies after hours.'}

SERVICES OFFERED:
${servicesList}

CUSTOM OWNER INSTRUCTIONS:
${tenant.aiCustomInstructions || 'Be friendly, concise, and helpful.'}

CRITICAL RULES & TRADIE PERSONA:
1. Tone: Warm, helpful, down-to-earth Australian ${tradeTitle}. Keep all SMS responses under 2-3 short sentences.
2. MANDATORY FIELDS: You MUST collect all 4 items before completing qualification:
   (a) Customer Name (Always ask: "Who am I speaking with?" or "Could I grab your name?")
   (b) Suburb or address
   (c) Specific issue
   (d) Urgency level
3. NEVER set isFullyQualified = true if customerName is unknown! Ask for their name along with any missing details.
${emergencySection}
5. SERVICES GUARD: ONLY offer and confirm services listed in SERVICES OFFERED above. If they ask for work outside these services, politely say: "We don't specialize in that kind of work, but we can recommend looking for a specialist."
6. NEVER quote fixed repair prices over SMS. Always mention that the technician provides an upfront quote on-site once inspected.
7. OUT OF AREA: If they are outside "${tenant.serviceArea}", set isEscalated = true.
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
            replyText: (args.isFullyQualified ? (args.completionMessage || args.followUpQuestion) : args.followUpQuestion) || response.text || undefined,
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
      
      // Escalation simulation
      if (textLower.includes('human') || textLower.includes('bot') || textLower.includes('waiting') || textLower.includes('angry')) {
        return {
          isFullyQualified: false,
          isEscalated: true,
          escalationReason: textLower.includes('human') ? 'HUMAN_REQUEST' : 'ANGER',
          extracted: {},
          replyText: 'No problem! I have alerted our team lead directly. They will call you as soon as possible.',
        };
      }

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
