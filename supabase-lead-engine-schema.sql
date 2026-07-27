-- Saltbox Lead Engine schema — Phase 1 only.
--
-- Run this manually in the Supabase SQL editor, AFTER supabase-launch-schema.sql
-- has already been applied (this file depends on public.is_admin() and
-- public.set_updated_at(), both defined there, and on public.admin_users and
-- public.customers).
--
-- This file creates exactly four tables for Phase 1 (manual lead entry,
-- review, scoring, status tracking, duplicate detection, and permanent
-- suppression): leads, lead_sources, outreach_opt_outs, lead_activity_log.
-- It intentionally does NOT create the Phase 2-5 tables (lead_audits,
-- lead_mockups, outreach_drafts, outreach_events).
--
-- This file does not touch any existing table, policy, or object. In
-- particular: public.quote_requests, Stripe-related columns/tables, and
-- customer-portal policies are never referenced or altered below.
-- public.quote_requests' own CREATE TABLE definition remains missing from
-- source control (see handoff.md) — that gap is left alone, not guessed at.
--
-- The whole file runs as one transaction: either every statement below
-- succeeds, or none of it is applied. It is safe to run more than once
-- (every CREATE/ALTER/INDEX/POLICY statement is idempotent).
--
-- Do not run this file until you have reviewed it. Nothing in this
-- repository runs it automatically.

BEGIN;

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
-- ===========================================================================
-- Normalization functions
-- These are the single source of truth for identity normalization. Browser
-- code (leads.js) must never be trusted to compute the values that are
-- stored or used for duplicate/suppression matching — it may only mirror
-- this logic to build read-side query filters against the columns these
-- functions maintain.
-- ===========================================================================

create or replace function public.normalize_email(p_value text)
returns text
language sql
immutable
as $$
  select nullif(lower(trim(coalesce(p_value, ''))), '');
$$;

-- US phone canonicalization policy (also mirrored in leads.js's
-- normalizePhone() for read-side query filters only — this function is the
-- only thing that ever computes a stored normalized_phone value):
--   1. strip everything but digits
--   2. an 11-digit result starting with '1' is a US number with a country
--      code — drop the leading 1 so it matches the corresponding 10-digit
--      form (so "(801) 555-1212" and "+1 801-555-1212" normalize identically)
--   3. a 10-digit result is kept as-is
--   4. blank input becomes null
--   5. any other digit count is unsupported/malformed and becomes null
--      (never partially stored, never matched on a truncated suffix)
create or replace function public.normalize_phone(p_value text)
returns text
language plpgsql
immutable
as $$
declare
  v_digits text;
begin
  v_digits := regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g');
  if v_digits = '' then
    return null;
  end if;

  if length(v_digits) = 11 and left(v_digits, 1) = '1' then
    v_digits := substr(v_digits, 2);
  end if;

  if length(v_digits) <> 10 then
    return null;
  end if;

  return v_digits;
end;
$$;

-- Website domain normalization policy (also mirrored in leads.js's
-- normalizeDomain() for read-side query filters only). Beyond the previous
-- scheme/www/path stripping, this now:
--   - validates the extracted host against real hostname syntax and returns
--     null for anything malformed, rather than storing garbage
--   - preserves legitimate tenant subdomains (e.g. "shop.example.com" stays
--     "shop.example.com" — only a single leading "www." is stripped)
--   - returns null for known social/directory/maps/marketplace platforms
--     whose URLs are per-tenant *paths* under one shared host
--     (facebook.com/business-a vs facebook.com/business-b are different
--     businesses, not the same "domain" — collapsing them onto facebook.com
--     would falsely mark unrelated businesses as duplicates of each other,
--     or worse, suppress one business because another tenant on the same
--     platform opted out). The raw website_url is still stored as
--     entered/as a source reference; it just never becomes a hard
--     duplicate/suppression identity without a safe, business-specific
--     extractor, which Phase 1 does not implement.
create or replace function public.normalize_website_domain(p_value text)
returns text
language plpgsql
immutable
as $$
declare
  v_value text;
  v_host text;
  v_rest text;
  v_path text;
  v_slash_pos int;
