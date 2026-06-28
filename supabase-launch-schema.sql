-- Saltbox launch schema and security hardening.
-- Run this manually in the Supabase SQL editor. Do not run it until you are
-- ready to add Gabby's Supabase Auth user to public.admin_users.
--
-- REQUIRED MANUAL STEP AFTER RUNNING:
-- Replace the values below with Gabby's real Supabase Auth user ID and email,
-- then run the insert. Without this row, admin pages will no longer be able to
-- read or write protected admin data.
--
-- insert into public.admin_users (user_id, email, role)
-- values ('00000000-0000-0000-0000-000000000000', 'gabby@example.com', 'admin')
-- on conflict (user_id) do update
-- set email = excluded.email, role = excluded.role;

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'admin',
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = auth.uid()
  );
$$;

drop policy if exists "Admins can read admin users" on public.admin_users;
create policy "Admins can read admin users"
on public.admin_users
for select
to authenticated
using (public.is_admin());

drop policy if exists "Admins can manage admin users" on public.admin_users;
create policy "Admins can manage admin users"
on public.admin_users
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text,
  email text,
  phone text,
  business_name text,
  business_type text,
  status text not null default 'Lead',
  lead_source text,
  quote_request_id uuid,
  project_type text,
  package_interest text,
  selected_package text,
  package_price numeric,
  care_plan_interest text,
  selected_care_plan text,
  care_plan_price numeric,
  ideal_timeline text,
  features_needed text,
  notes text,
  discount_adjustment numeric,
  pricing_notes text,
  stripe_customer_id text
);

alter table public.customers add column if not exists stripe_customer_id text;

drop trigger if exists set_customers_updated_at on public.customers;
create trigger set_customers_updated_at
before update on public.customers
for each row execute function public.set_updated_at();

create table if not exists public.customer_notes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by text,
  note text not null
);

create table if not exists public.customer_files (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  created_at timestamptz not null default now(),
  file_name text not null,
  file_path text not null,
  file_type text,
  uploaded_by text
);

create table if not exists public.customer_invoices (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  created_at timestamptz not null default now(),
  title text not null,
  description text,
  amount numeric,
  status text not null default 'Draft',
  due_date date,
  stripe_invoice_id text,
  stripe_invoice_url text,
  stripe_checkout_url text
);

alter table public.customer_invoices add column if not exists stripe_checkout_url text;

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  customer_id uuid references public.customers(id) on delete set null,
  quote_request_id uuid references public.quote_requests(id) on delete set null,
  title text not null,
  description text,
  priority text not null default 'Normal',
  status text not null default 'Open',
  assigned_to text,
  created_by text
);

drop trigger if exists set_tickets_updated_at on public.tickets;
create trigger set_tickets_updated_at
before update on public.tickets
for each row execute function public.set_updated_at();

create table if not exists public.ticket_comments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by text,
  comment text not null
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'Draft',
  plan_name text,
  amount numeric,
  interval text default 'month',
  stripe_subscription_id text,
  stripe_customer_id text
);

drop trigger if exists set_subscriptions_updated_at on public.subscriptions;
create trigger set_subscriptions_updated_at
before update on public.subscriptions
for each row execute function public.set_updated_at();

create table if not exists public.package_payment_plans (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'Draft',
  package_name text,
  total_package_price numeric,
  down_payment numeric default 0,
  amount_financed numeric,
  number_of_payments integer,
  payment_interval text default 'month',
  monthly_payment_amount numeric,
  start_date date,
  next_due_date date,
  notes text,
  stripe_subscription_id text,
  stripe_customer_id text
);

drop trigger if exists set_package_payment_plans_updated_at on public.package_payment_plans;
create trigger set_package_payment_plans_updated_at
before update on public.package_payment_plans
for each row execute function public.set_updated_at();

create table if not exists public.package_payment_plan_payments (
  id uuid primary key default gen_random_uuid(),
  payment_plan_id uuid references public.package_payment_plans(id) on delete cascade,
  created_at timestamptz not null default now(),
  due_date date,
  amount_due numeric,
  amount_paid numeric default 0,
  paid_at date,
  status text not null default 'Due',
  notes text
);

create index if not exists customers_email_idx on public.customers(email);
create index if not exists customers_status_idx on public.customers(status);
create index if not exists customer_notes_customer_id_idx on public.customer_notes(customer_id);
create index if not exists customer_files_customer_id_idx on public.customer_files(customer_id);
create index if not exists customer_invoices_customer_id_idx on public.customer_invoices(customer_id);
create index if not exists tickets_customer_id_idx on public.tickets(customer_id);
create index if not exists tickets_quote_request_id_idx on public.tickets(quote_request_id);
create index if not exists tickets_status_idx on public.tickets(status);
create index if not exists ticket_comments_ticket_id_idx on public.ticket_comments(ticket_id);
create index if not exists subscriptions_customer_id_idx on public.subscriptions(customer_id);
create index if not exists subscriptions_status_idx on public.subscriptions(status);
create unique index if not exists subscriptions_stripe_subscription_id_key on public.subscriptions(stripe_subscription_id);
create index if not exists package_payment_plans_customer_id_idx on public.package_payment_plans(customer_id);
create index if not exists package_payment_plans_status_idx on public.package_payment_plans(status);
create index if not exists package_payment_plan_payments_payment_plan_id_idx on public.package_payment_plan_payments(payment_plan_id);
create index if not exists package_payment_plan_payments_due_date_idx on public.package_payment_plan_payments(due_date);
create index if not exists package_payment_plan_payments_status_idx on public.package_payment_plan_payments(status);

alter table public.customers enable row level security;
alter table public.customer_notes enable row level security;
alter table public.customer_files enable row level security;
alter table public.customer_invoices enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_comments enable row level security;
alter table public.subscriptions enable row level security;
alter table public.package_payment_plans enable row level security;
alter table public.package_payment_plan_payments enable row level security;

