'use client';

import { Button, Input, Label } from '@erq/ui';
import { useActionState } from 'react';
import { createInviteAction, type InviteState } from '@/app/(app)/team/actions';

export function InviteForm() {
  const [state, action, pending] = useActionState<InviteState, FormData>(createInviteAction, {});
  return (
    <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex flex-1 flex-col gap-1.5">
        <Label htmlFor="email">Teammate email</Label>
        <Input id="email" name="email" type="email" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="role">Role</Label>
        <select
          id="role"
          name="role"
          defaultValue="viewer"
          className="h-10 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="viewer">Viewer</option>
          <option value="analyst">Analyst</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <Button type="submit" disabled={pending}>
        Send invite
      </Button>
      <div className="sm:basis-full" aria-live="polite">
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
        {state.acceptUrl && (
          <p className="text-sm">
            Share this link with your teammate (it works once, for 7 days):{' '}
            <code className="break-all">{state.acceptUrl}</code>
          </p>
        )}
      </div>
    </form>
  );
}
