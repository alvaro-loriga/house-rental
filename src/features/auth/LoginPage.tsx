import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LanguageSwitch } from '../../app/Layout';
import { Field } from '../../components/ui';
import { useBasicErrorText } from '../../hooks/data';
import { applyLocale } from '../../lib/i18n';
import { isConfigured } from '../../lib/supabase';
import { useAuth } from './AuthContext';

export function AuthShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-top">
          <h1>{t('app.name')}</h1>
          <LanguageSwitch onChange={(locale) => void applyLocale(locale)} />
        </div>
        {children}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { t } = useTranslation();
  const { signIn } = useAuth();
  const errorText = useBasicErrorText();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);

  const missing = !email.trim() || !password;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (missing || pending) return;
    setPending(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthShell>
      <p className="muted">{t('auth.intro')}</p>
      {!isConfigured ? (
        <p className="alert alert-warning" role="alert">
          {t('auth.notConfigured')}
        </p>
      ) : null}
      <form onSubmit={submit} noValidate className="stack">
        <Field label={t('common.email')} error={touched && !email.trim() ? t('validation.required') : null}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" inputMode="email" />
        </Field>
        <Field label={t('auth.password')} error={touched && !password ? t('validation.required') : null}>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        {error ? (
          <p className="alert alert-error" role="alert">
            {errorText(error)}
          </p>
        ) : null}
        <button type="submit" className="button button-primary button-block" disabled={pending} aria-busy={pending}>
          {pending ? t('auth.signingIn') : t('auth.signIn')}
        </button>
      </form>
      <p className="muted small">{t('auth.inviteOnly')}</p>
    </AuthShell>
  );
}
