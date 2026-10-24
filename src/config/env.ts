import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Sanity CMS
  SANITY_PROJECT_ID: z.string().default('mc1571jp'),
  SANITY_DATASET: z.string().default('production'),
  SANITY_API_VERSION: z.string().default('2024-01-01'),

  // Upstash QStash
  QSTASH_TOKEN: z.string().optional(),
  QSTASH_CURRENT_SIGNING_KEY: z.string().optional(),
  // The public URL of our app where QStash will deliver messages (e.g. ngrok or railway url)
  APP_BASE_URL: z.string().default('http://localhost:3000'),

  // Google Gemini AI
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),

  // Telnyx (Optional for testing)
  TELNYX_API_KEY: z.string().optional(),
});

export const env = envSchema.parse(process.env);

