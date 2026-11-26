import { expect, test, type Page } from '@playwright/test';

// The tests share one seeded database and build on each other, so they run in order.
test.describe.configure({ mode: 'serial' });

const PASSWORD = process.env.LOCAL_DEV_PASSWORD ?? 'rental-demo';
const ADMIN = 'admin@example.test';
const MEMBER = 'member@example.test';
const OUTSIDER = 'outsider@example.test';

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto('/');
  await page.getByLabel(/Correo electrónico|Email/).fill(email);
  await page.getByLabel(/Contraseña|Password/).fill(password);
  await page.getByRole('button', { name: /Iniciar sesión|Sign in/ }).click();
}

async function signInAdmin(page: Page) {
  await signIn(page, ADMIN);
  await expect(page.getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible();
}

const dialog = (page: Page) => page.getByRole('dialog');
const candidateCard = (page: Page, name: string) => page.getByTestId(`candidate-${name}`);

async function newPeriodWithCandidate(page: Page, start: string, end: string, guest: string, price: string, status: string) {
  await page.goto('/prospects');
  await page.getByRole('button', { name: /Nuevo periodo/ }).click();
  await dialog(page).getByLabel('Entrada').fill(start);
  await dialog(page).getByLabel(/^Salida/).fill(end);
  await dialog(page).getByLabel('Nombre').fill(guest);
  await dialog(page).getByLabel(/Precio propuesto/).fill(price);
  await dialog(page).getByLabel('Estado').selectOption(status);
  await dialog(page).getByRole('button', { name: 'Guardar' }).click();
  await expect(page).toHaveURL(/\/prospects\/[0-9a-f-]{36}$/);
  await expect(candidateCard(page, guest)).toBeVisible();
  return page.url();
}

async function addCandidate(page: Page, guest: string, price: string) {
  await page.getByRole('button', { name: /Añadir interesado/ }).click();
  await dialog(page).getByLabel('Nombre').fill(guest);
  await dialog(page).getByLabel(/Precio propuesto/).fill(price);
  await dialog(page).getByRole('button', { name: 'Guardar' }).click();
  await expect(candidateCard(page, guest)).toBeVisible();
}

let periodA = '';
let bookingA = '';

test('access: wrong password, uninvited account, and the dashboard for a member', async ({ page }) => {
  await signIn(page, ADMIN, 'not-the-password');
  await expect(page.getByRole('alert')).toContainText('Correo o contraseña incorrectos.');

  await signIn(page, OUTSIDER);
  await expect(page.getByRole('heading', { name: 'Todavía no tienes acceso' })).toBeVisible();
  await expect(page.getByText('Ana Ejemplo')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible();

  await signInAdmin(page);
  const next = page.locator('.next-stay');
  await expect(next.getByRole('heading', { name: 'Próxima estancia' })).toBeVisible();
  await expect(next).toContainText('Ana Ejemplo');
  await expect(next).toContainText('700,00 €');
  await expect(next).toContainText('200,00 €');
  await expect(next).toContainText('500,00 €');
  // The seeded hold is visible with its Madrid-time deadline although the browser is in New York.
  await expect(page.getByText(/Vence mañana a las 20:00/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bloqueos vencidos recientemente' })).toBeVisible();
});

test('workflow A: several prospects, one confirmed booking, then a deposit', async ({ page }) => {
  await signInAdmin(page);
  periodA = await newPeriodWithCandidate(page, '2031-08-01', '2031-08-08', 'Elena E2E', '700', 'undecided');
  await addCandidate(page, 'Marcos E2E', '650');

  // Two prospects, nothing blocked.
  await expect(page.locator('.meta-row')).toContainText('Fechas libres');
  await expect(candidateCard(page, 'Elena E2E')).toContainText('Dudoso');
  await expect(candidateCard(page, 'Marcos E2E')).toContainText('Interesado');

  await candidateCard(page, 'Elena E2E').getByRole('button', { name: 'Confirmar reserva' }).click();
  await expect(dialog(page).getByLabel('Precio total acordado')).toHaveValue('700');
  await dialog(page).getByLabel(/Descartar al otro interesado/).check();
  await dialog(page).getByRole('button', { name: 'Confirmar reserva' }).click();

  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
  bookingA = page.url();
  await expect(page.getByRole('heading', { level: 1, name: 'Elena E2E' })).toBeVisible();
  await expect(page.locator('.page-actions')).toContainText('Confirmada');
  await expect(page.locator('.meta-row')).toContainText('7 noches');

  await page.getByRole('button', { name: /Añadir pago/ }).click();
  await dialog(page).getByLabel(/^Importe/).fill('200');
  await dialog(page).getByLabel('Tipo').selectOption('deposit');
  await dialog(page).getByLabel('Método').selectOption('bank_transfer');
  await dialog(page).getByRole('button', { name: 'Guardar' }).click();
  await expect(dialog(page)).toHaveCount(0);

  const stats = page.locator('.stats').first();
  await expect(stats).toContainText('Pagado200,00 €');
  await expect(stats).toContainText('Pendiente de cobro500,00 €');
  await expect(page.getByTestId('payments')).toContainText('Señal');
  await expect(page.getByTestId('payments')).toContainText('Transferencia');

  // Back on the period: Elena confirmed, Marcos discarded, dates blocked.
  await page.goto(periodA);
  await expect(candidateCard(page, 'Elena E2E')).toContainText('Confirmado');
  await expect(candidateCard(page, 'Marcos E2E')).toContainText('Descartado');
  await expect(page.locator('.meta-row')).toContainText('Reservado: Elena E2E');
});

test('workflow B: temporary hold blocks others, can be extended and converted', async ({ page, browser }) => {
  await signInAdmin(page);
  const period = await newPeriodWithCandidate(page, '2031-07-15', '2031-07-22', 'Nora E2E', '700', 'undecided');
  await addCandidate(page, 'Oscar E2E', '650');

  await candidateCard(page, 'Nora E2E').getByRole('button', { name: 'Bloquear fechas' }).click();
  // Confirmation shows guest, dates and deadline before anything is created.
  const summary = dialog(page).getByTestId('hold-summary');
  await expect(summary).toContainText('Nora E2E');
  await expect(summary).toContainText('15/07/2031 – 22/07/2031');
  await expect(summary).toContainText(/mañana a las \d{2}:\d{2}/);
  await dialog(page).getByRole('button', { name: 'Crear bloqueo' }).click();
  await expect(dialog(page)).toHaveCount(0);

  await expect(candidateCard(page, 'Nora E2E')).toContainText('Bloqueado temporalmente');
  await expect(candidateCard(page, 'Nora E2E')).toContainText(/Vence mañana a las \d{2}:\d{2}/);
  await expect(page.locator('.meta-row')).toContainText('Bloqueo temporal para Nora E2E');

  // Oscar stays a prospect but cannot be held or confirmed silently.
  await expect(candidateCard(page, 'Oscar E2E').getByRole('button', { name: 'Bloquear fechas' })).toBeDisabled();
  await candidateCard(page, 'Oscar E2E').getByRole('button', { name: 'Confirmar reserva' }).click();
  await expect(dialog(page)).toContainText('Fechas bloqueadas temporalmente para Nora E2E');
  const confirm = dialog(page).getByRole('button', { name: 'Confirmar reserva' });
  await expect(confirm).toBeDisabled();
  await dialog(page).getByLabel(/Anular el bloqueo de Nora E2E/).check();
  await confirm.click();
  await expect(dialog(page)).toContainText('Indica el motivo.');
  await dialog(page).getByRole('button', { name: 'Cancelar' }).click();

  // An ordinary member is told that only an admin may override, and the server agrees.
  const memberContext = await browser.newContext({ locale: 'es-ES' });
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, MEMBER);
  await expect(memberPage.getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible();
  await memberPage.goto(period);
  await expect(candidateCard(memberPage, 'Nora E2E')).toContainText('Bloqueado temporalmente'); // sees the admin's hold
  await candidateCard(memberPage, 'Oscar E2E').getByRole('button', { name: 'Confirmar reserva' }).click();
  await expect(dialog(memberPage)).toContainText('Solo un administrador puede anular');
  await expect(dialog(memberPage).getByRole('button', { name: 'Confirmar reserva' })).toBeDisabled();
  await memberContext.close();

  // Extend to 48 hours: the deadline is now a date, not "tomorrow".
  await candidateCard(page, 'Nora E2E').getByRole('button', { name: 'Cambiar vencimiento' }).click();
  await dialog(page).getByLabel('48 horas').check();
  await dialog(page).getByRole('button', { name: 'Guardar vencimiento' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(candidateCard(page, 'Nora E2E')).toContainText(/Vence el \d{2}\/\d{2}\/\d{4} a las \d{2}:\d{2}/);

  // Nora confirms in time: her hold becomes the booking.
  await candidateCard(page, 'Nora E2E').getByRole('button', { name: 'Confirmar reserva' }).click();
  await expect(dialog(page)).toContainText('se convertirá en la reserva');
  await dialog(page).getByRole('button', { name: 'Confirmar reserva' }).click();
  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Nora E2E' })).toBeVisible();

  await page.goto(period);
  await expect(page.locator('.meta-row')).toContainText('Reservado: Nora E2E');
  await expect(candidateCard(page, 'Oscar E2E')).toContainText('Interesado'); // preserved, not deleted
  await page.getByRole('button', { name: 'Historial' }).click();
  await expect(dialog(page)).toContainText('Bloqueo creado');
  await expect(dialog(page)).toContainText('Vencimiento cambiado');
  await expect(dialog(page)).toContainText('Convertido en reserva');
  await expect(dialog(page)).toContainText(ADMIN);
});

test('calendar shows holds, bookings, candidate counts and day details', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/calendar');
  const held = page.locator('button.day[data-state="held"]').first();
  for (let i = 0; i < 3 && (await held.count()) === 0; i++) {
    await page.getByRole('button', { name: 'Mes siguiente' }).click();
  }
  await expect(held).toBeVisible();
  await expect(held).toHaveAccessibleName(/Bloqueo temporal, María Demo/);
  await held.click();
  const details = page.getByTestId('day-details');
  await expect(details).toContainText('Noche bloqueada temporalmente');
  await expect(details).toContainText('Bloqueo temporal para María Demo');
  await expect(details).toContainText(/Vence (hoy|mañana) a las 20:00/);
  await expect(details).toContainText('Carlos Prueba'); // other prospects for the held dates

  await page.getByRole('button', { name: 'Año' }).click();
  await expect(page.locator('.calendar-mini')).toHaveCount(12);
  await page.getByRole('button', { name: 'Hoy' }).click();
  await expect(details).toBeVisible();
});

test('workflow C: winter rental with ten monthly instalments', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/bookings/new');
  await page.getByLabel('Nombre').fill('Lucas E2E');
  await page.getByLabel('Entrada').fill('2032-09-01');
  await page.getByLabel(/^Salida/).fill('2033-07-01');
  await expect(page.getByText('303 noches')).toBeVisible();
  await page.getByLabel('Tipo de precio').selectOption('per_month');
  await page.getByLabel('Precio por mes').fill('550');
  await expect(page.getByText(/10 meses completos/)).toBeVisible();
  await page.getByRole('button', { name: /^Usar/ }).click();
  await expect(page.getByLabel('Precio total acordado')).toHaveValue('5500');
  await page.getByRole('button', { name: 'Crear reserva' }).click();

  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Lucas E2E' })).toBeVisible();
  await page.getByRole('button', { name: 'Crear calendario de pagos' }).click();
  await dialog(page).getByRole('button', { name: 'Proponer plazos mensuales' }).click();
  await expect(dialog(page).locator('input[type="date"]')).toHaveCount(10);
  // Proposing again replaces the rows instead of duplicating them.
  await dialog(page).getByRole('button', { name: 'Proponer plazos mensuales' }).click();
  await expect(dialog(page).locator('input[type="date"]')).toHaveCount(10);
  await expect(dialog(page)).toContainText('10 plazos previstos');
  await expect(dialog(page).locator('.alert-warning')).toHaveCount(0); // adds up to the agreed total
  await dialog(page).getByRole('button', { name: 'Guardar' }).click();
  await expect(dialog(page)).toHaveCount(0);

  const schedule = page.getByTestId('schedule');
  await expect(schedule.locator('li')).toHaveCount(10);
  await expect(schedule.getByText('Futuro')).toHaveCount(10);
  await expect(schedule).toContainText('01/09/2032');
  await expect(schedule).toContainText('01/06/2033');
  const stats = page.locator('.stats').first();
  await expect(stats).toContainText('Pendiente de cobro5500,00 €');
  await expect(stats).not.toContainText('Vencido');

  // A partial monthly payment is recorded on its own; the schedule is not touched.
  await page.getByRole('button', { name: /Añadir pago/ }).click();
  await dialog(page).getByLabel(/^Importe/).fill('300');
  await dialog(page).getByRole('button', { name: 'Guardar' }).click();
  await expect(stats).toContainText('Pendiente de cobro5200,00 €');
  await expect(schedule.getByText('Parcial')).toHaveCount(1);
});

test('workflow D: cancel, keep the receipts, refund and void with an audit trail', async ({ page }) => {
  await signInAdmin(page);
  await page.goto(bookingA);
  await page.getByRole('button', { name: 'Cancelar reserva' }).click();
  await dialog(page).getByRole('button', { name: 'Cancelar la reserva' }).click();
  await expect(dialog(page)).toContainText('Indica el motivo.');
  await dialog(page).getByLabel('Motivo').fill('La huésped canceló el viaje');
  await dialog(page).getByLabel(/Penalización acordada/).fill('100');
  await dialog(page).getByRole('button', { name: 'Cancelar la reserva' }).click();
  await expect(dialog(page)).toHaveCount(0);

  await expect(page.locator('.page-actions')).toContainText('Cancelada');
  await expect(page.getByTestId('payments')).toContainText('Señal'); // receipt preserved
  await expect(page.locator('.stats').first()).toContainText('Importe retenido200,00 €');

  await page.getByRole('button', { name: 'Registrar devolución' }).click();
  await dialog(page).getByLabel(/^Importe/).fill('250');
  await dialog(page).getByRole('button', { name: 'Guardar' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('La devolución supera lo cobrado');
  await dialog(page).getByLabel(/^Importe/).fill('100');
  await dialog(page).getByRole('button', { name: 'Guardar' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId('payments')).toContainText('Devolución');
  await expect(page.getByTestId('payments')).toContainText('-100,00 €');
  await expect(page.locator('.stats').first()).toContainText('Importe retenido100,00 €');

  // Void the refund (needs a reason); it stays visible and audited.
  const refund = page.getByTestId('payments').locator('li', { hasText: 'Devolución' });
  await refund.getByRole('button', { name: 'Anular' }).click();
  await dialog(page).getByRole('button', { name: 'Anular pago' }).click();
  await expect(dialog(page)).toContainText('Indica el motivo.');
  await dialog(page).getByLabel('Motivo').fill('Devolución registrada por error');
  await dialog(page).getByRole('button', { name: 'Anular pago' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(refund).toContainText('Anulado');
  await expect(page.locator('.stats').first()).toContainText('Importe retenido200,00 €');
  await refund.getByRole('button', { name: 'Historial' }).click();
  await expect(dialog(page)).toContainText('Pago registrado');
  await expect(dialog(page)).toContainText('Pago anulado');
  await expect(dialog(page)).toContainText('Devolución registrada por error');
  await dialog(page).getByRole('button', { name: 'Cerrar' }).click();

  // The dates are free again and the period is back in the pipeline.
  await page.goto(periodA);
  await expect(page.locator('.meta-row')).toContainText('Fechas libres');
  await expect(page.locator('.meta-row')).toContainText('Abierto');

  // The global payment list still shows the money, including the voided record on request.
  await page.goto('/payments');
  await page.getByLabel('Filtrar por huésped…').fill('Elena');
  await expect(page.locator('.rtable tbody tr')).toHaveCount(1);
  await page.getByLabel('Mostrar anulados').check();
  await expect(page.locator('.rtable tbody tr')).toHaveCount(2);
});

test('phone contacts: a picked contact prefills a new guest or selects the registered one', async ({ page }) => {
  // Stand-in for the Android contact picker: hands back one contact per call.
  await page.addInitScript(() => {
    const queue = [
      [{ name: ['Elena  Agenda'], tel: ['+34 611 222 333'], email: ['elena@example.test'] }],
      [{ name: ['Carlos (móvil)'], tel: ['+34 600 000 002'], email: [] }],
    ];
    Object.defineProperty(navigator, 'contacts', { configurable: true, value: { select: async () => queue.shift() ?? [] } });
  });
  await signInAdmin(page);
  await page.goto('/prospects');
  await page.getByRole('button', { name: /Nuevo periodo/ }).click();
  const pick = dialog(page).getByRole('button', { name: 'Elegir de los contactos del teléfono' });

  await pick.click();
  await expect(dialog(page).getByLabel('Nombre')).toHaveValue('Elena Agenda');
  await expect(dialog(page).getByLabel(/Teléfono/)).toHaveValue('+34 611 222 333');
  await expect(dialog(page).getByLabel(/Correo/)).toHaveValue('elena@example.test');

  // Same phone as a registered guest (stored without the country code): reuse it, no second contact.
  await pick.click();
  await expect(dialog(page).getByText(/Carlos Prueba ya está registrado/)).toBeVisible();
  await expect(dialog(page).getByLabel('Huésped registrado').locator('option:checked')).toContainText('Carlos Prueba');

  // Cancelling the picker changes nothing.
  await pick.click();
  await expect(dialog(page).getByLabel('Huésped registrado').locator('option:checked')).toContainText('Carlos Prueba');
});

const CORE_ROUTES: [string, string, string][] = [
  ['/', 'Inicio', 'Dashboard'],
  ['/calendar', 'Calendario', 'Calendar'],
  ['/bookings', 'Reservas', 'Bookings'],
  ['/prospects', 'Interesados', 'Prospects'],
  ['/payments', 'Pagos', 'Payments'],
  ['/guests', 'Huéspedes', 'Guests'],
  ['/reports', 'Informes', 'Reports'],
  ['/settings', 'Ajustes', 'Settings'],
];

test('language: switches in place, keeps form input, persists and follows the account', async ({ page, browser }) => {
  await signInAdmin(page);
  await page.goto('/bookings/new?start=2033-10-01&end=2033-10-08');
  // Validation in Spanish, then switch with the form half filled.
  await page.getByLabel('Nombre').fill('Sin Guardar');
  await page.getByRole('button', { name: 'Crear reserva' }).click();
  await expect(page.getByText('Indica el precio total acordado.')).toBeVisible();
  const url = page.url();
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New booking' })).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Sin Guardar');
  await expect(page.getByLabel('Check-in')).toHaveValue('2033-10-01');
  await expect(page.getByText('Enter the agreed total price.')).toBeVisible();
  expect(page.url()).toBe(url);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'New booking' })).toBeVisible();
  for (const [route, , english] of CORE_ROUTES) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1, name: english })).toBeVisible();
  }
  // Money and dates follow the locale; the currency stays EUR.
  await page.goto('/');
  await expect(page.locator('.next-stay')).toContainText('€700.00');
  await expect(page.locator('.next-stay')).toContainText('Outstanding');

  // The preference is stored in the account: a fresh browser gets English after sign-in.
  const other = await browser.newContext({ locale: 'es-ES' });
  const otherPage = await other.newPage();
  await signIn(otherPage, ADMIN);
  await expect(otherPage.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await other.close();

  await page.getByRole('button', { name: 'ES', exact: true }).click();
  for (const [route, spanish] of CORE_ROUTES) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1, name: spanish })).toBeVisible();
  }
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
});

