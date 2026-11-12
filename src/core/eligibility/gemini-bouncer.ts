import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';

export interface BouncerClassificationOutput {
  classification: 'PERSONAL' | 'SERVICE';
  confidence: number;
  reasoning: string;
}

export class GeminiBouncerClassifier {
  private ai: GoogleGenAI | null = null;

  constructor() {
    if (env.GEMINI_API_KEY) {
      this.ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    }
  }

  /**
   * Fast, binary classification of an incoming text reply to a neutral missed call SMS.
   * Determines if the caller is asking for trade repair services or if it's personal/casual chat.
   */
  async classify(text: string, tradeType: string = 'tradie'): Promise<BouncerClassificationOutput> {
    if (!this.ai) {
      console.warn('[GeminiBouncer] No GEMINI_API_KEY. Using heuristic rule-based classifier.');
      const lower = text.toLowerCase();
      const isPersonal =
        /bro|tony|dave|mum|dad|mate|beer|dinner|footy|golf|hang out|catch up|tonight|weekend|how are you|how r u|what you up to/.test(lower) &&
        !/leak|burst|pipe|tap|drain|toilet|hot water|gas|quote|repair|electric|roof|job|fix/.test(lower);
      return {
        classification: isPersonal ? 'PERSONAL' : 'SERVICE',
        confidence: 0.9,
        reasoning: isPersonal ? 'Offline heuristic: personal slang/name' : 'Offline heuristic: default to service',
      };
    }

    const systemInstruction = `You are a binary intent classifier for an Australian ${tradeType} business owner.
The owner missed a call and an automated neutral SMS was sent: "Hey mate, missed your call, what's up?".
The caller has now sent a reply.

Your job is strictly to classify whether the incoming message is:
1. "SERVICE": The sender is asking for trade work, a repair, a quote, job updates, property issues, or business matters.
2. "PERSONAL": The sender is a friend, family member, mate, or acquaintance talking about casual life, social plans (e.g., getting a beer, dinner, footy, golf), or asking a purely personal question unrelated to hiring a tradie.

CRITICAL INSTRUCTIONS:
3. Common personal introductions (e.g. "hey bro it's [name]", "its mum", "mate call me", "are you free for dinner/beer/footy") with no mention of damage, leaking, electrical, or trade work must be classified as "PERSONAL".
4. Inquiries about personal evening/social plans (e.g. "we still on for tonight?", "are you coming over?", "did you see the game?", "call me later") must be classified as "PERSONAL".
- If the sender introduces themselves informally with no trade request (e.g. "its tony", "its mum"), classify as "PERSONAL".
- If uncertain and they describe a property issue or repair, default to "SERVICE" to avoid dropping legitimate paying work.
- Return strictly valid JSON with this shape:
  {"classification": "PERSONAL" | "SERVICE", "confidence": number, "reasoning": "brief explanation"}`;

    const modelName = env.GEMINI_MODEL || 'gemini-2.5-flash';

    try {
      const response = await this.ai.models.generateContent({
        model: modelName,
        contents: text,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          temperature: 0.1, // Near-zero temperature for deterministic output
        },
      });

      const parsed = JSON.parse(response.text?.trim() || '{}');
      return {
        classification: parsed.classification === 'PERSONAL' ? 'PERSONAL' : 'SERVICE',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.9,
        reasoning: parsed.reasoning || '',
      };
    } catch (err) {
      console.warn('[GeminiBouncer] Network error/offline. Using offline heuristic classifier.');
      const lower = text.toLowerCase();
      const isPersonal =
        /bro|tony|dave|mum|dad|mate|beer|dinner|footy|golf|tonight|weekend|still on|hang out|catch up|how are you|what you up to/.test(lower) &&
        !/leak|burst|pipe|tap|drain|toilet|hot water|gas|quote|repair|electric|roof|job|fix/.test(lower);
      return {
        classification: isPersonal ? 'PERSONAL' : 'SERVICE',
        confidence: 0.9,
        reasoning: isPersonal ? 'Offline heuristic: personal slang/name' : 'Offline heuristic: default to service',
      };
    }
  }
}

