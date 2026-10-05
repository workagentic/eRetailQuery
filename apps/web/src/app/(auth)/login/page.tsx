import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@erq/ui';
import { AuthForm } from '@/components/auth-form';
import { safeNextPath } from '@/lib/safe-next';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Sign in to eRetailQuery</CardTitle>
          <CardDescription>See what is actually making you money.</CardDescription>
        </CardHeader>
        <CardContent>
          <AuthForm mode="login" next={next} />
        </CardContent>
      </Card>
    </main>
  );
}
