import path from 'node:path';
import dotenv from 'dotenv';
import { provisionDemoUser } from '../provision-demo';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.DEMO_LOGIN_EMAIL;
const password = process.env.DEMO_LOGIN_PASSWORD;
if (!supabaseUrl || !serviceRoleKey || !email || !password) {
  throw new Error(
    'SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEMO_LOGIN_EMAIL and DEMO_LOGIN_PASSWORD are required',
  );
}
provisionDemoUser({ supabaseUrl, serviceRoleKey, email, password }).then(
  (result) => console.log(`demo login ${result}: ${email}`),
  (e: Error) => {
    console.error(e.message);
    process.exit(1);
  },
);
