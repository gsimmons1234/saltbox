const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function errorResponse(error, fallback = "Request failed.") {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  if (statusCode >= 500) console.error(error);
  return json(statusCode, { error: statusCode >= 500 ? fallback : error.message });
}

function parseJson(event) {
  try {
    return JSON.parse(event.body || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Add it in Netlify environment variables.`);
  return value;
}

function getSiteUrl() {
  const value = requiredEnv("SITE_URL");
  try {
    return new URL(value).origin;
  } catch {
    throw new Error("SITE_URL must be a valid absolute URL.");
  }
}

function getStripe() {
  const Stripe = require("stripe");
  return new Stripe(requiredEnv("STRIPE_SECRET_KEY"));
}

function getSupabase() {
  const { createClient } = require("@supabase/supabase-js");
  return createClient(
    requiredEnv("SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function bearerToken(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, "Sign in is required.");
  return match[1];
}

async function requireUser(event, supabase) {
  const token = bearerToken(event);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "Your session is invalid or expired.");
  return data.user;
}

async function requireAdmin(event, supabase) {
  const user = await requireUser(event, supabase);
  const { data, error } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(403, "Admin access is required.");
  return user;
}

async function requireCustomer(event, supabase) {
  const user = await requireUser(event, supabase);
  if (!user.email) throw new HttpError(403, "This login has no customer email.");
  const { data, error } = await supabase
    .from("customers")
    .select("id, name, email, business_name, stripe_customer_id")
    .eq("email", user.email)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(403, "No customer account is linked to this login.");
  return { user, customer: data };
}

function assertDatabaseResult(result) {
  if (result.error) throw result.error;
  return result.data;
}

module.exports = {
  HttpError,
  assertDatabaseResult,
  errorResponse,
  getSiteUrl,
  getStripe,
  getSupabase,
  headers,
  json,
  parseJson,
  requireAdmin,
  requireCustomer,
  requireUser,
  requiredEnv,
};
