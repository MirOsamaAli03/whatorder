'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AlertIcon, CheckIcon } from '@/components/icons';
import { ApiError, login, type OrganizationChoice } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Sign-in.
 *
 * Handles the case the API surfaces rather than hiding it: a person who works
 * for two organizations gets asked which one they are signing in to, because
 * one email can hold memberships in several tenants (plan §2.4).
 *
 * Two panels. The left one is not decoration: this is the first screen a
 * restaurant owner sees, and it is the only place in the product that says what
 * the product is. It collapses to a strip on tablet and disappears on a phone,
 * where the form is all that matters.
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

  return (
    <div className="app auth">
      <section className="auth-brand" aria-label="Restaurant OS">
        <div className="auth-logo">
          <span className="brand-mark" aria-hidden="true">
            R
          </span>
          Restaurant OS
        </div>

        <div className="stack" style={{ gap: 18 }}>
          {/* "Welcome", in Urdu. Marked with lang so a screen reader switches
              voice, and left out of the tablet layout where there is no room. */}
          <span className="auth-hello" lang="ur">
            خوش آمدید
          </span>
          <h2 className="auth-headline">Every WhatsApp order, one counter.</h2>
          <ul className="auth-points">
            <li>
              <CheckIcon />
              Orders arrive straight from WhatsApp
            </li>
            <li>
              <CheckIcon />
              A kitchen screen that shows what&rsquo;s running late
            </li>
            <li>
              <CheckIcon />
              Your menu in English and Urdu
            </li>
          </ul>
        </div>

        <span />
      </section>

      <section className="auth-panel">
        {choices ? (
          <div className="auth-card">
            <div className="stack" style={{ gap: 6 }}>
              <h1>Choose a restaurant</h1>
              <p className="muted">This account belongs to more than one.</p>
            </div>

            {error ? (
              <div className="alert alert-danger" role="alert">
                <AlertIcon />
                <div>{error}</div>
              </div>
            ) : null}

            <div className="stack" style={{ gap: 10 }}>
              {choices.map((organization) => (
                <button
                  key={organization.id}
                  type="button"
                  className="btn btn-lg org-choice"
                  disabled={submitting}
                  onClick={(event) => void submit(event, organization.slug)}
                >
                  <span>{organization.name}</span>
                  <span className="faint sm">{organization.type}</span>
                </button>
              ))}
            </div>

            <button type="button" className="btn btn-ghost" onClick={() => setChoices(null)}>
              Back
            </button>
          </div>
        ) : (
          <form className="auth-card" onSubmit={(event) => void submit(event)}>
            <div className="stack" style={{ gap: 6 }}>
              <h1>Sign in</h1>
              <p className="muted">Use the email your restaurant set you up with.</p>
            </div>

            {error ? (
              <div className="alert alert-danger" role="alert">
                <AlertIcon />
                <div>
                  <span className="alert-title">{error}</span>
                </div>
              </div>
            ) : null}

            <div className="field">
              <label className="field-label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                className="input"
                name="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                {...(fieldErrors.email ? { 'aria-invalid': true } : {})}
              />
              {fieldErrors.email ? (
                <p className="field-error">
                  <AlertIcon className="icon-sm" />
                  {fieldErrors.email}
                </p>
              ) : null}
            </div>

            <div className="field">
              <label className="field-label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                className="input"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                {...(fieldErrors.password ? { 'aria-invalid': true } : {})}
              />
              {fieldErrors.password ? (
                <p className="field-error">
                  <AlertIcon className="icon-sm" />
                  {fieldErrors.password}
                </p>
              ) : null}
            </div>

            <button type="submit" className="btn btn-primary btn-lg" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
