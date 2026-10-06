import 'reflect-metadata';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import dotenv from 'dotenv';
import { APP_CREATE_OPTIONS, configureApp } from './app.config';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  const app = await NestFactory.create(AppModule.register(env), APP_CREATE_OPTIONS);
  configureApp(app);
  app.enableCors({
    origin: env.WEB_PUBLIC_URL,
    allowedHeaders: ['authorization', 'content-type', 'x-org-id'],
  });
  app.enableShutdownHooks();
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('eRetailQuery API').setVersion('0.1').addBearerAuth().build(),
  );
  SwaggerModule.setup('docs', app, doc);
  await app.listen(env.API_PORT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
