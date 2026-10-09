import { Card, CardContent, CardHeader, CardTitle } from '@erq/ui';
import { hasRole, type ConnectionDto } from '@erq/shared';
import { ConnectShopify, ReconnectShopify } from '@/components/connect-shopify';
import { DisconnectButton } from '@/components/disconnect-button';
import { SyncNowButton } from '@/components/sync-now-button';
import { apiFetch } from '@/lib/api';
import { loadAppContext } from '@/lib/app-context';
import {
  describeConnection,
  describeResources,
  describeSync,
  describeUnlinked,
  REFRESH_NOTE,
  connectionsErrorMessage,
  shopifyWarningMessage,
  type ConnectionView,
} from '@/lib/connections';

type Param = string | string[] | undefined;
const first = (v: Param): string | undefined => (Array.isArray(v) ? v[0] : v);

const TONE_CLASS: Record<ConnectionView['tone'], string> = {
  ok: 'bg-muted font-semibold',
  warn: 'border border-destructive text-destructive',
  muted: 'bg-muted text-muted-foreground',
};

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, Param>>;
}) {
  const params = await searchParams;
  const { active } = await loadAppContext();
  // Never show the raw error; the Connect card stays usable.
  const connections = await apiFetch<ConnectionDto[]>(`/orgs/${active.orgId}/connections`, {
    orgId: active.orgId,
  }).catch(() => null);
  const isAdmin = hasRole(active.role, 'admin');
  const now = new Date();

  // Messages come from fixed maps; query text is never rendered.
  const connected = first(params.shopify) === 'connected';
  const errorMessage = connectionsErrorMessage(first(params.shopify_error));
  const warningMessage = shopifyWarningMessage(first(params.warning));

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Connections</h1>

      {connected && (
        <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">
          Your Shopify store is connected. We are loading your data now.
        </p>
      )}
      {connected && warningMessage && (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {warningMessage}
        </p>
      )}
      {errorMessage && (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {errorMessage}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Connect Shopify</CardTitle>
        </CardHeader>
        <CardContent>
          {isAdmin ? (
            <ConnectShopify />
          ) : (
            <p className="text-sm text-muted-foreground">Ask an admin to connect your store.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your stores</CardTitle>
        </CardHeader>
        <CardContent>
          {connections === null ? (
            <p role="alert" className="text-sm text-destructive">
              We could not load your connections. Please refresh the page.
            </p>
          ) : connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Connect your Shopify store to see your real profit. It takes about a minute.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {connections.map((c) => {
                const v = describeConnection(c, now);
                const s = describeSync(c.sync, c.lastSyncedAt, now, c);
                const lines = describeResources(c.sync, now);
                const unlinked = describeUnlinked(c.sync.unlinkedLines);
                const syncId = `sync-${c.id}`;
                return (
                  <li
                    key={c.id}
                    className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="break-all font-medium">{c.shop}</p>
                      <p className="text-sm text-muted-foreground">{v.detail}</p>
                      <div id={syncId} className="mt-1 text-sm">
                        <p
                          className={
                            s.tone === 'warn' ? 'font-medium text-destructive' : 'font-medium'
                          }
                        >
                          {s.headline}
                        </p>
                        {s.detail && <p className="text-muted-foreground">{s.detail}</p>}
                        {lines.length > 0 && (
                          <ul
                            aria-label={`Import status for ${c.shop}`}
                            className="mt-1 flex flex-col gap-0.5"
                          >
                            {lines.map((line) => (
                              <li
                                key={line.resource}
                                title={line.hint}
                                tabIndex={0}
                                className={`rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${
                                  line.tone === 'warn'
                                    ? 'text-destructive'
                                    : 'text-muted-foreground'
                                }`}
                              >
                                {line.text}
                                <span className="sr-only"> ({line.hint})</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {unlinked && <p className="text-muted-foreground">{unlinked}</p>}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${TONE_CLASS[v.tone]}`}>
                        {v.label}
                      </span>
                      {isAdmin && c.platform === 'shopify' && v.canReconnect && (
                        <ReconnectShopify shop={c.shop} />
                      )}
                      {isAdmin && c.platform === 'shopify' && c.status !== 'disconnected' && (
                        <SyncNowButton
                          id={c.id}
                          shop={c.shop}
                          canSync={s.canSync}
                          describedBy={syncId}
                        />
                      )}
                      {isAdmin && c.status !== 'disconnected' && c.status !== 'demo' && (
                        <DisconnectButton id={c.id} shop={c.shop} />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {connections !== null && connections.length > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">{REFRESH_NOTE}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