-- Remove the earlier broad authenticated policies before adding launch policies.
drop policy if exists "Authenticated admins can manage customers" on public.customers;
drop policy if exists "Authenticated admins can manage customer notes" on public.customer_notes;
drop policy if exists "Authenticated admins can manage customer files" on public.customer_files;
drop policy if exists "Authenticated admins can manage customer invoices" on public.customer_invoices;

-- quote_requests must remain insertable from the public quote form while reads
-- and updates are limited to rows in public.admin_users.
alter table public.quote_requests enable row level security;

drop policy if exists "Public can create quote requests" on public.quote_requests;
create policy "Public can create quote requests"
on public.quote_requests
for insert
to anon, authenticated
with check (true);

drop policy if exists "Admins can read quote requests" on public.quote_requests;
create policy "Admins can read quote requests"
on public.quote_requests
for select
to authenticated
using (public.is_admin());

drop policy if exists "Admins can update quote requests" on public.quote_requests;
create policy "Admins can update quote requests"
on public.quote_requests
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Admin policies.
drop policy if exists "Admins can manage customers" on public.customers;
create policy "Admins can manage customers"
on public.customers
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can manage customer notes" on public.customer_notes;
create policy "Admins can manage customer notes"
on public.customer_notes
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can manage customer files" on public.customer_files;
create policy "Admins can manage customer files"
on public.customer_files
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can manage customer invoices" on public.customer_invoices;
create policy "Admins can manage customer invoices"
on public.customer_invoices
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can manage tickets" on public.tickets;
create policy "Admins can manage tickets"
on public.tickets
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can manage ticket comments" on public.ticket_comments;
create policy "Admins can manage ticket comments"
on public.ticket_comments
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can manage subscriptions" on public.subscriptions;
create policy "Admins can manage subscriptions"
on public.subscriptions
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can manage package payment plans" on public.package_payment_plans;
create policy "Admins can manage package payment plans"
on public.package_payment_plans
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can manage package payment plan payments" on public.package_payment_plan_payments;
create policy "Admins can manage package payment plan payments"
on public.package_payment_plan_payments
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Customer portal read policies. These are intentionally read-only and match on
-- auth email for the first launch. A later hardening pass should add explicit
-- customer user IDs instead of relying on email matching.
drop policy if exists "Customers can read own profile by email" on public.customers;
create policy "Customers can read own profile by email"
on public.customers
for select
to authenticated
using (lower(email) = lower(auth.jwt() ->> 'email'));

drop policy if exists "Customers can read own invoices" on public.customer_invoices;
create policy "Customers can read own invoices"
on public.customer_invoices
for select
to authenticated
using (
  exists (
    select 1 from public.customers
    where customers.id = customer_invoices.customer_id
    and lower(customers.email) = lower(auth.jwt() ->> 'email')
  )
);

drop policy if exists "Customers can read own subscriptions" on public.subscriptions;
create policy "Customers can read own subscriptions"
on public.subscriptions
for select
to authenticated
using (
  exists (
    select 1
    from public.customers
    where customers.id = subscriptions.customer_id
    and lower(customers.email) = lower(auth.jwt() ->> 'email')
  )
);

drop policy if exists "Customers can read own tickets" on public.tickets;
create policy "Customers can read own tickets"
on public.tickets
for select
to authenticated
using (
  exists (
    select 1 from public.customers
    where customers.id = tickets.customer_id
    and lower(customers.email) = lower(auth.jwt() ->> 'email')
  )
);

drop policy if exists "Customers can read own file metadata" on public.customer_files;
create policy "Customers can read own file metadata"
on public.customer_files
for select
to authenticated
using (
  exists (
    select 1 from public.customers
    where customers.id = customer_files.customer_id
    and lower(customers.email) = lower(auth.jwt() ->> 'email')
  )
);

drop policy if exists "Customers can read own package payment plans" on public.package_payment_plans;
create policy "Customers can read own package payment plans"
on public.package_payment_plans
for select
to authenticated
using (
  exists (
    select 1 from public.customers
    where customers.id = package_payment_plans.customer_id
    and lower(customers.email) = lower(auth.jwt() ->> 'email')
  )
);

drop policy if exists "Customers can read own package payment plan payments" on public.package_payment_plan_payments;
create policy "Customers can read own package payment plan payments"
on public.package_payment_plan_payments
for select
to authenticated
using (
  exists (
    select 1
    from public.package_payment_plans
    join public.customers on customers.id = package_payment_plans.customer_id
    where package_payment_plans.id = package_payment_plan_payments.payment_plan_id
    and lower(customers.email) = lower(auth.jwt() ->> 'email')
  )
);

-- Private customer file bucket. Object reads/writes are admin-only for launch;
-- the customer portal lists file metadata only until signed download URLs are
-- created through a server-side Netlify Function.
insert into storage.buckets (id, name, public)
values ('customer-files', 'customer-files', false)
on conflict (id) do nothing;

drop policy if exists "Authenticated admins can manage customer storage files" on storage.objects;
drop policy if exists "Admins can manage customer storage files" on storage.objects;
create policy "Admins can manage customer storage files"
on storage.objects
for all
to authenticated
using (bucket_id = 'customer-files' and public.is_admin())
with check (bucket_id = 'customer-files' and public.is_admin());

-- Netlify Functions will later use server-side environment variables only:
-- STRIPE_SECRET_KEY
-- STRIPE_WEBHOOK_SECRET
-- SITE_URL
-- SUPABASE_URL
-- SUPABASE_SERVICE_ROLE_KEY
-- Never put Stripe secret keys or Supabase service role keys in browser code.
