import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  allowedDevOrigins: ['*.e2b.app'],
  // Enrichment talks to FMCSA / data.transportation.gov from the server only.
  // No images or third-party scripts are used, so the default CSP surface stays small.
  async headers() {
    const baseHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ];
    if (process.env.NODE_ENV === 'production') {
      baseHeaders.push({ key: 'X-Frame-Options', value: 'SAMEORIGIN' });
    }
    return [
      {
        source: '/(.*)',
        headers: baseHeaders,
      },
    ];
  },
};

export default nextConfig;
