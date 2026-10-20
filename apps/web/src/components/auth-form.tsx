'use client';

import { Button, Input, Label } from '@erq/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { isDemoMode } from '@/lib/demo-mode';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export function AuthForm({ mode, next }: { mode: 'login' | 'signup'; next: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isLogin = mode === 'login';
  const demo = isDemoMode(); // the demo has one provisioned login: no sign-up and no Google

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    const supabase = createSupabaseBrowserClient();
    const redirectTo = `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const result = isLogin
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
    setPending(false);
    if (result.error) return setError(result.error.message);
    if (!isLogin && !result.data.session)
      return setNotice('Check your email to confirm your account.');
    router.push(next);
    router.refresh();
  }

  async function google() {
    const supabase = createSupabaseBrowserClient();
    const redirectTo = `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const { error: e } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    });
    if (e) setError(e.message);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          minLength={8}
          required
          autoComplete={isLogin ? 'current-password' : 'new-password'}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <Button type="submit" disabled={pending} className="h-11">
        {isLogin ? 'Sign in' : 'Create account'}
      </Button>
      {!demo && (
        <Button type="button" variant="outline" onClick={google}>
          Continue with Google
        </Button>
      )}
      {!demo && (
      <p className="text-sm text-muted-foreground">
        {isLogin ? 'New here? ' : 'Already have an account? '}
        <Link
          className="underline"
          href={`${isLogin ? '/signup' : '/login'}?next=${encodeURIComponent(next)}`}
        >
          {isLogin ? 'Create an account' : 'Sign in'}
        </Link>
      </p>
      )}
    </form>
  );
}
