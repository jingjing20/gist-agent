import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { workerConfig } from '@gist/config';
import { GenerationService } from './generation.service';

@Injectable()
export class ZombieGenerationMonitorService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ZombieGenerationMonitorService.name);
  private readonly environment = workerConfig();
  private timer?: NodeJS.Timeout;
  private checking = false;

  constructor(private readonly generations: GenerationService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.checkOnce(), Math.max(1000, this.environment.heartbeatIntervalMs));
    this.timer.unref();
  }

  async checkOnce(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const recovered = await this.generations.failStale(this.environment.leaseTtlMs * 2);
      if (recovered) this.logger.error(`已终结 ${recovered} 个心跳超时的 generation`);
    } finally {
      this.checking = false;
    }
  }

  onApplicationShutdown(): void { if (this.timer) clearInterval(this.timer); }
}
