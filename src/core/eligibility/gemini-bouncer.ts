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
      console.warn('[GeminiBouncer] No GEMINI_API_KEY. Defaulting to SERVICE.');
      return { classification: 'SERVICE', confidence: 0.5, reasoning: 'Mock fallback' };
    }

    const systemInstruction = `You are a binary intent classifier for an Australian ${tradeType} business owner.
The owner missed a call and an automated neutral SMS was sent: "Hey mate, missed your call, what's up?".
The caller has now sent a reply.

Your job is strictly to classify whether the incoming message is:
1. "SERVICE": The sender is asking for trade work, a repair, a quote, job updates, property issues, or business matters.
2. "PERSONAL": The sender is a friend, family member, mate, or acquaintance talking about casual life, social plans (e.g., getting a beer, dinner, footy, golf), or asking a purely personal question unrelated to hiring a tradie.

CRITICAL INSTRUCTIONS:
- If uncertain, default to "SERVICE" to avoid dropping legitimate paying work.
- Return strictly valid JSON with this shape:
  {"classification": "PERSONAL" | "SERVICE", "confidence": number, "reasoning": "brief explanation"}`;

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-2.0-flash',
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
      console.error('[GeminiBouncer] Error during classification:', err);
      return { classification: 'SERVICE', confidence: 0.5, reasoning: 'Error fallback' };
    }
  }
}

