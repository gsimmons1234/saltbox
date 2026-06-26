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
  pricing_notes text
);

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
  stripe_invoice_url text
);

create index if not exists customers_email_idx on public.customers(email);
create index if not exists customers_status_idx on public.customers(status);
create index if not exists customer_notes_customer_id_idx on public.customer_notes(customer_id);
create index if not exists customer_files_customer_id_idx on public.customer_files(customer_id);
create index if not exists customer_invoices_customer_id_idx on public.customer_invoices(customer_id);

alter table public.customers enable row level security;
alter table public.customer_notes enable row level security;
alter table public.customer_files enable row level security;
alter table public.customer_invoices enable row level security;

drop policy if exists "Authenticated admins can manage customers" on public.customers;
create policy "Authenticated admins can manage customers"
on public.customers
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated admins can manage customer notes" on public.customer_notes;
create policy "Authenticated admins can manage customer notes"
on public.customer_notes
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated admins can manage customer files" on public.customer_files;
create policy "Authenticated admins can manage customer files"
on public.customer_files
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated admins can manage customer invoices" on public.customer_invoices;
create policy "Authenticated admins can manage customer invoices"
on public.customer_invoices
for all
to authenticated
using (true)
with check (true);

insert into storage.buckets (id, name, public)
values ('customer-files', 'customer-files', false)
on conflict (id) do nothing;

drop policy if exists "Authenticated admins can manage customer storage files" on storage.objects;
create policy "Authenticated admins can manage customer storage files"
on storage.objects
for all
to authenticated
using (bucket_id = 'customer-files')
with check (bucket_id = 'customer-files');
