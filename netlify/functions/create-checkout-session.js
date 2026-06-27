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

  const amount = Number(payload.amount);
  const title = payload.title || "Saltbox invoice";
  if (!Number.isFinite(amount) || amount <= 0) {
    return json(400, { error: "A positive amount is required." });
  }

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: payload.customer_email || undefined,
      success_url: `${process.env.SITE_URL}/client-dashboard.html?billing=success`,
      cancel_url: `${process.env.SITE_URL}/client-dashboard.html?billing=cancelled`,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: payload.currency || "usd",
            unit_amount: Math.round(amount * 100),
            product_data: { name: title },
          },
        },
      ],
      metadata: {
        customer_id: payload.customer_id || "",
        invoice_id: payload.invoice_id || "",
      },
    });

    return json(200, { url: session.url, id: session.id });
  } catch (error) {
    return json(500, { error: error.message || "Could not create checkout session." });
  }
};
