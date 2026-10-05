'use client';

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@erq/ui';
import { use, useState, useTransition } from 'react';
import { acceptInviteAction } from './actions';

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>You have been invited</CardTitle>
          <CardDescription>
            Accept to join the team. You must be signed in with the email that was invited.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div aria-live="polite">
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await acceptInviteAction(token);
                if (r?.error) setError(r.error);
              })
            }
          >
            Accept invite
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
