import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
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
import { ErrorMessage, Field, HoldDeadline, Notice, PageHeader } from '../../components/ui';
import { useAction, useBlocking } from '../../hooks/data';
import * as api from '../../services/api';
import { availabilityFor } from '../../utils/availability';
import { isISODate } from '../../utils/dates';

/** Direct booking, without going through a prospect. */
export function NewBookingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { workspace, properties, selectedProperty, timeZone } = useApp();
  const blocking = useBlocking();
  const [propertyId, setPropertyId] = useState(selectedProperty?.id ?? properties[0]?.id ?? '');
  const [guest, setGuest] = useState<GuestChoice>(emptyGuestChoice(params.get('guest') ?? ''));
  const [start, setStart] = useState(params.get('start') ?? '');
  const [end, setEnd] = useState(params.get('end') ?? '');
  const [price, setPrice] = useState<PriceDraft>(emptyPrice());
  const [status, setStatus] = useState<'confirmed' | 'provisional'>('confirmed');
  const [submitted, setSubmitted] = useState(false);

  const stayError = validateStay(start, end);
  const guestError = validateGuestChoice(guest);
  const parsed = parsePrice(price);
  const availability = !stayError && isISODate(start) && isISODate(end) && propertyId ? availabilityFor(blocking.data ?? [], propertyId, start, end) : null;
  const createdGuestId = useRef<string | undefined>(undefined);
  const action = useAction(
    async () => {
      createdGuestId.current ??= await resolveGuest(workspace.id, guest);
      return api.createBooking(propertyId, createdGuestId.current, status, { ...parsed.value!, start_date: start, end_date: end });
    },
    (id) => navigate(`/bookings/${id}`, { replace: true }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!propertyId || stayError || guestError || parsed.error) return;
    action.run(undefined);
  };
  const blocker = availability?.blockers[0];

  return (
    <>
      <PageHeader
        back={
          <Link to="/bookings" className="back-link">
            ← {t('nav.bookings')}
          </Link>
        }
        title={t('bookings.new')}
      />
      <form onSubmit={submit} className="stack form-page" noValidate>
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
        <GuestPicker value={guest} onChange={setGuest} error={submitted && guestError ? t(guestError) : null} />
        <StayFields
          start={start}
          end={end}
          onChange={(s, e) => {
            setStart(s);
            setEnd(e);
          }}
          error={submitted && stayError ? t(stayError) : null}
        />
        {availability && blocker && status === 'confirmed' ? (
          <Notice kind="warning">
            {blocker.kind === 'booking' ? (
              t('errors.DATES_BOOKED', { guest: blocker.guest_name })
            ) : (
              <>
                {t('prospects.heldBy', { guest: blocker.guest_name })} <HoldDeadline expiresAt={blocker.expires_at!} timeZone={timeZone} />
              </>
            )}
          </Notice>
        ) : null}
        <PriceFields draft={price} onChange={setPrice} start={isISODate(start) ? start : ''} end={isISODate(end) ? end : ''} error={submitted && parsed.error ? t(parsed.error) : null} />
        <fieldset className="fieldset">
          <legend>{t('common.status')}</legend>
          <label className="check">
            <input type="radio" name="booking-status" checked={status === 'confirmed'} onChange={() => setStatus('confirmed')} />
            <span>
              <strong>{t('status.booking.confirmed')}</strong> — {t('bookings.confirmedHint')}
            </span>
          </label>
          <label className="check">
            <input type="radio" name="booking-status" checked={status === 'provisional'} onChange={() => setStatus('provisional')} />
            <span>
              <strong>{t('status.booking.provisional')}</strong> — {t('bookings.provisionalHint')}
            </span>
          </label>
        </fieldset>
        <ErrorMessage error={action.error} />
        <div className="form-actions">
          <Link to="/bookings" className="button">
            {t('common.cancel')}
          </Link>
          <button type="submit" className="button button-primary" disabled={action.pending} aria-busy={action.pending}>
            {action.pending ? t('common.saving') : t('bookings.create')}
          </button>
        </div>
      </form>
    </>
  );
}
