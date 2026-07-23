const {
  HttpError,
  assertDatabaseResult,
  errorResponse,
  getStripe,
  getSupabase,
  json,
  parseJson,
  requireAdmin,
} = require("./_shared");

async function loadInvoiceContext(supabase, invoiceId) {
  const invoice = assertDatabaseResult(await supabase
    .from("customer_invoices")
    .select("id, customer_id, title, description, amount, due_date, status, stripe_invoice_id, stripe_invoice_url")
    .eq("id", invoiceId)
    .maybeSingle());
  if (!invoice) throw new HttpError(404, "Invoice not found.");

  const customer = assertDatabaseResult(await supabase
    .from("customers")
    .select("id, name, email, business_name, stripe_customer_id")
    .eq("id", invoice.customer_id)
    .maybeSingle());
  if (!customer) throw new HttpError(404, "Invoice customer not found.");
  return { customer, invoice };
}

async function ensureStripeCustomer(stripe, supabase, customer) {
  if (customer.stripe_customer_id) return customer.stripe_customer_id;
  if (!customer.email) throw new HttpError(400, "The customer needs an email before billing can be created.");

  const stripeCustomer = await stripe.customers.create({
    email: customer.email,
    name: customer.name || customer.business_name || undefined,
    metadata: { customer_id: customer.id },
  }, { idempotencyKey: `saltbox-customer-${customer.id}` });

  assertDatabaseResult(await supabase
    .from("customers")
    .update({ stripe_customer_id: stripeCustomer.id })
    .eq("id", customer.id));
  return stripeCustomer.id;
}

async function persistInvoice(supabase, invoiceId, stripeInvoice) {
  assertDatabaseResult(await supabase
    .from("customer_invoices")
    .update({
      status: "Open",
      stripe_invoice_id: stripeInvoice.id,
      stripe_invoice_url: stripeInvoice.hosted_invoice_url,
      stripe_checkout_url: stripeInvoice.hosted_invoice_url,
    })
    .eq("id", invoiceId));
}

function createHandler(deps = {}) {
  return async (event) => {
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });

    try {
      const payload = parseJson(event);
      const invoiceId = typeof payload.invoice_id === "string" ? payload.invoice_id.trim() : "";
      if (!invoiceId) throw new HttpError(400, "invoice_id is required.");

      const supabase = deps.supabase || getSupabase();
      await (deps.requireAdmin || requireAdmin)(event, supabase);
      const stripe = deps.stripe || getStripe();
      const { customer, invoice } = await (deps.loadInvoiceContext || loadInvoiceContext)(supabase, invoiceId);

      if (invoice.stripe_invoice_id && invoice.stripe_invoice_url) {
        return json(200, {
          id: invoice.stripe_invoice_id,
          url: invoice.stripe_invoice_url,
          existing: true,
        });
      }

      const amount = Number(invoice.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(400, "Invoice amount must be a positive number.");
      }

      const stripeCustomerId = await (deps.ensureStripeCustomer || ensureStripeCustomer)(stripe, supabase, customer);
      const stripeInvoice = await stripe.invoices.create({
        customer: stripeCustomerId,
        collection_method: "send_invoice",
        days_until_due: 14,
        description: invoice.description || undefined,
        metadata: { customer_id: customer.id, invoice_id: invoice.id },
      }, { idempotencyKey: `saltbox-invoice-${invoice.id}` });

      await stripe.invoiceItems.create({
        customer: stripeCustomerId,
        invoice: stripeInvoice.id,
        amount: Math.round(amount * 100),
        currency: "usd",
        description: invoice.description || invoice.title || "Saltbox invoice",
        metadata: { customer_id: customer.id, invoice_id: invoice.id },
      }, { idempotencyKey: `saltbox-invoice-item-${invoice.id}` });

      const finalized = await stripe.invoices.finalizeInvoice(stripeInvoice.id, {}, {
        idempotencyKey: `saltbox-finalize-invoice-${invoice.id}`,
      });
      await (deps.persistInvoice || persistInvoice)(supabase, invoice.id, finalized);

      return json(200, { id: finalized.id, url: finalized.hosted_invoice_url });
    } catch (error) {
      return errorResponse(error, "Could not create the Stripe invoice.");
    }
  };
}

exports.createHandler = createHandler;
exports.ensureStripeCustomer = ensureStripeCustomer;
exports.handler = createHandler();
exports.loadInvoiceContext = loadInvoiceContext;
exports.persistInvoice = persistInvoice;
