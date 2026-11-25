-- DEVELOPMENT SEED - fictitious data only. Never run this against production.
--
-- Creates a demo workspace with "Casa Salobreña", invented guests, overlapping enquiries,
-- a live and an expired temporary hold, bookings in every status, payments, a refund and
-- instalment schedules. All dates are relative to today, so the demo always looks current.
--
-- It needs at least one existing auth user (the oldest becomes admin, the second-oldest a
-- member) and does nothing if a workspace already exists. Bookings, holds and payments are
-- created through the same RPCs the app uses, impersonating that admin for the transaction.

do $$
declare
  v_admin uuid;
  v_member uuid;
  v_ws uuid;
  v_prop uuid;
  v_today date := (now() at time zone 'Europe/Madrid')::date;
  g_ana uuid; g_carlos uuid; g_maria uuid; g_pedro uuid; g_juan uuid; g_lucia uuid;
  v_period uuid;
  v_cand uuid;
  v_booking uuid;
  v_winter date;
  v_items jsonb;
begin
  if exists (select 1 from public.workspaces) then
    raise notice 'seed skipped: a workspace already exists';
    return;
  end if;
  select id into v_admin from auth.users order by created_at, id limit 1;
  if v_admin is null then
    raise notice 'seed skipped: create an auth user first, then run the seed again';
    return;
  end if;
  select id into v_member from auth.users where id <> v_admin order by created_at, id limit 1;

  insert into public.workspaces (name) values ('Familia Demo') returning id into v_ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (v_ws, v_admin, 'admin');
  if v_member is not null then
    insert into public.workspace_members (workspace_id, user_id, role) values (v_ws, v_member, 'member');
  end if;
  insert into public.properties (workspace_id, name, address, timezone, notes)
  values (v_ws, 'Casa Salobreña', 'Calle Inventada 1, Salobreña (Granada)', 'Europe/Madrid', 'Vivienda de demostración')
  returning id into v_prop;

  insert into public.guests (workspace_id, full_name, phone, email) values (v_ws, 'Ana Ejemplo', '+34 600 000 001', 'ana@example.test') returning id into g_ana;
  insert into public.guests (workspace_id, full_name, phone) values (v_ws, 'Carlos Prueba', '600 000 002') returning id into g_carlos;
  insert into public.guests (workspace_id, full_name, phone) values (v_ws, 'María Demo', '+34 600 000 003') returning id into g_maria;
  insert into public.guests (workspace_id, full_name, email) values (v_ws, 'Pedro Ficticio', 'pedro@example.test') returning id into g_pedro;
  insert into public.guests (workspace_id, full_name, phone) values (v_ws, 'Juan Muestra', '+34 600 000 005') returning id into g_juan;
  insert into public.guests (workspace_id, full_name, phone, notes) values (v_ws, 'Lucía Invierno', '+44 7700 900000', 'Alquiler de temporada') returning id into g_lucia;

  -- Act as the admin for the RPC calls below (transaction-local).
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- A completed stay two months ago, fully paid.
  v_booking := public.create_booking(v_prop, g_juan, v_today - 60, v_today - 53, 700);
  perform public.record_payment(v_booking, 200, v_today - 90, 'bank_transfer', 'deposit');
  perform public.record_payment(v_booking, 500, v_today - 60, 'cash', 'final_payment');
  perform public.set_booking_status(v_booking, 'completed');

  -- A cancelled booking: deposit received, half of it refunded, the rest retained.
  v_booking := public.create_booking(v_prop, g_carlos, v_today - 20, v_today - 13, 500, 'total', null, 'confirmed', 100);
  perform public.record_payment(v_booking, 100, v_today - 40, 'bizum', 'deposit');
  perform public.set_booking_status(v_booking, 'cancelled', 'El huésped canceló por motivos personales', 50);
  perform public.record_payment(v_booking, 50, v_today - 24, 'bizum', 'refund', 'Devolución parcial de la señal');

  -- Next stay: EUR 700, EUR 200 deposit received -> EUR 500 outstanding.
  v_booking := public.create_booking(v_prop, g_ana, v_today + 10, v_today + 17, 700, 'total', null, 'confirmed', 200);
  perform public.record_payment(v_booking, 200, v_today - 3, 'bank_transfer', 'deposit');

  -- A booking with an overdue instalment.
  v_booking := public.create_booking(v_prop, g_pedro, v_today + 30, v_today + 37, 650, 'per_night', 92.86, 'confirmed', 200);
  perform public.set_installments(v_booking, jsonb_build_array(
    jsonb_build_object('due_date', v_today - 5, 'amount', 200, 'description', 'Señal'),
    jsonb_build_object('due_date', v_today + 20, 'amount', 450, 'description', 'Resto')));

  -- Three prospects around the same week: María has an exclusive hold until tomorrow 20:00.
  insert into public.booking_periods (workspace_id, property_id, start_date, end_date, notes)
  values (v_ws, v_prop, v_today + 45, v_today + 52, 'Semana muy pedida') returning id into v_period;
  insert into public.booking_candidates (workspace_id, booking_period_id, guest_id, status, proposed_price, notes)
  values (v_ws, v_period, g_maria, 'undecided', 700, 'Contesta mañana') returning id into v_cand;
  insert into public.booking_candidates (workspace_id, booking_period_id, guest_id, status, proposed_price)
  values (v_ws, v_period, g_carlos, 'interested', 650);
  perform public.create_hold(v_cand, ((v_today + 1) + time '20:00') at time zone 'Europe/Madrid', 'Prioridad acordada por teléfono');

  insert into public.booking_periods (workspace_id, property_id, start_date, end_date)
  values (v_ws, v_prop, v_today + 47, v_today + 54) returning id into v_period;
  insert into public.booking_candidates (workspace_id, booking_period_id, guest_id, status, proposed_price)
  values (v_ws, v_period, g_juan, 'interested', 600);

  -- Two candidates, nobody decided yet.
  insert into public.booking_periods (workspace_id, property_id, start_date, end_date)
  values (v_ws, v_prop, v_today + 60, v_today + 67) returning id into v_period;
  insert into public.booking_candidates (workspace_id, booking_period_id, guest_id, status, proposed_price)
  values (v_ws, v_period, g_carlos, 'awaiting_response', 680), (v_ws, v_period, g_ana, 'interested', 650);

  -- A hold that has just expired: the dates are free again, the prospect is kept.
  insert into public.booking_periods (workspace_id, property_id, start_date, end_date)
  values (v_ws, v_prop, v_today + 75, v_today + 82) returning id into v_period;
  insert into public.booking_candidates (workspace_id, booking_period_id, guest_id, status, proposed_price)
  values (v_ws, v_period, g_pedro, 'undecided', 640) returning id into v_cand;
  perform public.create_hold(v_cand, clock_timestamp() + interval '1 second', 'Bloqueo de demostración ya vencido');
  perform pg_sleep(1.2);

  -- Winter rental: 1 September to 1 July (exclusive), ten months at EUR 550.
  v_winter := make_date(extract(year from v_today + 120)::int, 9, 1);
  if v_winter <= v_today + 120 then
    v_winter := (v_winter + interval '1 year')::date;
  end if;
  v_booking := public.create_booking(v_prop, g_lucia, v_winter, (v_winter + interval '10 months')::date, 5500, 'per_month', 550, 'confirmed', 550);
  select jsonb_agg(jsonb_build_object('due_date', (v_winter + make_interval(months => i))::date, 'amount', 550,
                                      'description', (i + 1) || '/10') order by i)
    into v_items from generate_series(0, 9) as i;
  perform public.set_installments(v_booking, v_items);
  perform public.record_payment(v_booking, 550, v_today - 1, 'bank_transfer', 'deposit', 'Primer mes por adelantado');
end $$;
