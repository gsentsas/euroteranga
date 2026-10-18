import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PublicTracking } from '../../components/public-tracking';

/** Public tracking tokens are 32 random bytes in base64url (43 characters). */
const TRACKING_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const metadata: Metadata = {
  title: 'Suivi de voyage — EURO TERANGA',
  robots: { index: false, follow: false },
};

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Any other path (robots.txt, favicon.ico, typos…) is a real 404, never an API call.
  if (!TRACKING_TOKEN.test(token)) notFound();
  return <PublicTracking token={token} />;
}
