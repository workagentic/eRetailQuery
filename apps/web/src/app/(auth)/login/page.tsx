import { AuthForm } from '@/components/auth-form';
import { AuthLayout } from '@/components/auth-layout';
import { safeNextPath } from '@/lib/safe-next';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  return (
    <AuthLayout title="Sign in" subtitle="Welcome back. See what is making you money today.">
      <AuthForm mode="login" next={next} />
    </AuthLayout>
  );
}
