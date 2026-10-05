'use client';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@erq/ui';
import { useActionState } from 'react';
import { createOrgAction, type FormState } from './actions';

export default function OnboardingPage() {
  const [state, action, pending] = useActionState<FormState, FormData>(createOrgAction, {});
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Set up your business</CardTitle>
          <CardDescription>
            You can connect your store and ads next. This takes under a minute.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={action} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name">Business name</Label>
              <Input
                id="name"
                name="name"
                required
                minLength={2}
                maxLength={100}
                autoComplete="organization"
              />
            </div>
            {state.error && (
              <p role="alert" className="text-sm text-destructive">
                {state.error}
              </p>
            )}
            <Button type="submit" disabled={pending}>
              Create business
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
