import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bulk URL Health Checker',
  description: 'Submit URLs, watch them get checked in the background.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="page">
          <h1>Bulk URL Health Checker</h1>
          {children}
        </main>
      </body>
    </html>
  );
}
