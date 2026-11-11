import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Base URL (Where QStash sends worker callbacks)
  APP_BASE_URL: z.string().default('http://localhost:3000'),

  // Sanity CMS
  SANITY_PROJECT_ID: z.string().default('mc1571jp'),
  SANITY_DATASET: z.string().default('production'),
  SANITY_API_VERSION: z.string().default('2024-01-01'),

  // Google Gemini AI
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),

  // Upstash Redis (Session State & Tenant Caching)
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // Upstash QStash (Async Delayed Queuing)
  QSTASH_TOKEN: z.string().optional(),
  QSTASH_CURRENT_SIGNING_KEY: z.string().optional(),

  // Twilio Telephony
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  BUSINESS_OWNER_PHONE: z.string().default('+61481880277'),
  DEFAULT_BUSINESS_NAME: z.string().default('Apex Plumbing & Gas'),
  DEFAULT_SERVICE_AREA: z.string().default('Sydney Eastern Suburbs & Inner West'),

  // ServiceM8 CRM (optional — simulation mode when absent)
  SERVICEM8_EMAIL: z.string().email().optional(),
  SERVICEM8_API_KEY: z.string().optional(),

  // PostgreSQL Database (Neon Serverless for Eligibility Engine & Contacts)
  DATABASE_URL: z.string().optional(),
});

export const env = envSchema.parse(process.env);
