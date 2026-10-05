'use client';

import { Label } from '@erq/ui';
import type { OrgSummary } from '@erq/shared';
import { switchOrgAction } from '@/app/(app)/actions';

export function OrgSwitcher({ orgs, activeId }: { orgs: OrgSummary[]; activeId: string }) {
  if (orgs.length < 2) return null;
  return (
    <form action={switchOrgAction} className="flex items-center gap-2">
      <Label htmlFor="orgId" className="sr-only">
        Business
      </Label>
      <select
        id="orgId"
        name="orgId"
        defaultValue={activeId}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-9 rounded-md border border-border bg-background px-2 text-sm"
      >
        {orgs.map((o) => (
          <option key={o.orgId} value={o.orgId}>
            {o.name}
          </option>
        ))}
      </select>
    </form>
  );
}
