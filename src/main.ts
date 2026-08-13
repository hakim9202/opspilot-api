import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { loadDotEnv } from './load-env';

async function bootstrap() {
  loadDotEnv();
  const app = await NestFactory.create(AppModule);
  // HTML dashboard forms post application/x-www-form-urlencoded.
  app.use(json());
  app.use(urlencoded({ extended: true }));
  const port = Number(process.env.PORT || 3000);
  // Prefer dual-stack (::) so localhost (::1) and 127.0.0.1 both work on macOS.
  // Fall back to 0.0.0.0 if IPv6 is unavailable.
  const host = process.env.HOST || '::';
  const server = await app.listen(port, host);
  try {
    server.setTimeout?.(0);
  } catch {
    /* ignore */
  }
  const hasOpenAi =
    Boolean(process.env.OPENAI_API_KEY?.trim()) &&
    !process.env.OPENAI_API_KEY!.trim().startsWith('crsr_');
  const hasCursor = Boolean(process.env.CURSOR_API_KEY?.trim());
  const ai = hasOpenAi
    ? 'openai-compatible'
    : hasCursor
      ? 'cursor-sdk'
      : 'not configured';
  console.log(`OpsPilot API listening on http://${host === '::' ? '[::]' : host}:${port}`);
  console.log(`Dashboard: http://localhost:${port}/dashboard`);
  console.log(`License:   http://localhost:${port}/dashboard/license`);
  console.log(`Security:  http://localhost:${port}/dashboard/security`);
  console.log(`Redaction: http://localhost:${port}/dashboard/redaction`);
  console.log(`AI suggestions: ${ai}`);
}
bootstrap();
