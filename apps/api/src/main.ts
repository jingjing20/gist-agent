import 'reflect-metadata';
import { loadWorkspaceEnv } from '@gist/config';
loadWorkspaceEnv();

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
    const app = await NestFactory.create(AppModule);
    app.enableCors();
    app.setGlobalPrefix('api');
    const port = Number(process.env.SERVER_PORT) || 3000;
    await app.listen(port);
    console.log(`Server running at http://localhost:${port}`);
}

bootstrap();
