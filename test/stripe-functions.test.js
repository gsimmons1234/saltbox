const test = require("node:test");
const assert = require("node:assert/strict");
const Stripe = require("stripe");

const { HttpError, requireAdmin, requireCustomer, requireUser } = require("../netlify/functions/_shared");
const { createHandler: createInvoiceHandler } = require("../netlify/functions/create-invoice");
const { createHandler: createPortalHandler } = require("../netlify/functions/create-customer-portal-session");
const { createHandler: createSubscriptionHandler } = require("../netlify/functions/create-subscription-checkout");
const {
  createHandler: createWebhookHandler,
  invoiceStatus,
  subscriptionStatus,
} = require("../netlify/functions/stripe-webhook");

function body(response) {
  return JSON.parse(response.body);
}

test("Supabase access tokens are required and verified server-side", async () => {
  await assert.rejects(
    requireUser({ headers: {} }, {}),
    (error) => error instanceof HttpError && error.statusCode === 401,
  );

  let receivedToken;
  const user = await requireUser(
    { headers: { authorization: "Bearer verified-token" } },
    {
      auth: {
        getUser: async (token) => {
          receivedToken = token;
          return { data: { user: { id: "user-1", email: "admin@example.com" } }, error: null };
        },
      },
    },
  );
  assert.equal(receivedToken, "verified-token");
  assert.equal(user.id, "user-1");
});

test("admin authorization requires an admin_users match", async () => {
  const query = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data: null, error: null }; },
  };
  const supabase = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: () => query,
  };
  await assert.rejects(
    requireAdmin({ headers: { authorization: "Bearer token" } }, supabase),
    (error) => error instanceof HttpError && error.statusCode === 403,
  );
});

test("customer authorization matches the verified email exactly", async () => {
  let comparedEmail;
  const query = {
    select() { return this; },
    eq(_column, value) { comparedEmail = value; return this; },
    limit() { return this; },
    async maybeSingle() {
      return { data: { id: "customer-1", email: comparedEmail }, error: null };
    },
  };
  const supabase = {
    auth: {
      getUser: async () => ({
        data: { user: { id: "user-1", email: "customer_name@example.com" } },
        error: null,
      }),
    },
    from: () => query,
  };
  const result = await requireCustomer(
    { headers: { authorization: "Bearer token" } },
    supabase,
  );
  assert.equal(comparedEmail, "customer_name@example.com");
  assert.equal(result.customer.id, "customer-1");
});

test("billing functions reject missing authorization before reading configuration", async () => {
  const handlers = [
    createInvoiceHandler(),
    createPortalHandler(),
    createSubscriptionHandler(),
  ];
  for (const handler of handlers) {
    const response = await handler({ httpMethod: "POST", headers: {}, body: "{}" });
    assert.equal(response.statusCode, 401);
    assert.equal(body(response).error, "Sign in is required.");
  }
});

test("customer portal uses the authenticated customer's stored Stripe ID", async () => {
  let portalParams;
  const handler = createPortalHandler({
    supabase: {},
    stripe: {
      billingPortal: {
        sessions: {
          create: async (params) => {
            portalParams = params;
            return { url: "https://billing.stripe.test/session" };
          },
        },
      },
    },
    requireCustomer: async () => ({
      customer: { id: "customer-local", stripe_customer_id: "cus_verified" },
    }),
    getSiteUrl: () => "https://saltbox.test",
  });

  const response = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer token" },
    body: JSON.stringify({ stripe_customer_id: "cus_attacker" }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(body(response).url, "https://billing.stripe.test/session");
  assert.deepEqual(portalParams, {
    customer: "cus_verified",
    return_url: "https://saltbox.test/client-dashboard.html",
  });
});

test("customer portal refuses accounts that are not linked to Stripe", async () => {
  const handler = createPortalHandler({
    supabase: {},
    stripe: {},
    requireCustomer: async () => ({ customer: { id: "customer-local", stripe_customer_id: null } }),
  });
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer token" } });
  assert.equal(response.statusCode, 409);
});

test("invoice creation reuses an existing Stripe invoice", async () => {
  let adminChecked = false;
  const handler = createInvoiceHandler({
    supabase: {},
    stripe: {},
    requireAdmin: async () => { adminChecked = true; },
    loadInvoiceContext: async () => ({
      customer: { id: "customer-local" },
      invoice: {
        id: "invoice-local",
        stripe_invoice_id: "in_existing",
        stripe_invoice_url: "https://invoice.stripe.test/existing",
      },
    }),
  });
  const response = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer token" },
    body: '{"invoice_id":"invoice-local"}',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(body(response).existing, true);
  assert.equal(adminChecked, true);
});

test("invoice creation builds, finalizes, and persists one Stripe invoice", async () => {
  const calls = [];
  let persisted;
  const stripe = {
    invoices: {
      create: async (params, options) => {
        calls.push(["invoice", params, options]);
        return { id: "in_new" };
      },
      finalizeInvoice: async (id, params, options) => {
        calls.push(["finalize", id, params, options]);
        return { id, hosted_invoice_url: "https://invoice.stripe.test/new" };
      },
    },
    invoiceItems: {
      create: async (params, options) => calls.push(["item", params, options]),
    },
  };
  const handler = createInvoiceHandler({
    supabase: {},
    stripe,
    requireAdmin: async () => {},
    loadInvoiceContext: async () => ({
      customer: { id: "customer-local", email: "customer@example.com" },
      invoice: { id: "invoice-local", title: "Website", description: "Build", amount: 1250 },
    }),
    ensureStripeCustomer: async () => "cus_verified",
    persistInvoice: async (_supabase, invoiceId, invoice) => { persisted = { invoiceId, invoice }; },
  });

  const response = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer token" },
    body: '{"invoice_id":"invoice-local"}',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0][0], "invoice");
  assert.equal(calls[1][1].amount, 125000);
  assert.equal(calls[1][1].invoice, "in_new");
  assert.equal(calls[2][0], "finalize");
  assert.equal(calls[0][2].idempotencyKey, "saltbox-invoice-invoice-local");
  assert.equal(persisted.invoiceId, "invoice-local");
});

