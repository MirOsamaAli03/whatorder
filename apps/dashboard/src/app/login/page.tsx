'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, login, type OrganizationChoice } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Sign-in.
 *
 * Handles the case the API surfaces rather than hiding it: a person who works
 * for two organizations gets asked which one they are signing in to, because
 * one email can hold memberships in several tenants (plan §2.4).
 */
export default function LoginPage() {
  const router = useRouter();
  const session = useSession();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [choices, setChoices] = useState<OrganizationChoice['organizations'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (session.status === 'authenticated') router.replace('/orders');
  }, [session.status, router]);

  async function submit(event: FormEvent, organizationSlug?: string) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      const result = await login(email, password, organizationSlug);

      if ('organizationSelectionRequired' in result) {
        setChoices(result.organizations);
        return;
      }

      await session.reload();
      router.replace('/orders');
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        setFieldErrors(caught.fieldErrors);
      } else {
        setError('Could not reach the server. Check that the API is running.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (choices) {
    return (
      <main className="auth">
        <div className="auth-card card stack">
          <div>
            <h1>Choose an organization</h1>
            <p className="faint">This account belongs to more than one.</p>
          </div>

          {error ? <div className="banner banner-error">{error}</div> : null}

          <div className="stack" style={{ gap: 8 }}>
            {choices.map((organization) => (
              <button
                key={organization.id}
                type="button"
                className="btn"
                disabled={submitting}
                onClick={(event) => void submit(event, organization.slug)}
                style={{ justifyContent: 'space-between', width: '100%' }}
              >
                <span>{organization.name}</span>
                <span className="faint">{organization.type}</span>
              </button>
            ))}
          </div>

          <button type="button" className="btn btn-sm" onClick={() => setChoices(null)}>
            Back
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="auth">
      <form className="auth-card card stack" onSubmit={(event) => void submit(event)}>
        <div>
          <h1>Restaurant OS</h1>
          <p className="faint">Sign in to your dashboard</p>
        </div>

        {error ? (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        ) : null}

        <div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            {fieldErrors.email ? <p className="field-error">{fieldErrors.email}</p> : null}
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {fieldErrors.password ? <p className="field-error">{fieldErrors.password}</p> : null}
          </div>
        </div>

        <button type="submit" className="btn btn-primary btn-lg" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
