'use client';

import { Button, Input, Label } from '@erq/ui';
import { useActionState, useState } from 'react';
import { startShopifyInstall } from '@/app/(app)/connections/actions';
import { suggestShopDomain } from '@/lib/connections';

export function ConnectShopify() {
  const [state, action, pending] = useActionState(startShopifyInstall, undefined);
  const [shop, setShop] = useState('');
  const hint = suggestShopDomain(shop);
  return (
    <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex flex-1 flex-col gap-1.5">
        <Label htmlFor="shop">Your Shopify store address</Label>
        <Input
          id="shop"
          name="shop"
          placeholder="my-store.myshopify.com"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={shop}
          onChange={(e) => setShop(e.target.value)}
          aria-describedby="shop-hint"
        />
        <p id="shop-hint" className="text-sm text-muted-foreground">
          {shop.trim() === ''
            ? 'It looks like my-store.myshopify.com.'
            : hint.valid
              ? `We will connect ${hint.value}.`
              : 'That does not look like a Shopify address. Use the one ending in .myshopify.com.'}
        </p>
      </div>
      <p role="status" className="sr-only">
        {hint.valid ? 'Store address looks right.' : 'Store address is not valid yet.'}
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? 'Opening Shopify...' : 'Connect Shopify'}
      </Button>
      <div className="sm:basis-full" aria-live="polite">
        {state?.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}

export function ReconnectShopify({ shop }: { shop: string }) {
  const [state, action, pending] = useActionState(startShopifyInstall, undefined);
  return (
    <form action={action} className="flex flex-col items-start gap-1">
      <input type="hidden" name="shop" value={shop} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? 'Opening Shopify...' : 'Reconnect'}
        <span className="sr-only"> {shop}</span>
      </Button>
      {state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
