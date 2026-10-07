'use client';

import { Button } from '@erq/ui';
import { useActionState } from 'react';
import { syncNowAction, type SyncNowState } from '@/app/(app)/connections/actions';

export function SyncNowButton({
  id,
  shop,
  canSync,
  describedBy,
}: {
  id: string;
  shop: string;
  canSync: boolean;
  /** Id of the element that explains the sync state (shown when the button is disabled). */
  describedBy: string;
}) {
  const [state, action, pending] = useActionState<SyncNowState, FormData>(syncNowAction, {});
  const message = state.error ?? (state.started === true ? 'Import started.' : null);
  const notStarted = state.started === false ? 'An import is already running.' : null;
  return (
    <form action={action} className="flex flex-col items-start gap-1">
      <input type="hidden" name="id" value={id} />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending || !canSync}
        aria-describedby={describedBy}
      >
        {pending ? 'Starting...' : 'Sync now'}
        <span className="sr-only"> {shop}</span>
      </Button>
      <p
        role="status"
        aria-live="polite"
        className={`text-xs ${state.error ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {message ?? notStarted}
      </p>
    </form>
  );
}