begin
  if p_value is null then
    return null;
  end if;

  v_value := lower(trim(p_value));
  if v_value = '' then
    return null;
  end if;

  -- strip protocol/scheme (http://, https://, ftp://, etc.)
  v_rest := regexp_replace(v_value, '^[a-z][a-z0-9+.-]*://', '');

  v_slash_pos := position('/' in v_rest);
  if v_slash_pos > 0 then
    v_host := substr(v_rest, 1, v_slash_pos - 1);
    v_path := substr(v_rest, v_slash_pos);
  else
    v_host := v_rest;
    v_path := '';
  end if;

  -- a bare host may still carry a query/fragment/port; cut those off too
  v_host := split_part(v_host, '?', 1);
  v_host := split_part(v_host, '#', 1);
  v_host := split_part(v_host, ':', 1);
  v_host := rtrim(v_host, '.');

  if left(v_host, 4) = 'www.' then
    v_host := substr(v_host, 5);
  end if;

  if v_host = '' then
    return null;
  end if;

  -- reject malformed host syntax outright rather than storing it
  if v_host !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' then
    return null;
  end if;

  -- known hosted-profile platforms: path-based tenants under one shared
  -- host, never a business's own domain identity in Phase 1
  if v_host = any(array[
    'facebook.com', 'm.facebook.com', 'business.facebook.com',
    'instagram.com',
    'twitter.com', 'x.com',
    'linkedin.com',
    'yelp.com', 'biz.yelp.com',
    'nextdoor.com',
    'tiktok.com',
    'pinterest.com',
    'youtube.com',
    'thumbtack.com',
    'angi.com', 'angieslist.com',
    'houzz.com',
    'bbb.org',
    'yellowpages.com',
    'foursquare.com',
    'tripadvisor.com',
    'maps.google.com',
    'business.google.com',
    'g.page', 'g.co', 'goo.gl'
  ]) then
    return null;
  end if;

  -- google.com/maps, google.com/local, etc. — path-based Maps/Business
  -- profile URLs hosted on the bare google.com domain
  if v_host in ('google.com') and v_path ~ '^/(maps|local|business)(/|$|\?)' then
    return null;
  end if;

  return v_host;
end;
$$;

-- Resolves the calling admin's email via a trusted, database-derived
-- identity (auth.uid() looked up against admin_users), never a
-- browser-supplied value. Falls back to the raw auth uid if no admin_users
-- row matches (should not happen given RLS already requires is_admin()).
create or replace function public.current_actor_label()
returns text
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select coalesce(
    (select email from public.admin_users where user_id = auth.uid()),
    auth.uid()::text
  );
$$;

-- Canonical admin-managed status transition matrix. Normal workflow and
-- outcome statuses can move directly to any other normal status. Opted Out
-- remains terminal, and entry into Opted Out or Duplicate is still restricted
-- to its dedicated RPC by leads_validate_status_transition().
create or replace function public.lead_status_transitions(p_status text)
returns text[]
language sql
immutable
as $$
  select case
    -- Opted Out is terminal in Phase 1: there is no reopen/suppression-lift
    -- workflow. A lead can still be *edited* while Opted Out (its identity
    -- fields), but it can never change status again.
    when p_status = 'Opted Out' then array[]::text[]
    when p_status = 'Duplicate' then array[
      'Discovered', 'Needs Review', 'Approved for Mockup', 'Mockup In Progress',
      'Draft Ready', 'Approved to Send', 'Contacted', 'Follow-up Due', 'Replied', 'Rejected'
    ]
    when p_status = any(array[
      'Discovered', 'Needs Review', 'Approved for Mockup', 'Mockup In Progress',
      'Draft Ready', 'Approved to Send', 'Contacted', 'Follow-up Due', 'Replied', 'Rejected'
    ])
    then array_remove(array[
      'Discovered', 'Needs Review', 'Approved for Mockup', 'Mockup In Progress',
      'Draft Ready', 'Approved to Send', 'Contacted', 'Follow-up Due', 'Replied', 'Rejected',
      'Opted Out', 'Duplicate'
    ], p_status)
    else array[]::text[]
  end;
$$;

-- Statuses that represent active outreach progression. A lead whose
-- identity matches a permanent suppression record must never be in, or
-- move into, one of these — regardless of how it got there (a direct status
-- change, or an identity edit that newly causes a match while already
-- sitting in one of these statuses).
create or replace function public.is_outreach_status(p_status text)
returns boolean
language sql
immutable
as $$
  select p_status = any(array[
    'Approved for Mockup', 'Mockup In Progress', 'Draft Ready',
    'Approved to Send', 'Contacted', 'Replied', 'Follow-up Due'
  ]);
$$;

-- ===========================================================================
-- leads
-- ===========================================================================

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  business_name text not null,
  contact_name text,
  email text,
  phone text,
  normalized_email text,
  normalized_phone text,

  website_url text,
  normalized_website_domain text,
  has_website boolean not null default false,

  address text,
  city text,
  state text,
  postal_code text,
  country text not null default 'US',
  category text,

  discovery_method text not null default 'manual',
  status text not null default 'Discovered',

  fit_score numeric,
  fit_score_reasoning text,
  activity_confirmed boolean not null default false,
  activity_confirmed_notes text,

  normalized_business_key text,
  duplicate_of uuid references public.leads(id) on delete set null,
  converted_customer_id uuid references public.customers(id) on delete set null,

  primary_source_url text,
  rejected_reason text,
  assigned_to text,
  notes text,

  constraint leads_discovery_method_check check (discovery_method in ('manual', 'ai_search')),
  constraint leads_status_check check (status in (
    'Discovered',
    'Needs Review',
    'Approved for Mockup',
    'Mockup In Progress',
    'Draft Ready',
    'Approved to Send',
    'Contacted',
    'Replied',
    'Follow-up Due',
    'Rejected',
    'Opted Out',
    'Duplicate'
  )),
  constraint leads_fit_score_range_check check (fit_score is null or (fit_score >= 0 and fit_score <= 100))
);

-- ===========================================================================
-- lead_sources
-- ===========================================================================

create table if not exists public.lead_sources (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  created_at timestamptz not null default now(),

  field_name text not null,
  field_value text not null,
  source_url text not null,
  source_type text not null default 'manual',
  captured_at timestamptz not null default now(),
  notes text,

  constraint lead_sources_source_type_check check (source_type in ('manual', 'search_result', 'directory', 'social', 'maps', 'other'))
);

-- ===========================================================================
-- outreach_opt_outs
-- Permanent suppression list. lead_id is nullable with ON DELETE SET NULL so
-- deleting a lead can never remove a suppression entry. Independent
-- database-maintained normalized identities, matching leads' pattern.
-- There is no suppression-removal workflow in Phase 1 — permanent means
-- permanent for this version.
-- ===========================================================================

create table if not exists public.outreach_opt_outs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  email text,
  phone text,
  website_url text,
  normalized_email text,
  normalized_phone text,
  normalized_website_domain text,

  business_name text,
  reason text,
  source text not null default 'manual_admin',
  lead_id uuid references public.leads(id) on delete set null,

  constraint outreach_opt_outs_source_check check (source in ('recipient_reply', 'manual_admin', 'unsubscribe_link')),
  constraint outreach_opt_outs_identity_check check (
    normalized_email is not null or normalized_phone is not null or normalized_website_domain is not null
  )
);

-- ===========================================================================
-- lead_activity_log
-- Append-only from the browser's perspective: admins may SELECT, nobody may
-- INSERT/UPDATE/DELETE directly (see RLS section below). All writes happen
-- inside SECURITY DEFINER triggers/RPCs using trusted, database-derived
-- actor identity and server-generated timestamps.
-- ===========================================================================

create table if not exists public.lead_activity_log (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  created_at timestamptz not null default now(),

  actor text,
  action text not null,
  from_status text,
  to_status text,
  detail text,
  metadata jsonb
);

-- Defensive column additions for safe re-runs against a table created by an
-- earlier version of this file. These are additive only — this file never
-- drops a column. An earlier draft of this migration dropped a
-- differently-named "website_domain" column here; that was destructive
-- (silently discarding any data it held) and has been removed. If a table
-- from that earlier draft still has a "website_domain" column, it is left
-- alone: not migrated, not dropped. `CREATE TABLE IF NOT EXISTS` only
-- creates the table when it is entirely absent — it does NOT add missing
-- columns/constraints to an existing, incompatible table, which is why the
-- `alter table ... add column if not exists` and guarded
-- `alter table ... add constraint` blocks below exist as an explicit repair
-- path for a partially-created table from an earlier run.
alter table public.leads add column if not exists normalized_email text;
alter table public.leads add column if not exists normalized_phone text;
alter table public.leads add column if not exists normalized_website_domain text;

-- Guarded repair path: add constraints that a pre-existing table (created by
-- an earlier version of this file, before CREATE TABLE could add them) might
-- be missing. A no-op against a freshly-created table, which already has
-- these from the CREATE TABLE above.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leads_discovery_method_check' and conrelid = 'public.leads'::regclass
  ) then
    alter table public.leads add constraint leads_discovery_method_check check (discovery_method in ('manual', 'ai_search'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'leads_status_check' and conrelid = 'public.leads'::regclass
  ) then
    alter table public.leads add constraint leads_status_check check (status in (
      'Discovered', 'Needs Review', 'Approved for Mockup', 'Mockup In Progress', 'Draft Ready',
      'Approved to Send', 'Contacted', 'Replied', 'Follow-up Due', 'Rejected', 'Opted Out', 'Duplicate'
    ));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'leads_fit_score_range_check' and conrelid = 'public.leads'::regclass
  ) then
    alter table public.leads add constraint leads_fit_score_range_check check (fit_score is null or (fit_score >= 0 and fit_score <= 100));
  end if;
