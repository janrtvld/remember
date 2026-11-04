import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  redirects() {
    return ['/buy', '/license', '/thanks'].map((source) => ({
      source,
      destination: '/download',
      permanent: true,
    }))
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
