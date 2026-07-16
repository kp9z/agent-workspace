import type { Metadata, Viewport } from 'next';
import { branding } from '@/lib/branding';
import './globals.css';

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#05080d' },
  ],
};

export const metadata: Metadata = {
  title: branding.workspaceName,
  description: `Private ${branding.workspaceName} browser UI`,
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/favicon.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const themeScript = `(() => {
    try {
      const stored = window.localStorage.getItem('hermes-web-ui:theme');
      const preference = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark';
      const effective = preference === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : preference === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.themePreference = preference;
      document.documentElement.dataset.theme = effective;
    } catch {
      document.documentElement.dataset.themePreference = 'dark';
      document.documentElement.dataset.theme = 'dark';
    }
  })();`;

  return (
    <html lang="en" className="h-full overflow-hidden" data-theme="dark" suppressHydrationWarning>
      <body className="h-full overflow-hidden">
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  );
}
