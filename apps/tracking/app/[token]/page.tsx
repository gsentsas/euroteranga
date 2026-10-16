import type { Metadata } from 'next';
import { PublicTracking } from '../../components/public-tracking';

export const metadata: Metadata = {
  title: 'Suivi de voyage — EURO TERANGA',
  robots: { index: false, follow: false },
};

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicTracking token={token} />;
}
