import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import { ContactPickButton } from '../../components/forms';
import { Empty, ErrorMessage, Field, FormActions, Modal, Money, Notice, PageHeader, PhoneLinks, QueryGate } from '../../components/ui';
import { useAction, useGuests, useLocale } from '../../hooks/data';
import * as api from '../../services/api';
import type { Guest } from '../../types/database';
import { formatDate } from '../../utils/format';
import { findPossibleDuplicates, matchesContact } from '../../utils/phone';

/** Create or edit a contact. Only the name is required; similar contacts produce a warning, not a block. */
export function GuestDialog({ guest, onClose }: { guest?: Guest; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { workspace } = useApp();
  const guests = useGuests();
  const [form, setForm] = useState<api.GuestInput>({
    full_name: guest?.full_name ?? '',
    phone: guest?.phone ?? '',
    email: guest?.email ?? '',
    notes: guest?.notes ?? '',
  });
  const [submitted, setSubmitted] = useState(false);
  const duplicates = form.full_name.trim() ? findPossibleDuplicates(guests.data ?? [], { id: guest?.id, ...form }) : [];
  const emailInvalid = form.email.trim() !== '' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim());
  const action = useAction(
    async () => (guest ? (await api.updateGuest(guest.id, form), guest.id) : api.createGuest(workspace.id, form)),
    (id) => {
      onClose();
      if (!guest) navigate(`/guests/${id}`);
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!form.full_name.trim() || emailInvalid) return;
    action.run(undefined);
  };
  return (
    <Modal title={guest ? t('guests.editTitle') : t('guests.newTitle')} onClose={onClose}>
      <form onSubmit={submit} className="stack" noValidate>
        {guest ? null : <ContactPickButton onPick={(contact) => setForm({ ...form, ...contact })} />}
        <Field label={t('common.name')} error={submitted && !form.full_name.trim() ? t('validation.nameRequired') : null}>
          <input type="text" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} autoFocus />
        </Field>
        <Field label={t('common.phoneOptional')} hint={t('guests.phoneHint')}>
          <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label={t('common.emailOptional')} error={submitted && emailInvalid ? t('validation.invalidEmail') : null}>
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label={t('common.notesOptional')} hint={t('guests.notesHint')}>
          <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
        {duplicates.length > 0 ? <Notice kind="warning">{t('guests.duplicateWarning', { names: duplicates.map((d) => d.full_name).join(', ') })}</Notice> : null}
        <ErrorMessage error={action.error} />
        <FormActions onCancel={onClose} pending={action.pending} submitLabel={t('common.save')} />
      </form>
    </Modal>
  );
}

export function GuestsPage() {
  const { t } = useTranslation();
  const locale = useLocale();
  const guests = useGuests();
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const rows = (guests.data ?? []).filter((g) => (showArchived || !g.archived_at) && matchesContact(g, query));

  return (
    <>
      <PageHeader
        title={t('nav.guests')}
        actions={
          <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
            + {t('guests.newTitle')}
          </button>
        }
      />
      <div className="toolbar">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('guests.searchPlaceholder')} aria-label={t('common.search')} />
        <label className="check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          {t('guests.showArchived')}
        </label>
      </div>
      <QueryGate queries={[guests]}>
        {() =>
          rows.length === 0 ? (
            <Empty>{t('guests.empty')}</Empty>
          ) : (
            <table className="rtable">
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('common.phone')}</th>
                  <th>{t('common.email')}</th>
                  <th className="num">{t('guests.bookingsCount')}</th>
                  <th className="num">{t('guests.totalAgreed')}</th>
                  <th>{t('guests.lastStay')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => (
                  <tr key={g.id} className={g.archived_at ? 'row-muted' : ''}>
                    <td data-label={t('common.name')}>
                      <Link to={`/guests/${g.id}`} className="strong-link">
                        {g.full_name}
                      </Link>
                      {g.archived_at ? <span className="badge">{t('guests.archived')}</span> : null}
                    </td>
                    <td data-label={t('common.phone')}>{g.phone ? <PhoneLinks phone={g.phone} /> : '—'}</td>
                    <td data-label={t('common.email')}>{g.email ? <a href={`mailto:${g.email}`}>{g.email}</a> : '—'}</td>
                    <td data-label={t('guests.bookingsCount')} className="num">
                      {g.bookings_count}
                    </td>
                    <td data-label={t('guests.totalAgreed')} className="num">
                      <Money value={g.total_agreed} />
                    </td>
                    <td data-label={t('guests.lastStay')}>{formatDate(g.last_stay_end, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </QueryGate>
      {creating ? <GuestDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