end $$;

-- Backfill normalized_* columns for any pre-existing rows (e.g. from a
-- partial earlier run of this file, or rows written before the phone/domain
-- canonicalization rules above were tightened) before the unique indexes
-- further down are created. This ensures old rows are matched correctly for
-- duplicate/suppression purposes without waiting on an incidental future
-- UPDATE, and makes any genuine duplicate conflict among existing rows
-- surface here as a clear index-creation failure rather than silently
-- leaving rows unindexed and unenforced. On a clean first run (no existing
-- rows) this is a no-op.
update public.leads set
  normalized_email = public.normalize_email(email),
  normalized_phone = public.normalize_phone(phone),
  normalized_website_domain = public.normalize_website_domain(website_url)
where normalized_email is distinct from public.normalize_email(email)
   or normalized_phone is distinct from public.normalize_phone(phone)
   or normalized_website_domain is distinct from public.normalize_website_domain(website_url);

create unique index if not exists leads_normalized_email_unique_idx on public.leads (normalized_email) where normalized_email is not null;
create unique index if not exists leads_normalized_phone_unique_idx on public.leads (normalized_phone) where normalized_phone is not null;
create unique index if not exists leads_normalized_website_domain_unique_idx on public.leads (normalized_website_domain) where normalized_website_domain is not null;

create index if not exists leads_status_idx on public.leads (status);
create index if not exists leads_normalized_business_key_idx on public.leads (normalized_business_key);
create index if not exists leads_normalized_business_key_trgm_idx on public.leads using gin (normalized_business_key gin_trgm_ops);
create index if not exists leads_duplicate_of_idx on public.leads (duplicate_of);
create index if not exists leads_converted_customer_id_idx on public.leads (converted_customer_id);
create index if not exists leads_created_at_idx on public.leads (created_at);
create index if not exists lead_sources_lead_id_idx on public.lead_sources (lead_id);
create index if not exists lead_sources_lead_id_field_name_idx on public.lead_sources (lead_id, field_name);

-- Additive-only, same reasoning as leads above: no column is ever dropped
-- here. A "website_domain" column from an earlier draft, if present, is
-- left alone rather than silently discarded or renamed.
alter table public.outreach_opt_outs add column if not exists normalized_email text;
alter table public.outreach_opt_outs add column if not exists normalized_phone text;
alter table public.outreach_opt_outs add column if not exists normalized_website_domain text;
alter table public.outreach_opt_outs add column if not exists website_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'outreach_opt_outs_source_check' and conrelid = 'public.outreach_opt_outs'::regclass
  ) then
    alter table public.outreach_opt_outs add constraint outreach_opt_outs_source_check check (source in ('recipient_reply', 'manual_admin', 'unsubscribe_link'));
  end if;

  -- outreach_opt_outs_identity_check depends on normalized_email/phone/
  -- website_domain, which a pre-existing table repaired by this block may
  -- not have backfilled yet (that happens below). Adding a CHECK constraint
  -- normally validates it against every existing row immediately — on a
  -- partially-migrated table with un-backfilled rows, that validation would
  -- fail even though the backfill two statements below would fix it. NOT
  -- VALID adds the constraint without checking existing rows (it is still
  -- enforced for all new writes immediately); `validate constraint` after
  -- the backfill then confirms existing rows satisfy it too, so a row
  -- doesn't just silently skip enforcement forever. On a freshly-created
  -- table this constraint is already valid from CREATE TABLE, so this block
  -- and the `validate constraint` below are both no-ops.
  if not exists (
    select 1 from pg_constraint where conname = 'outreach_opt_outs_identity_check' and conrelid = 'public.outreach_opt_outs'::regclass
  ) then
    alter table public.outreach_opt_outs add constraint outreach_opt_outs_identity_check check (
      normalized_email is not null or normalized_phone is not null or normalized_website_domain is not null
    ) not valid;
  end if;
end $$;

-- Backfill, same reasoning as leads above: correct any pre-existing rows
-- before the unique indexes further down are created, and before the
-- identity constraint above is validated.
update public.outreach_opt_outs set
  normalized_email = public.normalize_email(email),
  normalized_phone = public.normalize_phone(phone),
  normalized_website_domain = public.normalize_website_domain(website_url)
where normalized_email is distinct from public.normalize_email(email)
   or normalized_phone is distinct from public.normalize_phone(phone)
   or normalized_website_domain is distinct from public.normalize_website_domain(website_url);

-- Now that every row's normalized_* columns are correct, confirm the
-- identity constraint actually holds. A no-op if it was already valid (the
-- fresh-table case); a clear, actionable failure — not a silently-skipped
-- constraint — if some pre-existing row genuinely has no usable identity at
-- all even after backfill.
alter table public.outreach_opt_outs validate constraint outreach_opt_outs_identity_check;

create unique index if not exists outreach_opt_outs_normalized_email_unique_idx on public.outreach_opt_outs (normalized_email) where normalized_email is not null;
create unique index if not exists outreach_opt_outs_normalized_phone_unique_idx on public.outreach_opt_outs (normalized_phone) where normalized_phone is not null;
create unique index if not exists outreach_opt_outs_normalized_website_domain_unique_idx on public.outreach_opt_outs (normalized_website_domain) where normalized_website_domain is not null;
create index if not exists outreach_opt_outs_lead_id_idx on public.outreach_opt_outs (lead_id);

create index if not exists lead_activity_log_lead_id_idx on public.lead_activity_log (lead_id);
create index if not exists lead_activity_log_created_at_idx on public.lead_activity_log (created_at);

-- Database-maintained normalization. Runs before every insert/update so
-- normalized_email / normalized_phone / normalized_website_domain / has_website
-- are always derived by Postgres, never trusted from the browser. Named so it
-- sorts (and therefore fires) alphabetically before
-- leads_validate_status_transition among same-timing BEFORE triggers.
create or replace function public.leads_set_normalized_fields()
returns trigger
language plpgsql
as $$
begin
  new.normalized_email := public.normalize_email(new.email);
  new.normalized_phone := public.normalize_phone(new.phone);
  new.normalized_website_domain := public.normalize_website_domain(new.website_url);
  new.has_website := (new.normalized_website_domain is not null);
  return new;
end;
$$;

