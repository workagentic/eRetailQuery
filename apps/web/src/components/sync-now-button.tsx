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
  // Success messages disappear once a refresh says no new import can start (it is running now).
  const success =
    !canSync || state.started === undefined
      ? null
      : state.started
        ? 'Import started.'
        : 'An import is already running.';
  const message = state.error ?? success;
  return (
    <form action={action} className="flex flex-col items-start gap-1">
      <input type="hidden" name="id" value={id} />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending}
        aria-disabled={!canSync}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        onClick={(e) => {
          if (!canSync) e.preventDefault();
        }}
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
        {message}
      </p>
    </form>
  );
}
