export type SyncResource = 'products' | 'locations' | 'inventory' | 'orders';
/** Dependency order: inventory and orders refer to locations and products. */
export const SYNC_RESOURCES: readonly SyncResource[] = [
  'locations',
  'products',
  'inventory',
  'orders',
];
export type LocationType = 'warehouse' | 'store' | '3pl' | 'fba' | 'other';
export type ProductStatus = 'active' | 'draft' | 'archived';
export type SalesChannel = 'shopify_online' | 'shopify_pos';
export type OrderStatus = 'open' | 'closed' | 'cancelled';

export interface NormalizedLocation {
  externalId: string;
  name: string;
  type: LocationType;
  address: string | null;
  isActive: boolean;
}
export interface NormalizedVariant {
  externalId: string;
  skuCode: string | null;
  barcode: string | null;
  priceCents: number;
  compareAtPriceCents: number | null;
  currency: string;
  unitCostCents: number | null;
  updatedAt: Date;
}
export interface NormalizedProduct {
  externalId: string;
  title: string;
  brand: string | null;
  category: string | null;
  status: ProductStatus;
  updatedAt: Date;
  variants: NormalizedVariant[];
}
export interface NormalizedInventoryLevel {
  externalVariantId: string;
  locationExternalId: string;
  onHand: number;
  reserved: number;
  incoming: number;
  updatedAt: Date;
}
export interface NormalizedOrderLine {
  externalLineId: string;
  externalVariantId: string | null;
  title: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
}
export interface NormalizedRefundLine {
  externalLineId: string;
  quantity: number;
  amountCents: number;
}
export interface NormalizedRefund {
  externalId: string;
  refundedAt: Date;
  /** Refunded amount excluding tax. */
  amountCents: number;
  shippingRefundCents: number;
  restock: boolean;
  lines: NormalizedRefundLine[];
}
export interface NormalizedOrder {
  externalId: string;
  channel: SalesChannel;
  status: OrderStatus;
  placedAt: Date;
  cancelledAt: Date | null;
  currency: string;
  grossCents: number;
  discountCents: number;
  shippingChargedCents: number;
  taxCents: number;
  customerExternalId: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  landingSite: string | null;
  isTest: boolean;
  updatedAt: Date;
  lines: NormalizedOrderLine[];
  refunds: NormalizedRefund[];
}
