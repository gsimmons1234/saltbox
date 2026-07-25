const {
  bearerToken,
  errorResponse,
  getSiteUrl,
  getStripe,
  getSupabase,
  json,
  requireCustomer,
} = require("./_shared");

function createHandler(deps = {}) {
  return async (event) => {
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });

    try {
      bearerToken(event);
      const supabase = deps.supabase || getSupabase();
      const { customer } = await (deps.requireCustomer || requireCustomer)(event, supabase);
      const stripe = deps.stripe || getStripe();

      if (!customer.stripe_customer_id) {
        return json(409, { error: "No Stripe billing account is linked yet." });
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: customer.stripe_customer_id,
        return_url: `${(deps.getSiteUrl || getSiteUrl)()}/client-dashboard.html`,
      });

      return json(200, { url: session.url });
    } catch (error) {
      return errorResponse(error, "Could not create a customer portal session.");
    }
  };
}

exports.createHandler = createHandler;
exports.handler = createHandler();
