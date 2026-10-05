import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

loadEnvConfig(path.resolve(process.cwd(), '../..'));

const config: NextConfig = {
  eslint: { ignoreDuringBuilds: true }, // linting runs from the repo root
};
export default config;