-- Authoritative initial-status enforcement. A generic INSERT policy alone
-- lets any authenticated admin session (including a direct PostgREST call
-- that never touches leads.html) insert a row with any status string that
-- passes the CHECK constraint, including terminal/late-workflow ones like
-- 'Opted Out' or 'Contacted'. This trigger forces every newly-created lead
-- to start at 'Discovered' — the column default already produces this when
-- the caller omits status entirely, so this only ever rejects an explicit,
-- non-Discovered value. opt_out_lead() (and other legal transitions) may
-- still move a lead away from Discovered immediately after creation.
create or replace function public.leads_enforce_initial_status()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from 'Discovered' then
    raise exception 'New leads must be created with status Discovered (got %). Create the lead first, then transition it.', new.status;
  end if;
  return new;
end;
$$;

-- Protects the two RPC-owned columns from any direct browser/API write.
-- converted_customer_id may only be set by convert_lead_to_customer();
-- duplicate_of may only be set by mark_lead_duplicate(). Both RPCs call
-- set_config('saltbox.trusted_write', 'on', true) — transaction-local, so it
-- resets automatically and can never leak across requests — immediately
-- before making the change this trigger would otherwise block. PostgREST
-- never exposes Postgres's built-in set_config() as a callable RPC (it is
-- not a function in the public schema), so a browser client has no way to
-- set that flag itself.
create or replace function public.leads_protect_restricted_columns()
returns trigger
language plpgsql
as $$
begin
  if new.converted_customer_id is distinct from old.converted_customer_id
     and coalesce(current_setting('saltbox.trusted_write', true), '') <> 'on' then
    raise exception 'converted_customer_id can only be changed by convert_lead_to_customer().';
  end if;

  if new.duplicate_of is distinct from old.duplicate_of
     and coalesce(current_setting('saltbox.trusted_write', true), '') <> 'on' then
    raise exception 'duplicate_of can only be changed by mark_lead_duplicate().';
  end if;

  return new;
end;
$$;

-- Authoritative status-transition enforcement. The old CHECK constraint only
-- validated that a status value was one of the known strings; this trigger
-- validates that a transition from OLD.status to NEW.status is legal per
-- lead_status_transitions(), blocks any status change once a lead has been
-- converted (converted_customer_id is set), and makes both 'Opted Out' and
-- 'Duplicate' RPC-only: a direct UPDATE (PostgREST or otherwise) setting
-- either status is rejected unless the transaction-local
-- 'saltbox.trusted_write' flag is 'on', which only opt_out_lead() and
-- mark_lead_duplicate() (respectively) ever set, immediately before their
-- own already-validated write — the same mechanism leads_protect_restricted_
-- columns() uses for converted_customer_id/duplicate_of. This is
-- deliberately NOT "does a matching suppression record already exist" —
-- that check could be satisfied by an unrelated identity match that this
-- particular call never verified or created, which is not a safe basis for
-- an irreversible transition. opt_out_lead() itself is what guarantees every
-- one of the lead's identities is merged into outreach_opt_outs and verified
-- *before* it sets the flag and makes this write.
--
-- It also enforces the suppression boundary on every relevant update (not
-- just ones that change status): a lead whose identity matches a permanent
-- suppression record can never be in, or move into, an outreach-progress
-- status. And it enforces that a lead can never sit at status 'Duplicate'
-- without duplicate_of set — mark_lead_duplicate() always sets both in the
-- same statement, so this only ever fires against a state that shouldn't be
-- reachable at all.
--
-- Identity edits on an already-Opted-Out lead are rejected outright (see
-- "Suppression / opt-out logic" in handoff.md for why Phase 1 takes this
-- simplest-safe approach instead of an in-trigger correction workflow).
create or replace function public.leads_validate_status_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if old.converted_customer_id is not null then
      raise exception 'Cannot change status of a converted lead (lead % has converted_customer_id set).', old.id;
    end if;

    if not (new.status = any (public.lead_status_transitions(old.status))) then
      raise exception 'Illegal lead status transition from % to %.', old.status, new.status;
    end if;

    if new.status = 'Opted Out' and coalesce(current_setting('saltbox.trusted_write', true), '') <> 'on' then
      raise exception 'Opted Out can only be set by opt_out_lead().';
    end if;

    if new.status = 'Duplicate' and coalesce(current_setting('saltbox.trusted_write', true), '') <> 'on' then
      raise exception 'Duplicate can only be set by mark_lead_duplicate().';
    end if;
  end if;

  -- Suppression is a hard boundary on outreach progression, independent of
  -- whether THIS update is the one changing status: editing email/phone/
  -- website on a lead that is already sitting in an outreach status must
  -- not be allowed to newly match (or keep matching) a permanent
  -- suppression identity.
  if public.is_outreach_status(new.status) and public.lead_identity_is_suppressed(new.normalized_email, new.normalized_phone, new.normalized_website_domain) then
    raise exception 'This lead matches a permanent suppression record and cannot be in or move into outreach status %. Use opt_out_lead() instead.', new.status;
  end if;

  -- Invariant: a Duplicate lead must always have a valid duplicate_of
  -- target. Belt-and-suspenders alongside the RPC-only gate above and
  -- leads_protect_restricted_columns (which independently blocks a direct
  -- change to duplicate_of) — this checks the pairing itself, not just each
  -- column in isolation.
  if new.status = 'Duplicate' and new.duplicate_of is null then
    raise exception 'A lead with status Duplicate must have duplicate_of set. Use mark_lead_duplicate().';
  end if;

  -- Opted-out identities are locked in Phase 1: once permanently suppressed,
  -- a lead's email/phone/website can no longer be edited directly at all.
  -- An earlier version of this trigger called the SECURITY DEFINER
  -- merge_lead_identities_into_suppression() helper from here to fold an
  -- edited identity into suppression automatically. That mixes a
  -- side-effecting, privilege-elevating write into what should be a
  -- read-only validation trigger fired by an ordinary UPDATE, which is more
  -- than Phase 1 needs. The simplest safe rule instead: reject the edit
  -- outright. A genuine correction is a rare, deliberate admin action, not a
  -- normal edit — it goes through direct, privileged SQL access outside the
  -- browser, which is intentionally outside what any RPC exposes.
  if old.status = 'Opted Out' and (
       new.email is distinct from old.email
    or new.phone is distinct from old.phone
    or new.website_url is distinct from old.website_url
  ) then
    raise exception 'This lead is permanently suppressed (Opted Out). Its email, phone, and website are locked in Phase 1 and cannot be edited.';
  end if;

  return new;
end;
$$;