const VIEWPORTS = [
  { name: 'phone portrait', width: 375, height: 812, mobile: true },
  { name: 'phone landscape', width: 812, height: 375, mobile: true },
  { name: 'small phone', width: 320, height: 640, mobile: true },
  { name: 'desktop', width: 1280, height: 800, mobile: false },
];

for (const viewport of VIEWPORTS) {
  test(`layout: no horizontal overflow and reachable navigation on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await signInAdmin(page);
    const routes = [...CORE_ROUTES.map(([route]) => route), '/bookings/new', '/prospects?new=1'];
    await page.goto('/bookings');
    await page.getByLabel('Filtrar').selectOption('all');
    const firstBooking = await page.locator('.rtable a').first().getAttribute('href');
    routes.push(firstBooking!);
    await page.goto('/prospects');
    routes.push((await page.locator('.card-list a').first().getAttribute('href'))!);

    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator('h1').first()).toBeVisible();
      await expect(page.locator('.spinner')).toHaveCount(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on ${route}`).toBeLessThanOrEqual(0);
    }

    await page.goto('/');
    if (viewport.mobile) {
      const bottom = page.locator('.bottomnav');
      await expect(bottom).toBeVisible();
      await expect(bottom.getByRole('link')).toHaveCount(5);
      for (const name of ['Inicio', 'Calendario', 'Reservas', 'Interesados', 'Pagos']) {
        await expect(bottom.getByRole('link', { name })).toBeInViewport();
      }
      const box = await bottom.getByRole('link', { name: 'Reservas' }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      // Language switch and the remaining sections are reachable from the top bar.
      await expect(page.getByRole('button', { name: 'EN', exact: true })).toBeInViewport();
      await page.getByRole('button', { name: 'Más opciones' }).click();
      await page.locator('#more-menu').getByRole('link', { name: 'Huéspedes' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Huéspedes' })).toBeVisible();
      await bottom.getByRole('link', { name: 'Calendario' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Calendario' })).toBeVisible();
    } else {
      await expect(page.locator('.sidenav')).toBeVisible();
      await expect(page.locator('.bottomnav')).toBeHidden();
      await expect(page.locator('.rtable thead')).toHaveCount(0); // dashboard has no table
      await page.locator('.sidenav').getByRole('link', { name: 'Reservas' }).click();
      await expect(page.locator('.rtable thead th').first()).toBeVisible(); // real table on desktop
    }
  });
}
