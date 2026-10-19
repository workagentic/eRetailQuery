import { getProducts } from '@erq/db';
import { productsCsvResponse } from '@/lib/products-export';
import { loadReportContext } from '@/lib/report-context';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  return productsCsvResponse({
    isSignedIn: async () => {
      const supabase = await createSupabaseServerClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return user !== null;
    },
    loadRows: async () => {
      const params = Object.fromEntries(new URL(request.url).searchParams);
      const ctx = await loadReportContext(params);
      return ctx.db.withTenant(ctx.orgId, (tx) =>
        getProducts(tx, { range: ctx.range, channel: ctx.filters.channel, asOf: ctx.asOf }),
      );
    },
  });
}
