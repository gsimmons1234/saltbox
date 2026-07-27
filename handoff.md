# Saltbox Handoff

## Current Project Structure

Saltbox is a static site with Supabase-backed quote requests, a protected admin area, launch SQL hardening, a first customer portal, and Netlify Function scaffolds for Stripe.

Top-level files:

- `index.html` - public marketing site and quote form
- `supabase-client.js` - Supabase browser client using the publishable anon key
- `login.html` - admin login
- `admin.html` - admin dashboard
- `requests.html` - quote requests
- `customers.html` - customer list and manual customer creation
- `customer-detail.html` - customer profile, notes, files, invoices, and customer-linked tickets
- `tickets.html` - real ticket list/detail/create/update UI
- `subscriptions.html` - real subscription list UI
- `settings.html` - account and Supabase status
- `client-login.html` - customer portal login
- `client-dashboard.html` - customer portal dashboard scoped to the logged-in email
- `admin.css` - shared dark admin/client-portal styling
- `admin.js` - admin auth guard, Supabase helpers, shared format/render helpers
- `supabase-schema.sql` - earlier customer-management schema
- `supabase-launch-schema.sql` - launch-ready schema and RLS hardening
- `supabase-lead-engine-schema.sql` - Lead Engine Phase 1 schema (leads, lead_sources, outreach_opt_outs, lead_activity_log) — written but NOT yet run in Supabase
- `leads.js` - Lead Engine data module: CRUD, status transitions, duplicate detection, suppression checks, lead-to-customer conversion
- `leads.html` - Lead Engine list/search/manual-entry admin page
- `lead-detail.html` - Lead Engine detail page: overview edit, status transitions, scoring, duplicate check, source records, suppression, activity log, convert to customer
- `package.json` - Netlify Function dependencies

Netlify Functions:

- `netlify/functions/create-checkout-session.js`
- `netlify/functions/create-customer-portal-session.js`
- `netlify/functions/create-invoice.js`
- `netlify/functions/stripe-webhook.js`

## Existing Public Pages

- `index.html`

The public homepage, hero, story/how-it-works section, public pricing/package layout, and quote form visual layout were not changed in this session.

## Existing Admin Pages

All admin pages call `initAdminPage(...)` from `admin.js` and redirect logged-out users to `login.html`.

- `admin.html`
- `requests.html`
- `leads.html`
- `lead-detail.html`
- `customers.html`
- `customer-detail.html`
- `tickets.html`
- `subscriptions.html`
- `settings.html`

## Existing Customer Portal Pages

- `client-login.html` uses Supabase Auth.
- `client-dashboard.html` requires a Supabase session and queries only the customer record matching the logged-in user's email.

Current portal security model: email matching. This is acceptable for a first foundation only if customer auth emails are controlled carefully. Later, add explicit customer user IDs for stronger linking.

## Supabase Tables Expected by the Code

Existing quote form/admin:

- `quote_requests`

**Known gap: `quote_requests` has no `CREATE TABLE` statement in this repo.** It is referenced by foreign key and RLS policy in `supabase-launch-schema.sql`, and `quote.html`/`admin.js` read and write it, so the table clearly exists in the live Supabase project — but its actual column list and constraints were evidently created directly in the Supabase SQL editor at some point and never captured in a tracked schema file. This session did not guess at, recreate, or alter it in any way; it is documented here as a prerequisite to resolve later (ideally by exporting its real definition from Supabase into a tracked file), not something to reverse-engineer speculatively.

Lead Engine (Phase 1 — schema written in `supabase-lead-engine-schema.sql`, not yet run):

- `leads`
- `lead_sources`
- `outreach_opt_outs`
- `lead_activity_log`

Phase 2-5 Lead Engine tables (`lead_audits`, `lead_mockups`, `outreach_drafts`, `outreach_events`) do not exist yet and are intentionally out of scope for this file.

Customer system:

- `customers`
- `customer_notes`
- `customer_files`
- `customer_invoices`

Launch/admin security:

- `admin_users`

Tickets:

- `tickets`
- `ticket_comments`

Billing:

- `subscriptions`

Storage:

- private bucket `customer-files`
- metadata in `customer_files`

## Known Setup Already Completed

- Supabase browser client is configured in `supabase-client.js`.
- The public quote form submits to `quote_requests`.
- Admin login uses Supabase Auth.
- Admin pages are protected by `initAdminPage(...)`.
- Customer management UI exists.
- Tickets UI now reads/writes real `tickets` rows after launch SQL is applied.
- Draft invoices save to `customer_invoices`.
- File uploads use Supabase Storage bucket `customer-files` if the bucket and policies exist.
- Netlify Function scaffolds are present for Stripe.

## Current Security Gaps

- `supabase-launch-schema.sql` must be run before real client data is stored.
- After running launch SQL, Gabby's Supabase Auth `user_id` must be inserted into `admin_users`; otherwise admin reads/writes will be blocked by RLS.
- Customer portal access is currently matched by logged-in email. Later harden with explicit customer user IDs.
- Stripe is scaffolded only. Do not treat billing as live until Stripe env vars, webhook endpoint, products/prices, and test payments are configured.
- File download URLs for the customer portal are not implemented. The portal lists file metadata only.
- `SUPABASE_SERVICE_ROLE_KEY` is referenced only in Netlify Functions and must never be placed in browser code.
- `supabase-lead-engine-schema.sql` has not been run yet. Until it is, `leads.html` and `lead-detail.html` will load but every Supabase call will fail (the pages handle this as a normal error state, not a crash).

## Lead Engine (Phase 1)

Phase 1 of the assisted client-discovery/outreach system: manual lead entry, review, scoring, status tracking, duplicate detection, permanent suppression, and lead-to-customer conversion. No automated research, mockup generation, screenshotting, or email sending exists yet — those are Phases 2-5 and are not built.

