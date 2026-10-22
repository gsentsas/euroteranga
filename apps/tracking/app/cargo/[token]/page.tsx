import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PublicCargoTracking } from '../../../components/public-cargo-tracking';

const TRACKING_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const metadata: Metadata = {
  title: 'Suivi fret — EURO TERANGA',
  robots: { index: false, follow: false },
};

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!TRACKING_TOKEN.test(token)) notFound();
  return <PublicCargoTracking token={token} />;
}
