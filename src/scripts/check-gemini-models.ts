import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';

async function checkModels() {
  console.log('--- Testing Gemini API Key with Multiple Model IDs ---\n');
  if (!env.GEMINI_API_KEY) {
    console.log('No GEMINI_API_KEY found in .env');
    return;
  }

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const testModels = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-2.0-flash-exp'];

  for (const model of testModels) {
    console.log(`Testing model: ${model}...`);
    try {
      const res = await ai.models.generateContent({
        model,
        contents: 'Say hello in 5 words',
      });
      console.log(`✅ SUCCESS with ${model}! Response: "${res.text?.trim()}"\n`);
      return; // Stop on first success!
    } catch (err: any) {
      console.log(`❌ Failed on ${model}: ${err.message || err.status}\n`);
    }
  }
}

checkModels();

