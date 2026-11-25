import type { Blocking, Candidate } from '../types/database';
import { rangesOverlap, type ISODate } from './dates';

export type AvailabilityState = 'free' | 'held' | 'booked';

export interface Availability {
  state: AvailabilityState;
  /** Everything that blocks at least one night of the range, bookings first. */
  blockers: Blocking[];
}

/**
 * Availability of [start, end) on a property, from the rows the database currently reports
 * as blocking (confirmed/completed bookings and effective holds). Candidates never block.
 * This is for display only; the database decides again when an action is submitted.
 */
export function availabilityFor(blocking: Blocking[], propertyId: string, start: ISODate, end: ISODate): Availability {
  const blockers = blocking
    .filter((b) => b.property_id === propertyId && rangesOverlap(start, end, b.start_date, b.end_date))
    .sort((a, b) => (a.kind === b.kind ? a.start_date.localeCompare(b.start_date) : a.kind === 'booking' ? -1 : 1));
  const state: AvailabilityState = blockers.some((b) => b.kind === 'booking') ? 'booked' : blockers.length > 0 ? 'held' : 'free';
  return { state, blockers };
}

/** Open candidates in *other* periods of the same property whose dates overlap the given range. */
export function overlappingCandidates(candidates: Candidate[], propertyId: string, periodId: string, start: ISODate, end: ISODate): Candidate[] {
  return candidates.filter(
    (c) =>
      c.property_id === propertyId &&
      c.booking_period_id !== periodId &&
      c.status !== 'discarded' &&
      c.status !== 'confirmed' &&
      rangesOverlap(start, end, c.start_date, c.end_date),
  );
}