This section was substantially revised after a read-only security audit found release-blocking gaps in the first pass (browser-trusted normalization, a client-only transition "guard" that the database didn't actually enforce, a directly-writable activity log, non-atomic opt-out/duplicate/conversion flows, unsanitized link rendering, and an admin page guard that only checked for *a* session rather than an *admin* session). Everything below describes the corrected, current implementation — not the original one.

### Database

`supabase-lead-engine-schema.sql` runs as a single transaction (`BEGIN` ... `COMMIT`): either every statement applies, or none does. It does not alter, recreate, or drop any existing Saltbox table, policy, Stripe object, or customer-portal object, and `quote_requests` is not referenced. It creates exactly four tables:

- **`leads`** — one row per prospect. `status` is constrained by a `CHECK` to the 12-value enum (see Status workflow), but that CHECK only validates the string is a known status — it does **not** enforce which transitions are legal, nor what a lead may start at (see below for what does). Raw `email`/`phone`/`website_url` are user-entered; `normalized_email`, `normalized_phone`, `normalized_website_domain`, and `has_website` are computed by a `BEFORE INSERT OR UPDATE` trigger (`leads_set_normalized_fields`), never by browser code. Partial unique indexes on all three normalized columns (`where ... is not null`) hard-block exact duplicate leads on email, phone, and website domain.
- **`lead_sources`** — provenance rows (`field_name`, `field_value`, `source_url`, `source_type`, `captured_at`). Every insert, update, and delete is auto-logged to `lead_activity_log` by a trigger.
- **`outreach_opt_outs`** — the permanent suppression list. Same normalization pattern as `leads` (raw `email`/`phone`/`website_url` plus trigger-computed `normalized_email`/`normalized_phone`/`normalized_website_domain`), with a `CHECK` requiring at least one non-null normalized identity and partial unique indexes on all three normalized columns. `lead_id` is nullable with `ON DELETE SET NULL` so deleting a lead can never remove a suppression entry. **There is no browser-facing INSERT, UPDATE, or DELETE policy on this table at all** — the only way to write a row is `merge_lead_identities_into_suppression()`, called from `opt_out_lead()` and from the identity-change trigger described below. There is no suppression-removal workflow in Phase 1; permanent means permanent for this version.
- **`lead_activity_log`** — the audit trail. **There is no browser-facing INSERT, UPDATE, or DELETE policy on this table either** — admins may only `SELECT`. Every row is written by a trusted, `SECURITY DEFINER` trigger or RPC, using `auth.uid()` (resolved to an admin's email via `admin_users`, never a browser-supplied name) and a server-generated `created_at`.

Database functions created (all schema-qualified `public.*`, `SECURITY DEFINER` ones use a fixed `set search_path = public, pg_temp` and avoid dynamic SQL):

- `normalize_email(text)` — trim + lowercase, blank → null.
- `normalize_phone(text)` — US canonicalization: strip everything but digits; an 11-digit result starting with `1` drops the leading digit to the corresponding 10-digit form (so `(801) 555-1212` and `+1 801-555-1212` normalize identically); a 10-digit result is kept; blank or any other digit count → null. Never matches on a truncated suffix.
- `normalize_website_domain(text)` — lowercase, strip scheme/single leading `www.`/path/query/fragment/port/trailing dot, then validates the remaining host against real hostname syntax (malformed → null). Legitimate subdomains (e.g. `shop.example.com`) are preserved as their own identity. A fixed list of known hosted-profile hosts (`facebook.com`, `instagram.com`, `linkedin.com`, `yelp.com`, `maps.google.com`, `bbb.org`, etc. — see the function body for the full list) and Google's path-based `google.com/maps`, `/local`, `/business` URLs return `null` instead of a domain, since those are per-tenant paths under one shared host, not a business's own domain. The raw `website_url` is still stored for reference/as a source; it just never becomes a hard duplicate/suppression identity without a safe, business-specific extractor, which Phase 1 does not implement.
- `current_actor_label()` (`SECURITY DEFINER`, **PUBLIC execute revoked**) — resolves the calling admin's email from `admin_users` via `auth.uid()`; used by every trigger/RPC that writes `lead_activity_log.actor`. Not directly callable through PostgREST — every caller is itself `SECURITY DEFINER` (or calls one), so it runs under the function owner's privileges regardless of the caller's own grants. There is no legitimate reason for any authenticated session to call it directly, so `execute` is revoked from `public` and never granted to `authenticated`.
- `lead_status_transitions(text)` — returns the array of legal next statuses for a given status. `'Opted Out'` returns an empty array: **Opted Out is terminal in Phase 1**, there is no reopen/suppression-lift workflow.
- `is_outreach_status(text)` — true for the seven active-outreach statuses (`Approved for Mockup` through `Follow-up Due`, i.e. everything past `Needs Review`/`Duplicate`/`Rejected`/`Opted Out`/`Discovered`).
- `lead_identity_is_suppressed(normalized_email, normalized_phone, normalized_domain)` — true if any of the three matches an existing `outreach_opt_outs` row. Invoker-rights; the calling admin already has read access via RLS.
- `leads_set_normalized_fields()` — `BEFORE INSERT OR UPDATE` trigger function on `leads`; sets the three normalized columns and `has_website`.
- `leads_enforce_initial_status()` — `BEFORE INSERT` trigger function on `leads`. Forces every newly-created lead to start at `'Discovered'`, rejecting any explicit non-Discovered value (a direct PostgREST insert can no longer create a lead that starts life as `Opted Out`, `Contacted`, or any other status). The column default already produces `Discovered` when the caller omits `status`, so normal inserts are unaffected.
- `leads_protect_restricted_columns()` — `BEFORE UPDATE` trigger function on `leads`. Blocks any direct change to `converted_customer_id` or `duplicate_of` unless the transaction-local flag `saltbox.trusted_write` is set to `'on'` — which only `convert_lead_to_customer()` and `mark_lead_duplicate()` (respectively) ever do, via `set_config(..., true)` immediately before their own validated write. PostgREST never exposes Postgres's built-in `set_config()` as a callable RPC, so a browser client has no way to set that flag itself.
- `leads_validate_status_transition()` — `BEFORE UPDATE OF status, email, phone, website_url` trigger function on `leads`. This is the actual transition enforcement (see Status workflow below), and it also enforces the suppression boundary on outreach statuses and atomically folds identity edits on an already-Opted-Out lead into suppression (see Suppression / opt-out logic below).
- `leads_log_status_change()`, `leads_log_lifecycle()` (`SECURITY DEFINER`) — `AFTER` triggers on `leads` that write `lead_activity_log` rows for status changes and for creation/meaningful edits, respectively. `leads_log_status_change()` skips its own insert when `saltbox.trusted_write` is `'on'`, since `opt_out_lead()`/`mark_lead_duplicate()` already write their own, richer entry for that same transition — avoiding a duplicate log row per event.
- `lead_sources_log_activity()` (`SECURITY DEFINER`) — `AFTER INSERT OR UPDATE OR DELETE` trigger on `lead_sources`.
- `outreach_opt_outs_set_normalized_fields()` — `BEFORE INSERT OR UPDATE` trigger function on `outreach_opt_outs`.
- `merge_lead_identities_into_suppression(p_lead_id, p_email, p_phone, p_website_url, p_business_name, p_reason, p_source, p_log)` (`SECURITY DEFINER`, not directly callable — `execute` revoked from `public` and never granted to `authenticated`) — the only function that ever writes to `outreach_opt_outs`. Described in detail below.
- `add_lead_note(p_lead_id, p_note)`, `opt_out_lead(p_lead_id, p_reason, p_source)`, `mark_lead_duplicate(p_lead_id, p_duplicate_of_id)`, `convert_lead_to_customer(p_lead_id)` — the four browser-facing RPCs (all `SECURITY DEFINER`, all `revoke ... from public` + `grant execute ... to authenticated`, all verify `public.is_admin()` as their first step). Described individually below.

All four tables `enable row level security`. `leads` has three separate policies — `SELECT`, `INSERT`, `UPDATE`, each gated on `public.is_admin()` — and **no `DELETE` policy**. `lead_sources` keeps a single `FOR ALL` admin policy (delete included; see "Preserving audit history" below for why that's safe here but not on `leads`). `outreach_opt_outs` and `lead_activity_log` each have exactly one `SELECT` policy and nothing else. This depends on `public.is_admin()` and `public.set_updated_at()`, both already defined in `supabase-launch-schema.sql`, which must be applied first.

**This SQL file has not been run.** Run it manually in the Supabase SQL editor, after confirming `supabase-launch-schema.sql` is already applied and your admin user is in `admin_users`.

### Migration safety (non-destructive)

An earlier draft of this file included `alter table ... drop column if exists website_domain` statements on both `leads` and `outreach_opt_outs`, left over from an earlier naming choice for the normalized-domain column. Dropping a column silently destroys whatever it holds — that has been removed entirely from this file. If a table from that earlier draft still has a `website_domain` column, this migration leaves it alone: not migrated, not renamed, not dropped. Manual cleanup of that leftover column, if it exists, is a separate decision outside this file's scope.

`CREATE TABLE IF NOT EXISTS` only creates a table when it is entirely absent — it does **not** add missing columns or constraints to an existing, incompatible table from a partial earlier run. To repair that case without guessing at intent, this file:

- adds normalized columns via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (additive only, as before);
- adds any of the four column-only-dependent `CHECK` constraints (`leads_status_check`, `leads_discovery_method_check`, `leads_fit_score_range_check`, `outreach_opt_outs_source_check`) that a pre-existing table might be missing, via a guarded `DO $$ ... $$` block that checks `pg_constraint` by name first — a no-op against a freshly-created table, since these depend only on raw columns (`status`, `discovery_method`, `fit_score`, `source`) that already hold real values on any pre-existing row;
- backfills `normalized_email`/`normalized_phone`/`normalized_website_domain` on any pre-existing rows (from a partial earlier run, or rows written before the phone/domain rules above were tightened) **before** the unique indexes are created, so old rows match correctly without waiting on an incidental future `UPDATE`, and so a genuine duplicate conflict among existing rows surfaces as a clear index-creation failure instead of silently going unindexed.

**`outreach_opt_outs_identity_check` gets special handling**, because — unlike the four constraints above — it depends on `normalized_email`/`normalized_phone`/`normalized_website_domain`, which a pre-existing table repaired by this file may not have backfilled yet. Adding a `CHECK` constraint normally validates it against every existing row immediately; doing that *before* the backfill would make this migration fail on a partially-migrated table with un-backfilled rows, even though the backfill two statements later would have fixed the very data it's complaining about. So the order is, specifically:

1. add the constraint `NOT VALID` if missing (skips validating existing rows; still enforced against every new write immediately);
2. backfill the three normalized columns;
3. `ALTER TABLE ... VALIDATE CONSTRAINT outreach_opt_outs_identity_check` — confirms every row (including the ones just backfilled) actually satisfies it.

On a freshly-created table the constraint is already valid from `CREATE TABLE` (zero rows, trivially satisfied), so both the guarded `NOT VALID` add and the `VALIDATE CONSTRAINT` call are no-ops. On a genuinely broken pre-existing row (one with no usable identity at all, even after backfill), `VALIDATE CONSTRAINT` fails loudly and specifically — a clear, actionable error rather than either a migration failure unrelated to the real cause, or a constraint that silently never gets enforced.

This does not claim general rerunnability beyond what's described above: it is safe for a clean first run (the only run actually expected, since this file has never been applied) and reasonably safe after a partial earlier attempt at this same file, but it cannot repair arbitrary hand-edited schema drift, and a genuine duplicate-identity conflict or unfixable-identity row surfaced during backfill/validation must be resolved manually — this file does not decide for the operator which conflicting row is authoritative.

### Status workflow

```
Discovered → Needs Review → Approved for Mockup → Mockup In Progress → Draft Ready → Approved to Send → Contacted → Replied
                                                                                                          ↘ Follow-up Due
Any active status → Rejected (admin override, always allowed)
Any active status → Opted Out, but ONLY if a matching outreach_opt_outs record already exists (see opt_out_lead() below)
Discovered, Needs Review → Duplicate, but only through mark_lead_duplicate() (see below)
Rejected, Duplicate → Needs Review (the only way out of those two terminal states — "Reopen")
Opted Out → nothing. Terminal. There is no reopen/suppression-lift workflow in Phase 1.
A lead with converted_customer_id set cannot change status at all, in either direction
A brand-new lead inserted directly (bypassing leads.html) is forced to start at Discovered, always
A lead whose identity matches a permanent suppression record cannot be in, or move into, any of the
seven active-outreach statuses (Approved for Mockup through Follow-up Due), regardless of how the
match came about
```

**PostgreSQL is authoritative**, not JavaScript. `leads.js` still keeps a `LEAD_TRANSITIONS` map (with `"Opted Out": []`) for responsive UI filtering, but that copy is advisory only. The actual enforcement lives in three triggers:

- `leads_enforce_initial_status()` (`BEFORE INSERT`) forces every new row's `status` to `'Discovered'`, raising if the caller explicitly sent anything else. A direct PostgREST `POST` to `/leads` with `"status": "Contacted"` (or `"Opted Out"`, or any non-Discovered value) is rejected outright, not just hidden by the create form.
- `leads_validate_status_transition()` (`BEFORE UPDATE OF status, email, phone, website_url`) rejects any status change once `converted_customer_id` is set, and rejects any transition not present in `lead_status_transitions(OLD.status)`. Beyond that, **`Opted Out` and `Duplicate` are RPC-only**: a transition to either is rejected unless the transaction-local flag `saltbox.trusted_write` is `'on'` (see "Protecting RPC-owned columns and transitions" below) — this is deliberately *not* "does a suppression record already exist for this identity", which could be satisfied by an unrelated match the current call never verified or created. It also rejects any update (whether or not status itself is changing) that would leave the lead's `status` in an outreach-progress status while its identity matches `outreach_opt_outs`; enforces the invariant that a lead can never sit at status `Duplicate` without `duplicate_of` set; and rejects outright any edit to email/phone/website_url on a lead that is already `Opted Out` (see "Suppression / opt-out logic" below for why Phase 1 locks these fields rather than trying to correct them in-trigger).
- `leads_protect_restricted_columns()` (`BEFORE UPDATE`) rejects any direct change to `converted_customer_id` or `duplicate_of` — see "Protecting RPC-owned columns and transitions" below.

A generic browser `UPDATE`/`INSERT` on `leads` that tries to bypass any of this — including one issued directly against the Supabase REST/SQL API, not just through the app's UI — is rejected by Postgres itself, not merely hidden by the UI. `Opted Out` and `Duplicate` are also removed from the generic status dropdown in `lead-detail.html` (`allowedNextStatusesForDropdown()`, which returns nothing at all once a lead is `Opted Out`) since both require a dedicated RPC or are terminal; a legal status change is logged automatically by `leads_log_status_change()` — the browser never calls an activity-log insert directly.

### Protecting RPC-owned columns and transitions

`converted_customer_id`, `duplicate_of`, and the `Opted Out`/`Duplicate` status transitions are each meant to be set by exactly one RPC (`convert_lead_to_customer()`, `mark_lead_duplicate()`, `opt_out_lead()`, and `mark_lead_duplicate()` again, respectively) and never by a direct `UPDATE`. All four are gated the same way: `leads_protect_restricted_columns()` raises if `converted_customer_id` or `duplicate_of` is changing, and `leads_validate_status_transition()` raises if `status` is changing to `Opted Out` or `Duplicate`, unless the transaction-local setting `saltbox.trusted_write` is `'on'`. Each RPC calls `perform set_config('saltbox.trusted_write', 'on', true)` (the `true` makes it transaction-local, so it resets automatically and can never leak into an unrelated request) immediately before making its own already-validated write. PostgREST has no way to expose Postgres's built-in `set_config()` function as a callable RPC — it isn't a function in the `public` schema — so a browser client cannot set that flag itself, and a direct `PATCH` attempting any of these four things is rejected regardless of what else is in the request or what `outreach_opt_outs` happens to contain.

A lead with status `Duplicate` is also required, as a standing invariant, to always have `duplicate_of` set — `mark_lead_duplicate()` sets both columns together in the same statement, so this only ever fires against a state that shouldn't be reachable through any other path.

### Duplicate detection

`findDuplicateLeads()` in `leads.js` runs two checks, both reading the database's own normalized columns:
- **Hard matches** (blocking on the create form; shown with a "mark as duplicate" action on the detail page): exact `normalized_email`, `normalized_phone`, or `normalized_website_domain`. Enforced as partial unique DB indexes on all three.
- **Fuzzy matches** (advisory only, never blocks): word-overlap similarity on business name, boosted when city also matches. A lightweight in-app JavaScript comparison over up to 200 recent leads, not a database-side trigram query, even though the schema creates the `pg_trgm` extension and a trigram index for future use — acceptable at Phase 1 volumes, worth revisiting if lead volume grows.

Marking a lead as a duplicate goes through `mark_lead_duplicate(p_lead_id, p_duplicate_of_id)` (`SECURITY DEFINER` RPC), called from `leads.js`'s `markLeadDuplicate()` — the only path that can ever set `status = 'Duplicate'` or write `duplicate_of` (see "Protecting RPC-owned columns and transitions" above). In one function invocation it: verifies admin, locks both the source and target lead rows (`FOR UPDATE`, in a stable id order so two concurrent calls marking the same pair in opposite directions can't deadlock), rejects self-reference, rejects a target that doesn't exist, rejects a target whose own `duplicate_of` is already set (it isn't a valid canonical lead), rejects a target with status `Duplicate`, rejects a target with status `Opted Out` (an unsafe canonical relationship — the permanently-suppressed lead shouldn't become the "real" record other leads point at), sets `saltbox.trusted_write` and updates `duplicate_of` and `status` together in one statement (satisfying both the RPC-only status gate and the "Duplicate always has duplicate_of" invariant at once — an illegal attempt raises and the whole call rolls back), and writes one `lead_activity_log` row. Nothing is left partially applied.

### Suppression / opt-out logic

`findOptOutMatches()` (read-only, browser-callable) checks `outreach_opt_outs` by normalized email, phone, and website domain — used for the pre-creation warning on `leads.html` and the "Check suppression list" button on `lead-detail.html`.

Actually suppressing a lead goes entirely through `opt_out_lead(p_lead_id, p_reason, p_source)` (`SECURITY DEFINER` RPC), called from `leads.js`'s `optOutLead()` — the only path that can ever set `status = 'Opted Out'` (see "Protecting RPC-owned columns and transitions" above; a direct `PATCH` is rejected unconditionally, even if the lead's identity happens to already match some unrelated suppression row). It: verifies admin, locks the lead row (`FOR UPDATE`), requires at least one usable normalized identity, canonicalizes `p_source` to one of the three values `outreach_opt_outs_source_check` allows (`recipient_reply`, `manual_admin`, `unsubscribe_link` — anything blank or unrecognized becomes `manual_admin`) exactly once into a local variable, calls `merge_lead_identities_into_suppression()` with that canonical value to record every one of the lead's identities (raising and rolling back the whole call if verification fails — see below), sets `saltbox.trusted_write` and transitions the lead's status to `Opted Out`, and writes a trusted `lead_activity_log` `opted_out` entry whose `metadata.source` is the *same* canonical variable used for the `outreach_opt_outs` row — the two can never disagree about what source was recorded, because they're never computed twice.

**Suppression identity merge** (`merge_lead_identities_into_suppression()`, the only function that ever writes to `outreach_opt_outs`, called only by `opt_out_lead()`): the previous version did a single `insert ... on conflict do nothing`, which meant that if the lead's email already matched an existing suppression row, the *entire* insert was skipped — including a phone or website identity on the same lead that had never been suppressed before, letting it escape suppression entirely. The fixed version handles each of the lead's up-to-three identities independently: if an identity is already represented by some row, nothing to do; otherwise it tries to attach the identity to an existing row that already matches a *different* one of the lead's identities and has a free column for this one (handling the case where two different pre-existing rows each match a different identity of the same lead, without ever overwriting an existing unrelated value); otherwise it inserts a new minimal row carrying just that identity. Whenever an attach happens, the row's `source` is always overwritten to the current call's canonical value — unlike `business_name`/`reason`, which are preserved via `coalesce` if already set. A row's suppression `source` should reflect the most recent opt-out event that touched it, not whichever event happened to create it first. It finishes by re-querying `outreach_opt_outs` and raising an exception — aborting the whole transaction, including the status change the caller was about to make — if any non-null identity the lead has is still not represented. This is a hard verification backstop, not an assumption that the steps above worked, and it is what makes "one identity is already suppressed" insufficient: every non-null identity on the lead must be represented, or the whole call fails.

**Opted-out identities are locked, not editable, in Phase 1.** An earlier version of `leads_validate_status_transition()` called `merge_lead_identities_into_suppression()` from inside the trigger itself when an already-`Opted Out` lead's email/phone/website was edited, to fold the new identity into suppression automatically. That mixed a side-effecting, privilege-elevating write into what should be a read-only validation trigger fired by an ordinary `UPDATE` — more machinery than Phase 1 needs, and it meant the merge helper had to be safe to call from an invoker-rights context, not just from a trusted RPC. The simplest safe rule instead: **any direct edit to `email`, `phone`, or `website_url` on a lead whose status is already `Opted Out` is rejected outright**, with a clear message ("This lead is permanently suppressed (Opted Out). Its email, phone, and website are locked in Phase 1 and cannot be edited."). That message reaches the admin through the existing generic error-handling path on `lead-detail.html`'s Overview form (`error.message` from the failed Supabase call) — no separate UI work was needed. There is no in-trigger correction workflow: if a suppressed lead's identity was recorded wrong and genuinely needs fixing, that is a rare, deliberate admin action done via direct, privileged SQL access outside the browser, which is intentionally outside what any RPC exposes.

Suppression entries are never deleted when a lead is deleted (`lead_id` is nullable, `ON DELETE SET NULL`), and there is no suppression-removal workflow at all in Phase 1.

### Lead-to-customer conversion

Entirely handled by `convert_lead_to_customer(p_lead_id)` (`SECURITY DEFINER` RPC), called from `leads.js`'s `convertLeadToCustomer()`. In one function invocation it: verifies admin, locks the lead row (`FOR UPDATE`), returns the existing `customer_id` immediately with `status: "already_converted"` if `converted_customer_id` is already set (safe to call repeatedly — idempotent), rejects conversion outright if the lead's status is `Duplicate`, `Rejected`, or `Opted Out`, looks for an existing customer by normalized email and reuses it (`status: "existing_customer_matched"`) rather than ever creating a second customer row for the same email, otherwise creates a new customer (`status: "created"`), sets `saltbox.trusted_write` and `leads.converted_customer_id`, and writes a trusted activity record. **No new lead status is introduced for "converted"** — `converted_customer_id` being set is the only representation, and the transition trigger separately guarantees a converted lead can never change status again in either direction (so a converted lead can never re-enter outreach progression). The browser (`lead-detail.html`) calls only this RPC, disables the button for the duration of the call, and branches its success message on the returned `status` field; any thrown error (ineligible status, database error, etc.) re-enables the button and shows the message.

### URL validation

HTML-escaping a URL (the existing `html()` helper in `admin.js`) makes it safe as *text*, not safe as a clickable link — `javascript:`, `data:`, and `file:` URLs escape cleanly but are dangerous in an `href`. `leads.js` exports `sanitizeUrl(rawUrl)`, which parses the value with the `URL` constructor and returns it only if the protocol is `http:` or `https:`, otherwise `null`. `lead-detail.html` uses it (via a small `renderLink()` wrapper) everywhere a stored URL becomes a link: source records (`source_url`) and the lead's own website. An invalid or unsupported URL renders as plain escaped text instead of a link.

### Admin authorization

`initAdminPage()` in `admin.js` calls `supabase.rpc("is_admin")` immediately after confirming a session exists (a session alone is true for a signed-in customer-portal user too, since customers and admins authenticate through the same Supabase Auth project), before any admin page content renders or any page-specific query runs. Row Level Security remains the actual, final security boundary regardless of this check (every Lead Engine table's policies independently require `is_admin()`) — this check only prevents the admin UI from rendering for a non-admin session; it is a UX/defense-in-depth improvement, not a replacement for RLS.

**Redirect targets, and the loop that used to exist between them:** a signed-out visitor still goes to `login.html` (`redirectToLogin()`). A signed-in session that fails `is_admin()` now goes to `client-dashboard.html` (`redirectNonAdminAway()`) instead of back to `login.html`. That change is the fix: previously, `admin.js` sent a non-admin session to `login.html`, and `login.html` — on seeing *any* existing session — sent it straight back to `admin.html` unconditionally, which `admin.js` would again reject and send to `login.html`, looping forever. `login.html` now calls `supabase.rpc("is_admin")` itself before redirecting an existing session anywhere: only a session that passes goes to `admin.html`; anything else (non-admin, or the `is_admin` call itself erroring) goes to `client-dashboard.html`. Neither redirect calls `supabase.auth.signOut()` at any point — doing so would destroy an unrelated, legitimate customer-portal session in the same browser if a customer happened to land on an admin URL, or open `login.html` while already signed in. No admin-page content or query runs before the `is_admin()` check resolves, on either page.

### Preserving audit history

`leads` has no `DELETE` policy — hard deletion of a lead through normal browser operations (the admin UI, or a direct PostgREST call) is impossible. This is deliberate: `lead_activity_log.lead_id` references `leads(id) ON DELETE CASCADE`, so deleting a lead would silently wipe its entire audit trail, directly undermining the point of having one. Use a terminal status (`Rejected`, `Opted Out`, `Duplicate`) instead of deleting a lead. `lead_sources` keeps its `DELETE` policy — removing a bad source row does not cascade-delete a lead's own history, and the deletion itself is captured by `lead_sources_log_activity` before the row disappears. If a lead is ever removed via direct, privileged SQL access outside the browser (e.g. the Supabase SQL editor, not a Phase 1 concern), its `lead_sources` and `lead_activity_log` rows cascade away with it; only `outreach_opt_outs` is specifically designed to survive that (`ON DELETE SET NULL`), because suppression protects a third party, not the lead's own record-keeping.

### Files added

- `supabase-lead-engine-schema.sql`
- `leads.js`
- `leads.html`
- `lead-detail.html`

### Files changed

- `admin.js` — `initAdminPage()` performs a real `is_admin()` authorization check after confirming a session, and redirects a signed-in non-admin to `client-dashboard.html` instead of `login.html` (see "Admin authorization" above — this is what fixes the redirect loop). No other admin.js behavior changed.
- `login.html` — checks `is_admin()` before redirecting an existing session to `admin.html`; redirects to `client-dashboard.html` instead when the session isn't an admin (see "Admin authorization" above). No visual/design changes, and normal email/password sign-in is unchanged.
- `admin.html` — sidebar nav item, "Leads needing review" metric tile, "Lead Engine" resource card, dashboard script wiring
- `requests.html`, `customers.html`, `customer-detail.html`, `tickets.html`, `subscriptions.html`, `settings.html` — sidebar nav item only
- `admin.css` — one additive class, `.danger` (reuses the existing `--red` variable, same pattern as `.priority-urgent`), used for the `Rejected` / `Opted Out` / `Duplicate` status pills
- `.gitignore` — added `.env`, `.env.*`, `!.env.example`, `.netlify/`
- `handoff.md` — this section, plus updates to the file/table lists and security gaps above

### Manual testing checklist (Phase 1)

Run `supabase-lead-engine-schema.sql` in Supabase and confirm your admin user is in `admin_users` before testing. All steps assume you are logged into `login.html` as an admin unless a step says otherwise.

1. **Lead creation** — On `leads.html`, click "Add lead", fill in a business name plus a few optional fields, save. Confirm it appears in the list and redirects to `lead-detail.html`.
2. **Search** — On `leads.html`, type part of a business name, email, or city into the search box; confirm the table filters live and the "no matching results" state appears for a nonsense query.
3. **Edit** — On `lead-detail.html`, change fields in the Overview panel and save; reload the page and confirm the changes persisted, and confirm a `lead_updated` row appears in the Activity log listing the changed fields.
4. **Status transitions** — Use the Status panel's dropdown; confirm only the legal next statuses for the current status appear (note `Opted Out` and `Duplicate` never appear here — they have their own actions), the change succeeds, the badge updates, and a `status_changed` row appears in the Activity log automatically.
5. **Illegal transition prevention (direct API bypass)** — With the browser dev tools open (or any REST client) while signed in as an admin, attempt a direct `PATCH` to the Supabase REST endpoint for a `leads` row setting `status` to a value that is not legal from its current status (e.g. `Discovered` straight to `Contacted`). Confirm Postgres rejects it with the `leads_validate_status_transition` exception message — this must fail even though it bypasses the UI entirely, since the UI dropdown was never the real enforcement.
6. **Opted Out is RPC-only (direct API bypass)** — On any lead, attempt a direct `PATCH` setting `status` to `Opted Out` without calling `opt_out_lead()`. Confirm it is rejected ("Opted Out can only be set by opt_out_lead()") — including on a lead whose email/phone/website *already* happens to match an existing `outreach_opt_outs` row from an unrelated suppression event; that match alone must not be enough to let a direct write through. Then call `mark_lead_duplicate()`'s counterpart test: attempt a direct `PATCH` setting `status` to `Duplicate` (with or without also setting `duplicate_of` in the same request) without calling `mark_lead_duplicate()`. Confirm it is rejected ("Duplicate can only be set by mark_lead_duplicate()").
6a. **Opted Out is terminal (direct API bypass)** — Opt out a lead, then attempt a direct `PATCH` setting `status` back to `Needs Review` (or anything else). Confirm it is rejected — `lead_status_transitions('Opted Out')` now returns an empty array, so there is no legal next status at all, via the UI or directly.
6b. **Initial status enforcement (direct API bypass)** — Attempt a direct `POST` to the Supabase REST endpoint for `leads` with `"status": "Contacted"` (or `"Opted Out"`, or any non-Discovered value) set explicitly on an otherwise-valid new row. Confirm `leads_enforce_initial_status` rejects it. Confirm a normal insert that omits `status` entirely (or sends `"Discovered"`) still succeeds and produces a `lead_created` activity entry.
7. **Converted lead is frozen** — Convert a lead to a customer, then attempt any status change on it (via the UI, which should no longer offer one meaningfully, and via a direct `PATCH`). Confirm both are rejected.
7a. **converted_customer_id is not directly writable (direct API bypass)** — On any lead, attempt a direct `PATCH` setting `converted_customer_id` to an arbitrary customer id (assigning it on an unconverted lead, changing it on a converted one, or clearing it back to `null`). Confirm all three are rejected by `leads_protect_restricted_columns` regardless of the lead's current state. Confirm `convert_lead_to_customer()` itself still succeeds normally.
7b. **duplicate_of is not directly writable (direct API bypass)** — Attempt a direct `PATCH` setting `duplicate_of` on a lead (assigning, changing, or clearing it) without going through `mark_lead_duplicate()`. Confirm it is rejected. Then call `mark_lead_duplicate()` targeting a lead that is itself already a duplicate, one with status `Duplicate`, and one with status `Opted Out`; confirm all three target choices are rejected with a clear error, and that a valid target still succeeds.
8. **Duplicate blocking** — Create a lead with a given email, phone, or website; then try to create a second lead with the same normalized email, phone, or website domain. Confirm the create form blocks it with a link to the existing lead. Create two leads with similar-but-not-identical business names in the same city and confirm the fuzzy-match warning appears (non-blocking).
8a. **Phone canonicalization** — Create a lead with phone `(801) 555-1212`. Attempt to create a second lead with phone `+1 801-555-1212`. Confirm the create form blocks it as a duplicate — both forms must normalize to the same 10-digit `normalized_phone`. Try a clearly malformed phone (e.g. 4 digits); confirm it is accepted as raw text but does not participate in duplicate/suppression matching (`normalized_phone` is `null`).
8b. **Hosted-profile domains do not collapse** — Create two leads whose `website_url` is a Facebook page under different tenant paths (e.g. `facebook.com/business-a` and `facebook.com/business-b`). Confirm they are **not** flagged as duplicates of each other — `normalized_website_domain` should be `null` for both, not `facebook.com`. Repeat for a `maps.google.com` or `google.com/maps/...` URL. Then create a lead with a real business subdomain (e.g. `shop.example.com`) and confirm it normalizes to its own distinct domain, not collapsed to `example.com`.
9. **Suppression checking and atomic opt-out** — On a lead's detail page, submit "Add to suppression list" with a reason. Confirm the lead's status flips to `Opted Out` immediately (not just the suppression row), an `opted_out` activity entry appears, and a matching row now exists in `outreach_opt_outs` (visible via "Check suppression list"). Then create a brand-new lead with that same email and confirm the create form shows the suppression warning.
9a. **Suppression identity merge covers every identity dimension** — Opt out a lead that has only an email set. Separately, opt out an unrelated lead that has only a phone set (a different phone). Now take a third lead whose email matches the first suppressed lead's email *and* whose phone matches the second suppressed lead's phone, and opt it out too. Confirm (via direct `outreach_opt_outs` inspection, e.g. "Check suppression list" against each identity individually) that **both** the email and the phone identity end up represented in `outreach_opt_outs` — this is the collision case the old `ON CONFLICT DO NOTHING` implementation used to silently drop.
9b. **Suppression boundary blocks outreach** — Take a lead that is not yet suppressed and manually advance it to an outreach status (e.g. `Approved for Mockup`). Then edit its email to match an existing `outreach_opt_outs` entry. Confirm the edit is rejected. Separately, attempt a direct `PATCH` moving a lead whose identity already matches suppression straight into `Contacted`; confirm it is rejected.
9c. **Opted-out identities are locked, not correctable in-place** — Opt out a lead. Then attempt to edit its email, phone, or website_url via the Overview form (or a direct `PATCH`). Confirm both are rejected with "This lead is permanently suppressed (Opted Out). Its email, phone, and website are locked in Phase 1 and cannot be edited." — and confirm editing unrelated fields (business name, notes, city, etc.) on that same Opted Out lead still succeeds normally.
10. **Suppression is not directly writable** — Attempt a direct `INSERT` into `outreach_opt_outs` via the REST API (bypassing `opt_out_lead()`). Confirm it is rejected by RLS (no INSERT policy exists for `authenticated`).
11. **Activity log is not directly writable** — Attempt a direct `INSERT`, `UPDATE`, or `DELETE` against `lead_activity_log` via the REST API. Confirm all three are rejected by RLS. Then use the "Add note" form and confirm that *does* succeed (via `add_lead_note()`), appears with your actual admin email as `actor`, and that action is literally `note` (the RPC cannot be used to insert any other action value).
12. **Lead-to-customer conversion, including idempotency** — Click "Convert to customer" on an eligible lead. Confirm it redirects to the new customer's `customer-detail.html` and the lead now shows "View customer". Click "Convert to customer" again on the same lead via a direct RPC call (or by navigating back) and confirm it returns the same `customer_id` with `status: "already_converted"` rather than creating a second customer. Attempt conversion on a `Duplicate`, `Rejected`, or `Opted Out` lead and confirm it is rejected.
13. **Lead deletion is blocked** — Attempt a direct `DELETE` on a `leads` row via the REST API. Confirm it is rejected (no DELETE policy exists).
14. **URL sanitization** — Add a source record with `source_url` set to `javascript:alert(1)`. Confirm it renders as plain text, not a clickable link, on `lead-detail.html`. Add one with a normal `https://` URL and confirm it renders as a real link.
15. **Admin authentication and authorization** — Log out and try to open `leads.html` or `lead-detail.html?id=...` directly; confirm you're redirected to `login.html`. Sign in as a Supabase user who has a valid session but is *not* in `admin_users` (e.g. a customer-portal account) and confirm you are redirected to `client-dashboard.html` (not `login.html`) without being signed out of that session, and separately confirm all Lead Engine reads/writes fail under RLS for that user regardless of what the UI does.
16. **No redirect loop** — As that same non-admin session, navigate directly to `login.html`. Confirm you are sent to `client-dashboard.html`, not bounced back to `admin.html` (which would in turn bounce you back here). Then sign in as an actual admin and confirm visiting `login.html` with that session sends you straight to `admin.html` as before.
17. **current_actor_label() is not directly callable** — Attempt a direct RPC call to `/rest/v1/rpc/current_actor_label` as any authenticated user. Confirm it is rejected (no `execute` grant for any role other than the function owner/other `SECURITY DEFINER` functions calling it internally).

### Assumptions and open issues from this phase

- Added a 12th status, `Duplicate`, beyond the 11 originally listed, per an earlier approved decision to keep it separate from `Rejected`.
- `normalized_business_key` (business-name/city dedupe key) is still computed in `leads.js`, not by a database trigger — it was not one of the three columns (`normalized_email`, `normalized_phone`, `normalized_website_domain`) moved into the database. It is only recomputed in `updateLead()` when both `business_name` and `city` are present in the same update payload — true for the Overview panel's save (which always submits both together).
- Fuzzy duplicate matching is a JavaScript word-overlap comparison over up to 200 recent leads, not a database-side trigram query, even though the schema creates the `pg_trgm` extension and a trigram index for future use. Fine at Phase 1 volumes; revisit if lead volume grows.
- The `leads.notes` field and `lead_activity_log` notes overlap in purpose (mirrors the existing `customers.notes` + `customer_notes` convention already in this codebase) — `notes` is a quick current-state field, the activity log is the full timestamped history.
- No dedicated "Suppression list" admin page was built — suppression is managed per-lead from `lead-detail.html` only. A standalone browse/search page for `outreach_opt_outs` would be a natural small addition later.
- `is_admin()` remains the only permission tier — there's no research-only vs. send-capable distinction. Not a problem for Phase 1, which has no research or sending.
- `leads.js`'s `LEAD_TRANSITIONS` map and the database's `lead_status_transitions()` function must be kept in sync by hand; a mismatch can't allow an illegal transition to persist (the database wins), but it could make the UI offer a status that the database then rejects, or hide one the database would actually allow.
- There is no reopen/suppression-lift workflow for `Opted Out` in Phase 1 — it is genuinely terminal. If a suppression turns out to have been recorded in error, correcting it requires direct, privileged SQL access outside the browser (deleting/editing the `outreach_opt_outs` row and separately moving the lead's status), which is intentionally outside what any RPC exposes.
- An `Opted Out` lead's `email`, `phone`, and `website_url` are likewise locked from normal editing in Phase 1 — any direct edit attempt (Overview form or raw API) is rejected, full stop, rather than silently re-merged into suppression. This is a deliberate simplicity trade-off: correcting a wrong identity on an already-suppressed lead is a rare, deliberate action, not a normal edit, so it is handled the same way as a wrong suppression record itself — via direct, privileged SQL access outside the browser.
- `merge_lead_identities_into_suppression()`'s "attach to an existing row with a free column" step will, in a genuine three-way identity collision (a lead's email, phone, and domain each already belong to three different existing suppression rows for three different unrelated past events), end up creating additional narrow rows rather than collapsing everything onto one canonical row — every identity is still guaranteed to be represented (the function's own verification step enforces this), just not always inside a single row. Acceptable for Phase 1 volumes; a future pass could periodically compact `outreach_opt_outs` if row count becomes unwieldy.
- Hosted-profile domain handling (Facebook, Instagram, Yelp, Google Maps, etc.) intentionally returns `null` for `normalized_website_domain` rather than attempting to extract a per-tenant identity from the URL path. This means two leads that are genuinely the same business, found only via two different hosted-profile URLs (no independent domain, email, or phone in common), will **not** be flagged as duplicates of each other. A future pass could add a safe, platform-specific tenant-id extractor if this becomes a real gap; guessing at one now risked exactly the false-collapse bug this fix addresses.
- The known hosted-profile host list in `normalize_website_domain()` (SQL) and `HOSTED_PROFILE_HOSTS` (`leads.js`) is a fixed, manually-maintained list — a platform not on the list still normalizes to its own bare domain, which is correct for an actual small-business domain but would be wrong if a not-yet-listed platform also serves per-tenant paths under one shared host. Extend both lists together if that comes up.

## Files Changed During This Session

- `admin.css`
- `admin.html`
- `admin.js`
- `customer-detail.html`
- `tickets.html`
- `subscriptions.html`
- `client-login.html`
- `client-dashboard.html`
- `supabase-launch-schema.sql`
- `package.json`
- `netlify/functions/create-checkout-session.js`
- `netlify/functions/create-customer-portal-session.js`
- `netlify/functions/create-invoice.js`
- `netlify/functions/stripe-webhook.js`
- `handoff.md`

## Supabase SQL To Run

Run manually in the Supabase SQL editor:

```sql
-- Use the full file contents:
supabase-launch-schema.sql
```

Then insert Gabby's admin user row by replacing the placeholder values in the commented section at the top of `supabase-launch-schema.sql`:

```sql
insert into public.admin_users (user_id, email, role)
values ('GABBYS-AUTH-USER-ID', 'gabby@example.com', 'admin')
on conflict (user_id) do update
set email = excluded.email, role = excluded.role;
```

Important: applying launch RLS without the `admin_users` row will block admin access to protected data.

## Netlify Environment Variables To Set Later

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SITE_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

`SUPABASE_SERVICE_ROLE_KEY` is server-side only for Netlify Functions. Do not add it to `supabase-client.js` or any browser file.

## Stripe Setup Still Needed

1. Create/confirm Stripe account.
2. Add Netlify env vars.
3. Run `npm install` so Netlify can install `stripe` and `@supabase/supabase-js`.
4. Configure Stripe webhook endpoint to call `/.netlify/functions/stripe-webhook`.
5. Test checkout/invoice/portal flows with Stripe test keys.
6. Confirm webhook updates `customer_invoices` and `subscriptions`.

## Testing Checklist

Local static server:

```bash
python3 -m http.server 8080
```

If port `8080` is busy:

```bash
python3 -m http.server 8081
```

Open locally:

- `http://localhost:8080/index.html`
- `http://localhost:8080/login.html`
- `http://localhost:8080/admin.html`
- `http://localhost:8080/requests.html`
- `http://localhost:8080/customers.html`
- `http://localhost:8080/customer-detail.html`
- `http://localhost:8080/tickets.html`
- `http://localhost:8080/subscriptions.html`
- `http://localhost:8080/settings.html`
- `http://localhost:8080/client-login.html`
- `http://localhost:8080/client-dashboard.html`

Command checks:

```bash
git diff --check
curl -I http://localhost:8080/index.html
curl -I http://localhost:8080/admin.html
curl -I http://localhost:8080/tickets.html
curl -I http://localhost:8080/client-login.html
curl -I http://localhost:8080/client-dashboard.html
curl -I http://localhost:8080/supabase-launch-schema.sql
```

Node is not installed in the current environment, so JS syntax checks with `node --check` cannot be run here unless Node is installed.

## Git Commands To Commit And Push

```bash
git status --short
git add admin.css admin.html admin.js customer-detail.html tickets.html subscriptions.html client-login.html client-dashboard.html supabase-launch-schema.sql package.json netlify/functions/create-checkout-session.js netlify/functions/create-customer-portal-session.js netlify/functions/create-invoice.js netlify/functions/stripe-webhook.js handoff.md
git commit -m "Prepare Saltbox launch admin and billing foundation"
git push
```

## Next Recommended Steps

1. Review `supabase-launch-schema.sql`.
2. Run the launch SQL in Supabase.
3. Insert Gabby's Supabase Auth user into `admin_users`.
4. Log in to admin and test requests, customers, tickets, files, and invoice drafts.
5. Create a test customer portal Supabase Auth user whose email matches a customer row.
6. Set Netlify env vars in a staging environment.
7. Test Stripe functions with Stripe test keys only.
8. Replace email-based customer portal matching with customer user IDs before broad client rollout.
