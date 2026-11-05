import { Redis } from '@upstash/redis';

export interface BufferedMessage {
  text: string;
  mediaUrls?: string[];
  receivedAt: string;
}

export interface IngestResult {
  version: number;
  totalBuffered: number;
}

export interface DrainedBatch {
  combinedText: string;
  combinedMediaUrls: string[];
  messageCount: number;
}

/**
 * MessageBufferManager
 * 
 * Implements a distributed debounce buffer for incoming customer SMS streams.
 * Prevents the AI from interrupting customers who type in multiple short fragments.
 */
export class MessageBufferManager {
  private redis: Redis | null;
  // Local in-memory fallback for local development or offline unit tests
  private memoryLists = new Map<string, BufferedMessage[]>();
  private memoryVersions = new Map<string, number>();

  constructor(redis: Redis | null = null) {
    this.redis = redis;
  }

  private getBufferKey(businessId: string, callerNumber: string): string {
    const cleanNumber = callerNumber.replace(/[^\d+]/g, '');
    return `buffer:${businessId}:${cleanNumber}`;
  }

  private getVersionKey(businessId: string, callerNumber: string): string {
    const cleanNumber = callerNumber.replace(/[^\d+]/g, '');
    return `debounce:${businessId}:${cleanNumber}`;
  }

  /**
   * Appends an incoming text message to the customer's buffer
   * and increments the debounce version token.
   */
  async ingestMessage(
    businessId: string,
    callerNumber: string,
    message: BufferedMessage
  ): Promise<IngestResult> {
    const bufferKey = this.getBufferKey(businessId, callerNumber);
    const versionKey = this.getVersionKey(businessId, callerNumber);

    if (this.redis) {
      // 1. Push to Redis list (expires in 60s as a safety cleanup)
      await this.redis.rpush(bufferKey, JSON.stringify(message));
      await this.redis.expire(bufferKey, 60);

      // 2. Increment version token
      const version = await this.redis.incr(versionKey);
      await this.redis.expire(versionKey, 60);

      const total = await this.redis.llen(bufferKey);
      return { version, totalBuffered: total };
    }

    // In-memory fallback
    const list = this.memoryLists.get(bufferKey) || [];
    list.push(message);
    this.memoryLists.set(bufferKey, list);

    const version = (this.memoryVersions.get(versionKey) || 0) + 1;
    this.memoryVersions.set(versionKey, version);

    return { version, totalBuffered: list.length };
  }

  /**
   * Attempts to drain and combine the buffered messages if the version matches.
   * If the version in Redis is HIGHER than the version passed here, it means
   * another message arrived during the debounce delay — so we return null to skip!
   */
  async drainIfLatest(
    businessId: string,
    callerNumber: string,
    expectedVersion: number
  ): Promise<DrainedBatch | null> {
    const bufferKey = this.getBufferKey(businessId, callerNumber);
    const versionKey = this.getVersionKey(businessId, callerNumber);

    if (this.redis) {
      const currentVersion = await this.redis.get<number>(versionKey);

      // If a newer text arrived, this trigger is stale — ignore it!
      if (currentVersion !== null && currentVersion !== expectedVersion) {
        return null;
      }

      // Read all messages accumulated in the list
      const rawItems = await this.redis.lrange<string>(bufferKey, 0, -1);
      if (!rawItems || rawItems.length === 0) {
        return null;
      }

      // Clean up the keys now that we are consuming them
      await this.redis.del(bufferKey);
      await this.redis.del(versionKey);

      const parsed: BufferedMessage[] = rawItems.map((item) =>
        typeof item === 'string' ? JSON.parse(item) : item
      );

      const combinedText = parsed
        .map((p) => p.text.trim())
        .filter(Boolean)
        .join('\n');

      const combinedMediaUrls = parsed.flatMap((p) => p.mediaUrls || []);

      return {
        combinedText,
        combinedMediaUrls,
        messageCount: parsed.length,
      };
    }

    // In-memory fallback
    const currentVersion = this.memoryVersions.get(versionKey) || 0;
    if (currentVersion !== expectedVersion) {
      return null;
    }

    const list = this.memoryLists.get(bufferKey) || [];
    if (list.length === 0) {
      return null;
    }

    this.memoryLists.delete(bufferKey);
    this.memoryVersions.delete(versionKey);

    const combinedText = list
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join('\n');

    const combinedMediaUrls = list.flatMap((p) => p.mediaUrls || []);

    return {
      combinedText,
      combinedMediaUrls,
      messageCount: list.length,
    };
  }
}

