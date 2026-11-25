import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext';
import { LanguageSwitch } from '../../app/Layout';
import { useMembers } from '../../components/AuditList';
import { ErrorMessage, Field, FormActions, Modal, Notice, PageHeader, QueryGate } from '../../components/ui';
import { useAction, useLocale } from '../../hooks/data';
import * as api from '../../services/api';
import type { MemberRole, Property } from '../../types/database';
import { formatDate } from '../../utils/format';
import { useAuth } from '../auth/AuthContext';

const TIME_ZONES = ['Europe/Madrid', 'Atlantic/Canary', 'Europe/Lisbon', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Rome'];

function PropertyDialog({ property, onClose }: { property?: Property; onClose: () => void }) {
  const { t } = useTranslation();
  const { workspace } = useApp();
  const [form, setForm] = useState<api.PropertyInput>({
    name: property?.name ?? '',
    address: property?.address ?? '',
    timezone: property?.timezone ?? 'Europe/Madrid',
    notes: property?.notes ?? '',
  });
  const [submitted, setSubmitted] = useState(false);
  const zones = TIME_ZONES.includes(form.timezone) ? TIME_ZONES : [form.timezone, ...TIME_ZONES];
  const action = useAction(() => (property ? api.updateProperty(property.id, form) : api.createProperty(workspace.id, form)), onClose);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (form.name.trim()) action.run(undefined);
  };
  return (
    <Modal title={property ? t('settings.editProperty') : t('settings.addProperty')} onClose={onClose}>
      <form onSubmit={submit} className="stack" noValidate>
        <Field label={t('common.name')} error={submitted && !form.name.trim() ? t('validation.nameRequired') : null}>
          <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        </Field>
        <Field label={t('settings.addressOptional')}>
          <input type="text" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
        <Field label={t('settings.timeZone')} hint={t('settings.timeZoneHint')}>
          <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('common.notesOptional')}>
          <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
        <ErrorMessage error={action.error} />
        <FormActions onCancel={onClose} pending={action.pending} submitLabel={t('common.save')} />
      </form>
    </Modal>
  );
}

