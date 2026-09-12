import { Injectable } from '@nestjs/common';
import type { TransactionClient } from '@restaurant-os/database';
import { Money, haversineMetres } from '@restaurant-os/domain';
import { BranchStatus, DeliveryZoneType, OrderType } from '@restaurant-os/types';

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface ZoneMatch {
  zoneId: string;
  zoneName: string;
  deliveryFee: Money;
  minimumOrder: Money | null;
  distanceMetres: number;
}

export interface BranchCandidate {
  branchId: string;
  branchName: string;
  distanceMetres: number | null;
  zone: ZoneMatch | null;
}

/**
 * Delivery zones and branch selection (ENGINEERING_SPEC.md 29).
 *
 * Deterministic rules only, as the spec requires for the first pass:
 *
 *   branch is ACTIVE and has delivery enabled
 *     -> a delivery zone contains the customer
 *       -> nearest such branch wins
 *
 * Capacity, live preparation time and route optimisation are explicitly later
 * work; putting a scoring model here now would make an unpredictable system
 * that nobody can explain to a restaurant owner asking why an order went to
 * the wrong branch.
 */
@Injectable()
export class DeliveryZoneService {
  /**
   * The zone covering a point at a given branch, or null if it delivers no
   * further. Overlapping zones are resolved by `sortOrder`, so a cheap inner
   * zone beats the wider one it sits inside.
   */
  async findZoneForPoint(
    tx: TransactionClient,
    branchId: string,
    point: Coordinates,
    currency = 'PKR',
  ): Promise<ZoneMatch | null> {
    const zones = await tx.deliveryZone.findMany({
      where: { branchId, isActive: true },
      orderBy: { sortOrder: 'asc' },
    });

    for (const zone of zones) {
      if (
        zone.type !== DeliveryZoneType.RADIUS ||
        zone.centerLatitude === null ||
        zone.centerLongitude === null ||
        zone.radiusMetres === null
      ) {
        continue;
      }

      const distance = haversineMetres(
        {
          latitude: Number(zone.centerLatitude),
          longitude: Number(zone.centerLongitude),
        },
        point,
      );

      if (distance <= zone.radiusMetres) {
        return {
          zoneId: zone.id,
          zoneName: zone.name,
          deliveryFee: Money.fromDecimalString(zone.deliveryFee.toString(), currency),
          minimumOrder: zone.minimumOrder
            ? Money.fromDecimalString(zone.minimumOrder.toString(), currency)
            : null,
          distanceMetres: distance,
        };
      }
    }

    return null;
  }

  /**
   * Branches that can serve this order, nearest first.
   *
   * For pickup and dine-in, distance is informational and every open branch
   * qualifies — the customer chooses. For delivery, a branch qualifies only if
   * one of its zones covers the address.
   */
  async findEligibleBranches(
    tx: TransactionClient,
    input: { orderType: OrderType; point?: Coordinates | null; currency?: string },
  ): Promise<BranchCandidate[]> {
    const currency = input.currency ?? 'PKR';

    const branches = await tx.branch.findMany({
      where: {
        status: BranchStatus.ACTIVE,
        ...(input.orderType === OrderType.DELIVERY ? { deliveryEnabled: true } : {}),
        ...(input.orderType === OrderType.PICKUP ? { pickupEnabled: true } : {}),
        ...(input.orderType === OrderType.DINE_IN ? { dineInEnabled: true } : {}),
      },
    });

    const candidates: BranchCandidate[] = [];

    for (const branch of branches) {
      const distance =
        input.point && branch.latitude !== null && branch.longitude !== null
          ? haversineMetres(
              { latitude: Number(branch.latitude), longitude: Number(branch.longitude) },
              input.point,
            )
          : null;

      if (input.orderType !== OrderType.DELIVERY) {
        candidates.push({
          branchId: branch.id,
          branchName: branch.name,
          distanceMetres: distance,
          zone: null,
        });
        continue;
      }

      if (!input.point) continue;

      const zone = await this.findZoneForPoint(tx, branch.id, input.point, currency);
      if (zone) {
        candidates.push({
          branchId: branch.id,
          branchName: branch.name,
          distanceMetres: distance,
          zone,
        });
      }
    }

    // Nearest first; branches with no coordinates sort last rather than
    // pretending to be at distance zero.
    return candidates.sort((a, b) => {
      if (a.distanceMetres === null) return 1;
      if (b.distanceMetres === null) return -1;
      return a.distanceMetres - b.distanceMetres;
    });
  }

  /**
   * The delivery fee for an order.
   *
   * A matching zone's fee wins over the tenant default, because that is the
   * whole point of drawing a zone. A free-delivery threshold overrides both.
   */
  resolveDeliveryFee(input: {
    orderType: OrderType;
    zone: ZoneMatch | null;
    defaultFee: Money;
    freeDeliveryAbove: Money | null;
    discountedSubtotal: Money;
  }): Money {
    if (input.orderType !== OrderType.DELIVERY) {
      return Money.zero(input.defaultFee.currency);
    }

    if (
      input.freeDeliveryAbove &&
      !input.discountedSubtotal.lessThan(input.freeDeliveryAbove)
    ) {
      return Money.zero(input.defaultFee.currency);
    }

    return input.zone ? input.zone.deliveryFee : input.defaultFee;
  }
}
