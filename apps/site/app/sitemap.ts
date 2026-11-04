import type { MetadataRoute } from 'next'
import { absoluteSiteUrl } from '../lib/site'

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: absoluteSiteUrl('/'), changeFrequency: 'weekly', priority: 1 },
    { url: absoluteSiteUrl('/download'), changeFrequency: 'weekly', priority: 0.7 },
    { url: absoluteSiteUrl('/privacy'), changeFrequency: 'yearly', priority: 0.3 },
  ]
}
