import type {
  MenuItemAvailability,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
} from '@restaurant-os/types';

/**
 * The shapes the API actually returns.
 *
 * Note that every monetary field is a `string`, never a number. The API emits
 * fixed two-place decimals and the UI renders them verbatim; parsing one into a
 * float to "format" it is exactly the mistake the Money type exists to prevent
 * (plan §2.6). Nothing in the dashboard adds up a bill.
 */

export interface Branch {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  city: string | null;
  status: string;
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  dineInEnabled: boolean;
}

export interface MenuModifierOption {
  id: string;
  name: string;
  priceDelta: string;
  isDefault: boolean;
  isAvailable: boolean;
}

export interface MenuModifier {
  id: string;
  name: string;
  selectionType: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  options: MenuModifierOption[];
}

export interface MenuVariant {
  id: string;
  name: string;
  price: string;
  isDefault: boolean;
}

export interface MenuItem {
  id: string;
  categoryId: string | null;
  name: string;
  nameLocalized: Record<string, string>;
  description: string | null;
  imageUrl: string | null;
  currency: string;
  preparationTimeMinutes: number;
  sortOrder: number;
  isActive: boolean;

  /** Tenant-wide values, for management screens. */
  basePrice: string;
  baseAvailability: MenuItemAvailability;

  /** Resolved for the requested branch. Equal to the base when none applies. */
  price: string;
  availability: MenuItemAvailability;
  hasBranchOverride: boolean;
  isVisible: boolean;

  variants: MenuVariant[];
  modifiers: MenuModifier[];
}

export interface MenuCategory {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  items: MenuItem[];
}

export interface Menu {
  branchId: string | null;
  categories: MenuCategory[];
  uncategorized: MenuItem[];
}

export interface OrderItem {
  id: string;
  name: string;
  variantName: string | null;
  quantity: number;
  unitPrice: string;
  totalPrice: string;
  notes: string | null;
  modifiers: Array<{ modifierName: string; optionName: string; priceDelta: string }>;
}

export interface Order {
  id: string;
  orderNumber: string;
  branchId: string;
  customerId: string | null;
  source: string;
  orderType: OrderType;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  businessDate: string;
  currency: string;
  totals: {
    subtotal: string;
    discountAmount: string;
    serviceCharge: string;
    deliveryFee: string;
    taxAmount: string;
    total: string;
  };
  customerName: string | null;
  customerPhone: string;
  deliveryAddress: string | null;
  tableLabel: string | null;
  notes: string | null;
  cancellationReason: string | null;
  timestamps: Record<string, string | null>;
  /** Computed by the API's state machine. The UI renders buttons for these. */
  allowedTransitions: OrderStatus[];
  completionStatus: OrderStatus;
  items: OrderItem[];
  history: Array<{
    fromStatus: OrderStatus | null;
    toStatus: OrderStatus;
    actorId: string | null;
    reason: string | null;
    at: string;
  }>;
}

export interface KdsCard {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  column: 'NEW' | 'ACCEPTED' | 'PREPARING' | 'READY';
  orderType: OrderType;
  source: string;
  customerName: string | null;
  tableLabel: string | null;
  hasDeliveryAddress: boolean;
  notes: string | null;
  elapsedSeconds: number;
  urgency: 'NORMAL' | 'WARNING' | 'CRITICAL';
  isUnacknowledged: boolean;
  placedAt: string;
  items: Array<{
    id: string;
    name: string;
    variantName: string | null;
    quantity: number;
    notes: string | null;
    modifiers: string[];
  }>;
}

export interface KdsSnapshot {
  branchId: string;
  branchName: string;
  /** Watermark for gap detection against the live stream. */
  sequence: string;
  serverTime: string;
  acknowledgementTimeoutSeconds: number;
  urgency: { warningSeconds: number; criticalSeconds: number };
  columns: Record<'NEW' | 'ACCEPTED' | 'PREPARING' | 'READY', KdsCard[]>;
  counts: Record<'NEW' | 'ACCEPTED' | 'PREPARING' | 'READY', number>;
  unacknowledged: number;
}

export interface UnacknowledgedReport {
  thresholdSeconds: number;
  count: number;
  orders: Array<{
    id: string;
    orderNumber: string;
    branchId: string;
    orderType: OrderType;
    source: string;
    confirmedAt: string | null;
    waitingSeconds: number;
    escalations: Array<{
      level: number;
      target: string;
      delaySeconds: number;
      at: string;
      resolvedAt: string | null;
    }>;
  }>;
}

/** What arrives over the SSE stream. */
export interface RealtimeEvent {
  sequence: string;
  eventId: string;
  eventType: string;
  tenantId: string;
  branchId: string | null;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}
