import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { ENV } from '../src/config/config.module';
import { parseEnv } from '../src/config/env.schema';

/**
 * Rate limiting (ENGINEERING_SPEC.md 67) and health probes (69).
 *
 * The rest of the suite runs with a very high limit so that dozens of logins
 * from one address do not trip the limiter. Here the configured budget is
 * overridden downward instead, which exercises the real guard, the real Redis
 * counter and the real 429 envelope rather than a stub.
 */
describe('rate limiting and health', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const env = { ...parseEnv(), RATE_LIMIT_AUTH_PER_MINUTE: 3, LOG_LEVEL: 'silent' as const };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      .useValue(env)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 429 once the authentication budget is exhausted', async () => {
    // A unique address per run keeps the fixed-window counter from carrying
    // over between runs inside the same minute.
    const clientIp = `10.99.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': clientIp },
        remoteAddress: clientIp,
        payload: { email: 'nobody@nowhere.test', password: 'WrongPassword123!' },
      });
      statuses.push(response.statusCode);
    }

    // The first three are answered normally (401, wrong credentials), the rest
    // are refused by the limiter.
    expect(statuses.slice(0, 3).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(3).every((status) => status === 429)).toBe(true);
  });

  it('describes the refusal with the standard error envelope', async () => {
    const clientIp = `10.98.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': clientIp },
        remoteAddress: clientIp,
        payload: { email: 'nobody@nowhere.test', password: 'WrongPassword123!' },
      });
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-for': clientIp },
      remoteAddress: clientIp,
      payload: { email: 'nobody@nowhere.test', password: 'WrongPassword123!' },
    });

    expect(blocked.statusCode).toBe(429);
    const body = blocked.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RATE_LIMITED');
    // Every failure carries a request id so a complaint can be traced to a log
    // line (spec 62, 69).
    expect(body.error.requestId).toBeTruthy();
  });

  it('budgets each client separately', async () => {
    const noisy = `10.97.${Math.floor(Math.random() * 250)}.1`;
    const quiet = `10.97.${Math.floor(Math.random() * 250)}.2`;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': noisy },
        remoteAddress: noisy,
        payload: { email: 'nobody@nowhere.test', password: 'WrongPassword123!' },
      });
    }

    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-for': quiet },
      remoteAddress: quiet,
      payload: { email: 'nobody@nowhere.test', password: 'WrongPassword123!' },
    });

    // One abusive client must not lock everyone else out.
    expect(other.statusCode).toBe(401);
  });

  describe('health probes', () => {
    it('answers /health without touching dependencies', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.status).toBe('ok');
    });

    it('reports dependency state on /ready', async () => {
      const response = await app.inject({ method: 'GET', url: '/ready' });

      expect(response.statusCode).toBe(200);
      const body = response.json().data;
      expect(body.status).toBe('ready');
      expect(body.checks).toEqual({ database: true, redis: true });
    });

    it('leaves health probes unauthenticated', async () => {
      // An orchestrator has no credentials; a probe that needs a token is a
      // probe that reports the service down during every rollout.
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).not.toBe(401);
    });
  });
});
