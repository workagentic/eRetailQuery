'use client';

import { Button } from '@erq/ui';
import { useState } from 'react';
import { disconnectConnection } from '@/app/(app)/connections/actions';

// Two-step confirm so a stray click cannot disconnect a store.
export function DisconnectButton({ id, shop }: { id: string; shop: string }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(true)}>
        Disconnect
        <span className="sr-only"> {shop}</span>
      </Button>
    );
  }
  return (
    <form
      action={disconnectConnection}
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label={`Confirm disconnecting ${shop}`}
    >
      <input type="hidden" name="id" value={id} />
      <span className="text-sm">Are you sure?</span>
      {/* autoFocus moves keyboard focus into the confirm step the user just opened. */}
      <Button type="submit" size="sm" autoFocus>
        Yes, disconnect
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </form>
  );
}
