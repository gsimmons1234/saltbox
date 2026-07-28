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
- `lead-detail.html` - Lead Engine detail page: overview edit, manual qualification, activity evidence, status transitions, duplicate check, source records, suppression, activity log, convert to customer
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

Lead Engine (Phase 2A — AI research reports, schema written in `supabase-lead-research-schema.sql`, not yet run; depends on Phase 1's tables above):

- `lead_research_reports`
- `lead_research_sources`
- `lead_asset_candidates`

Remaining Phase 2-5 Lead Engine tables (`lead_audits`, `lead_mockups`, `outreach_drafts`, `outreach_events`) do not exist yet and are intentionally out of scope for this file. Scheduled/automatic business discovery, AI image generation, email sending, and automatic outreach are also not built.

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

Phase 1 of the assisted client-discovery/outreach system: manual lead entry, review, qualification, status tracking, duplicate detection, permanent suppression, and lead-to-customer conversion. Qualification is a manual decision represented by `Needs Review`, `Approved for Mockup`, or `Rejected`; there is no active numeric lead-scoring workflow. The existing nullable `fit_score` and `fit_score_reasoning` database columns are unused and deferred, and the Phase 1 UI does not display, require, or write them. No automated research, mockup generation, screenshotting, or email sending exists yet — those are Phases 2-5 and are not built.

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

## Lead Engine (Phase 2A)

AI-generated business research reports. An admin opens an existing lead on `lead-detail.html`, clicks "Run AI Research," and a server-side Netlify Function researches that business and saves a source-backed report. Amy's Nails (Layton, Utah) is the manual test lead used to build and exercise this phase — see `mockups/amys-nails-layton/`, an unrelated earlier deliverable, for its public business details.

Explicitly out of scope for this phase (do not assume any of this exists): scheduled/automatic business discovery, AI image generation, email sending, automatic outreach, and numeric fit scoring. `leads.fit_score`/`fit_score_reasoning` remain unused, as in Phase 1.

### Database

`supabase-lead-research-schema.sql` is a targeted addition, not a rerun of `supabase-lead-engine-schema.sql` — it depends on `public.is_admin()`/`public.set_updated_at()` (from `supabase-launch-schema.sql`) and `public.leads` (from `supabase-lead-engine-schema.sql`), both of which must already be applied. It creates exactly three new tables:

- **`lead_research_reports`** — one row per research run. `status` is `running` → `complete` or `failed`. A partial unique index (`where status = 'running'`) allows at most one in-flight run per `lead_id` at the database level — this, not app logic, is what actually blocks two concurrent "Run AI Research" clicks (or two admins clicking it at once) from racing. `is_mock` is `true` only for a report produced by the explicit mock-fixture path (see "Explicit mock mode" below) — it is never inferred, and real/mock content can never mix. `error_classification` is always one of a fixed set of safe labels (`provider_auth_error`, `provider_rate_limited`, `provider_timeout`, `provider_invalid_response`, `provider_refusal`, `provider_incomplete`, `provider_unavailable`, `research_validation_failed`, `internal_error` — enforced by a `CHECK` constraint) and `error_message` is a short, sanitized, human-written description — neither is ever a raw provider/Supabase error object, and neither can ever contain `OPENAI_API_KEY` or `SUPABASE_SERVICE_ROLE_KEY`. `requested_by_actor` is the verified caller's email, captured server-side from their Supabase session — mirrors `current_actor_label()`'s pattern in Phase 1, computed in the Netlify Function itself since this row is written with the service-role key, outside any `auth.uid()` context. A `unique (id, lead_id)` constraint backs the composite foreign keys described next. See "Research-report JSON structure" below for what the `jsonb` columns actually contain.
- **`lead_research_sources`** — every source URL backing a specific report's claims (`source_url`, `source_title`, `source_type`, `supports_fields`, `notes`). Deliberately a separate table from Phase 1's `lead_sources` (manual, human-entered source records) — the two are never mixed, so the admin UI can keep "an admin typed this in" visually and structurally distinct from "the model said it found this."
- **`lead_asset_candidates`** — candidate images found during research, for admin review only. `approved_for_mockup` defaults to `false`; nothing in this phase (or any code that exists yet) ever places one of these into an actual mockup — that flag is only ever a signal for a later phase to read.

**Child-row lead/report consistency.** `lead_research_sources` and `lead_asset_candidates` both carry `report_id` and `lead_id`. Rather than two independent single-column foreign keys (which would let a bug insert a source whose `report_id` names one lead's report while its own `lead_id` names a different lead entirely), both are tied together with one composite foreign key — `foreign key (report_id, lead_id) references lead_research_reports (id, lead_id)` — backed by `lead_research_reports`' own `unique (id, lead_id)` constraint. Postgres itself now rejects a mismatched pair at the database level; existing UI queries (`.eq("report_id", ...)`, `.eq("lead_id", ...)`) are unaffected since both columns still exist and are still independently indexed.

Write path: all writes to `lead_research_reports`/`lead_research_sources` go through three narrowly-scoped, **server-only** RPCs — not plain `INSERT`/`UPDATE` calls, and not RPCs an admin's browser session can call:

- **`begin_lead_research_run(p_lead_id, p_requested_by_actor)`** — called once per "Run AI Research" click. Atomically verifies the lead exists, repairs any of that lead's `status='running'` reports older than a 10-minute staleness threshold (marking them `failed` with `error_classification = 'provider_timeout'` — see "Stale running report recovery" below), inserts the new running report, and returns its id. The partial unique index is still the actual concurrency guard: a second, near-simultaneous call still only gets one successful `INSERT`, surfacing a Postgres unique-violation (`23505`) that `lead-research.js` turns into an HTTP 409, exactly as before.
- **`complete_lead_research_run(p_report_id, p_lead_id, ...content, p_sources, p_asset_candidates)`** — called once, after `lead-research.js` has already fully validated the result. Locks the report row, confirms it exists, belongs to the expected lead, and is still `running`; then **strictly validates `p_sources`/`p_asset_candidates` are themselves genuine, non-null JSON arrays** (`jsonb_typeof(...) = 'array'`) — a SQL `NULL`, a JSON `null`, an object, a string, or a number raises a controlled exception instead of being silently treated as "nothing to insert" (an actual empty array `[]` is valid and legitimately inserts zero rows); then inserts the source/asset-candidate child rows and writes the report content, all in the same function invocation. Because this is one Postgres function call, any failure along the way (the array-type check, or an insert hitting a `CHECK` constraint on something that slipped past the Netlify Function's own validation) rolls back everything, including the report-content update — a completed report can never end up with partial or missing child rows, and the array-shape guard can never be silently bypassed by a caller bug.
- **`fail_lead_research_run(p_report_id, p_lead_id, p_error_classification, p_error_message)`** — called from the Netlify Function's own `catch` block. Only transitions a report that is still `running`; a report already `complete` or already `failed` is left untouched, so a late/duplicate error handler can never downgrade a successful completion. If this call itself fails (network hiccup, transient DB error), the Netlify Function does not retry or crash — it writes one sanitized structured log line (classification, report id, lead id, plus a fixed `fail_rpc_write_failed` marker — never the raw Supabase error, a token, or the lead record) and still returns the browser the friendly message for the *original* failure classification. The affected report may be left at `status='running'` in that rare case; `begin_lead_research_run()`'s stale-run recovery (see below) is what eventually frees that lead for a new run regardless, so nothing stays permanently stuck.

All three are `revoke all ... from public` **and** `revoke all ... from authenticated`, then `grant execute ... to service_role` only — they cannot be called by a signed-in admin's browser session at all, only by the Netlify Function (which has already independently verified the caller's session and `public.is_admin()` before ever reaching them). None of the three re-checks `is_admin()` itself: under the service-role connection there is no `auth.uid()` to check against, so that would always fail closed — the admin check has already happened, in the calling function, before any of these RPCs are ever invoked.

`lead_asset_candidates` has one narrow exception to the "browser reads only" rule:

- **`review_lead_asset_candidate(p_asset_id, p_approved, p_rejection_reason)`** (`SECURITY DEFINER`, granted to `authenticated`, same shape as Phase 1's `add_lead_note()`) — the only way the browser can ever change a `lead_asset_candidates` row. Authorization uses `if public.is_admin() is not true then raise exception`; the `UPDATE` touches only `approved_for_mockup`/`rejection_reason` — `asset_url`, `source_page_url`, `report_id`, `lead_id`, and `ownership_context` never appear on its left-hand side, so an admin can approve or reject a candidate but never rewrite what it is, where it was found, or whose lead it belongs to. Approving always clears any prior `rejection_reason`; rejecting always stores a non-null reason (falling back to a fixed placeholder — `'Rejected (no reason provided).'` — if the admin's prompt was empty or cancelled), so a rejected candidate can never look identical to a never-reviewed one, which previously both had `rejection_reason = null`.

All three tables `enable row level security`, each with exactly one `SELECT` policy gated on `public.is_admin()`.

**This SQL file has not been run.** Run it manually in the Supabase SQL editor, after confirming `supabase-launch-schema.sql` and `supabase-lead-engine-schema.sql` are already applied.

### Stale running report recovery

A Netlify Function invocation can be hard-killed by the platform's own execution-time ceiling before its own `catch` block ever runs — e.g. a slow OpenAI web-search call that outruns the limit. Without recovery, that would leave a permanent `status='running'` row that blocks all future research for that lead forever, since only one running report is allowed per lead. `begin_lead_research_run()` handles this itself, every time it's called: any `running` report for that lead older than 10 minutes is marked `failed` (`error_classification = 'provider_timeout'`) before the new one is created. 10 minutes was chosen as comfortably longer than any realistic Netlify Function execution ceiling (10 seconds by default; longer for higher-tier plans and background functions) while still being short enough that a genuinely stuck run doesn't block research for long. This is documented in full in the function's own comment in `supabase-lead-research-schema.sql`.

### Server-side authorization (`netlify/functions/lead-research.js`)

This function is the only thing that ever calls OpenAI or writes to the three tables above. Per request:

1. **Method check** — only `POST` is handled; everything else (including `OPTIONS`) gets a plain 405. `lead-detail.html` only ever calls this same-origin via a relative URL, which never triggers a CORS preflight regardless of headers sent, so there is nothing for `OPTIONS` to legitimately do here.
2. **Strict request validation, before `body.lead_id` is ever read** — the raw body is byte-length-capped (2048 bytes) before it is even `JSON.parse`'d; the parsed value must be a plain object (not `null`, not an array, not a primitive) with **exactly one** property, `lead_id`; that value is then checked against a UUID regex. Any deviation — extra properties, wrong shape, malformed UUID — is rejected with 400 before any Supabase call is made.
3. **Session verification** — the `Authorization: Bearer <token>` header is required and is verified against Supabase Auth itself via `authedClient.auth.getUser(token)`, not decoded or trusted locally.
4. **Admin verification** — `public.is_admin()` is then called through that *same* authenticated client (anon key + the caller's own JWT as the request's `Authorization` header), so it runs under the caller's real `auth.uid()` context — the identical RLS path the browser itself would get, not an assumption this function makes on its own. A non-admin session (e.g. a signed-in customer-portal user) is rejected with 403 here even though it has a perfectly valid session.
5. Only after all of the above passes does it switch to a **service-role client** to load the lead and perform the actual writes.
6. **Mode is decided before any report row exists** — see "Explicit mock mode" below. A missing `OPENAI_API_KEY` with mock mode not explicitly enabled returns a configuration error immediately; no report row is created either way.
7. **Duplicate concurrent runs and stale-run recovery** are both handled inside `begin_lead_research_run()` (see above) — the RPC either succeeds and returns a report id, or fails with `23505` and the function returns 409, never both.
8. Every run — start, completion, and failure — writes a `lead_activity_log` row (`ai_research_started`/`ai_research_completed`/`ai_research_failed`) directly, using the service-role key. This is the same trust model Phase 1 already applies to every other `lead_activity_log` write (a trusted, privileged path with a database-derived actor label, never a browser-supplied one) — a verified-admin, verified-session serverless function is an equally trusted writer as a `SECURITY DEFINER` Postgres function.
9. `OPENAI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are read only from `process.env`, are never included in any HTTP response, and are never logged — see "Error sanitization and classification" below.
10. This function never sends email and never generates a mockup — neither exists anywhere in the codebase yet. It also never writes to any local filesystem path: a deployed Netlify Function has no access to the operator's laptop, so the local export folder (`C:\Users\gabby\OneDrive\Documents\Site Mockup Images`) is out of scope for this phase entirely — future generated assets belong in Supabase Storage or a later Google Drive integration, not a local folder, and nothing in this codebase writes there.

The Supabase anon/publishable key used for steps 3/4 is hardcoded in `lead-research.js` (`SUPABASE_ANON_KEY`) rather than read from an env var — it is the same public value already shipped to every browser in `supabase-client.js` (visible in view-source today), carries no elevated privileges on its own, and requiring yet another Netlify env var for a value that is already public would only add setup friction without adding security. Keep the two in sync if the Supabase project's anon key ever rotates.

### Explicit mock mode

Mock-fixture research (`buildMockResearchResult()`, zero network calls, zero cost) only ever runs when the server operator has explicitly set `LEAD_RESEARCH_MOCK_MODE=true` — `isMockModeEnabled()` lowercases the env var and compares it, literally, against the string `"true"`; any other value (`"1"`, `"yes"`, unset, **or `" true "` with surrounding whitespace**, etc.) leaves it disabled. The comparison deliberately does not `.trim()` the value first — a value that isn't the exact literal string `"true"` is not treated as if it were, even if it merely has stray whitespace around an otherwise-correct value; a copy-paste artifact in an env var should fail closed, not silently succeed. **A missing `OPENAI_API_KEY` no longer implies mock mode.** If `LEAD_RESEARCH_MOCK_MODE` is not `true` and `OPENAI_API_KEY` is not set, the function returns a 500 configuration error (`classification: "configuration_error"`) and creates no report row at all — there is no automatic/implicit fallback to fake data. When `LEAD_RESEARCH_MOCK_MODE=true`, mock mode always wins regardless of whether `OPENAI_API_KEY` also happens to be set, so an admin can force mock output for testing without having to unset a real key first.

A saved mock report always has `is_mock: true` and `model_used: "mock-fixture-v1"`; a saved live report always has `is_mock: false` and whatever model string the OpenAI response itself reports (see "Research-report JSON structure" below). The two paths are strictly `if`/`else` — `buildMockResearchResult()` and `runOpenAiResearch()` can never both run for the same request, so real and mock content can never mix within one report. `lead-detail.html`'s "Mock data" banner reads `is_mock` directly and its copy says the report "was generated with `LEAD_RESEARCH_MOCK_MODE` explicitly enabled on the server" — it no longer implies the key merely happened to be missing.

### Error sanitization and classification

Every failure `lead-research.js` can produce is mapped to exactly one of nine fixed classifications (`provider_auth_error`, `provider_rate_limited`, `provider_timeout`, `provider_invalid_response`, `provider_refusal`, `provider_incomplete`, `provider_unavailable`, `research_validation_failed`, `internal_error`) before it ever reaches a log line, the database, or the browser:

- HTTP status from the OpenAI request maps to a classification (401/403 → auth error, 429 → rate limited, 5xx → unavailable, other non-2xx → invalid response); a fetch-level `AbortSignal.timeout(25000)` timeout maps to `provider_timeout`; a Responses API `status: "incomplete"` maps to `provider_incomplete`; a `refusal`-type content item maps to `provider_refusal`; missing/unparseable structured output maps to `provider_invalid_response`; any structural/type/citation-coverage problem from `validateAndBuildResearchResult()` maps to `research_validation_failed`; anything else (including a failed `complete_lead_research_run()` call) maps to `internal_error`.
- Log lines (`console.error`) contain only the classification, the report id, and the lead id — never a raw error object, a provider response body, a request payload, an `Authorization` header, or the lead record itself.
- The value stored in `lead_research_reports.error_message` is always a short, developer-written string set at the point the classified `ResearchError` was thrown (e.g. `"OpenAI rejected the request credentials (HTTP 401)."`) — never the raw response body. The old behavior of embedding up to 300 characters of the raw OpenAI error response text has been removed entirely.
- The browser receives a fixed, friendly message per classification (`FRIENDLY_MESSAGE_BY_CLASS`) plus the classification string itself, and an HTTP status chosen per classification (e.g. 429 for rate-limited, 504 for timeout, 502 for most provider/validation failures, 500 for internal errors) — never the sanitized-but-still-internal `error_message` stored in the database.

### Strict output validation (`validateAndBuildResearchResult()`)

Replaces the earlier "coerce anything malformed into a safe default" approach entirely. Nothing here silently turns a missing or wrong-typed field into `""`, `[]`, `false`, or a stock fallback claim (e.g. the old `"Call to check availability."` fallback for a missing `recommended_customer_action` is gone) — every structural problem throws a `research_validation_failed` `ResearchError` instead, and the whole run fails rather than saving a partially-invented report. This runs only against real OpenAI output — the mock-fixture path is static, already-correct data and deliberately bypasses it entirely (see "Explicit mock mode" above).

Checked, in order:

1. The top-level value is a plain object; every required top-level key is present; `business_summary`, `recommended_customer_action`, `mockup_brief.concept_direction`, and `mockup_brief.tone` are non-empty strings; every nested object (`verified_details`, `website_findings`, `activity_evidence`, `brand_cues`, `mockup_brief`) is itself a plain object with correctly-typed fields (nullable strings stay nullable strings, arrays stay string arrays, `website_findings.presence_type` must be one of the three recognized values, `activity_evidence.appears_active` must actually be a boolean).
2. **`sources` and `asset_candidates` are each fully, structurally validated entry-by-entry before anything else happens to them.** A malformed entry — wrong type on any field, a `source_type`/`asset_type` outside the approved enum, a `supports_fields` entry that isn't one of the approved field-name tokens (see "Fact-specific citation coverage" below), an entry that isn't even an object — is **not** silently dropped or repaired; it fails the entire run with `research_validation_failed`, identifying exactly which entry and field (e.g. `"sources[2].source_type must be one of the approved source types."`).
3. **Only after every entry has passed structural validation** may an individual, already-valid entry still be excluded from what gets saved — never a run failure by itself — for an unsafe URL (`isSafeHttpsUrl()`, see "URL safety hardening" below) or, for sources specifically, no matching web-search citation (see "Source citation cross-checking" below).
4. **Fact-specific citation coverage** (see below) is checked last, using only the sources that survived step 3.

### Source citation cross-checking

A model can write a plausible-looking URL without having actually found it via web search — Responses-API output text is not proof of a citation. `extractCitationUrls()` walks the response's `output[].content[].annotations` looking specifically for entries where **`annotation.type === "url_citation"`** — the Responses API's actual web-search citation shape — and builds a set of normalized citation URLs from those only. An annotation that merely happens to carry a `url` property but isn't tagged `url_citation` (a different/future annotation type, or a `url` with no `type` at all) is never treated as a verified citation. A structurally-valid `sources` entry is kept only if: it is a safe HTTPS URL (see "URL safety hardening" below), **and** its normalized form matches one of those extracted `url_citation` URLs. Anything else is excluded at the per-source level (not a run failure by itself — see step 3 above). The same URL-safety check applies to every `asset_candidates` entry's `asset_url` and `source_page_url`; assets have no citation requirement (they're for admin review, never treated as verified facts) and always default to `approved_for_mockup: false`.

**Fact-specific citation coverage** — report-wide coverage (formerly: "at least one source exists somewhere") is not enough, and has been replaced. Every source's `supports_fields` must itself be an array containing only tokens from a fixed, approved vocabulary (`FACT_FIELD_TOKENS` in `lead-research.js`): `business_name`, `address`, `phone`, `email`, `hours`, `services`, `website_presence`, `activity_evidence` — an unapproved token is a structural validation failure (see step 2 above), not silently ignored. For every verified field the report actually populated, **at least one surviving, citation-backed source must explicitly list that exact field** in its own `supports_fields` — a source that supports only `"phone"` can never validate a separately-claimed `services` list or `address`. `business_name` and `website_presence` are always in scope (`business_summary` and `website_findings.presence_type` are both always-required, non-empty fields); `address` gates on either `verified_details.address` or `.service_area`; `phone`/`email`/`hours` gate on their own field; `services` gates on a non-empty `services` array; `activity_evidence` gates on `appears_active === true` or a non-empty `signals` array. A field with no matching coverage fails the whole run with `research_validation_failed`, naming the specific field. Free-form AI observations, recommendations, missing-information notes, and the creative brief (`website_findings.observations`/`.homepage_opportunities`, `brand_cues`, `recommended_customer_action`, `personalization_detail`, `missing_or_conflicting_information`, `mockup_brief`) are never subject to this — only verified facts are.

**Caveat:** because `OPENAI_API_KEY` was never configured in this environment, the exact annotation shape (`output[].content[].annotations[].type === "url_citation"`, `.url`) has never been observed against a real response — it reflects the Responses API's documented contract as of this writing. If the live shape differs, `extractCitationUrls()` simply returns an empty set, which makes the fact-specific coverage check above fail closed (every real, fact-bearing report would be rejected as unvalidated) rather than silently accepting unverified URLs — a loud, safe failure to fix before relying on this in production, not a security gap.

The model identifier actually saved (`model_used`) is read from the OpenAI response body itself (`data.model`) when present, falling back to the requested model name (`OPENAI_RESEARCH_MODEL` or the `"gpt-4.1"` default) only if the response doesn't report one — the API's served model can differ from the one requested (e.g. aliasing to a dated snapshot).

### URL safety hardening (`isSafeHttpsUrl()`)

Applied to every research source URL and every asset/source-page URL. HTTPS only (no `http:`, `javascript:`, `data:`, `file:`, or any other scheme), a 2048-character length cap, and `localhost`/`*.localhost`/`*.local` rejected by name. Beyond that, the function rejects a URL whose host is a literal IP address in any non-public range: the full IPv4 loopback block (`127.0.0.0/8`, not just `127.0.0.1`), RFC 1918 private ranges, link-local, unspecified (`0.0.0.0`), carrier-grade NAT (`100.64.0.0/10`), IETF/documentation/benchmarking ranges, and multicast/reserved — plus the IPv6 equivalents (loopback `::1`, unspecified `::`, link-local `fe80::/10`, unique-local/private `fc00::/7`, multicast `ff00::/8`) and IPv4-mapped/NAT64 IPv6 forms (`::ffff:0:0/96`, `64:ff9b::/96`), which are rejected unconditionally rather than having their embedded IPv4 address extracted and separately re-checked — no legitimate citation or image URL is ever written in that form, so treating the whole range as an ambiguous IP literal and failing closed is the safer choice. `new URL()`'s own parsing already normalizes obfuscated IPv4 forms (hex `0x7f000001`, octal `0177.0.0.1`, bare-decimal `2130706433`, shorthand `127.1`) into canonical dotted-decimal before this check ever runs, and a malformed bracketed-IPv6 host (or any other unparseable URL) fails closed via the initial `new URL()` try/catch. Ordinary domain names (anything that isn't a literal IP) pass through unchanged — DNS resolution itself is out of scope; this validates the literal URL a source/asset claims, not where its name might resolve at fetch time.

Implemented with two separate `net.BlockList` instances (Node's built-in CIDR/IP-range matcher), one for IPv4 ranges and one for IPv6 — **not one shared instance for both.** On the Node version this was developed and tested against, registering both IPv4 and IPv6 subnets on a single `BlockList` was empirically found to make its IPv4 checks incorrectly match unrelated public IPv4 addresses (e.g. `8.8.8.8` and `100.128.0.1`, which are not in any registered private range) once any IPv6 subnet was also present on that same instance. Splitting into two family-specific instances was verified to resolve this cleanly, including at the exact public/private boundary addresses (`100.63.255.255` blocked, `100.128.0.1` allowed; `172.31.255.255` blocked, `172.32.0.1` allowed). If Node's `BlockList` behavior around mixed-family instances changes in a future version, this two-instance split remains correct regardless — it just may become unnecessary, not wrong.

### Research-report JSON structure

Both the mock-fixture path and the validated real-OpenAI path return this exact shape before saving. `sources` and `asset_candidates` are lifted out of the object into their own tables; every other key maps 1:1 onto a `lead_research_reports` column:

```
{
  business_summary: string,
  verified_details: {
    phone: string|null, email: string|null, address: string|null, service_area: string|null,
    services: string[], hours: string|null, hours_conflict: string|null
  },
  website_findings: {
    presence_type: "dedicated_website" | "social_only" | "no_website_found",
    website_url: string|null, observations: string[], homepage_opportunities: string[]
  },
  activity_evidence: { appears_active: boolean, signals: string[] },
  brand_cues: { personality: string[], colors: string[], notes: string|null },
  recommended_customer_action: string,
  personalization_detail: string,
  missing_or_conflicting_information: string[],
  mockup_brief: { concept_direction: string, key_sections: string[], tone: string, must_avoid: string[] },
  sources: [{ source_url, source_title, source_type, supports_fields: string[], notes }],
  asset_candidates: [{ asset_url, source_page_url, asset_type, description, ownership_context }]
}
```

`hours` is only ever populated when sources agree; when they conflict, `hours` stays `null` and `hours_conflict` explains the disagreement instead of guessing.

### Local testing with Netlify Dev

**A plain static server (`npx serve`, `python3 -m http.server`, etc.) cannot execute `lead-research.js` at all.** Those serve files only — there is no Node runtime behind them to invoke a Netlify Function, so `/.netlify/functions/lead-research` returns a plain static-server 404 no matter what the browser sends. Testing Phase 2A (mock or live) requires one of:

- **Netlify Dev** (recommended for local iteration) — runs the static site *and* executes functions locally, proxying `/.netlify/functions/*` to real Node invocations of the files in `netlify/functions/`.
- **A deployed Netlify Function endpoint** (a real Netlify site, or a Netlify deploy preview) — functions run for real, on Netlify's infrastructure.

**Exact local command** (from the repository root):

```
npx netlify-cli dev
```

The first run prompts for a few one-time answers if there is no linked site yet: no build command, publish directory `.` (the repository root, since this is a plain static site with no build step), and functions directory `netlify/functions` (already the correct location — nothing in this repo needs to change for Netlify Dev to find `lead-research.js`). Once running, open the URLs Netlify Dev prints (typically `http://localhost:8888/lead-detail.html?id=...`) — that's a single origin that proxies both the static files and the function together, so the "Run AI Research" button's same-origin `fetch("/.netlify/functions/lead-research")` call actually reaches the function.

**Environment variables for Netlify Dev** are read from a local `.env` file in the repository root (already covered by `.gitignore`'s `.env`/`.env.*` entries — never commit one). Create it locally with:

For mock-mode testing (no OpenAI account needed):

```
LEAD_RESEARCH_MOCK_MODE=true
SUPABASE_URL=<your Supabase project URL>
SUPABASE_SERVICE_ROLE_KEY=<your Supabase service role key>
```

For live research testing:

```
OPENAI_API_KEY=<your OpenAI API key>
SUPABASE_URL=<your Supabase project URL>
SUPABASE_SERVICE_ROLE_KEY=<your Supabase service role key>
```

(`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are required in both cases — the function loads and updates the lead/report rows in Supabase regardless of which research mode is active; only the research call itself differs.) Do not set both `LEAD_RESEARCH_MOCK_MODE=true` and a real `OPENAI_API_KEY` unless you specifically want mock mode to win — explicit mock mode always takes priority over a configured key (see "Explicit mock mode" above).

Do not write real secret values into `handoff.md`, any tracked file, or a commit — the placeholders above are illustrative only.

### Files added

- `supabase-lead-research-schema.sql`
- `netlify/functions/lead-research.js`
- `netlify/functions/lead-research.test.js` — plain-Node tests (no framework, no new dependency) for the pure, side-effect-free helpers in `lead-research.js`, exposed for testing only via `exports.__internal` (`isMockModeEnabled`, `isSafeHttpsUrl`, `extractCitationUrls`, `validateAndBuildResearchResult`, `buildMockResearchResult`, plus the `CLASS`/`FACT_FIELD_TOKENS` constants). Run with `node netlify/functions/lead-research.test.js`; exits non-zero on any failed assertion, so it's safe to wire into a future CI step as-is. Covers: `url_citation`-only annotation acceptance, malformed source/asset objects failing validation (not being silently dropped), fact-specific per-field citation coverage (including the "one source can't validate an unrelated field" case), the literal/untrimmed mock-mode match, and ~35 URL-safety cases (public domains, every rejected private/loopback/reserved range, obfuscated IPv4 literals, IPv6 forms). Does not exercise `exports.handler` itself (session verification, the three RPC calls, request routing) — that requires a live Supabase project and stays covered by the manual testing checklist below, consistent with every other RPC-level scenario in this phase.

### Files changed

- `leads.js` — added `getLatestResearchReport()`, `getResearchSources()`, `getResearchAssetCandidates()`, `reviewAssetCandidate()`, `runLeadResearch()`, and the three research-related column lists. Nothing existing in this file changed.
- `lead-detail.html` — added an "AI Research Report" panel (Run AI Research button, loading/success/error states, last-researched date, all report fields, source list, and a candidate-image gallery with approve/reject controls). The candidate-image gallery never renders `<img src="">` for an invalid/unsafe URL — it shows a visible "Invalid or unavailable image URL" placeholder instead, and a runtime image-load failure (a URL that validated but 404s) falls back to the same placeholder via `onerror` without affecting any other part of the panel. Nothing else existing in this file changed.
- `admin.css` — additive-only classes for the new panel (`.research-block`, `.research-list`, `.tag-row`/`.tag`, `.asset-grid`/`.asset-card`/`.asset-thumb`/`.asset-body`/`.asset-status`), plus updated copy on `.asset-thumb.broken::after` ("Invalid or unavailable image URL").
- `handoff.md` — this section, plus updates to the SQL-to-run and Netlify env var lists below.

### Manual testing checklist (Phase 2A)

Run `supabase-lead-research-schema.sql` in Supabase first (after confirming Phase 1's migration is applied). Test with Netlify Dev (see above) — a plain static server cannot run any of this.

0. **Run the automated tests first** — `node netlify/functions/lead-research.test.js`. Confirm every assertion passes (no Supabase/OpenAI access needed for this step) before working through the scenarios below, which cover the parts that do need a live Supabase project.

1. **Configuration error when nothing is set** — With neither `LEAD_RESEARCH_MOCK_MODE` nor `OPENAI_API_KEY` set, click "Run AI Research." Confirm a clear configuration-error message, and confirm (via a direct Supabase check, or "Check suppression list"-style inspection) that **no** `lead_research_reports` row was created for that lead.
2. **Run AI Research (explicit mock mode)** — With `LEAD_RESEARCH_MOCK_MODE=true` set, click "Run AI Research." Confirm the button disables and shows "Researching...", then re-enables with a success message noting mock fixture data.
3. **Report renders** — Confirm every section of the new panel populates: business summary, verified details, activity evidence, website findings, brand cues, recommended action, personalization detail, missing/conflicting info, mockup brief, sources, and candidate images. Confirm the "Mock data" banner is visible and its text references `LEAD_RESEARCH_MOCK_MODE`, not a missing key.
4. **Sources are clickable and safe** — Confirm each source renders as a link (they're `https://example.com/...` fixtures, so they'll load an empty/placeholder page, not error out or execute anything).
5. **Candidate image approve/reject** — Click "Approve" on one candidate image; confirm its status badge changes to "Approved for mockup" and the button disables. Click "Reject" on the other; confirm a prompt for a reason appears, and the status badge changes to "Rejected." Reject a candidate with an empty/cancelled prompt and confirm it still shows as "Rejected" (not "Pending review") — this is the `rejection_reason` fallback placeholder.
6. **Invalid asset image renders a placeholder, not a broken request** — Manually set a candidate's `asset_url` to something `sanitizeUrl()` rejects (e.g. `javascript:alert(1)`) via direct Supabase access, reload the report, and confirm the gallery shows "Invalid or unavailable image URL" with no `<img>` tag in the DOM for that card, and that the rest of the panel renders normally.
7. **Activity log integration** — Confirm `ai_research_started` and `ai_research_completed` rows appear in the lead's existing Activity log panel after a run.
8. **Duplicate concurrent runs are blocked** — Click "Run AI Research," and before it finishes, trigger a second call (e.g. a second browser tab, or a direct `POST` to `/.netlify/functions/lead-research` with the same `lead_id`). Confirm the second request returns 409 ("AI research is already running for this lead"), not a second report.
9. **Stale running report recovery** — Manually set an existing report's `status` back to `'running'` and `created_at` to more than 10 minutes ago (direct Supabase access), then click "Run AI Research" for that same lead. Confirm the stale report is now `status='failed'` with `error_classification='provider_timeout'`, and a new report was created and completed normally.
10. **Non-admin rejection** — Sign in as a non-admin Supabase session (e.g. a customer-portal account) and attempt a direct `POST` to `/.netlify/functions/lead-research` with a valid `lead_id` and that session's access token. Confirm 403.
11. **Unauthenticated rejection** — Attempt a direct `POST` to the function with no `Authorization` header. Confirm 401.
12. **Request validation** — Attempt a direct `POST` with a non-UUID `lead_id`, with a UUID for a lead that doesn't exist, with an array body, with `null`, and with an extra property alongside `lead_id`. Confirm each is rejected (400 for shape/format problems, 404 for a well-formed but nonexistent lead), with no report row created for any of them.
13. **RLS blocks a forged report (direct API bypass)** — While signed in as an admin, attempt a direct `INSERT` into `lead_research_reports` (or `lead_research_sources`) via the Supabase REST API. Confirm it is rejected — there is no browser-facing `INSERT` policy on either table, and `begin_/complete_/fail_lead_research_run()` are not callable by `authenticated` at all.
14. **Asset review RPC is scoped correctly** — Attempt a direct `PATCH` on a `lead_asset_candidates` row via the REST API (bypassing `review_lead_asset_candidate()`). Confirm it is rejected. Then call the RPC directly with a nonexistent `p_asset_id`; confirm a clear "not found" error rather than a silent no-op.
15. **Child-row consistency is enforced** — Attempt a direct `INSERT` into `lead_research_sources` (as service role, e.g. via the SQL editor) with a `report_id` that belongs to lead A but a `lead_id` naming lead B. Confirm the composite foreign key rejects it.
16. **`complete_lead_research_run()` rejects non-array JSON inputs** — Call the RPC directly (service role / SQL editor) against a `running` report with `p_sources` set to SQL `NULL`, then to JSON `null`, then to a JSON object (`{}`), then to a string, then to a number. Confirm each is rejected with a clear exception rather than silently completing with zero source rows; repeat for `p_asset_candidates`. Confirm a genuine empty array (`[]`) for either parameter *does* complete successfully with zero child rows.
17. **A failed `fail_lead_research_run()` call doesn't crash the response or log anything unsafe** — Hard to trigger directly without simulating a Supabase outage; at minimum, read through `lead-research.js`'s `catch` block and confirm by inspection that a `failRpcError` from that call only ever produces one `console.error` with `{ classification, report_id, lead_id, fail_rpc: "fail_rpc_write_failed" }` and that the function still returns the friendly message for the *original* failure — never the raw Supabase error, and never a different response shape.
18. **Live mode, once `OPENAI_API_KEY` is set** — See "Adding `OPENAI_API_KEY`" under Netlify Environment Variables below; do this only after the mock-mode checklist above passes and only with `LEAD_RESEARCH_MOCK_MODE` unset or `false`.

### Assumptions and open issues from this phase

- The real OpenAI Responses API path (`runOpenAiResearch()` / `validateAndBuildResearchResult()` / `extractCitationUrls()` in `lead-research.js`) has never been exercised against the live API in this environment — no `OPENAI_API_KEY` was configured, and this phase's instructions explicitly forbade calling a paid API during implementation. The endpoint, `tools: [{ type: "web_search" }]`, `text.format` structured-output shape, and — most importantly — the citation/annotation shape `extractCitationUrls()` expects all reflect the Responses API's documented contract as of this writing; confirm against current OpenAI docs and do one small live test (a cheap model, one lead) before relying on it. If the citation shape is wrong, every fact-bearing real report will fail validation loudly (fail closed) rather than silently saving unverified sources — see "Source citation cross-checking" above.
- Netlify Functions have a synchronous execution time limit (10 seconds on the default plan, longer on higher tiers). The OpenAI fetch itself is capped at 25 seconds via `AbortSignal.timeout()`, which may already exceed some plans' function ceiling — if real runs start hitting the platform's own timeout (not the 25s abort) in practice, moving this function to a Netlify Background Function (different invocation/response model) is the natural next step. `begin_lead_research_run()`'s 10-minute stale-report recovery (see above) means a platform-level kill no longer permanently blocks that lead's research even before that migration happens.
- `OPENAI_RESEARCH_MODEL` is an optional env var (defaults to `"gpt-4.1"` in code) for picking which OpenAI model performs the research once a key is added — not required for mock mode, and only used as a fallback if the OpenAI response itself doesn't report which model actually served the request.
- There is no report history UI — `getLatestResearchReport()` only ever surfaces the most recent report per lead. Older reports (and their sources/asset candidates) remain in the database and in the lead's Activity log, just not browsable as a list yet.
- No re-run confirmation dialog exists — clicking "Run AI Research" again on a lead that already has a completed report simply starts a new one (the old report and its sources/assets remain in the database; only the newest is shown). Acceptable for Phase 2A's manual, single-admin testing; worth reconsidering if this becomes a heavily-used feature with a cost per run.
- Fact-specific citation coverage (see "Source citation cross-checking" above) trusts the model's own `supports_fields` tagging on each source — it confirms a source is a real citation and that its claimed field tags are all from the approved vocabulary, but it does not independently verify that the source's actual page content genuinely discusses the specific field it claims to support (e.g. a real, cited page that happens to be tagged `"phone"` when it doesn't actually mention a phone number). Catching that would require fetching and parsing the cited page's own content, which is out of scope for Phase 2A.
- `isSafeHttpsUrl()`'s private/loopback/reserved-range rejection relies on two separate `net.BlockList` instances to work around a mixed-IPv4/IPv6 `BlockList` quirk observed on the Node version this was developed against (see "URL safety hardening" above) — worth re-verifying (and potentially collapsing back to one instance) against whatever Node version Netlify's function runtime actually uses, and again on any future Node upgrade.

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

If you are also applying the Lead Engine, run these two (in order) after the launch schema above:

```sql
-- Use the full file contents, in this order:
supabase-lead-engine-schema.sql
supabase-lead-research-schema.sql
```

`supabase-lead-research-schema.sql` (Phase 2A — AI research reports) depends on tables and functions created by both `supabase-launch-schema.sql` and `supabase-lead-engine-schema.sql`, so it must be applied last.

## Netlify Environment Variables To Set Later

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SITE_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY` (Lead Engine Phase 2A — AI research reports; see below)
- `OPENAI_RESEARCH_MODEL` (optional, Phase 2A; defaults to `gpt-4.1` in code if unset)
- `LEAD_RESEARCH_MOCK_MODE` (Lead Engine Phase 2A — explicit mock-fixture testing; see below)

`SUPABASE_SERVICE_ROLE_KEY` is server-side only for Netlify Functions. Do not add it to `supabase-client.js` or any browser file. The same applies to `OPENAI_API_KEY` — it is read only by `netlify/functions/lead-research.js` via `process.env` and must never be placed in browser code. `LEAD_RESEARCH_MOCK_MODE` is not a secret, but it is still server-side-only (read from `process.env` in the Netlify Function) — there is no browser-facing way to request mock mode, and a request cannot ask for it either (see "Explicit mock mode" in the Phase 2A section above).

**Mock-mode testing (`LEAD_RESEARCH_MOCK_MODE`):** set it to the literal string `true` (case-insensitive; anything else, including unset, leaves it off) to exercise the full save/render/approve-reject workflow with zero network calls and zero cost, without `OPENAI_API_KEY` configured at all. **Important:** unlike the phase's first draft, a missing `OPENAI_API_KEY` no longer implicitly triggers mock mode — with neither `LEAD_RESEARCH_MOCK_MODE=true` nor `OPENAI_API_KEY` set, "Run AI Research" now fails with a clear configuration error and creates no report row, rather than silently generating fake research. See "Local testing with Netlify Dev" in the Phase 2A section above for how to actually set this locally (a plain static server can't run the function at all).

**Adding `OPENAI_API_KEY` (Phase 2A):**

1. Confirm `supabase-lead-research-schema.sql` has been run (see "Supabase SQL To Run" above) — the research report tables and the three server-only RPCs (`begin_/complete_/fail_lead_research_run`) must exist before any run, mock or real, can save.
2. In the Netlify dashboard, add `OPENAI_API_KEY` (and optionally `OPENAI_RESEARCH_MODEL`) as environment variables. Make sure `LEAD_RESEARCH_MOCK_MODE` is **not** set to `true` in that same environment — explicit mock mode always wins over a configured key (see "Explicit mock mode" above), so a stray `LEAD_RESEARCH_MOCK_MODE=true` left over from testing would silently keep producing mock reports even with a real key present. Redeploy so the function picks up the new environment.
3. Before relying on it for real leads, do one small live test: click "Run AI Research" on a single lead and confirm the saved report actually came from OpenAI (`model_used` will be the model the API actually reports, not `mock-fixture-v1`, and `is_mock` will be `false`) and that the shape matches what `lead-detail.html` expects (see "Research-report JSON structure" in the Phase 2A section above). Pay particular attention to whether any sources were saved at all — if `extractCitationUrls()`'s assumed annotation shape doesn't match what the live API actually returns, every fact-bearing report will fail with `research_validation_failed` (a loud, safe failure — see "Source citation cross-checking" above) rather than silently saving unverified sources, so a validation failure on the first live test is a signal to check that shape, not necessarily a broken key.
4. If real research calls start hitting Netlify's own platform-level timeout (distinct from the 25-second `AbortSignal` timeout already built into the OpenAI fetch itself), the next step is converting this function to a Netlify Background Function — not done in this phase. `begin_lead_research_run()`'s 10-minute stale-report recovery means a platform-level kill no longer permanently blocks that lead's research even before that migration happens.
5. To go back to mock-fixture testing later, explicitly set `LEAD_RESEARCH_MOCK_MODE=true` — simply removing `OPENAI_API_KEY` is no longer sufficient on its own (see "Important" note above).

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
