import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema.js';
import { env } from '../../config/env.js';

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (dbInstance) return dbInstance;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    // If running in development without PostgreSQL, we provide a warning
    // and callers can check or use in-memory fallbacks during tests.
    console.warn('[Database] DATABASE_URL not set in environment.');
    return null;
  }

  const sql = neon(connectionString);
  dbInstance = drizzle(sql, { schema });
  return dbInstance;
}

export type AppDatabase = NonNullable<ReturnType<typeof getDb>>;

