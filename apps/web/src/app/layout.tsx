import type { Metadata } from 'next';
import Link from 'next/link';
import { ThemeScript } from '@/components/ThemeScript';
import { ThemeToggle } from '@/components/ThemeToggle';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bulk URL Health Checker',
  description: 'Submit URLs, watch them get checked in the background.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // ThemeScript writes data-theme before React hydrates, so the attribute it sets
    // will not match the server HTML. That is the intent, not a bug.
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <main className="page">
          <header className="masthead">
            <div>
              <h1>
                <Link href="/" className="link" style={{ color: 'inherit' }}>
                  Bulk URL Health Checker
                </Link>
              </h1>
              <p className="tagline">Paste URLs, watch them checked in the background.</p>
            </div>
            <ThemeToggle />
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}
