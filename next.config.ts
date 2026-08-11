import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  output: 'standalone',
  // This repo lives beside other lockfiles; pin the tracing root to silence the
  // multi-lockfile workspace-root inference warning.
  outputFileTracingRoot: import.meta.dirname,
}

export default nextConfig
