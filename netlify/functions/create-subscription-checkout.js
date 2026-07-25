const {
  HttpError,
  assertDatabaseResult,
  bearerToken,
  errorResponse,
  getSiteUrl,
  getStripe,
  getSupabase,
  json,
  parseJson,
  requireAdmin,
} = require("./_shared");
const { ensureStripeCustomer } = require("./create-invoice");

async function loadSubscriptionContext(supabase, subscriptionId) {
  const subscription = assertDatabaseResult(await supabase
    .from("subscriptions")
    .select("id, customer_id, plan_name, amount, interval, status, stripe_subscription_id")
    .eq("id", subscriptionId)
    .maybeSingle());
  if (!subscription) throw new HttpError(404, "Subscription not found.");

  const customer = assertDatabaseResult(await supabase
    .from("customers")
    .select("id, name, email, business_name, stripe_customer_id")
    .eq("id", subscription.customer_id)
    .maybeSingle());
  if (!customer) throw new HttpError(404, "Subscription customer not found.");
  return { customer, subscription };
}

function createHandler(deps = {}) {
  return async (event) => {
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });

    try {
      bearerToken(event);
      const supabase = deps.supabase || getSupabase();
      await (deps.requireAdmin || requireAdmin)(event, supabase);
      const payload = parseJson(event);
      const subscriptionId = typeof payload.subscription_id === "string"
        ? payload.subscription_id.trim()
        : "";
      if (!subscriptionId) throw new HttpError(400, "subscription_id is required.");

      const stripe = deps.stripe || getStripe();
      const { customer, subscription } = await (deps.loadSubscriptionContext || loadSubscriptionContext)(supabase, subscriptionId);

      if (subscription.stripe_subscription_id) {
        throw new HttpError(409, "This subscription is already connected to Stripe.");
      }

      const amount = Number(subscription.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(400, "Subscription amount must be a positive number.");
      }
      const interval = subscription.interval === "year" ? "year" : "month";
      const stripeCustomerId = await (deps.ensureStripeCustomer || ensureStripeCustomer)(stripe, supabase, customer);
      const siteUrl = (deps.getSiteUrl || getSiteUrl)();
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: stripeCustomerId,
        success_url: `${siteUrl}/client-dashboard.html?billing=success`,
        cancel_url: `${siteUrl}/client-dashboard.html?billing=cancelled`,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(amount * 100),
            recurring: { interval },
            product_data: { name: subscription.plan_name || "Saltbox care plan" },
          },
        }],
        metadata: {
          customer_id: customer.id,
          subscription_id: subscription.id,
        },
        subscription_data: {
          metadata: {
            customer_id: customer.id,
            subscription_id: subscription.id,
          },
        },
      }, { idempotencyKey: `saltbox-subscription-checkout-${subscription.id}` });

      if (!session.url) throw new Error("Stripe did not return a Checkout URL.");
      return json(200, { id: session.id, url: session.url });
    } catch (error) {
      return errorResponse(error, "Could not create the subscription checkout.");
    }
  };
}

exports.createHandler = createHandler;
exports.handler = createHandler();
exports.loadSubscriptionContext = loadSubscriptionContext;
