import { alerts, webhookEvents, type Tx } from '@erq/db';
import { and, eq } from 'drizzle-orm';

/** Sweep retries a failed live-topic event gets before it stays failed and raises an alert. Must equal the literal in migration 0026. */
export const WEBHOOK_SWEEP_MAX_RETRIES = 5;
/**
 * Mandatory privacy topics: retried without limit and never alerted on here. This list must match the privacy
 * branch of migrations 0021 and 0026. Migration 0026 lists the budgeted (non-privacy) retries by the three LIVE
 * topics instead (`app/uninstalled`, `products/update`, `inventory_levels/update`), so any other failed topic is
 * never retried.
 */
export const MANDATORY_PRIVACY_TOPICS = [
  'customers/data_request',
  'customers/redact',
  'shop/redact',
] as const;

export function webhookAlertFor(topic: string): { severity: 'high' | 'medium'; message: string } {
  if (topic === 'app/uninstalled') {
    return {
      severity: 'high',
      message: 'Shopify could not tell us the shop uninstalled. Reconnect if you removed the app.',
    };
  }
  return {
    severity: 'medium',
    message:
      'A live update from Shopify could not be applied. We still check your store every 15 minutes, so nothing is lost.',
  };
}

/**
 * Called in the same transaction that marks an event `failed`. Writes the alert when the event has used up its
 * sweep retries; the partial unique index plus ON CONFLICT DO NOTHING keep it to one open alert per event.
 */
export async function raiseWebhookAlertIfExhausted(
  tx: Tx,
  a: { orgId: string; eventId: string; topic: string; storeConnectionId: string },
): Promise<void> {
  if ((MANDATORY_PRIVACY_TOPICS as readonly string[]).includes(a.topic)) return;
  const [event] = await tx
    .select({ retries: webhookEvents.sweepRetries })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.orgId, a.orgId), eq(webhookEvents.id, a.eventId)));
  if (!event || event.retries < WEBHOOK_SWEEP_MAX_RETRIES) return;
  const text = webhookAlertFor(a.topic);
  await tx
    .insert(alerts)
    .values({
      orgId: a.orgId,
      type: 'webhook_failed',
      severity: text.severity,
      storeConnectionId: a.storeConnectionId,
      entityRef: `webhook_event:${a.eventId}`,
      message: text.message,
    })
    .onConflictDoNothing();
}
