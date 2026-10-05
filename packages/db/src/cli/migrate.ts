import path from 'node:path';
import dotenv from 'dotenv';
import { runMigrations } from '../admin';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const ownerUrl = process.env.DATABASE_OWNER_URL;
const password = process.env.APP_USER_PASSWORD;
if (!ownerUrl || !password) throw new Error('DATABASE_OWNER_URL and APP_USER_PASSWORD are required');
runMigrations(ownerUrl, password).then(
  () => console.log('migrations applied'),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
