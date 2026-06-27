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

function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Add them in Netlify environment variables.");
  }
  const { createClient } = require("@supabase/supabase-js");
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function loadInvoiceContext(payload) {
  if (!payload.invoice_id || !payload.customer_id) {
    return {
      customer: {
        id: payload.customer_id || null,
        email: payload.customer_email || null,
        name: payload.customer_name || null,
        business_name: payload.business_name || null,
        stripe_customer_id: payload.stripe_customer_id || null,
      },
      invoice: {
        id: payload.invoice_id || null,
        title: payload.title || "Saltbox invoice",
        description: payload.description || null,
        amount: payload.amount,
        due_date: payload.due_date || null,
      },
      supabase: null,
    };
  }

  const supabase = getSupabase();
  const [{ data: customer, error: customerError }, { data: invoice, error: invoiceError }] = await Promise.all([
    supabase.from("customers").select("id, name, email, business_name, stripe_customer_id").eq("id", payload.customer_id).single(),
    supabase.from("customer_invoices").select("id, title, description, amount, due_date, status").eq("id", payload.invoice_id).single(),
  ]);

  if (customerError) throw customerError;
  if (invoiceError) throw invoiceError;
  return { customer, invoice, supabase };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Invalid JSON body." });
  }

  try {
    const stripe = getStripe();
    const { customer, invoice, supabase } = await loadInvoiceContext(payload);
    const amount = Number(invoice.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return json(400, { error: "Invoice amount must be a positive number." });
    }
    if (!customer.email && !customer.stripe_customer_id) {
      return json(400, { error: "Customer email or Stripe customer id is required." });
    }

    let stripeCustomerId = customer.stripe_customer_id;
    if (!stripeCustomerId) {
      const stripeCustomer = await stripe.customers.create({
        email: customer.email,
        name: customer.name || customer.business_name || undefined,
        metadata: { customer_id: customer.id || "" },
      });
      stripeCustomerId = stripeCustomer.id;

      if (supabase && customer.id) {
        await supabase.from("customers").update({ stripe_customer_id: stripeCustomerId }).eq("id", customer.id);
      }
    }

    await stripe.invoiceItems.create({
      customer: stripeCustomerId,
      amount: Math.round(amount * 100),
      currency: payload.currency || "usd",
      description: invoice.description || invoice.title || "Saltbox invoice",
      metadata: {
        customer_id: customer.id || "",
        invoice_id: invoice.id || "",
      },
    });

    const stripeInvoice = await stripe.invoices.create({
      customer: stripeCustomerId,
      collection_method: "send_invoice",
      days_until_due: payload.days_until_due || 14,
      description: invoice.description || undefined,
      metadata: {
        customer_id: customer.id || "",
        invoice_id: invoice.id || "",
      },
    });

    const finalized = await stripe.invoices.finalizeInvoice(stripeInvoice.id);

    if (supabase && invoice.id) {
      await supabase
        .from("customer_invoices")
        .update({
          status: "Stripe draft",
          stripe_invoice_id: finalized.id,
          stripe_invoice_url: finalized.hosted_invoice_url,
        })
        .eq("id", invoice.id);
    }

    return json(200, { id: finalized.id, url: finalized.hosted_invoice_url });
  } catch (error) {
    return json(500, { error: error.message || "Could not create Stripe invoice." });
  }
};
