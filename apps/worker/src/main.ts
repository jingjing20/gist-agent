import 'reflect-metadata';
import { loadWorkspaceEnv, workerConfig } from '@gist/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  loadWorkspaceEnv();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const { healthPort } = workerConfig();
  await app.listen(healthPort, '0.0.0.0');
  console.log(`Worker health server listening on http://localhost:${healthPort}`);
}

void bootstrap();
