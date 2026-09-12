'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '@/lib/session';

/**
 * Entry point. Sends a signed-in user to the live order list and everyone else
 * to sign in; there is no marketing page to land on.
 */
export default function Home() {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (session.status === 'authenticated') router.replace('/orders');
    if (session.status === 'anonymous') router.replace('/login');
  }, [session.status, router]);

  return (
    <div className="auth">
      <p className="muted">Loading…</p>
    </div>
  );
}
