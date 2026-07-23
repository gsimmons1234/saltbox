# Saltbox Operations Handoff

## Architecture

Saltbox is a static HTML/CSS/JavaScript site deployed on Netlify.

- Supabase provides Auth, Postgres data, Row Level Security, and private customer file storage.
- Netlify Functions are the only server-side Stripe runtime.
- Stripe hosts invoice payment, subscription Checkout, and the customer billing portal.
- There is no frontend build step.

Do not add a second copy of the Stripe runtime in Supabase Edge Functions. Keeping one webhook and one set of billing functions avoids deployment drift.

## Public and Account Pages

- `index.html` - public homepage
- `quote.html` - public quote request form
- `client-login.html` - customer sign-in
- `client-dashboard.html` - read-only customer account and billing portal entry
- `login.html` - admin sign-in
- `admin.html`, `requests.html`, `customers.html`, `customer-detail.html`, `tickets.html`, `subscriptions.html`, `settings.html` - authenticated admin area

## Supabase

Browser configuration is in `supabase-client.js`. Only the public publishable key belongs there. Never put the service-role key in browser code.

The current schema/RLS source is `supabase-launch-schema.sql`. It defines:

- `admin_users`
- `customers`, notes, files, and invoices
- tickets and comments
- care subscriptions
- package payment plans and payment schedule rows
- admin-only management policies
- customer read-only policies scoped by authenticated email
- private `customer-files` storage policies

After applying the SQL, add the real admin Auth user to `public.admin_users` using the example at the top of the file. Without that row, admin RLS correctly denies access.

### Live public audit on July 22, 2026

Read-only public API probes confirmed that these tables exist in project `plpkvifafggqzxpsyiie` and anonymous reads returned zero rows:

- `quote_requests`
- `customers`, `customer_notes`, `customer_files`, `customer_invoices`
- `tickets`, `ticket_comments`
- `subscriptions`
- `package_payment_plans`, `package_payment_plan_payments`

The required frontend columns were also present. The only Auth user is already present in `admin_users` with the `admin` role. Auth email login is enabled, email confirmation is required, and public signup is currently allowed. For an invite-only client portal, disable public signup in Supabase Auth settings and create/invite customer users from the dashboard.

The `customer-files` Storage bucket also exists, and an anonymous list request returned no objects.

The linked project has no deployed Supabase Edge Functions or Edge Function secrets. Its migration history is empty because the current schema was applied manually. Use `supabase-launch-schema.sql` as the source of truth until migrations are deliberately introduced; do not assume `supabase db push` will recreate the existing project.

## Stripe Billing Flow

Netlify Functions:

- `create-invoice.js` - admin-only; creates/finalizes one Stripe invoice from a protected Supabase invoice row
- `create-subscription-checkout.js` - admin-only; creates recurring Stripe Checkout from a protected subscription row
- `create-customer-portal-session.js` - customer-only; opens the portal for the Stripe customer linked to the signed-in email
- `stripe-webhook.js` - signature-verified synchronization for invoices and subscriptions
- `_shared.js` - shared environment, authentication, and response helpers

The browser sends its Supabase access token to every user-triggered billing function. Functions verify the token server-side and ignore caller-supplied pricing/customer details. Invoice and Checkout requests use Stripe idempotency keys.

Required Netlify environment variables are documented in `.env.example`:

- `SITE_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Use Stripe test-mode keys first. Configure the webhook endpoint as:

`https://YOUR_SITE/.netlify/functions/stripe-webhook`

Subscribe it to:

- `invoice.finalized`
- `invoice.paid`
- `invoice.payment_failed`
- `invoice.voided`
- `invoice.marked_uncollectible`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Enable and configure the Stripe Customer Portal before testing the Manage Billing button.

## Verification

Install and run automated checks:

```bash
npm install
npm test
git diff --check
```

The Node test suite covers:

- customer portal isolation
- existing-invoice reuse
- invoice amount/idempotency behavior
- recurring Checkout construction
- real Stripe SDK webhook signature verification with dummy test values
- Stripe-to-Saltbox status mapping

Serve the static pages locally:

```bash
npm run serve
```

A plain static server cannot execute Netlify Functions. Use a Netlify dev environment or a deploy preview for browser-to-function tests.

### Final Stripe test-mode checklist

1. Sign in as an admin and create a draft customer invoice.
2. Create its Stripe link and complete payment with a Stripe test card.
3. Confirm the webhook changes the Supabase invoice status to `Paid`.
4. Create a draft care subscription and click `Create checkout`.
5. Complete Checkout and confirm the Supabase subscription becomes `Active` with Stripe IDs.
6. Sign in as that customer and open Manage Billing.
7. Cancel the test subscription in Stripe and confirm the webhook changes it to `Canceled`.
8. Replay a webhook in Stripe and confirm the resulting Supabase state remains correct.

Do not switch to live Stripe keys until every item passes in test mode.