function PropertiesSection() {
  const { t } = useTranslation();
  const { allProperties, isAdmin } = useApp();
  const [dialog, setDialog] = useState<{ property?: Property } | null>(null);
  const archive = useAction(({ id, archived }: { id: string; archived: boolean }) => api.setPropertyArchived(id, archived));
  return (
    <section className="section">
      <div className="section-head">
        <h2>{t('settings.properties')}</h2>
        {isAdmin ? (
          <button type="button" className="button" onClick={() => setDialog({})}>
            + {t('settings.addProperty')}
          </button>
        ) : null}
      </div>
      <ErrorMessage error={archive.error} />
      <ul className="card-list">
        {allProperties.map((p) => (
          <li key={p.id} className={p.archived_at ? 'card row-muted' : 'card'}>
            <div className="card-row">
              <strong>{p.name}</strong>
              {p.archived_at ? <span className="badge">{t('guests.archived')}</span> : null}
            </div>
            <p className="muted small">
              {p.address ? `${p.address} · ` : ''}
              {p.timezone} · {t('settings.checkInTime', { time: p.check_in_time.slice(0, 5) })}
            </p>
            {p.notes ? <p className="small">{p.notes}</p> : null}
            <div className="button-row">
              <button type="button" className="button" onClick={() => setDialog({ property: p })}>
                {t('common.edit')}
              </button>
              {allProperties.filter((x) => !x.archived_at).length > 1 || p.archived_at ? (
                <button type="button" className="button" disabled={archive.pending} onClick={() => archive.run({ id: p.id, archived: !p.archived_at })}>
                  {p.archived_at ? t('guests.unarchive') : t('guests.archive')}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {dialog ? <PropertyDialog property={dialog.property} onClose={() => setDialog(null)} /> : null}
    </section>
  );
}

function MembersSection() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { workspace, isAdmin, userId } = useApp();
  const members = useMembers();
  const invitations = useQuery({
    queryKey: ['invitations', workspace.id],
    queryFn: () => api.listInvitations(workspace.id),
    enabled: isAdmin,
    refetchInterval: false,
  });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('member');
  const [submitted, setSubmitted] = useState(false);
  const invite = useAction(
    () => api.inviteMember(workspace.id, email, role),
    () => {
      setEmail('');
      setSubmitted(false);
    },
  );
  const revoke = useAction((id: string) => api.revokeInvitation(id));
  const remove = useAction((id: string) => api.removeMember(workspace.id, id));
  const changeRole = useAction(({ id, next }: { id: string; next: MemberRole }) => api.setMemberRole(workspace.id, id, next));
  const emailInvalid = !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  return (
    <section className="section">
      <h2>{t('settings.members')}</h2>
      <p className="muted small">{t('settings.membersExplain')}</p>
      <ErrorMessage error={remove.error ?? changeRole.error ?? revoke.error} />
      <QueryGate queries={[members]}>
        {() => (
          <ul className="card-list">
            {members.data!.map((m) => (
              <li key={m.user_id} className="card">
                <div className="card-row">
                  <strong>{m.email}</strong>
                  <span className="badge">{t(`role.${m.role}`)}</span>
                </div>
                <p className="muted small">
                  {t('settings.memberSince', { date: formatDate(m.created_at.slice(0, 10), locale) })}
                  {m.user_id === userId ? ` · ${t('settings.you')}` : ''}
                </p>
                {isAdmin && m.user_id !== userId ? (
                  <div className="button-row">
                    <button type="button" className="button" disabled={changeRole.pending} onClick={() => changeRole.run({ id: m.user_id, next: m.role === 'admin' ? 'member' : 'admin' })}>
                      {m.role === 'admin' ? t('settings.makeMember') : t('settings.makeAdmin')}
                    </button>
                    <button type="button" className="button button-danger-outline" disabled={remove.pending} onClick={() => remove.run(m.user_id)}>
                      {t('settings.removeMember')}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </QueryGate>
      {isAdmin ? (
        <>
          <h3>{t('settings.invite')}</h3>
          <form
            className="stack"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(true);
              if (!emailInvalid) invite.run(undefined);
            }}
          >
            <div className="grid-2">
              <Field label={t('common.email')} error={submitted && emailInvalid ? t('validation.invalidEmail') : null}>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label={t('settings.role')}>
                <select value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
                  <option value="member">{t('role.member')}</option>
                  <option value="admin">{t('role.admin')}</option>
                </select>
              </Field>
            </div>
            <ErrorMessage error={invite.error} />
            <div className="button-row">
              <button type="submit" className="button button-primary" disabled={invite.pending}>
                {t('settings.sendInvite')}
              </button>
            </div>
            <p className="muted small">{t('settings.inviteExplain')}</p>
          </form>
          {(invitations.data ?? []).length > 0 ? (
            <>
              <h3>{t('settings.pendingInvitations')}</h3>
              <ul className="plain-list">
                {invitations.data!.map((inv) => (
                  <li key={inv.id} className="card-row">
                    <span>
                      {inv.email} · {t(`role.${inv.role}`)}
                    </span>
                    <button type="button" className="link-button" disabled={revoke.pending} onClick={() => revoke.run(inv.id)}>
                      {t('settings.revoke')}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function AccountSection() {
  const { t } = useTranslation();
  const { user, signOut, changePassword } = useAuth();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const action = useAction(
    () => changePassword(password),
    () => {
      setPassword('');
      setSubmitted(false);
      setDone(true);
    },
  );
  const tooShort = password.length < 8;
  return (
    <section className="section">
      <h2>{t('settings.account')}</h2>
      <p>{user?.email}</p>
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          setDone(false);
          if (!tooShort) action.run(undefined);
        }}
      >
        <Field label={t('settings.newPassword')} error={submitted && tooShort ? t('validation.passwordLength') : null}>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        {done ? <Notice kind="success">{t('settings.passwordChanged')}</Notice> : null}
        <ErrorMessage error={action.error} />
        <div className="button-row">
          <button type="submit" className="button" disabled={action.pending}>
            {t('settings.changePassword')}
          </button>
          <button type="button" className="button button-danger-outline" onClick={() => void signOut()}>
            {t('nav.signOut')}
          </button>
        </div>
      </form>
    </section>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { setLocale, workspaces, workspace, setWorkspaceId } = useApp();
  return (
    <>
      <PageHeader title={t('nav.settings')} />
      <section className="section">
        <h2>{t('settings.language')}</h2>
        <LanguageSwitch onChange={setLocale} />
        <p className="muted small">{t('settings.languageExplain')}</p>
      </section>
      {workspaces.length > 1 ? (
        <section className="section">
          <h2>{t('settings.workspace')}</h2>
          <select value={workspace.id} onChange={(e) => setWorkspaceId(e.target.value)} aria-label={t('settings.workspace')}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </section>
      ) : null}
      <PropertiesSection />
      <MembersSection />
      <AccountSection />
    </>
  );
}
