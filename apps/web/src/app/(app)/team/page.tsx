import { Card, CardContent, CardHeader, CardTitle } from '@erq/ui';
import { hasRole, type MemberDto } from '@erq/shared';
import { InviteForm } from '@/components/invite-form';
import { apiFetch } from '@/lib/api';
import { loadAppContext } from '@/lib/app-context';

export default async function TeamPage() {
  const { active } = await loadAppContext();
  const members = await apiFetch<MemberDto[]>(`/orgs/${active.orgId}/members`, {
    orgId: active.orgId,
  });
  const canInvite = hasRole(active.role, 'admin');
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Team</h1>
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {members.map((m) => (
              <li key={m.userId} className="flex justify-between py-2 text-sm">
                <span className="font-mono">{m.userId.slice(0, 8)}</span>
                <span className="capitalize">{m.role}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {canInvite ? (
        <Card>
          <CardHeader>
            <CardTitle>Invite a teammate</CardTitle>
          </CardHeader>
          <CardContent>
            <InviteForm />
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only admins and owners can invite teammates.
        </p>
      )}
    </div>
  );
}
