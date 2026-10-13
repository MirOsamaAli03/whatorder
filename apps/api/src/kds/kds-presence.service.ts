import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Whether a branch has a live kitchen screen (ENGINEERING_SPEC.md 70; B-17).
 *
 * The stream heartbeats every 15 seconds and the browser can tell when those
 * stop. That covers the case where somebody is standing in front of the screen
 * — and does nothing for the case that matters: the tablet is asleep, or off
 * the wifi, or the tab was closed at the end of yesterday's service. To the
 * kitchen there are simply no orders, which looks exactly like a quiet evening.
 *
 * So each heartbeat is also written down, once per branch. The worker reads it
 * and raises the alarm when a branch has orders waiting and no screen that has
 * said anything for two minutes.
 */
@Injectable()
export class KdsPresenceService {
  private readonly logger = new Logger(KdsPresenceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records that a screen at this branch is alive.
   *
   * Clearing `offlineAlertedAt` here is the whole recovery mechanism: a screen
   * that comes back says so, which re-arms the alarm for the next outage. No
   * separate "back online" path can therefore be forgotten.
   */
  async touch(tenantId: string, branchId: string, connected = false): Promise<void> {
    const now = new Date();

    try {
      await this.prisma.forTenant(tenantId, (tx) =>
        tx.kdsPresence.upsert({
          where: { branchId },
          create: {
            tenantId,
            branchId,
            lastSeenAt: now,
            lastConnectedAt: now,
          },
          update: {
            lastSeenAt: now,
            offlineAlertedAt: null,
            ...(connected ? { lastConnectedAt: now } : {}),
          },
        }),
      );
    } catch (error) {
      // Deliberately swallowed. This is a monitoring side-effect on the hot
      // path of a kitchen screen; a database hiccup must not tear down the
      // stream the kitchen is actually working from. The consequence of losing
      // one heartbeat is at worst one false alarm, which is the right way round
      // — a monitor that fails loudly beats one that fails silent.
      this.logger.warn(
        { err: error, tenantId, branchId },
        'Could not record kitchen screen presence',
      );
    }
  }
}
