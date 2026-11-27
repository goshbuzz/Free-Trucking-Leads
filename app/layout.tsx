import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SITE_NAME, SITE_URL, SITE_DESCRIPTION, organizationJsonLd, websiteJsonLd } from '@/lib/site';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'Free Trucking Leads | New Authority & Renewal Leads by GoshBuzz', template: '%s | Free Trucking Leads by GoshBuzz' },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: 'GoshBuzz', url: 'https://goshbuzz.com' }],
  creator: 'GoshBuzz',
  alternates: { canonical: '/' },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, 'max-image-preview': 'large' } },
  openGraph: { type: 'website', siteName: SITE_NAME, url: SITE_URL, title: 'Free Trucking Leads by GoshBuzz', description: SITE_DESCRIPTION, images: [{ url: '/og-image.jpg', width: 1200, height: 630, alt: 'A truck on a US highway' }], locale: 'en_US' },
  twitter: { card: 'summary_large_image', title: 'Free Trucking Leads by GoshBuzz', description: SITE_DESCRIPTION, images: ['/og-image.jpg'] },
  icons: { icon: [{ url: '/favicon.ico', sizes: '48x48' }, { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' }, { url: '/logo-512.png', sizes: '512x512', type: 'image/png' }], apple: '/apple-touch-icon.png' },
  manifest: '/manifest.webmanifest',
  verification: { google: process.env.GOOGLE_SITE_VERIFICATION || undefined },
};
export const viewport: Viewport = { themeColor: '#0a2130', width: 'device-width', initialScale: 1 };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en-US"><head><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify([organizationJsonLd(), websiteJsonLd()]).replace(/</g, '\\u003c') }} /></head><body>{children}</body></html>;
}
