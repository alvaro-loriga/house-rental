/** Digits only, for searching ("+34 600 11 22 33" -> "34600112233"). */
export function phoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

/**
 * International form for tel: and WhatsApp links, or null when it cannot be derived safely.
 * A bare nine-digit Spanish number (starting 6, 7, 8 or 9) gets the +34 prefix; numbers
 * written with + or 00 keep their own country code. Anything else is left alone.
 */
export function toInternational(phone: string | null | undefined): string | null {
  const raw = (phone ?? '').trim();
  if (!raw) return null;
  const digits = phoneDigits(raw);
  if (raw.startsWith('+')) return digits.length >= 8 ? `+${digits}` : null;
  if (digits.startsWith('00')) return digits.length >= 10 ? `+${digits.slice(2)}` : null;
  if (/^[6789]\d{8}$/.test(digits)) return `+34${digits}`;
  return null;
}

export function telHref(phone: string | null | undefined): string | null {
  const digits = phoneDigits(phone);
  if (!digits) return null;
  return `tel:${toInternational(phone) ?? digits}`;
}

export function whatsappHref(phone: string | null | undefined): string | null {
  const international = toInternational(phone);
  return international ? `https://wa.me/${international.slice(1)}` : null;
}

const strip = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export interface ContactLike {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
}

/** Free-text match on name (accent-insensitive), normalized phone digits and e-mail. */
export function matchesContact(contact: ContactLike, query: string): boolean {
  const q = strip(query);
  if (!q) return true;
  if (strip(contact.full_name).includes(q)) return true;
  if (contact.email && contact.email.toLowerCase().includes(q)) return true;
  const qDigits = phoneDigits(query);
  return qDigits.length >= 3 && phoneDigits(contact.phone).includes(qDigits);
}

/** Existing contacts that look like the one being entered (same name, phone or e-mail). */
export function findPossibleDuplicates<T extends ContactLike>(
  contacts: T[],
  draft: { id?: string; full_name: string; phone?: string | null; email?: string | null },
): T[] {
  const name = strip(draft.full_name);
  const digits = phoneDigits(draft.phone);
  const email = (draft.email ?? '').trim().toLowerCase();
  return contacts.filter((c) => {
    if (c.id === draft.id) return false;
    if (name && strip(c.full_name) === name) return true;
    if (digits.length >= 9 && phoneDigits(c.phone).endsWith(digits.slice(-9))) return true;
    return Boolean(email) && (c.email ?? '').toLowerCase() === email;
  });
}
