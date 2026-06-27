const headers = {
  "Content-Type": "application/json",
};

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("Missing STRIPE_SECRET_KEY. Add it in Netlify environment variables.");
  }
  try {
    const Stripe = require("stripe");
    return new Stripe(process.env.STRIPE_SECRET_KEY);
  } catch (error) {
    throw new Error("Stripe dependency is not installed. Run npm install before deploying Netlify Functions.");
  }
}

async function getStripeCustomerId(payload) {
  if (payload.stripe_customer_id) return payload.stripe_customer_id;
  if (!payload.customer_id) return null;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for customer lookup.");
  }

  const { createClient } = require("@supabase/supabase-js");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase
    .from("customers")
    .select("stripe_customer_id")
    .eq("id", payload.customer_id)
    .single();

  if (error) throw error;
  return data?.stripe_customer_id || null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });

  if (!process.env.SITE_URL) {
    return json(500, { error: "Missing SITE_URL. Add it in Netlify environment variables." });
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Invalid JSON body." });
  }

  try {
    const stripe = getStripe();
    const stripeCustomerId = await getStripeCustomerId(payload);
    if (!stripeCustomerId) {
      return json(400, { error: "No Stripe customer is linked to this customer yet." });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${process.env.SITE_URL}/client-dashboard.html`,
    });

    return json(200, { url: session.url });
  } catch (error) {
    return json(500, { error: error.message || "Could not create customer portal session." });
  }
};
