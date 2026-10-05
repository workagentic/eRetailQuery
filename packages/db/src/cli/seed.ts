import path from 'node:path';
import dotenv from 'dotenv';
import { seedDemoOrg } from '../admin';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) throw new Error('DATABASE_OWNER_URL is required');
seedDemoOrg(ownerUrl).then(
  () => console.log('demo org seeded'),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
