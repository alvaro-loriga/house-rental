// Phone address book, through the browser's Contact Picker API (Chrome on Android).
// The browser shows its own picker and hands over only the one contact the person chooses,
// and only the fields requested here. Nothing is read in the background.

export interface PickedContact {
  full_name: string;
  phone: string;
  email: string;
}

/** Shape returned by `navigator.contacts.select`: every property is a list. */
export interface RawContact {
  name?: string[] | null;
  tel?: string[] | null;
  email?: string[] | null;
}

interface ContactsManager {
  select(properties: string[], options?: { multiple?: boolean }): Promise<RawContact[]>;
  getProperties?: () => Promise<string[]>;
}

function manager(): ContactsManager | null {
  if (typeof navigator === 'undefined') return null;
  const contacts = (navigator as Navigator & { contacts?: Partial<ContactsManager> }).contacts;
  return contacts && typeof contacts.select === 'function' ? (contacts as ContactsManager) : null;
}

export function contactPickerSupported(): boolean {
  return manager() !== null;
}

const first = (values: string[] | null | undefined) => (values ?? []).map((v) => (v ?? '').replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';

/** First usable name, phone and e-mail of a picked contact; null when it has no name at all. */
export function fromRawContact(raw: RawContact | null | undefined): PickedContact | null {
  if (!raw) return null;
  const phone = first(raw.tel);
  const email = first(raw.email);
  const full_name = first(raw.name) || phone || email;
  return full_name ? { full_name, phone, email } : null;
}

/** Opens the phone's contact picker. Resolves to null when the person cancels. */
export async function pickPhoneContact(): Promise<PickedContact | null> {
  const contacts = manager();
  if (!contacts) return null;
  const wanted = ['name', 'tel', 'email'];
  const available = contacts.getProperties ? await contacts.getProperties() : wanted;
  const properties = wanted.filter((p) => available.includes(p));
  const picked = await contacts.select(properties.length ? properties : wanted, { multiple: false });
  return fromRawContact(picked[0]);
}
