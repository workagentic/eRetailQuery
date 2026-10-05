import { createBrowserClient } from '@supabase/ssr';
import { supabaseConfig } from './config';

export function createSupabaseBrowserClient() {
  const { url, key } = supabaseConfig();
  return createBrowserClient(url, key);
}
