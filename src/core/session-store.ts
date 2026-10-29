import { Redis } from '@upstash/redis';
import {
  SessionState,
  SessionStateSchema,
  buildSessionKey,
  createInitialSession,
} from '../contracts/session-state.contract.js';
import { env } from '../config/env.js';

export interface SessionStoreOptions {
  redisUrl?: string;
  redisToken?: string;
  defaultTtlSeconds?: number;
}

export class SessionStore {
  private redis: Redis | null = null;
  // Local in-memory store for development/testing when UPSTASH_REDIS_REST_URL is not set
  private memoryStore = new Map<string, SessionState>();
  // Default session expiration: 24 hours (86,400 seconds)
  private readonly defaultTtl: number;

  constructor(options: SessionStoreOptions = {}) {
    const url = options.redisUrl || env.UPSTASH_REDIS_REST_URL;
    const token = options.redisToken || env.UPSTASH_REDIS_REST_TOKEN;
    this.defaultTtl = options.defaultTtlSeconds || 86400;

    if (url && token) {
      this.redis = new Redis({ url, token });
    }
  }

  /**
   * Fetches and validates a session state from Upstash Redis (or memory store in dev)
   */
  async getSession(businessId: string, callerNumber: string): Promise<SessionState | null> {
    const key = buildSessionKey(businessId, callerNumber);

    if (!this.redis) {
      const memoryItem = this.memoryStore.get(key);
      return memoryItem ? JSON.parse(JSON.stringify(memoryItem)) : null;
    }

    const data = await this.redis.get<unknown>(key);
    if (!data) {
      return null;
    }

    const parseResult = SessionStateSchema.safeParse(data);
    if (!parseResult.success) {
      console.error(`[SessionStore] Corrupt session state found for key ${key}:`, parseResult.error.format());
      return null;
    }

    return parseResult.data;
  }

  /**
   * Saves or updates a session state in Redis with automatic TTL expiration.
   */
  async saveSession(session: SessionState, ttlSeconds?: number): Promise<void> {
    const key = buildSessionKey(session.businessId, session.callerNumber);
    const ttl = ttlSeconds ?? this.defaultTtl;

    session.updatedAt = new Date().toISOString();

    if (!this.redis) {
      this.memoryStore.set(key, JSON.parse(JSON.stringify(session)));
      return;
    }

    await this.redis.set(key, session, { ex: ttl });
  }

  /**
   * Helper: Gets an existing session or initializes a new one in the INIT state.
   */
  async getOrCreateSession(params: {
    businessId: string;
    callerNumber: string;
    callSid?: string;
  }): Promise<{ session: SessionState; isNew: boolean }> {
    const existing = await this.getSession(params.businessId, params.callerNumber);
    if (existing) {
      return { session: existing, isNew: false };
    }

    const newSession = createInitialSession(params);
    await this.saveSession(newSession);
    return { session: newSession, isNew: true };
  }

  /**
   * Deletes a session key
   */
  async deleteSession(businessId: string, callerNumber: string): Promise<void> {
    const key = buildSessionKey(businessId, callerNumber);
    if (this.redis) {
      await this.redis.del(key);
    } else {
      this.memoryStore.delete(key);
    }
  }
}

