import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  
  // Sanity
  SANITY_PROJECT_ID: z.string().default('mc1571jp'),
  SANITY_DATASET: z.string().default('production'),
  SANITY_API_VERSION: z.string().default('2024-01-01'),
  SANITY_API_TOKEN: z.string().optional(),

  // Telephony
  TELEPHONY_PROVIDER: z.enum(['twilio', 'telnyx']).default('twilio'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TELNYX_API_KEY: z.string().optional(),

  // LLM
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),

  // Lead Dispatch
  LEAD_WEBHOOK_SECRET: z.string().optional(),
});

export const env = envSchema.parse(process.env);
