import type { MetadataRoute } from 'next';
export default function manifest(): MetadataRoute.Manifest {
  return { name: 'Free Trucking Leads by GoshBuzz', short_name: 'Trucking Leads', description: 'Search public US carrier and insurance data.', start_url: '/', display: 'standalone', background_color: '#0a2130', theme_color: '#0a2130', icons: [{ src: '/logo-192.png', sizes: '192x192', type: 'image/png' }, { src: '/logo-512.png', sizes: '512x512', type: 'image/png' }] };
}
