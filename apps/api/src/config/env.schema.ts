import { z } from 'zod';

/**
 * Environment validation.
 *
 * Parsed once at boot; the process exits with a readable list of problems
 * rather than failing later with an undefined value halfway through a request.
 * Every variable here is documented in .env.example.
 */

const secret = (name: string) =>
  z
    .string()
    .min(32, `${name} must be at least 32 characters`)
    .refine(
      (value) => !value.startsWith('change_me') || process.env.NODE_ENV !== 'production',
      `${name} still holds its development placeholder; set a real secret in production`,
    );

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    DATABASE_URL: z.string().url(),
    DATABASE_URL_ADMIN: z.string().url().optional(),
    REDIS_URL: z.string().url(),

    PORT: z.coerce.number().int().positive().default(3001),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),

    JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
    JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
    /** Access token lifetime in seconds. Short by design; refresh rotates it. */
    JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
    /** Refresh token lifetime in seconds. */
    JWT_REFRESH_TTL: z.coerce.number().int().positive().default(2_592_000),

    /**
     * Meta's app secret, used to verify the HMAC on every inbound WhatsApp
     * webhook. Optional so development works without one; when it is absent the
     * check is skipped and a warning is logged on every request, because a
     * deployment that accepts unverified callbacks would let anyone mark
     * messages delivered or, from Phase 6, forge a customer's message.
     */
    WHATSAPP_WEBHOOK_SECRET: z.string().min(16).optional(),
    /** The token echoed back during Meta's one-time subscription handshake. */
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(8).optional(),

    RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_DEFAULT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  })
  .superRefine((env, ctx) => {
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      // Sharing one secret means an access token can be replayed as a refresh
      // token, defeating rotation and reuse detection entirely.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${problems}\n\n` +
        'Copy .env.example to .env and fill in the missing values.',
    );
  }

  return result.data;
}
