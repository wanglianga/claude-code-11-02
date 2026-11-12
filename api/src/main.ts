import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import path from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.setGlobalPrefix('api');
  // 证据文件（原始报表/截图）静态服务：/api/static/**
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
  app.getHttpAdapter().getInstance().use('/api/static', express.static(dataDir));
  app.enableCors({ origin: true, credentials: false });
  const port = +(process.env.PORT || 8080);
  await app.listen(port, '0.0.0.0');
  console.log(`[api] listening on :${port}, data dir: ${dataDir}`);
}
bootstrap();
