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
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error("Missing STRIPE_WEBHOOK_SECRET. Add it in Netlify environment variables.");
  }
  const Stripe = require("stripe");
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const { createClient } = require("@supabase/supabase-js");
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });

  try {
    const stripe = getStripe();
    const signature = event.headers["stripe-signature"];
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    const stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
    const supabase = getSupabase();

    if (supabase && stripeEvent.type === "invoice.paid") {
      const invoice = stripeEvent.data.object;
      const invoiceId = invoice.metadata?.invoice_id;
      if (invoiceId) {
        await supabase
          .from("customer_invoices")
          .update({
            status: "Paid",
            stripe_invoice_id: invoice.id,
            stripe_invoice_url: invoice.hosted_invoice_url,
          })
          .eq("id", invoiceId);
      }
    }

    if (supabase && ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(stripeEvent.type)) {
      const subscription = stripeEvent.data.object;
      const customerId = subscription.metadata?.customer_id;
      if (customerId) {
        await supabase.from("subscriptions").upsert({
          customer_id: customerId,
          status: subscription.status,
          stripe_subscription_id: subscription.id,
          stripe_customer_id: subscription.customer,
          updated_at: new Date().toISOString(),
        }, { onConflict: "stripe_subscription_id" });
      }
    }

    return json(200, { received: true });
  } catch (error) {
    return json(400, { error: error.message || "Webhook verification failed." });
  }
};
