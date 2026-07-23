# Saltbox Operations Handoff

## Architecture

Saltbox is a static HTML/CSS/JavaScript site deployed on Netlify.

- Production URL: `https://saltboxwebdesign.com`
- Netlify project: `saltboxwebdesign`

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

- `create-invoice.js` - admin-only; creates, finalizes, and sends one Stripe invoice from a protected Supabase invoice row
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

As of July 22, 2026, `SITE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the test-mode `STRIPE_SECRET_KEY` are configured and verified in Netlify production and deploy-preview contexts.

The Stripe test webhook `we_1TwDPdJV8LiNF8sGc7fRB2sG` targets deploy preview 1 and its write-only signing secret is configured only in Netlify's deploy-preview context. Create a separate webhook for `https://saltboxwebdesign.com/.netlify/functions/stripe-webhook` and set its separate signing secret in the production context when this branch is merged. Do not reuse one endpoint's signing secret for the other URL.

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

The test-mode Customer Portal configuration `bpc_1TwDRSJV8LiNF8sGfIRJcJsj` is active and default. It allows invoice history, payment-method updates, and subscription cancellation at the end of the billing period. Customer profile and subscription-plan changes are intentionally disabled so Stripe cannot drift from Supabase's email-based access model or Saltbox's admin-controlled plans.

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

### Live Stripe test-mode verification on July 22, 2026

An isolated end-to-end run against deploy preview 1 passed all of these checks:

- Supabase admin JWT authorization
- Stripe customer creation and ID persistence
- invoice creation/finalization and payment with Stripe's Visa test token
- signed `invoice.paid` webhook synchronization to `Paid` in Supabase
- Stripe-hosted Customer Portal session creation
- recurring Checkout session creation with the expected amount and monthly interval
- test-card subscription payment
- signed subscription `created` and `deleted` webhook synchronization to `Active` and `Canceled`

The temporary Supabase Auth user and database rows were deleted, the Checkout session was expired, the Stripe customer was deleted, the subscription was canceled, and the temporary Product/Price were archived. Paid test invoices remain in Stripe's test data as an audit trail.

### Remaining browser acceptance checklist

1. Sign in through the real admin UI and create a test invoice for a real test customer.
2. Send the Stripe invoice from Saltbox. In test mode, copy its secure payment link and open it as the customer; Stripe does not deliver test-mode invoice emails.
3. Create a care-plan Checkout through the admin UI and complete the hosted Checkout with the same test card.
4. Sign in as that customer, open Manage Billing, and confirm invoice history, payment-method update, and end-of-period cancellation are available.
5. Confirm the Saltbox dashboards show the final `Paid`, `Active`, and `Canceled` statuses.

Do not switch to live Stripe keys until every item passes in test mode.