-- Trusted activity logging: status changes. Runs AFTER the validation
-- trigger above has either allowed the change or aborted the whole
-- statement, so this only ever records legal transitions. SECURITY DEFINER
-- because lead_activity_log has no browser-facing INSERT policy at all.
-- Skipped when the update came through a trusted RPC that already writes
-- its own, richer activity entry (opt_out_lead, mark_lead_duplicate) — this
-- is what "saltbox.trusted_write" is for here, avoiding a duplicate log
-- entry for the same status change.
create or replace function public.leads_log_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status
     and coalesce(current_setting('saltbox.trusted_write', true), '') <> 'on' then
    insert into public.lead_activity_log (lead_id, actor, action, from_status, to_status, detail)
    values (new.id, public.current_actor_label(), 'status_changed', old.status, new.status, new.rejected_reason);
  end if;
  return new;
end;
$$;

-- Trusted activity logging: lead creation and meaningful edits. "Meaningful"
-- means a business/contact/scoring field actually changed — status,
-- duplicate_of, converted_customer_id, and normalized_*/has_website/updated_at
-- changes are intentionally excluded here because they are already logged by
-- their own dedicated triggers/RPCs (leads_log_status_change,
-- mark_lead_duplicate, convert_lead_to_customer), avoiding duplicate or noisy
-- entries.
create or replace function public.leads_log_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_changed text[] := array[]::text[];
begin
  if tg_op = 'INSERT' then
    insert into public.lead_activity_log (lead_id, actor, action, detail)
    values (new.id, public.current_actor_label(), 'lead_created', new.business_name);
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.business_name is distinct from old.business_name then v_changed := v_changed || 'business_name'; end if;
    if new.contact_name is distinct from old.contact_name then v_changed := v_changed || 'contact_name'; end if;
    if new.email is distinct from old.email then v_changed := v_changed || 'email'; end if;
    if new.phone is distinct from old.phone then v_changed := v_changed || 'phone'; end if;
    if new.website_url is distinct from old.website_url then v_changed := v_changed || 'website_url'; end if;
    if new.address is distinct from old.address then v_changed := v_changed || 'address'; end if;
    if new.city is distinct from old.city then v_changed := v_changed || 'city'; end if;
    if new.state is distinct from old.state then v_changed := v_changed || 'state'; end if;
    if new.postal_code is distinct from old.postal_code then v_changed := v_changed || 'postal_code'; end if;
    if new.country is distinct from old.country then v_changed := v_changed || 'country'; end if;
    if new.category is distinct from old.category then v_changed := v_changed || 'category'; end if;
    if new.assigned_to is distinct from old.assigned_to then v_changed := v_changed || 'assigned_to'; end if;
    if new.notes is distinct from old.notes then v_changed := v_changed || 'notes'; end if;
    if new.fit_score is distinct from old.fit_score then v_changed := v_changed || 'fit_score'; end if;
    if new.fit_score_reasoning is distinct from old.fit_score_reasoning then v_changed := v_changed || 'fit_score_reasoning'; end if;
    if new.activity_confirmed is distinct from old.activity_confirmed then v_changed := v_changed || 'activity_confirmed'; end if;
    if new.activity_confirmed_notes is distinct from old.activity_confirmed_notes then v_changed := v_changed || 'activity_confirmed_notes'; end if;

    if array_length(v_changed, 1) > 0 then
      insert into public.lead_activity_log (lead_id, actor, action, detail, metadata)
      values (
        new.id,
        public.current_actor_label(),
        'lead_updated',
        array_to_string(v_changed, ', ') || ' changed',
        jsonb_build_object('changed_fields', to_jsonb(v_changed))
      );
    end if;
    return new;
  end if;

  return new;
end;
$$;

-- Trusted activity logging: source creation, update, and removal.
-- SECURITY DEFINER because lead_activity_log has no browser-facing INSERT
-- policy.
create or replace function public.lead_sources_log_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.lead_activity_log (lead_id, actor, action, detail)
    values (new.lead_id, public.current_actor_label(), 'source_added', new.field_name || ': ' || new.field_value);
    return new;
  elsif tg_op = 'UPDATE' then
    insert into public.lead_activity_log (lead_id, actor, action, detail)
    values (new.lead_id, public.current_actor_label(), 'source_updated', new.field_name || ': ' || new.field_value);
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.lead_activity_log (lead_id, actor, action, detail)
    values (old.lead_id, public.current_actor_label(), 'source_removed', old.field_name || ': ' || old.field_value);
    return old;
  end if;
  return null;
end;
$$;

create or replace function public.outreach_opt_outs_set_normalized_fields()
returns trigger
language plpgsql
as $$
begin
  new.normalized_email := public.normalize_email(new.email);
  new.normalized_phone := public.normalize_phone(new.phone);
  new.normalized_website_domain := public.normalize_website_domain(new.website_url);
  return new;
end;
$$;

-- True if any of the given normalized identities already matches a
-- permanent suppression record. Invoker-rights: the calling admin session
-- already has its own SELECT policy on outreach_opt_outs, so no elevation
-- is needed just to read it. Deliberately placed here, after
-- outreach_opt_outs is fully created above (table, trigger, indexes) —
-- LANGUAGE SQL function bodies are parsed and validated against real
-- database objects immediately at CREATE FUNCTION time (unlike
-- LANGUAGE PLPGSQL bodies, which are only checked at first execution), so
-- this function must not be created before the table it queries exists.
-- It is called from leads_validate_status_transition() above (a plpgsql
-- trigger function defined earlier, in the leads table's section) — that
-- call is fine regardless of definition order, since a plpgsql body isn't
-- resolved against other functions until it actually runs, long after this
-- entire migration has committed.
create or replace function public.lead_identity_is_suppressed(
  p_normalized_email text, p_normalized_phone text, p_normalized_domain text
)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.outreach_opt_outs o
    where (p_normalized_email is not null and o.normalized_email = p_normalized_email)
       or (p_normalized_phone is not null and o.normalized_phone = p_normalized_phone)
       or (p_normalized_domain is not null and o.normalized_website_domain = p_normalized_domain)
  );
$$;

