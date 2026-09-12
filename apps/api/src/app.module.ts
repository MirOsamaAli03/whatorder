import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BranchesModule } from './branches/branches.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { RequestContextModule } from './common/request-context.module';
import { ConfigModule, ENV } from './config/config.module';
import { EventsModule } from './events/events.module';
import type { Env } from './config/env.schema';
import { HealthModule } from './health/health.module';
import { CartModule } from './cart/cart.module';
import { CustomersModule } from './customers/customers.module';
import { MenuModule } from './menu/menu.module';
import { NotificationsModule } from './notifications/notifications.module';
import { KdsModule } from './kds/kds.module';
import { OrdersModule } from './orders/orders.module';
import { PricingModule } from './pricing/pricing.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { StaffModule } from './staff/staff.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';

/**
 * The modular monolith (ENGINEERING_SPEC.md 4).
 *
 * Domain modules are separate and communicate through services, so any one of
 * them could later become its own process without rewriting callers. Rule 4:
 * no premature microservices.
 *
 * Guard order matters and is the order below:
 *   1. RateLimitGuard  — cheapest, and must apply to unauthenticated traffic.
 *   2. JwtAuthGuard    — establishes who the caller is.
 *   3. PermissionsGuard — decides what they may do.
 */
@Module({
  imports: [
    ConfigModule,
    RequestContextModule,
    /**
     * Structured logs with a request id on every line (ENGINEERING_SPEC.md 69).
     * Credentials and tokens are redacted at the logger rather than at each
     * call site, so a careless `log(request.body)` cannot leak a password.
     */
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              'req.body.password',
              'req.body.refreshToken',
              '*.passwordHash',
              '*.refreshTokenHash',
            ],
            censor: '[REDACTED]',
          },
          // Readable in a terminal during development, JSON everywhere else so
          // log aggregation works.
          transport:
            env.NODE_ENV === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } }
              : undefined,
          autoLogging: {
            ignore: (request) => request.url === '/health' || request.url === '/ready',
          },
        },
      }),
    }),
    PrismaModule,
    RedisModule,
    AuditModule,
    EventsModule,
    AuthModule,
    HealthModule,
    OrganizationsModule,
    BranchesModule,
    MenuModule,
    PricingModule,
    CustomersModule,
    CartModule,
    OrdersModule,
    RealtimeModule,
    KdsModule,
    StaffModule,
    WhatsAppModule,
    NotificationsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
