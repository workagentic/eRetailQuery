import { Button, Card, CardContent, CardHeader, CardTitle } from '@erq/ui';
import { hasRole, type ConnectionDto } from '@erq/shared';
import { ConnectShopify, ReconnectShopify } from '@/components/connect-shopify';
import { apiFetch } from '@/lib/api';
import { loadAppContext } from '@/lib/app-context';
import {
  describeConnection,
  shopifyErrorMessage,
  shopifyWarningMessage,
  type ConnectionView,
} from '@/lib/connections';
import { disconnectConnection } from './actions';

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
  const connections = await apiFetch<ConnectionDto[]>(`/orgs/${active.orgId}/connections`, {
    orgId: active.orgId,
  });
  const isAdmin = hasRole(active.role, 'admin');
  const now = new Date();

  // Messages come from fixed maps; query text is never rendered.
  const connected = first(params.shopify) === 'connected';
  const errorMessage = shopifyErrorMessage(first(params.shopify_error));
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
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Connect your Shopify store to see your real profit. It takes about a minute.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {connections.map((c) => {
                const v = describeConnection(c, now);
                return (
                  <li
                    key={c.id}
                    className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="break-all font-medium">{c.shop}</p>
                      <p className="text-sm text-muted-foreground">{v.detail}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${TONE_CLASS[v.tone]}`}>
                        {v.label}
                      </span>
                      {isAdmin && c.platform === 'shopify' && v.canReconnect && (
                        <ReconnectShopify shop={c.shop} />
                      )}
                      {isAdmin && c.status !== 'disconnected' && c.status !== 'demo' && (
                        <form action={disconnectConnection}>
                          <input type="hidden" name="id" value={c.id} />
                          <Button type="submit" size="sm" variant="ghost">
                            Disconnect
                            <span className="sr-only"> {c.shop}</span>
                          </Button>
                        </form>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
