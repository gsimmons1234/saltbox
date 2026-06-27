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
