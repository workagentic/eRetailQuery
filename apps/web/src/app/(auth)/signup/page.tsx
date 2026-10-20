import { AuthForm } from '@/components/auth-form';
import { AuthLayout } from '@/components/auth-layout';
import { safeNextPath } from '@/lib/safe-next';

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  return (
    <AuthLayout title="Create your account" subtitle="Connect a store and see your profit in minutes.">
      <AuthForm mode="signup" next={next} />
    </AuthLayout>
  );
}
