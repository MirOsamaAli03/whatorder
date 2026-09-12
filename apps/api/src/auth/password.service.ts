import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Password hashing (ENGINEERING_SPEC.md 66).
 *
 * Argon2id with parameters at the OWASP-recommended floor. Argon2 is memory
 * hard, which is what makes GPU cracking of a leaked hash table expensive in a
 * way bcrypt no longer reliably is.
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  private readonly options: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19_456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  };

  /**
   * A hash of a value nobody knows, used to burn the same CPU time when an
   * email does not exist. Without it, login response time reveals which
   * addresses are registered.
   */
  private dummyHash: string | null = null;

  async hash(password: string): Promise<string> {
    return argon2.hash(password, this.options);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch (error) {
      // A malformed stored hash is a data problem, not a wrong password.
      this.logger.error({ err: error }, 'Password verification failed to run');
      return false;
    }
  }

  /** Equalises timing for a login attempt against an unknown email address. */
  async burnTimingBudget(): Promise<void> {
    this.dummyHash ??= await this.hash('unused-placeholder-for-timing-equalisation');
    await this.verify(this.dummyHash, 'definitely-not-the-password');
  }

  /**
   * True when a stored hash was produced with weaker parameters than the
   * current policy, so it can be transparently upgraded on next login.
   */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, this.options);
    } catch {
      return true;
    }
  }
}
