import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@erq/ui';
import { loadAppContext } from '@/lib/app-context';

export default async function DashboardPage() {
  const { active } = await loadAppContext();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{active.name}</h1>
      <Card>
        <CardHeader>
          <CardTitle>Connect your store to see your profit</CardTitle>
          <CardDescription>
            Once your Shopify store and ad accounts are connected, this page shows what you earned
            today, which ads to pause, and what is about to run out. Store connections arrive in the
            next release.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Your role: {active.role}
        </CardContent>
      </Card>
    </div>
  );
}
