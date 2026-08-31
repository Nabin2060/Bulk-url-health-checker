import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@buhc/shared'],
  eslint: { ignoreDuringBuilds: true },
};

export default config;
