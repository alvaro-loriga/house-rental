import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import {
  emptyGuestChoice,
  emptyPrice,
  GuestPicker,
  parsePrice,
  PriceFields,
  resolveGuest,
  StayFields,
  validateGuestChoice,
  validateStay,
  type GuestChoice,
  type PriceDraft,
} from '../../components/forms';
import { ErrorMessage, Field, FormActions, HoldDeadline, Modal, Notice } from '../../components/ui';
import { useAction, useLocale } from '../../hooks/data';
import * as api from '../../services/api';
import { EDITABLE_CANDIDATE_STATUSES, type Candidate, type CandidateStatus, type Period } from '../../types/database';
import type { Availability } from '../../utils/availability';
import { formatDateRange, formatMoney } from '../../utils/format';
import { parseMoney } from '../../utils/money';

interface CandidateDraft {
  status: CandidateStatus;
  price: string;
  notes: string;
}

function CandidateFields({ draft, onChange, priceError }: { draft: CandidateDraft; onChange: (next: CandidateDraft) => void; priceError: string | null }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="grid-2">
        <Field label={t('prospects.proposedPrice')} error={priceError}>
          <input type="text" inputMode="decimal" value={draft.price} onChange={(e) => onChange({ ...draft, price: e.target.value })} />
        </Field>
        <Field label={t('common.status')}>
          <select value={draft.status} onChange={(e) => onChange({ ...draft, status: e.target.value as CandidateStatus })}>
            {EDITABLE_CANDIDATE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`status.candidate.${status}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={t('common.notesOptional')}>
        <textarea rows={2} value={draft.notes} onChange={(e) => onChange({ ...draft, notes: e.target.value })} />
      </Field>
    </>
  );
}

const parseCandidate = (draft: CandidateDraft): { input: api.CandidateInput | null; invalid: boolean } => {
  const price = draft.price.trim() === '' ? null : parseMoney(draft.price);
  if (draft.price.trim() !== '' && price == null) return { input: null, invalid: true };
  return { input: { status: draft.status, proposed_price: price, notes: draft.notes }, invalid: false };
};

/** New potential period, optionally with its first interested guest. */
export function NewPeriodDialog({ onClose, initialStart = '', initialEnd = '' }: { onClose: () => void; initialStart?: string; initialEnd?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { workspace, properties, selectedProperty } = useApp();
  const [propertyId, setPropertyId] = useState(selectedProperty?.id ?? properties[0]?.id ?? '');
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [notes, setNotes] = useState('');
  const [withGuest, setWithGuest] = useState(true);
  const [guest, setGuest] = useState<GuestChoice>(emptyGuestChoice());
  const [candidate, setCandidate] = useState<CandidateDraft>({ status: 'interested', price: '', notes: '' });
  const [submitted, setSubmitted] = useState(false);

  const stayError = validateStay(start, end);
  const guestError = withGuest ? validateGuestChoice(guest) : null;
  const parsed = parseCandidate(candidate);
  // Remembers what an earlier, partly failed attempt already created, so a retry never
  // produces a second period or a duplicate contact.
  const created = useRef<{ periodId?: string; guestId?: string }>({});
  const action = useAction(
    async () => {
      created.current.periodId ??= await api.createPeriod(workspace.id, propertyId, start, end, notes);
      const periodId = created.current.periodId;
      if (withGuest && parsed.input) {
        created.current.guestId ??= await resolveGuest(workspace.id, guest);
        await api.createCandidate(workspace.id, periodId, created.current.guestId, parsed.input);
      }
      return periodId;
    },
    (periodId) => {
      onClose();
      navigate(`/prospects/${periodId}`);
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!propertyId || stayError || guestError || (withGuest && parsed.invalid)) return;
    action.run(undefined);
  };

  return (
    <Modal title={t('prospects.newPeriod')} onClose={onClose} wide>
      <form onSubmit={submit} className="stack" noValidate>
        {properties.length > 1 ? (
          <Field label={t('common.property')}>
            <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <StayFields
          start={start}
          end={end}
          onChange={(s, e) => {
            setStart(s);
            setEnd(e);
          }}
          error={submitted && stayError ? t(stayError) : null}
        />
        <Field label={t('prospects.periodNotes')}>
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={withGuest} onChange={(e) => setWithGuest(e.target.checked)} />
          {t('prospects.addFirstCandidate')}
        </label>
        {withGuest ? (
          <>
            <GuestPicker value={guest} onChange={setGuest} error={submitted && guestError ? t(guestError) : null} />
            <CandidateFields draft={candidate} onChange={setCandidate} priceError={submitted && parsed.invalid ? t('validation.invalidAmount') : null} />
          </>
        ) : null}
        <p className="muted small">{t('prospects.nonBlockingHint')}</p>
        <ErrorMessage error={action.error} />
        <FormActions onCancel={onClose} pending={action.pending} submitLabel={t('common.save')} />
      </form>
    </Modal>
  );
}

/** Add a guest to a period, or edit an existing candidate's price / status / notes. */
export function CandidateDialog({ period, candidate, existingGuestIds, availability, onClose }: { period: Period; candidate?: Candidate; existingGuestIds: string[]; availability: Availability; onClose: () => void }) {
  const { t } = useTranslation();
  const { workspace } = useApp();
  const [guest, setGuest] = useState<GuestChoice>(emptyGuestChoice());
  const [draft, setDraft] = useState<CandidateDraft>({
    status: candidate && candidate.status !== 'confirmed' ? candidate.status : 'interested',
    price: candidate?.proposed_price != null ? String(candidate.proposed_price) : '',
    notes: candidate?.notes ?? '',
  });
  const [submitted, setSubmitted] = useState(false);
  const guestError = candidate ? null : validateGuestChoice(guest);
  const parsed = parseCandidate(draft);
  const createdGuestId = useRef<string | undefined>(undefined);
  const action = useAction(async () => {
    if (candidate) return api.updateCandidate(candidate.id, parsed.input!);
    createdGuestId.current ??= await resolveGuest(workspace.id, guest);
    return api.createCandidate(workspace.id, period.id, createdGuestId.current, parsed.input!);
  }, onClose);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (guestError || parsed.invalid) return;
    action.run(undefined);
  };
  return (
    <Modal title={candidate ? t('prospects.editCandidate', { guest: candidate.guest_name }) : t('prospects.addCandidate')} onClose={onClose} wide>
      <form onSubmit={submit} className="stack" noValidate>
        {!candidate && availability.state !== 'free' ? <Notice kind="warning">{t(`prospects.enquiryWarning.${availability.state}`)}</Notice> : null}
        {candidate ? null : <GuestPicker value={guest} onChange={setGuest} exclude={existingGuestIds} error={submitted && guestError ? t(guestError) : null} />}
        <CandidateFields draft={draft} onChange={setDraft} priceError={submitted && parsed.invalid ? t('validation.invalidAmount') : null} />
        <ErrorMessage error={action.error} />
        <FormActions onCancel={onClose} pending={action.pending} submitLabel={t('common.save')} />
      </form>
    </Modal>
  );
}

/**
 * Confirm a candidate. Shows what will happen, asks whether to discard the other candidates,
 * warns about overlapping enquiries elsewhere, and - when somebody else holds the dates -
 * requires an admin to release that hold explicitly with a reason.
 */
export function ConfirmCandidateDialog({ candidate, others, overlapping, availability, onClose }: { candidate: Candidate; others: Candidate[]; overlapping: Candidate[]; availability: Availability; onClose: () => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const { isAdmin, timeZone } = useApp();
  const [price, setPrice] = useState<PriceDraft>(emptyPrice(candidate.proposed_price));
  const [discardOthers, setDiscardOthers] = useState(false);
  const [override, setOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const booked = availability.state === 'booked';
  const foreignHolds = availability.blockers.filter((b) => b.kind === 'hold' && b.candidate_id !== candidate.id);
  const ownHold = availability.blockers.find((b) => b.kind === 'hold' && b.candidate_id === candidate.id);
  const foreignHold = foreignHolds[0];
  const parsed = parsePrice(price);
  const openOthers = others.filter((c) => c.status !== 'discarded');
  const reasonMissing = Boolean(foreignHold) && override && overrideReason.trim() === '';

  const action = useAction(
    () =>
      api.confirmCandidate(candidate.id, {
        ...parsed.value!,
        discardOthers,
        overrideHoldId: foreignHold && override ? foreignHold.hold_id : null,
        overrideReason,
      }),
    (bookingId) => {
      onClose();
      navigate(`/bookings/${bookingId}`);
    },
  );
  const blocked = booked || (Boolean(foreignHold) && (!isAdmin || !override || foreignHolds.length > 1));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (blocked || parsed.error || reasonMissing) return;
    action.run(undefined);
  };

  return (
    <Modal title={t('prospects.confirmTitle', { guest: candidate.guest_name })} onClose={onClose} wide>
      <form onSubmit={submit} className="stack" noValidate>
        <p>
          {t('prospects.confirmSummary', {
            guest: candidate.guest_name,
            dates: formatDateRange(candidate.start_date, candidate.end_date, locale),
            property: candidate.property_name,
          })}
        </p>
        {booked ? <Notice kind="error">{t('errors.DATES_BOOKED', { guest: availability.blockers[0].guest_name })}</Notice> : null}
        {ownHold ? <Notice kind="info">{t('prospects.ownHoldConverted')}</Notice> : null}
        {!booked && foreignHold ? (
          <div className="alert alert-warning" role="alert">
            <p>
              {t('prospects.heldBy', { guest: foreignHold.guest_name })} <HoldDeadline expiresAt={foreignHold.expires_at!} timeZone={timeZone} />
            </p>
            {foreignHolds.length > 1 ? (
              <p>{t('prospects.severalHolds')}</p>
            ) : isAdmin ? (
              <>
                <label className="check">
                  <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                  {t('prospects.overrideCheck', { guest: foreignHold.guest_name })}
                </label>
                {override ? (
                  <Field label={t('prospects.overrideReason')} error={submitted && reasonMissing ? t('validation.reasonRequired') : null}>
                    <input type="text" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
                  </Field>
                ) : null}
              </>
            ) : (
              <p>{t('prospects.overrideAdminOnly')}</p>
            )}
          </div>
        ) : null}
        <PriceFields draft={price} onChange={setPrice} start={candidate.start_date} end={candidate.end_date} error={submitted && parsed.error ? t(parsed.error) : null} />
        {openOthers.length > 0 ? (
          <label className="check">
            <input type="checkbox" checked={discardOthers} onChange={(e) => setDiscardOthers(e.target.checked)} />
            {t('prospects.discardOthers', { count: openOthers.length, names: openOthers.map((c) => c.guest_name).join(', ') })}
          </label>
        ) : null}
        {overlapping.length > 0 ? (
          <Notice kind="warning">
            {t('prospects.overlapWarning')}{' '}
            {overlapping.map((c) => `${c.guest_name} (${formatDateRange(c.start_date, c.end_date, locale)}${c.proposed_price != null ? `, ${formatMoney(c.proposed_price, locale)}` : ''})`).join('; ')}
          </Notice>
        ) : null}
        <ErrorMessage error={action.error} />
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose} disabled={action.pending}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="button button-primary" disabled={action.pending || blocked} aria-busy={action.pending}>
            {action.pending ? t('common.saving') : t('prospects.confirmAction')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function EditPeriodDialog({ period, locked, onClose }: { period: Period; locked: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [start, setStart] = useState<string>(period.start_date);
  const [end, setEnd] = useState<string>(period.end_date);
  const [notes, setNotes] = useState(period.notes ?? '');
  const [submitted, setSubmitted] = useState(false);
  const stayError = validateStay(start, end);
  const action = useAction(
    () => api.updatePeriod(period.id, locked ? { notes: notes.trim() || null } : { start_date: start, end_date: end, notes: notes.trim() || null }),
    onClose,
  );
  return (
    <Modal title={t('prospects.editPeriod')} onClose={onClose}>
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (!locked && stayError) return;
          action.run(undefined);
        }}
      >
        {locked ? (
          <Notice kind="info">{t('errors.PERIOD_LOCKED')}</Notice>
        ) : (
          <StayFields
            start={start}
            end={end}
            onChange={(s, e) => {
              setStart(s);
              setEnd(e);
            }}
            error={submitted && stayError ? t(stayError) : null}
          />
        )}
        <Field label={t('prospects.periodNotes')}>
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorMessage error={action.error} />
        <FormActions onCancel={onClose} pending={action.pending} submitLabel={t('common.save')} />
      </form>
    </Modal>
  );
}
