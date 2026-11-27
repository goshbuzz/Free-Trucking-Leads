import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FMCSA Lead Desk — DOT enricher',
  description:
    'Upload a list of USDOT numbers and download carrier contact, authority and insurance details from FMCSA.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0a2130',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
