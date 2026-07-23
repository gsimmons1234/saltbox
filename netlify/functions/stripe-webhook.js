const {
  HttpError,
  assertDatabaseResult,
  errorResponse,
  getStripe,
  getSupabase,
  json,
  requiredEnv,
} = require("./_shared");

function stripeId(value) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

function invoiceStatus(eventType) {
  return {
    "invoice.finalized": "Open",
    "invoice.paid": "Paid",
    "invoice.payment_failed": "Payment failed",
    "invoice.voided": "Void",
    "invoice.marked_uncollectible": "Uncollectible",
  }[eventType];
}

function subscriptionStatus(status, deleted = false) {
  if (deleted) return "Canceled";
  return {
    active: "Active",
    trialing: "Active",
    past_due: "Past due",
    canceled: "Canceled",
    unpaid: "Unpaid",
    incomplete: "Incomplete",
    incomplete_expired: "Canceled",
    paused: "Paused",
  }[status] || status || "Draft";
}

async function syncInvoice(supabase, eventType, invoice) {
  const invoiceId = invoice.metadata?.invoice_id;
  if (!invoiceId) return;
  assertDatabaseResult(await supabase
    .from("customer_invoices")
    .update({
      status: invoiceStatus(eventType),
      stripe_invoice_id: invoice.id,
      stripe_invoice_url: invoice.hosted_invoice_url || null,
      stripe_checkout_url: invoice.hosted_invoice_url || null,
    })
    .eq("id", invoiceId));
}

async function syncSubscription(supabase, subscription, deleted = false) {
  const localSubscriptionId = subscription.metadata?.subscription_id;
  const customerId = subscription.metadata?.customer_id;
  const values = {
    status: subscriptionStatus(subscription.status, deleted),
    stripe_subscription_id: subscription.id,
    stripe_customer_id: stripeId(subscription.customer),
    updated_at: new Date().toISOString(),
  };

  if (localSubscriptionId) {
    assertDatabaseResult(await supabase
      .from("subscriptions")
      .update(values)
      .eq("id", localSubscriptionId));
  } else if (customerId) {
    assertDatabaseResult(await supabase
      .from("subscriptions")
      .upsert({ ...values, customer_id: customerId }, { onConflict: "stripe_subscription_id" }));
  }
}

async function processEvent(supabase, event) {
  if (invoiceStatus(event.type)) {
    await syncInvoice(supabase, event.type, event.data.object);
    return;
  }

  if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    await syncSubscription(
      supabase,
      event.data.object,
      event.type === "customer.subscription.deleted",
    );
  }
}

function createHandler(deps = {}) {
  return async (event) => {
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });

    try {
      const stripe = deps.stripe || getStripe();
      const signature = event.headers?.["stripe-signature"] || event.headers?.["Stripe-Signature"];
      if (!signature) return json(400, { error: "Missing Stripe signature." });

      const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body || "", "base64").toString("utf8")
        : (event.body || "");
      let stripeEvent;
      try {
        stripeEvent = stripe.webhooks.constructEvent(
          rawBody,
          signature,
          deps.webhookSecret || requiredEnv("STRIPE_WEBHOOK_SECRET"),
        );
      } catch {
        throw new HttpError(400, "Invalid Stripe signature.");
      }

      const supabase = deps.supabase || getSupabase();
      await (deps.processEvent || processEvent)(supabase, stripeEvent);
      return json(200, { received: true });
    } catch (error) {
      return errorResponse(error, "Webhook processing failed.");
    }
  };
}

exports.createHandler = createHandler;
exports.handler = createHandler();
exports.invoiceStatus = invoiceStatus;
exports.processEvent = processEvent;
exports.stripeId = stripeId;
exports.subscriptionStatus = subscriptionStatus;
exports.syncInvoice = syncInvoice;
exports.syncSubscription = syncSubscription;