-- Deterministic identity merge into the permanent suppression list. This is
-- the single place that ever writes to outreach_opt_outs. It is called only
-- by opt_out_lead() below — not from any trigger — and trusts that its
-- caller has already canonicalized p_source to one of the three values
-- outreach_opt_outs_source_check allows (opt_out_lead() does this exactly
-- once, before calling here, so the same canonical value is used for both
-- the outreach_opt_outs row and the caller's own activity-log metadata).
--
-- The previous implementation did a single `insert ... on conflict do
-- nothing`, which meant: if the lead's email already matched an existing
-- suppression row, the whole insert was skipped — including a phone or
-- website identity on the same lead that had never been suppressed before.
-- That let a not-yet-suppressed identity dimension "escape" suppression
-- entirely.
--
-- This version handles each of the lead's up-to-three identities
-- (normalized_email, normalized_phone, normalized_website_domain)
-- independently:
--   1. If an identity is already represented by some row, nothing to do.
--   2. Otherwise, try to attach it to an existing row that already matches
--      a *different* one of the lead's identities and has a free column for
--      this one (handles the "different rows match different identities"
--      collision case by consolidating onto one row where possible, without
--      ever overwriting an existing, unrelated value already stored there).
--   3. Otherwise, insert a new minimal row carrying just that identity.
-- It finishes by re-querying outreach_opt_outs and raising an exception if
-- any non-null identity the lead has is still not represented — a hard
-- verification backstop, not an assumption that the steps above worked.
create or replace function public.merge_lead_identities_into_suppression(
  p_lead_id uuid,
  p_email text,
  p_phone text,
  p_website_url text,
  p_business_name text,
  p_reason text,
  p_source text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_norm_email text := public.normalize_email(p_email);
  v_norm_phone text := public.normalize_phone(p_phone);
  v_norm_domain text := public.normalize_website_domain(p_website_url);
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_row_id uuid;
begin
  if v_norm_email is null and v_norm_phone is null and v_norm_domain is null then
    raise exception 'This lead has no usable email, phone, or website to suppress.';
  end if;

  -- Lock every existing row that could be touched by this merge up front,
  -- so a concurrent opt-out on an overlapping identity serializes instead
  -- of racing.
  perform 1 from public.outreach_opt_outs
    where (v_norm_email is not null and normalized_email = v_norm_email)
       or (v_norm_phone is not null and normalized_phone = v_norm_phone)
       or (v_norm_domain is not null and normalized_website_domain = v_norm_domain)
    for update;

  -- Email
  if v_norm_email is not null and not exists (
    select 1 from public.outreach_opt_outs where normalized_email = v_norm_email
  ) then
    select id into v_row_id from public.outreach_opt_outs
      where email is null
        and ((v_norm_phone is not null and normalized_phone = v_norm_phone)
          or (v_norm_domain is not null and normalized_website_domain = v_norm_domain))
      limit 1;
    if v_row_id is not null then
      update public.outreach_opt_outs
      set email = p_email,
          business_name = coalesce(business_name, p_business_name),
          reason = coalesce(reason, v_reason),
          source = p_source,
          lead_id = coalesce(lead_id, p_lead_id)
      where id = v_row_id;
    else
      insert into public.outreach_opt_outs (email, business_name, reason, source, lead_id)
      values (p_email, p_business_name, v_reason, p_source, p_lead_id);
    end if;
  end if;

  -- Phone
  if v_norm_phone is not null and not exists (
    select 1 from public.outreach_opt_outs where normalized_phone = v_norm_phone
  ) then
    select id into v_row_id from public.outreach_opt_outs
      where phone is null
        and ((v_norm_email is not null and normalized_email = v_norm_email)
          or (v_norm_domain is not null and normalized_website_domain = v_norm_domain))
      limit 1;
    if v_row_id is not null then
      update public.outreach_opt_outs
      set phone = p_phone,
          business_name = coalesce(business_name, p_business_name),
          reason = coalesce(reason, v_reason),
          source = p_source,
          lead_id = coalesce(lead_id, p_lead_id)
      where id = v_row_id;
    else
      insert into public.outreach_opt_outs (phone, business_name, reason, source, lead_id)
      values (p_phone, p_business_name, v_reason, p_source, p_lead_id);
    end if;
  end if;

  -- Website domain
  if v_norm_domain is not null and not exists (
    select 1 from public.outreach_opt_outs where normalized_website_domain = v_norm_domain
  ) then
    select id into v_row_id from public.outreach_opt_outs
      where website_url is null
        and ((v_norm_email is not null and normalized_email = v_norm_email)
          or (v_norm_phone is not null and normalized_phone = v_norm_phone))
      limit 1;
    if v_row_id is not null then
      update public.outreach_opt_outs
      set website_url = p_website_url,
          business_name = coalesce(business_name, p_business_name),
          reason = coalesce(reason, v_reason),
          source = p_source,
          lead_id = coalesce(lead_id, p_lead_id)
      where id = v_row_id;
    else
      insert into public.outreach_opt_outs (website_url, business_name, reason, source, lead_id)
      values (p_website_url, p_business_name, v_reason, p_source, p_lead_id);
    end if;
  end if;

  -- Verify every non-null identity is now represented before returning
  -- control to the caller — a hard backstop, not just an assumption the
  -- merge above worked.
  if v_norm_email is not null and not exists (
    select 1 from public.outreach_opt_outs where normalized_email = v_norm_email
  ) then
    raise exception 'Suppression merge failed to record the email identity for lead %.', p_lead_id;
  end if;
  if v_norm_phone is not null and not exists (
    select 1 from public.outreach_opt_outs where normalized_phone = v_norm_phone
  ) then
    raise exception 'Suppression merge failed to record the phone identity for lead %.', p_lead_id;
  end if;
  if v_norm_domain is not null and not exists (
    select 1 from public.outreach_opt_outs where normalized_website_domain = v_norm_domain
  ) then
    raise exception 'Suppression merge failed to record the website identity for lead %.', p_lead_id;
  end if;
end;
$$;

drop trigger if exists set_leads_updated_at on public.leads;
create trigger set_leads_updated_at
before update on public.leads
for each row execute function public.set_updated_at();

drop trigger if exists leads_set_normalized_fields on public.leads;
create trigger leads_set_normalized_fields
before insert or update on public.leads
for each row execute function public.leads_set_normalized_fields();

drop trigger if exists leads_enforce_initial_status on public.leads;
create trigger leads_enforce_initial_status
before insert on public.leads
for each row execute function public.leads_enforce_initial_status();

drop trigger if exists leads_protect_restricted_columns on public.leads;
create trigger leads_protect_restricted_columns
before update on public.leads
for each row execute function public.leads_protect_restricted_columns();

drop trigger if exists leads_validate_status_transition on public.leads;
create trigger leads_validate_status_transition
before update of status, email, phone, website_url on public.leads
for each row execute function public.leads_validate_status_transition();

drop trigger if exists leads_log_status_change on public.leads;
create trigger leads_log_status_change
after update of status on public.leads
for each row execute function public.leads_log_status_change();

drop trigger if exists leads_log_lifecycle on public.leads;
create trigger leads_log_lifecycle
after insert or update on public.leads
for each row execute function public.leads_log_lifecycle();

drop trigger if exists lead_sources_log_activity on public.lead_sources;
create trigger lead_sources_log_activity
after insert or update or delete on public.lead_sources
for each row execute function public.lead_sources_log_activity();

drop trigger if exists outreach_opt_outs_set_normalized_fields on public.outreach_opt_outs;
create trigger outreach_opt_outs_set_normalized_fields
before insert or update on public.outreach_opt_outs
for each row execute function public.outreach_opt_outs_set_normalized_fields();

-- ===========================================================================
-- Trusted RPC functions
-- Every function below: verifies public.is_admin() internally, uses a fixed
-- search_path, schema-qualifies every object it touches, avoids dynamic SQL,
-- and has default PUBLIC execute revoked with execute granted only to
-- authenticated. Each runs as a single Postgres function invocation, so
-- Postgres itself guarantees all-or-nothing behavior — any exception rolls
-- back every write the function attempted.
-- ===========================================================================

-- Narrowly-scoped note insertion: the only way the browser can add a
-- lead_activity_log row directly. Can only ever create an action = 'note'
-- entry with a trusted actor and timestamp.
create or replace function public.add_lead_note(p_lead_id uuid, p_note text)
returns public.lead_activity_log
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_note text;
  v_row public.lead_activity_log;
begin
  if not public.is_admin() then
    raise exception 'Not authorized.';
  end if;

  v_note := nullif(trim(coalesce(p_note, '')), '');
  if v_note is null then
    raise exception 'Note text is required.';
  end if;

  if not exists (select 1 from public.leads where id = p_lead_id) then
    raise exception 'Lead % not found.', p_lead_id;
  end if;

  insert into public.lead_activity_log (lead_id, actor, action, detail)
  values (p_lead_id, public.current_actor_label(), 'note', v_note)
  returning * into v_row;

  return v_row;
end;
$$;

-- Atomic, permanent opt-out. Locks the lead, requires at least one usable
-- normalized identity, merges every known identity into outreach_opt_outs
-- (see merge_lead_identities_into_suppression() above — this guarantees
-- every identity is represented, not just the first one matched), verifies
-- that merge before touching status, sets the transaction-local
-- 'saltbox.trusted_write' flag, then transitions the lead to Opted Out — the
-- flag is what leads_validate_status_transition() actually requires for that
-- transition now (not "does a suppression record happen to already exist",
-- which could be satisfied by an unrelated match this call never verified)
-- — then records a trusted activity entry. A direct UPDATE of leads.status
-- to 'Opted Out' that skips this function is unconditionally rejected: the
-- flag is never set outside this one call site, and PostgREST has no way to
-- set it itself.
create or replace function public.opt_out_lead(p_lead_id uuid, p_reason text, p_source text default 'manual_admin')
returns public.leads
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lead public.leads;
  v_source text;
begin
  if not public.is_admin() then
    raise exception 'Not authorized.';
  end if;

  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % not found.', p_lead_id;
  end if;

  if v_lead.normalized_email is null and v_lead.normalized_phone is null and v_lead.normalized_website_domain is null then
    raise exception 'This lead has no usable email, phone, or website to suppress.';
  end if;

  -- Canonicalize the opt-out source exactly once, here. The same value is
  -- then used both for the outreach_opt_outs row (via
  -- merge_lead_identities_into_suppression, which trusts this is already
  -- canonical) and the opted_out activity metadata below, so the two can
  -- never disagree about what source was actually recorded.
  v_source := coalesce(nullif(trim(coalesce(p_source, '')), ''), 'manual_admin');
  if v_source not in ('recipient_reply', 'manual_admin', 'unsubscribe_link') then
    v_source := 'manual_admin';
  end if;

  -- Merges and verifies every one of this lead's identities into
  -- outreach_opt_outs; raises (aborting this whole call) if verification
  -- fails.
  perform public.merge_lead_identities_into_suppression(
    p_lead_id, v_lead.email, v_lead.phone, v_lead.website_url, v_lead.business_name, p_reason, v_source
  );

  perform set_config('saltbox.trusted_write', 'on', true);
  update public.leads set status = 'Opted Out' where id = p_lead_id;

  insert into public.lead_activity_log (lead_id, actor, action, detail, metadata)
  values (
    p_lead_id,
    public.current_actor_label(),
    'opted_out',
    nullif(trim(coalesce(p_reason, '')), ''),
    jsonb_build_object('source', v_source)
  );

  select * into v_lead from public.leads where id = p_lead_id;
  return v_lead;
end;
$$;

-- Atomic duplicate marking. Locks both the source and target leads (in a
-- stable id order, so two concurrent calls marking the same pair in
-- opposite directions can't deadlock), rejects self-reference and an
-- unsuitable target (not found, itself already a duplicate of something
-- else, already status Duplicate, or permanently suppressed — none of
-- those are safe canonical leads to point at), then updates duplicate_of
-- and status together (status is separately validated by
-- leads_validate_status_transition, which allows entry to Duplicate from any
-- normal admin-managed status only when this trusted RPC sets its guarded
-- write flag), then records a trusted
-- activity entry. duplicate_of is protected from any other write path by
-- leads_protect_restricted_columns; set_config('saltbox.trusted_write', ...)
-- below is what authorizes this specific, validated write.
create or replace function public.mark_lead_duplicate(p_lead_id uuid, p_duplicate_of_id uuid)
returns public.leads
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lead public.leads;
  v_target public.leads;
begin
  if not public.is_admin() then
    raise exception 'Not authorized.';
  end if;

  if p_lead_id = p_duplicate_of_id then
    raise exception 'A lead cannot be marked as a duplicate of itself.';
  end if;

  -- Lock both rows in a stable order (lowest id first) rather than
  -- source-then-target, so this call and a concurrent call marking the
  -- same two leads for each other can't deadlock against one another.
  if p_lead_id < p_duplicate_of_id then
    select * into v_lead from public.leads where id = p_lead_id for update;
    select * into v_target from public.leads where id = p_duplicate_of_id for update;
  else
    select * into v_target from public.leads where id = p_duplicate_of_id for update;
    select * into v_lead from public.leads where id = p_lead_id for update;
  end if;

  if v_lead.id is null then
    raise exception 'Lead % not found.', p_lead_id;
  end if;
  if v_target.id is null then
    raise exception 'Target lead % not found.', p_duplicate_of_id;
  end if;

  if v_target.duplicate_of is not null then
    raise exception 'Target lead % is itself already marked as a duplicate; point to its canonical lead instead.', p_duplicate_of_id;
  end if;
  if v_target.status = 'Duplicate' then
    raise exception 'Target lead % is marked Duplicate and cannot be used as a canonical lead.', p_duplicate_of_id;
  end if;
  if v_target.status = 'Opted Out' then
    raise exception 'Target lead % is permanently suppressed and cannot be used as a canonical lead.', p_duplicate_of_id;
  end if;

  perform set_config('saltbox.trusted_write', 'on', true);
  update public.leads
  set duplicate_of = p_duplicate_of_id, status = 'Duplicate'
  where id = p_lead_id;

  insert into public.lead_activity_log (lead_id, actor, action, detail, metadata)
  values (
    p_lead_id,
    public.current_actor_label(),
    'duplicate_marked',
    'Marked as a duplicate of lead ' || p_duplicate_of_id::text,
    jsonb_build_object('duplicate_of', p_duplicate_of_id)
  );

  select * into v_lead from public.leads where id = p_lead_id;
  return v_lead;
end;
$$;

-- Atomic, idempotent lead-to-customer conversion. Locks the lead;
-- already-converted leads short-circuit and return the existing customer id
-- without doing further work (safe to call repeatedly); ineligible statuses
-- (Duplicate/Rejected/Opted Out) are rejected; an existing customer is
-- matched by normalized email before a new one is created, so retries or
-- races never create duplicate customer rows. converted_customer_id is the
-- only representation of "converted" — no new lead status is introduced.
-- converted_customer_id is protected from any other write path by
-- leads_protect_restricted_columns; set_config('saltbox.trusted_write', ...)
-- below is what authorizes this specific write. Once set, the transition
-- trigger also blocks the lead from ever changing status again, so a
-- converted lead can never re-enter outreach progression.
create or replace function public.convert_lead_to_customer(p_lead_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lead public.leads;
  v_customer_id uuid;
  v_existing_found boolean := false;
begin
  if not public.is_admin() then
    raise exception 'Not authorized.';
  end if;

  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % not found.', p_lead_id;
  end if;

  if v_lead.converted_customer_id is not null then
    return jsonb_build_object(
      'lead_id', p_lead_id,
      'customer_id', v_lead.converted_customer_id,
      'status', 'already_converted'
    );
  end if;

  if v_lead.status in ('Duplicate', 'Rejected', 'Opted Out') then
    raise exception 'Cannot convert a lead with status %.', v_lead.status;
  end if;

  if v_lead.normalized_email is not null then
    select id into v_customer_id
    from public.customers
    where lower(trim(email)) = v_lead.normalized_email
    limit 1;

    if v_customer_id is not null then
      v_existing_found := true;
    end if;
  end if;

  if v_customer_id is null then
    insert into public.customers (name, email, phone, business_name, business_type, status, lead_source, notes)
    values (
      coalesce(v_lead.contact_name, v_lead.business_name),
      v_lead.email,
      v_lead.phone,
      v_lead.business_name,
      v_lead.category,
      'Lead',
      'Lead Engine',
      v_lead.notes
    )
    returning id into v_customer_id;
  end if;

  perform set_config('saltbox.trusted_write', 'on', true);
  update public.leads set converted_customer_id = v_customer_id where id = p_lead_id;

  insert into public.lead_activity_log (lead_id, actor, action, detail, metadata)
  values (
    p_lead_id,
    public.current_actor_label(),
    'converted_to_customer',
    'Converted to customer ' || v_customer_id::text,
    jsonb_build_object('customer_id', v_customer_id, 'existing_customer_found', v_existing_found)
  );

  return jsonb_build_object(
    'lead_id', p_lead_id,
    'customer_id', v_customer_id,
    'status', case when v_existing_found then 'existing_customer_matched' else 'created' end
  );
end;
$$;

-- ===========================================================================
-- Row level security
-- ===========================================================================

alter table public.leads enable row level security;
alter table public.lead_sources enable row level security;
alter table public.outreach_opt_outs enable row level security;
alter table public.lead_activity_log enable row level security;

-- leads: admins can select/insert/update directly. There is deliberately no
-- DELETE policy — hard deletion of a lead is blocked in Phase 1 so that
-- lead_activity_log rows (ON DELETE CASCADE from leads) can never disappear
-- through normal browser operations. Use a terminal status (Rejected /
-- Opted Out / Duplicate) instead of deleting a lead. See handoff.md.
drop policy if exists "Admins can manage leads" on public.leads;
drop policy if exists "Admins can view leads" on public.leads;
drop policy if exists "Admins can create leads" on public.leads;
drop policy if exists "Admins can update leads" on public.leads;

create policy "Admins can view leads"
on public.leads
for select
to authenticated
using (public.is_admin());

create policy "Admins can create leads"
on public.leads
for insert
to authenticated
with check (public.is_admin());

create policy "Admins can update leads"
on public.leads
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- lead_sources: unchanged full admin access, including delete — deleting a
-- bad source row does not destroy a lead's own status/activity history, and
-- the delete itself is captured by lead_sources_log_activity above.
drop policy if exists "Admins can manage lead sources" on public.lead_sources;
create policy "Admins can manage lead sources"
on public.lead_sources
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- outreach_opt_outs: admins may only SELECT directly. There is no browser
-- INSERT, UPDATE, or DELETE policy — every write goes through opt_out_lead(),
-- which normalizes identities, requires a usable one, and is the only
-- trusted writer. This also means no generic identity-changing UPDATE and no
-- generic DELETE are possible from the browser; permanent means permanent.
drop policy if exists "Admins can manage outreach opt outs" on public.outreach_opt_outs;
drop policy if exists "Admins can view outreach opt outs" on public.outreach_opt_outs;
create policy "Admins can view outreach opt outs"
on public.outreach_opt_outs
for select
to authenticated
using (public.is_admin());

-- lead_activity_log: admins may only SELECT directly. There is no browser
-- INSERT, UPDATE, or DELETE policy — every write goes through the trusted
-- triggers and RPCs above (all SECURITY DEFINER), using auth.uid()-derived
-- actor identity and server-generated timestamps, never browser-supplied
-- values.
drop policy if exists "Admins can manage lead activity log" on public.lead_activity_log;
drop policy if exists "Admins can view lead activity log" on public.lead_activity_log;
create policy "Admins can view lead activity log"
on public.lead_activity_log
for select
to authenticated
using (public.is_admin());

-- Not directly callable through the API: every trigger/RPC below that needs
-- an actor label is itself SECURITY DEFINER (or calls one that is), so it
-- can invoke this function using the function-owner's privileges regardless
-- of the caller's own grants. Revoking PUBLIC execute here means a
-- PostgREST client cannot hit /rpc/current_actor_label directly — there is
-- no legitimate reason for any authenticated session, admin or customer, to
-- call this on its own.
revoke all on function public.current_actor_label() from public;
revoke all on function public.add_lead_note(uuid, text) from public;
grant execute on function public.add_lead_note(uuid, text) to authenticated;
revoke all on function public.merge_lead_identities_into_suppression(uuid, text, text, text, text, text, text) from public;
revoke all on function public.opt_out_lead(uuid, text, text) from public;
grant execute on function public.opt_out_lead(uuid, text, text) to authenticated;
revoke all on function public.mark_lead_duplicate(uuid, uuid) from public;
grant execute on function public.mark_lead_duplicate(uuid, uuid) to authenticated;
revoke all on function public.convert_lead_to_customer(uuid) from public;
grant execute on function public.convert_lead_to_customer(uuid) to authenticated;
COMMIT;
