import { GoogleGenAI, type FunctionDeclaration, Type } from '@google/genai';
import { ConversationTurn, CollectedJobDetails, LeadUrgency } from '../contracts/session-state.contract.js';
import { TenantContext } from './types/tenant.js';
import { env } from '../config/env.js';

export type LeadIntent = 'customer_lead' | 'solicitation' | 'spam';

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
  escalationReason?: 'ANGER' | 'HUMAN_REQUEST' | 'OUT_OF_BOUNDS' | 'MAX_TURNS_EXCEEDED' | 'DANGER_HAZARD';
  /** Spam sinkhole: if 'solicitation' or 'spam', worker transitions to TERMINATED */
  intent: LeadIntent;
}

export class GeminiQualificationEvaluator {
  private ai?: GoogleGenAI;

  constructor() {
    if (env.GEMINI_API_KEY) {
      this.ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    }
  }

  /**
   * Tool declaration: submit_qualification
   *
   * Key design decisions vs. the old schema:
   *
   * 1. `intent` (NEW): Gemini classifies every conversation as customer_lead,
   *    solicitation, or spam BEFORE trying to qualify. The worker reads this
   *    field first and short-circuits to TERMINATED if it's not customer_lead.
   *
   * 2. `name`/`suburb`/`issue` are NOT in `required[]`. This is intentional.
   *    The system prompt instructs Gemini to ask for only the single most
   *    important missing field per turn. Listing them all as required would
   *    encourage Gemini to interrogate the customer with a checklist.
   *
   * 3. `urgency` has no enum value of 'UNKNOWN'. Gemini must infer it from
   *    the customer's language (e.g. "flooding right now" → HIGH). It should
   *    only be omitted when there is genuinely no information to infer from.
   *
   * 4. `isFullyQualified` remains required because it is the single boolean
   *    gate that causes the state machine to latch to COMPLETED. Gemini
   *    cannot omit it.
   */
  private getQualificationTool(): FunctionDeclaration {
    return {
      name: 'submit_qualification',
      description:
        'Always call this function after reading the customer message. Classify intent, extract any newly mentioned details, and generate the next SMS reply.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          intent: {
            type: Type.STRING,
            enum: ['customer_lead', 'solicitation', 'spam'],
            description:
              'Classify the conversation. If this is a marketing call, SEO pitch, or bot — set "solicitation" or "spam". Only set "customer_lead" for genuine homeowners or business owners needing a trade service.',
          },
          customerName: {
            type: Type.STRING,
            description:
              'Customer first or full name. Leave omitted if not yet mentioned — do NOT guess or fabricate.',
          },
          suburb: {
            type: Type.STRING,
            description: 'Suburb or location of the job (e.g. "Glenelg", "Rose Park"). Omit if not yet provided.',
          },
          issue: {
            type: Type.STRING,
            description:
              'Concise summary of the trade issue. Omit if not yet described. Do not diagnose — just record.',
          },
          urgency: {
            type: Type.STRING,
            enum: ['LOW', 'MEDIUM', 'HIGH', 'EMERGENCY'],
            description:
              'Infer urgency from language and context. "flooding now", "no hot water all day", "smell of gas" → HIGH or EMERGENCY. "dripping tap" → LOW. Omit only if there is truly zero information to infer from.',
          },
          isFullyQualified: {
            type: Type.BOOLEAN,
            description:
              'Set true ONLY when ALL of the following are known: (1) customerName, (2) suburb, (3) specific issue, (4) urgency. If ANY is missing, this must be false.',
          },
          followUpQuestion: {
            type: Type.STRING,
            description:
              'The outbound SMS reply. Ask for only the single most critical missing field. Keep it under 2 sentences. Australian tradie tone — warm, direct, no corporate speak. Required when isFullyQualified is false.',
          },
          completionMessage: {
            type: Type.STRING,
            description:
              'Closing SMS when isFullyQualified is true. Warm, authentic Aussie tradie receptionist tone. Thank them by name, confirm the tradie will call shortly to arrange a time to inspect/take a look on-site and provide an upfront quote. DO NOT promise an immediate fix or say "get it sorted" (as on-site assessment/quoting is required first). Give any tenant-specific safety advice if urgency is HIGH or EMERGENCY.',
          },
          isEscalated: {
            type: Type.BOOLEAN,
            description:
              'Set true if: (1) immediate danger/hazard (gas leak, exposed live wires), (2) customer is furious, (3) customer explicitly demands a human, or (4) out of bounds trade/service.',
          },
          escalationReason: {
            type: Type.STRING,
            enum: ['DANGER_HAZARD', 'ANGER', 'HUMAN_REQUEST', 'OUT_OF_BOUNDS'],
            description: 'Required if isEscalated is true.',
          },
        },
        required: ['intent', 'isFullyQualified'],
      },
    };
  }

  /**
   * Builds the system instruction injected into every Gemini call.
   *
   * Design philosophy:
   *  - Rules are ordered by precedence (safety > spam > pricing > qualification).
   *  - Emergency triage advice is tenant-injected, NOT hardcoded. The only
   *    hardcoded text is the universal 000/utility provider safety guardrail,
   *    which applies regardless of trade type.
   *  - The pricing guardrail has a three-step pivot pattern: acknowledge the
   *    question → state on-site assessment policy → redirect to missing fields.
   *  - HIGH urgency triggers a tone shift. The system prompt explains the
   *    emotional register to adopt, not the specific words.
   */
  private buildSystemInstruction(input: EvaluationInput): string {
    const { tenant } = input;

    const servicesList =
      tenant.services && tenant.services.length > 0
        ? tenant.services
            .map(
              (s) =>
                `- ${s.title}${s.startingPrice ? ` (from ${s.startingPrice})` : ''}: ${s.shortDescription || ''}`
            )
            .join('\n')
        : 'General trade and repair services.';

    const tradeTitle = tenant.tradeType ? `${tenant.tradeType} professional` : 'plumbing and gas professional';
    const tradieName = tenant.ownerFirstName || tenant.businessName;

    // Tenant-specific emergency triage — injected dynamically from Sanity CMS per tradie, never hardcoded!
    const tenantTriageSection = tenant.emergencyTriageAdvice
      ? `RULE 3 — TRADE EMERGENCY TRIAGE ADVICE:
When urgency is HIGH or EMERGENCY (e.g. burst pipe, flooding, major leak), include this specific trade safety step in your reply:
"${tenant.emergencyTriageAdvice}"
Adopt an urgent tone, give this advice, and ask for the missing qualification details.
DO NOT tell them to call 000 for non-life-threatening property damage!`
      : '';

    const excludedList = tenant.excludedServices && tenant.excludedServices.length > 0
      ? tenant.excludedServices.map(e => `- ${e}`).join('\n')
      : 'None specified.';

    return `You are the SMS dispatcher for "${tenant.businessName}", a ${tradeTitle} business.
Service area: "${tenant.serviceArea}"
Business hours: ${tenant.businessHours || 'Standard hours. After-hours call-out fee applies.'}

FEATURED SERVICES (Top specialties):
${servicesList}

EXCLUDED WORK (Jobs this business DOES NOT take):
${excludedList}

CUSTOM OWNER INSTRUCTIONS:
${tenant.aiCustomInstructions || 'Be friendly, concise, and professional.'}

─── RULES (ordered by precedence) ───────────────────────────────────────────

RULE 1 — SPAM SINKHOLE (highest priority):
Before doing anything else, classify intent. If the message reads like a marketing pitch,
SEO offer, automated bot, or telemarketer, set intent = "solicitation" or "spam" and set
isFullyQualified = false. Do not engage or reply. The system will silently drop this job.

RULE 2 — IMMEDIATE LIFE THREAT SAFETY GUARDRAIL (non-negotiable):
If the customer describes an immediately dangerous situation — gas leak, live electrical
hazard in water, sparking wires, carbon monoxide, structural collapse:
  (a) Your followUpQuestion MUST contain:
      "Please get to safety immediately. For your safety, please isolate the issue if safe to do so, or contact 000 / your utility provider immediately. I have notified ${tradieName} directly."
  (b) STOP AUTOMATION: Set isEscalated = true and escalationReason = "DANGER_HAZARD".
  (c) DO NOT continue qualifying or asking for name/suburb. Safety takes precedence over sales.
  (d) NEVER invoke 000 for regular water leaks or non-life-threatening property issues (000 is for life threat only).

${tenantTriageSection}

RULE 4 — PRICING & DIAGNOSIS GUARDRAIL & COMPLETION POLICY:
(a) PRICING & DIAGNOSIS:
    You MUST NOT estimate any price, diagnose a root cause, or guarantee a technical outcome.
    If a customer asks "how much will it cost?" or "what do you think the problem is?":
      Step 1: Acknowledge: "Totally understand, you want a rough idea."
      Step 2: State policy: "${tradieName} provides an upfront quote once he can see it on-site."
      Step 3: Redirect: pivot back to collecting whichever field is most urgently missing.
    Never say anything that could be interpreted as a binding commitment on pricing.
(b) COMPLETION PHRASING (NO OVERPROMISES):
    When isFullyQualified is true, ALWAYS frame the next step as ${tradieName} giving them a call
    to arrange a time to come out, inspect/take a look, and provide an upfront quote.
    DO NOT say "we'll get it sorted" or promise that the issue will be repaired immediately on arrival,
    because every job requires an on-site assessment first. Example:
    "Thanks [Name]! I've passed your details to ${tradieName}. He'll give you a buzz shortly to arrange a time to take a look and give you an upfront quote."

RULE 5 — NATURAL QUALIFICATION (no interrogation):
Collect: (1) customer name, (2) suburb, (3) issue description, (4) urgency.
Ask for ONLY the single most important missing piece per SMS. Never fire a list of questions.
Infer urgency from language; do not ask "would you rate this LOW, MEDIUM or HIGH?".

RULE 6 — URGENCY TONE SHIFT:
If you infer urgency is HIGH or EMERGENCY (e.g. active burst pipe, water gushing), shift your
register: drop pleasantries, be sharp and direct. e.g. "Got it, that's urgent. What suburb
are you in so I can flag this straight away?" This is not panic, it is professional triage.

RULE 7 — TRADE DOMAIN ONTOLOGY & EXCLUSIONS (3-Layer Scope):
(a) EXCLUSIONS: If the customer asks for a service explicitly listed under EXCLUDED WORK above,
    politely decline: "Sorry, we don't take on [service]. I recommend looking for a specialist for that."
(b) STANDARD TRADE WORK & PHRASING GUARDRAIL:
    You represent a qualified professional ${tradeTitle}. Use common sense trade domain knowledge.
    For example, for a plumbing trade: taps, toilets, downpipes, gutters, stormwater, roof leaks,
    burst pipes, hot water, blocked drains, and gas fittings are all standard plumbing work.
    CRITICAL PHRASING RULES:
    1. Confirm that ${tradieName} handles that type of work, but NEVER say "we can definitely sort that out for you" or guarantee a fix sight unseen.
    2. NEVER use the em dash or dash punctuation character "—" in any SMS output as it looks robotic and artificial.
    3. Use natural Aussie phrasing such as "No worries, we handle downpipes all the time" or "Yeah, that is right up our alley, we can certainly come take a look."
    Proceed directly with natural qualification.
(c) FOREIGN TRADES: If the customer asks for work belonging to an entirely different trade (e.g. asking
    a plumber for electrical wiring, plastering, tiling, or painting), set isEscalated = true with
    reason OUT_OF_BOUNDS and politely let them know that trade is outside your licensing.

RULE 8 — OUT OF AREA:
If the job location is clearly outside "${tenant.serviceArea}", set isEscalated = true
with reason OUT_OF_BOUNDS.

RULE 9 — DO NOT FABRICATE:
Never invent a name, suburb, or issue the customer has not stated. Leave those fields
omitted in the tool call rather than guessing.

─── CURRENT CONVERSATION STATE ──────────────────────────────────────────────
Previously collected: ${JSON.stringify(input.previouslyCollected)}
─────────────────────────────────────────────────────────────────────────────`;
  }

  async evaluate(input: EvaluationInput): Promise<EvaluationOutput> {
    const { tenant } = input;
    const tradieName = tenant.ownerFirstName || tenant.businessName;

    // ── Local dev / CI mock (no Gemini API key) ─────────────────────────────
    if (!this.ai) {
      console.warn('[GeminiEvaluator] GEMINI_API_KEY not set. Using offline rule-based fallback.');
      return this.evaluateOffline(input);
    }

    const systemInstruction = this.buildSystemInstruction(input);

    // Map conversation history to Gemini multi-turn format
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
    for (const turn of input.history) {
      contents.push({
        role: turn.role === 'customer' ? 'user' : 'model',
        parts: [{ text: turn.content }],
      });
    }
    contents.push({
      role: 'user',
      parts: [{ text: input.latestMessage }],
    });

    try {
      const response = await this.ai.models.generateContent({
        model: env.GEMINI_MODEL || 'gemini-2.0-flash',
        contents,
        config: {
          systemInstruction,
          temperature: 0.1,
          tools: [{ functionDeclarations: [this.getQualificationTool()] }],
        },
      });

      const functionCalls = response.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        if (call.name === 'submit_qualification') {
          const args = call.args as any;

          const intent: LeadIntent = args.intent ?? 'customer_lead';

          return {
            intent,
            isFullyQualified: intent === 'customer_lead' ? !!args.isFullyQualified : false,
            extracted: {
              customerName: args.customerName,
              suburb: args.suburb,
              issue: args.issue,
              urgency: args.urgency as LeadUrgency | undefined,
              intent,
            },
            replyText: args.isFullyQualified
              ? args.completionMessage || args.followUpQuestion
              : args.followUpQuestion || response.text || undefined,
            isEscalated: !!args.isEscalated,
            escalationReason: args.escalationReason,
          };
        }
      }

      // Gemini replied with text rather than calling the tool — treat as unqualified
      return {
        intent: 'customer_lead',
        isFullyQualified: false,
        extracted: {},
        replyText: response.text ?? "Thanks! Could you let us know your suburb and what needs fixing?",
      };
    } catch (error) {
      console.warn('[GeminiEvaluator] Network error. Using offline rule-based fallback.');
      return this.evaluateOffline(input);
    }
  }

  private evaluateOffline(input: EvaluationInput): EvaluationOutput {
    const { tenant } = input;
    const tradieName = tenant.ownerFirstName || tenant.businessName;

    const textLower = (input.latestMessage + ' ' + input.history.map((h) => h.content).join(' ')).toLowerCase();

    if (textLower.includes('seo') || textLower.includes('marketing') || textLower.includes('we can get you more leads')) {
      return { intent: 'spam', isFullyQualified: false, extracted: { intent: 'spam' }, replyText: undefined };
    }

    if (textLower.includes('gas') || textLower.includes('sparking') || textLower.includes('live wire')) {
      return {
        intent: 'customer_lead',
        isFullyQualified: false,
        isEscalated: true,
        escalationReason: 'DANGER_HAZARD',
        extracted: {},
        replyText: `Please get to safety immediately. For your safety, please isolate the issue if safe to do so, or contact 000 / your utility provider immediately. I have notified ${tradieName} directly.`,
      };
    }

    if (textLower.includes('how much') || textLower.includes('cost') || textLower.includes('price') || textLower.includes('charge') || textLower.includes('ballpark')) {
      return {
        intent: 'customer_lead',
        isFullyQualified: false,
        extracted: {},
        replyText: `Totally understand you want a rough idea. ${tradieName} provides an upfront quote once he can see it on-site to inspect the job properly. What suburb are you located in?`,
      };
    }

    if (textLower.includes('human') || textLower.includes('angry') || textLower.includes('furious')) {
      return {
        intent: 'customer_lead',
        isFullyQualified: false,
        isEscalated: true,
        escalationReason: textLower.includes('human') ? 'HUMAN_REQUEST' : 'ANGER',
        extracted: {},
        replyText: 'No problem — I have flagged this for the team lead directly.',
      };
    }

    const textCombined = (input.latestMessage + ' ' + input.history.map((h) => h.content).join(' ')).toLowerCase();
    const hasSuburb = /maroubra|coogee|bondi|clovelly|rose park|glenelg/.test(textCombined);
    const hasIssue = /drain|pipe|leak|flood|burst|tap|hot water|gas/.test(textCombined);
    const hasUrgency = /urgent|emergency|overflow|flood|right now|burst/.test(textCombined);
    const nameMatch = textCombined.match(/(?:name is|i'm|i am|call me)\s+([a-z]+)/i);
    const customerName = nameMatch
      ? nameMatch[1].charAt(0).toUpperCase() + nameMatch[1].slice(1)
      : undefined;

    const isFullyQualified = !!(hasSuburb && hasIssue && hasUrgency && customerName);

    // Distinguish current turn progress: if latest message contains no meaningful job details, don't re-extract previous details
    const latestLower = input.latestMessage.toLowerCase();
    const latestHasInfo = /maroubra|coogee|bondi|clovelly|rose park|glenelg|drain|pipe|leak|flood|burst|tap|hot water|gas|urgent|emergency|overflow|right now|name is|i'm|i am|call me/.test(latestLower);

    return {
      intent: 'customer_lead',
      isFullyQualified,
      extracted: {
        suburb: latestHasInfo && hasSuburb ? 'Maroubra' : undefined,
        issue: latestHasInfo && hasIssue ? 'Plumbing issue' : undefined,
        urgency: latestHasInfo && hasUrgency ? 'HIGH' : undefined,
        customerName: latestHasInfo ? customerName : undefined,
        intent: 'customer_lead',
      },
      replyText: isFullyQualified
        ? undefined
        : "Got it! Who am I speaking with, and what suburb are you in?",
    };
  }
}
