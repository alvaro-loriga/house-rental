import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContactPickButton } from '../components/forms';
import '../lib/i18n';
import { contactPickerSupported, fromRawContact, pickPhoneContact } from '../utils/contacts';

type Select = (properties: string[], options?: { multiple?: boolean }) => Promise<unknown[]>;

function installPicker(select: Select, getProperties?: () => Promise<string[]>) {
  Object.defineProperty(navigator, 'contacts', { configurable: true, value: { select, getProperties } });
}

afterEach(() => {
  delete (navigator as unknown as { contacts?: unknown }).contacts;
});

describe('phone contact picker', () => {
  it('takes the first usable name, phone and e-mail and tidies spaces', () => {
    expect(fromRawContact({ name: ['  Lucía   Fernández '], tel: ['', '+34 600 11 22 33', '958 000 000'], email: ['lucia@example.test'] })).toEqual({
      full_name: 'Lucía Fernández',
      phone: '+34 600 11 22 33',
      email: 'lucia@example.test',
    });
  });

  it('falls back to the phone or e-mail when the contact has no name, and rejects empty contacts', () => {
    expect(fromRawContact({ name: [], tel: ['600112233'] })?.full_name).toBe('600112233');
    expect(fromRawContact({ name: null, tel: null, email: ['a@example.test'] })?.full_name).toBe('a@example.test');
    expect(fromRawContact({ name: [''], tel: [], email: [] })).toBeNull();
    expect(fromRawContact(undefined)).toBeNull();
  });

  it('is unsupported, and renders nothing, where the browser has no contact picker', () => {
    expect(contactPickerSupported()).toBe(false);
    const { container } = render(<ContactPickButton onPick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('asks for one contact with only the properties the phone offers', async () => {
    const select = vi.fn<Select>(async () => [{ name: ['Ana Ruiz'], tel: ['600112233'] }]);
    installPicker(select, async () => ['name', 'tel', 'address', 'icon']);
    expect(await pickPhoneContact()).toEqual({ full_name: 'Ana Ruiz', phone: '600112233', email: '' });
    expect(select).toHaveBeenCalledWith(['name', 'tel'], { multiple: false });
  });

  it('hands the picked contact to the form, and does nothing when the picker is cancelled', async () => {
    const select = vi.fn<Select>(async () => [{ name: ['Ana Ruiz'], tel: ['600112233'], email: [] }]);
    installPicker(select);
    const onPick = vi.fn();
    render(<ContactPickButton onPick={onPick} />);
    const button = screen.getByRole('button', { name: 'Elegir de los contactos del teléfono' });
    await userEvent.click(button);
    expect(onPick).toHaveBeenCalledWith({ full_name: 'Ana Ruiz', phone: '600112233', email: '' });

    select.mockResolvedValueOnce([]);
    await userEvent.click(button);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('shows a message when the phone refuses to open the picker', async () => {
    installPicker(async () => {
      throw new Error('SecurityError');
    });
    render(<ContactPickButton onPick={() => {}} />);
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No se han podido abrir los contactos'));
  });
});
