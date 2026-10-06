'use client';

import { Button } from '@erq/ui';

export default function ConnectionsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="text-2xl font-semibold">Connections</h1>
      <p role="alert" className="text-sm text-destructive">
        Something went wrong loading this page.
      </p>
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
