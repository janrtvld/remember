import type { NextConfig } from 'next'

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  reactCompiler: true,
  productionBrowserSourceMaps: true,
  images: {
    unoptimized: true,
  },
}

export default config
