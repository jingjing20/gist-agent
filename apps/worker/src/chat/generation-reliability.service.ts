import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { workerConfig } from '@gist/config';
import Redis from 'ioredis';

export interface GenerationPermit { token: string; keys: string[] }

@Injectable()
export class GenerationReliabilityService implements OnApplicationShutdown {
  private readonly environment = workerConfig();
  private readonly redis = new Redis(this.environment.redisUrl, { maxRetriesPerRequest: 1 });

  async acquire(input: { generationId: string; userId: number; provider: string; token: string }): Promise<GenerationPermit | null> {
    const keys = [
      `${this.environment.eventKeyPrefix}:semaphore:global`,
      `${this.environment.eventKeyPrefix}:semaphore:provider:${input.provider}`,
      `${this.environment.eventKeyPrefix}:semaphore:user:${input.userId}`,
    ];
    const limits = [this.environment.globalConcurrency, this.environment.providerConcurrency, this.environment.userConcurrency];
    const deadline = Date.now() + this.environment.semaphoreWaitMs;
    do {
      const now = Date.now();
      const acquired = Number(await this.redis.eval(`
        local now = tonumber(ARGV[1])
        local expires = tonumber(ARGV[2])
        local token = ARGV[3]
        for i = 1, #KEYS do
          redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
          if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[i + 3]) then return 0 end
        end
        for i = 1, #KEYS do
          redis.call('ZADD', KEYS[i], expires, token)
          redis.call('PEXPIRE', KEYS[i], expires - now + 1000)
        end
        return 1
      `, keys.length, ...keys, now, now + this.environment.leaseTtlMs, input.token, ...limits));
      if (acquired === 1) return { token: input.token, keys };
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() <= deadline);
    return null;
  }

  async renew(permit: GenerationPermit): Promise<boolean> {
    const renewed = Number(await this.redis.eval(`
      local count = 0
      for i = 1, #KEYS do
        if redis.call('ZSCORE', KEYS[i], ARGV[1]) then
          redis.call('ZADD', KEYS[i], ARGV[2], ARGV[1])
          redis.call('PEXPIRE', KEYS[i], ARGV[3])
          count = count + 1
        end
      end
      return count
    `, permit.keys.length, ...permit.keys, permit.token, Date.now() + this.environment.leaseTtlMs, this.environment.leaseTtlMs + 1000));
    return renewed === permit.keys.length;
  }

  async release(permit: GenerationPermit): Promise<void> {
    await this.redis.eval("for i = 1, #KEYS do redis.call('ZREM', KEYS[i], ARGV[1]) end return 1", permit.keys.length, ...permit.keys, permit.token);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'ready') await this.redis.quit();
    else this.redis.disconnect();
  }
}