test("subscription checkout derives recurring price data from the protected record", async () => {
  let checkout;
  const handler = createSubscriptionHandler({
    supabase: {},
    stripe: {
      checkout: {
        sessions: {
          create: async (params, options) => {
            checkout = { params, options };
            return { id: "cs_test", url: "https://checkout.stripe.test/session" };
          },
        },
      },
    },
    requireAdmin: async () => {},
    loadSubscriptionContext: async () => ({
      customer: { id: "customer-local", email: "customer@example.com" },
      subscription: {
        id: "subscription-local",
        plan_name: "Starter Care",
        amount: 75,
        interval: "month",
      },
    }),
    ensureStripeCustomer: async () => "cus_verified",
    getSiteUrl: () => "https://saltbox.test",
  });

  const response = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer token" },
    body: '{"subscription_id":"subscription-local"}',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(checkout.params.customer, "cus_verified");
  assert.equal(checkout.params.line_items[0].price_data.unit_amount, 7500);
  assert.equal(checkout.params.subscription_data.metadata.subscription_id, "subscription-local");
  assert.equal(checkout.options.idempotencyKey, "saltbox-subscription-checkout-subscription-local");
});

test("webhook verifies a real Stripe SDK signature before processing", async () => {
  const stripe = new Stripe("sk_test_dummy");
  const webhookSecret = "whsec_dummy";
  const payload = JSON.stringify({
    id: "evt_test",
    object: "event",
    type: "ping",
    data: { object: {} },
  });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
  let received;
  const handler = createWebhookHandler({
    stripe,
    webhookSecret,
    supabase: {},
    processEvent: async (_supabase, event) => { received = event; },
  });

  const response = await handler({
    httpMethod: "POST",
    headers: { "stripe-signature": signature },
    body: payload,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(received.id, "evt_test");
});

test("webhook rejects an invalid signature", async () => {
  const stripe = new Stripe("sk_test_dummy");
  const handler = createWebhookHandler({
    stripe,
    webhookSecret: "whsec_dummy",
    supabase: {},
  });
  const response = await handler({
    httpMethod: "POST",
    headers: { "stripe-signature": "bad" },
    body: "{}",
  });
  assert.equal(response.statusCode, 400);
  assert.equal(body(response).error, "Invalid Stripe signature.");
});

test("webhook rejects a missing signature before reading Stripe configuration", async () => {
  const response = await createWebhookHandler()({ httpMethod: "POST", headers: {}, body: "{}" });
  assert.equal(response.statusCode, 400);
  assert.equal(body(response).error, "Missing Stripe signature.");
});

test("Stripe statuses map to Saltbox labels", () => {
  assert.equal(invoiceStatus("invoice.payment_failed"), "Payment failed");
  assert.equal(subscriptionStatus("past_due"), "Past due");
  assert.equal(subscriptionStatus("active"), "Active");
  assert.equal(subscriptionStatus("active", true), "Canceled");
});
