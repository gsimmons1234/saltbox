import { supabase } from "./supabase-client.js";

// leadColumns intentionally reads the database-maintained normalized_*
// columns (normalized_email, normalized_phone, normalized_website_domain)
// rather than raw email/phone/website_url wherever identity matching
// matters — those three columns are computed by a Postgres trigger
// (leads_set_normalized_fields in supabase-lead-engine-schema.sql), never by
// this file. See the normalize* helpers below for why they still exist here.
export const leadColumns = [
  "id",
  "created_at",
  "updated_at",
  "business_name",
  "contact_name",
  "email",
  "phone",
  "normalized_email",
  "normalized_phone",
  "website_url",
  "normalized_website_domain",
  "has_website",
  "address",
  "city",
  "state",
  "postal_code",
  "country",
  "category",
  "discovery_method",
  "status",
  "fit_score",
  "fit_score_reasoning",
  "activity_confirmed",
  "activity_confirmed_notes",
  "normalized_business_key",
  "duplicate_of",
  "converted_customer_id",
  "primary_source_url",
  "rejected_reason",
  "assigned_to",
  "notes",
].join(", ");

export const leadSourceColumns = [
  "id",
  "lead_id",
  "created_at",
  "field_name",
  "field_value",
  "source_url",
  "source_type",
  "captured_at",
  "notes",
].join(", ");

export const activityLogColumns = [
  "id",
  "lead_id",
  "created_at",
  "actor",
  "action",
  "from_status",
  "to_status",
  "detail",
  "metadata",
].join(", ");

export const optOutColumns = [
  "id",
  "created_at",
  "email",
  "phone",
  "website_url",
  "normalized_email",
  "normalized_phone",
  "normalized_website_domain",
  "business_name",
  "reason",
  "source",
  "lead_id",
].join(", ");

// Full Phase 1-5 workflow enum in admin display order. Normal statuses can
// move directly to any other normal status; Opted Out and Duplicate still
// require their dedicated actions. This is a UI-convenience copy only — the
// database's public.lead_status_transitions() function (used by the
// leads_validate_status_transition trigger) is authoritative and enforces
// this same matrix regardless of what this file thinks is legal. Keep the
// two in sync by hand; a mismatch here only produces a confusing error from
// Postgres, it never allows an illegal transition to actually persist.
export const LEAD_STATUSES = [
  "Discovered",
  "Needs Review",
  "Approved for Mockup",
  "Mockup In Progress",
  "Draft Ready",
  "Approved to Send",
  "Contacted",
  "Follow-up Due",
  "Replied",
  "Rejected",
  "Opted Out",
  "Duplicate",
];

const NORMAL_LEAD_STATUSES = LEAD_STATUSES.slice(0, 10);

export const LEAD_TRANSITIONS = {
  ...Object.fromEntries(
    NORMAL_LEAD_STATUSES.map((status) => [
      status,
      [...NORMAL_LEAD_STATUSES.filter((candidate) => candidate !== status), "Opted Out", "Duplicate"],
    ])
  ),
  // Opted Out is terminal in Phase 1 — there is no reopen/suppression-lift
  // workflow. Must match public.lead_status_transitions()'s 'Opted Out'
  // case in supabase-lead-engine-schema.sql, which the database actually
  // enforces regardless of what this map says.
  "Opted Out": [],
  "Duplicate": [...NORMAL_LEAD_STATUSES],
};

// Statuses that require a dedicated RPC (opt_out_lead / mark_lead_duplicate)
// because they have side effects beyond a plain column update — these are
// filtered out of the generic "change status" dropdown so the UI can't even
// attempt a bare status update the database would reject anyway.
const STATUSES_REQUIRING_RPC = ["Opted Out", "Duplicate"];

export function allowedNextStatuses(currentStatus) {
  return LEAD_TRANSITIONS[currentStatus] || [];
}

export function allowedNextStatusesForDropdown(currentStatus) {
  return allowedNextStatuses(currentStatus).filter((status) => !STATUSES_REQUIRING_RPC.includes(status));
}

export function isValidTransition(fromStatus, toStatus) {
  return allowedNextStatuses(fromStatus).includes(toStatus);
}

export function leadStatusClass(status) {
  const value = String(status || "Discovered");
  if (["Rejected", "Opted Out", "Duplicate"].includes(value)) return "danger";
  if (["Contacted", "Replied"].includes(value)) return "won";
  if (["Approved for Mockup", "Mockup In Progress", "Draft Ready", "Approved to Send", "Follow-up Due"].includes(value)) return "progress";
  return "new";
}

// --- normalization helpers ---------------------------------------------
// These mirror public.normalize_email / public.normalize_phone /
// public.normalize_website_domain in supabase-lead-engine-schema.sql
// exactly, but they exist here ONLY to shape query filter values (e.g.
// `.eq("normalized_email", normalizeEmail(typedInput))`) so a duplicate or
// suppression search can match against the database's own normalized
// columns. They are never used to decide what gets stored — the database
// trigger is the only thing that writes normalized_email, normalized_phone,
// or normalized_website_domain.

export function normalizeEmail(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  return trimmed || null;
}

// US phone canonicalization: strip formatting; an 11-digit result starting
// with "1" drops the leading 1 down to the corresponding 10-digit form (so
// "(801) 555-1212" and "+1 801-555-1212" match); a 10-digit result is kept;
// blank or any other digit count becomes null. Must match
// public.normalize_phone() in supabase-lead-engine-schema.sql exactly.
export function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  return digits;
}

// Known hosted-profile platforms: path-based tenants under one shared host
// (facebook.com/business-a vs facebook.com/business-b are different
// businesses, not the same "domain"). Must match the list in
// public.normalize_website_domain() in supabase-lead-engine-schema.sql.
const HOSTED_PROFILE_HOSTS = new Set([
  "facebook.com", "m.facebook.com", "business.facebook.com",
  "instagram.com",
  "twitter.com", "x.com",
  "linkedin.com",
  "yelp.com", "biz.yelp.com",
  "nextdoor.com",
  "tiktok.com",
  "pinterest.com",
  "youtube.com",
  "thumbtack.com",
  "angi.com", "angieslist.com",
  "houzz.com",
  "bbb.org",
  "yellowpages.com",
  "foursquare.com",
  "tripadvisor.com",
  "maps.google.com",
  "business.google.com",
  "g.page", "g.co", "goo.gl",
]);

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeDomain(url) {
  let value = String(url || "").trim().toLowerCase();
  if (!value) return null;

  const rest = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const slashIndex = rest.indexOf("/");
  let host = slashIndex >= 0 ? rest.slice(0, slashIndex) : rest;
  const path = slashIndex >= 0 ? rest.slice(slashIndex) : "";

  host = host.split("?")[0].split("#")[0].split(":")[0].replace(/\.+$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  if (!host) return null;

  // reject malformed host syntax outright rather than returning garbage
  if (!HOSTNAME_PATTERN.test(host)) return null;

  if (HOSTED_PROFILE_HOSTS.has(host)) return null;

  // google.com/maps, google.com/local, etc. — path-based Maps/Business
  // profile URLs hosted on the bare google.com domain
  if (host === "google.com" && /^\/(maps|local|business)(\/|$|\?)/.test(path)) return null;

  return host;
}

export function normalizeBusinessKey(businessName, city) {
  const name = String(businessName || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!name) return null;
  const cityPart = String(city || "").trim().toLowerCase();
  return cityPart ? `${name}|${cityPart}` : name;
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Simple Jaccard word-overlap similarity, used only for non-blocking "possibly
// similar" duplicate warnings. Not a hard match — hard matches are exact
// normalized_email/normalized_phone/normalized_website_domain comparisons
// enforced by DB unique indexes.
function nameSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  setA.forEach((token) => {
    if (setB.has(token)) intersection += 1;
  });
  const union = new Set([...setA, ...setB]).size;
  return union ? intersection / union : 0;
}

// --- URL sanitization -----------------------------------------------------
// HTML-escaping (see html() in admin.js) makes a URL safe to display as
// text, but not safe to use as an <a href>: javascript:, data:, file:, and
// similar schemes are valid escaped text but dangerous as a clickable link.
// sanitizeUrl only ever returns an http:/https: URL, or null.

// Single source of truth for building a lead-detail link. Every place that
// navigates to the lead-detail route (row click, business-name link, "Open"
// link, post-create redirect, duplicate-result links) must go through this
// so the query parameter can never be dropped, renamed, or built
// inconsistently by hand in more than one place.
export function leadDetailUrl(id) {
  if (!id) {
    throw new Error("Cannot build lead detail URL without a lead id.");
  }

  return `lead-detail?id=${encodeURIComponent(id)}`;
}

export function sanitizeUrl(rawUrl) {
  if (!rawUrl) return null;
  let parsed;
  try {
    parsed = new URL(String(rawUrl).trim());
  } catch (error) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}

function buildLeadRecord(payload) {
  const websiteUrl = payload.website_url ? String(payload.website_url).trim() : null;
  return {
    business_name: String(payload.business_name || "").trim(),
    contact_name: payload.contact_name || null,
    email: payload.email ? String(payload.email).trim() : null,
    phone: payload.phone ? String(payload.phone).trim() : null,
    website_url: websiteUrl || null,
    address: payload.address || null,
    city: payload.city || null,
    state: payload.state || null,
    postal_code: payload.postal_code || null,
    country: payload.country || "US",
    category: payload.category || null,
    discovery_method: payload.discovery_method || "manual",
    status: payload.status || "Discovered",
    assigned_to: payload.assigned_to || null,
    notes: payload.notes || null,
    normalized_business_key: normalizeBusinessKey(payload.business_name, payload.city),
    primary_source_url: payload.primary_source_url || null,
  };
}

// --- lead CRUD ------------------------------------------------------------

export async function getLeads({ limit, status } = {}) {
  let query = supabase.from("leads").select(leadColumns).order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);
  if (limit) query = query.limit(limit);

  const { data, error } = await query;
  if (error) {
    console.error("Supabase leads select failed:", error);
    throw error;
  }
  return data || [];
}

export async function getLead(id) {
  const { data, error } = await supabase.from("leads").select(leadColumns).eq("id", id).single();
  if (error) {
    console.error("Supabase lead select failed:", error);
    throw error;
  }
  return data;
}

export async function getLeadsCount() {
  const { count, error } = await supabase.from("leads").select("id", { count: "exact", head: true });
  if (error) {
    console.error("Supabase leads count failed:", error);
    throw error;
  }
  return count || 0;
}

export async function getLeadsNeedingReviewCount() {
  const { count, error } = await supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("status", "Needs Review");

  if (error) {
    console.error("Supabase leads needs-review count failed:", error);
    throw error;
  }
  return count || 0;
}

export async function createLead(payload) {
  const record = buildLeadRecord(payload);
  const { data, error } = await supabase.from("leads").insert(record).select(leadColumns).single();
  if (error) {
    console.error("Supabase lead insert failed:", error);
    throw error;
  }
  return data;
}

// Generic update used by the overview and scoring panel-save handlers on
// lead-detail.html. Raw fields (email, phone, website_url) are passed
// through unchanged — normalized_email/normalized_phone/normalized_website_domain
// and has_website are recomputed by the leads_set_normalized_fields database
// trigger on every insert/update, not by this function. status,
// duplicate_of, and converted_customer_id are intentionally never accepted
// here: they are only ever changed through changeLeadStatus() (validated by
// the database trigger) or the mark_lead_duplicate / convert_lead_to_customer
// RPCs.
export async function updateLead(id, payload) {
  const values = { ...payload };
  delete values.status;
  delete values.duplicate_of;
  delete values.converted_customer_id;

  if ("business_name" in values && "city" in values) {
    values.normalized_business_key = normalizeBusinessKey(values.business_name, values.city);
  }

  const { data, error } = await supabase
    .from("leads")
    .update(values)
    .eq("id", id)
    .select(leadColumns)
    .single();

  if (error) {
    console.error("Supabase lead update failed:", error);
    throw error;
  }
  return data;
}

// Generic status transitions (everything except Opted Out and Duplicate,
// which require opt_out_lead()/mark_lead_duplicate()). Performs a fast
// client-side pre-check for a responsive UI, but the database's
// leads_validate_status_transition trigger is what actually enforces
// legality and is the only thing that matters for correctness. Activity
// logging happens automatically inside the database (leads_log_status_change
// trigger) — this function does not, and cannot, write to
// lead_activity_log directly.
export async function changeLeadStatus(lead, newStatus, { detail } = {}) {
  if (!isValidTransition(lead.status, newStatus)) {
    throw new Error(`Cannot move a lead from "${lead.status}" to "${newStatus}".`);
  }
  if (STATUSES_REQUIRING_RPC.includes(newStatus)) {
    throw new Error(`"${newStatus}" must be set through its dedicated action, not a direct status change.`);
  }

  const payload = { status: newStatus };
  if (newStatus === "Rejected" && detail) payload.rejected_reason = detail;

  const { data, error } = await supabase
    .from("leads")
    .update(payload)
    .eq("id", lead.id)
    .select(leadColumns)
    .single();

  if (error) {
    console.error("Supabase lead status update failed:", error);
    throw error;
  }
  return data;
}

// --- trusted RPCs -----------------------------------------------------------
// Every function below calls a SECURITY DEFINER Postgres RPC (see
// supabase-lead-engine-schema.sql) that verifies public.is_admin() itself,
// performs its work atomically, and writes its own trusted activity log
// entry. The browser never assembles these as separate update+insert calls.

export async function addLeadNote(leadId, note) {
  const { data, error } = await supabase.rpc("add_lead_note", { p_lead_id: leadId, p_note: note });
  if (error) {
    console.error("Supabase add_lead_note RPC failed:", error);
    throw error;
  }
  return data;
}

export async function optOutLead(leadId, reason, source = "manual_admin") {
  const { data, error } = await supabase.rpc("opt_out_lead", { p_lead_id: leadId, p_reason: reason, p_source: source });
  if (error) {
    console.error("Supabase opt_out_lead RPC failed:", error);
    throw error;
  }
  return data;
}

export async function markLeadDuplicate(leadId, duplicateOfId) {
  const { data, error } = await supabase.rpc("mark_lead_duplicate", { p_lead_id: leadId, p_duplicate_of_id: duplicateOfId });
  if (error) {
    console.error("Supabase mark_lead_duplicate RPC failed:", error);
    throw error;
  }
  return data;
}

// Returns { lead_id, customer_id, status } where status is one of
// "already_converted" | "existing_customer_matched" | "created".
export async function convertLeadToCustomer(leadId) {
  const { data, error } = await supabase.rpc("convert_lead_to_customer", { p_lead_id: leadId });
  if (error) {
    console.error("Supabase convert_lead_to_customer RPC failed:", error);
    throw error;
  }
  return data;
}

// --- lead sources -----------------------------------------------------------

export async function getLeadSources(leadId) {
  const { data, error } = await supabase
    .from("lead_sources")
    .select(leadSourceColumns)
    .eq("lead_id", leadId)
    .order("captured_at", { ascending: false });

  if (error) {
    console.error("Supabase lead_sources select failed:", error);
    throw error;
  }
  return data || [];
}

export async function addLeadSource(leadId, payload) {
  const record = {
    lead_id: leadId,
    field_name: payload.field_name,
    field_value: payload.field_value,
    source_url: payload.source_url,
    source_type: payload.source_type || "manual",
    notes: payload.notes || null,
  };

  const { data, error } = await supabase.from("lead_sources").insert(record).select(leadSourceColumns).single();
  if (error) {
    console.error("Supabase lead_sources insert failed:", error);
    throw error;
  }
  return data;
}

// --- activity log (read-only from the browser) --------------------------------

export async function getActivityLog(leadId) {
  const { data, error } = await supabase
    .from("lead_activity_log")
    .select(activityLogColumns)
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Supabase lead_activity_log select failed:", error);
    throw error;
  }
  return data || [];
}

// --- duplicate detection ------------------------------------------------------
// Hard matches: exact normalized_email / normalized_phone / normalized_website_domain
// — these are also enforced as partial unique DB indexes, this is the
// friendly pre-check in front of that real constraint.
// Fuzzy matches: word-overlap similarity on business name, boosted when the
// city also matches — advisory only, never blocks.

export async function findDuplicateLeads({ businessName, city, email, phone, websiteUrl, excludeId } = {}) {
  const normEmail = normalizeEmail(email);
  const normPhone = normalizePhone(phone);
  const normDomain = normalizeDomain(websiteUrl);

  const hardMatches = [];
  if (normEmail || normPhone || normDomain) {
    const filters = [];
    if (normDomain) filters.push(`normalized_website_domain.eq.${normDomain}`);
    if (normEmail) filters.push(`normalized_email.eq.${normEmail}`);
    if (normPhone) filters.push(`normalized_phone.eq.${normPhone}`);

    let query = supabase.from("leads").select(leadColumns).or(filters.join(","));
    if (excludeId) query = query.neq("id", excludeId);

    const { data, error } = await query;
    if (error) {
      console.error("Supabase duplicate hard-match query failed:", error);
      throw error;
    }

    (data || []).forEach((row) => {
      const reasons = [];
      if (normDomain && row.normalized_website_domain === normDomain) reasons.push("website domain");
      if (normEmail && row.normalized_email === normEmail) reasons.push("email");
      if (normPhone && row.normalized_phone === normPhone) reasons.push("phone");
      if (reasons.length) hardMatches.push({ lead: row, reasons });
    });
  }

  let fuzzyMatches = [];
  if (businessName) {
    let query = supabase.from("leads").select(leadColumns).order("created_at", { ascending: false }).limit(200);
    if (excludeId) query = query.neq("id", excludeId);

    const { data, error } = await query;
    if (error) {
      console.error("Supabase duplicate fuzzy-match query failed:", error);
      throw error;
    }

    fuzzyMatches = (data || [])
      .filter((row) => !hardMatches.some((match) => match.lead.id === row.id))
      .map((row) => {
        const cityBoost = city && row.city && city.trim().toLowerCase() === row.city.trim().toLowerCase() ? 1 : 0.85;
        return { lead: row, score: nameSimilarity(businessName, row.business_name) * cityBoost };
      })
      .filter((entry) => entry.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  return { hardMatches, fuzzyMatches };
}

// --- suppression / opt-out (read-only checks from the browser) ------------------

export async function findOptOutMatches({ email, phone, websiteUrl } = {}) {
  const normEmail = normalizeEmail(email);
  const normPhone = normalizePhone(phone);
  const normDomain = normalizeDomain(websiteUrl);
  if (!normEmail && !normPhone && !normDomain) return [];

  const filters = [];
  if (normDomain) filters.push(`normalized_website_domain.eq.${normDomain}`);
  if (normEmail) filters.push(`normalized_email.eq.${normEmail}`);
  if (normPhone) filters.push(`normalized_phone.eq.${normPhone}`);

  const { data, error } = await supabase.from("outreach_opt_outs").select(optOutColumns).or(filters.join(","));
  if (error) {
    console.error("Supabase outreach_opt_outs check failed:", error);
    throw error;
  }
  return data || [];
}

// --- AI research reports (Phase 2A, read-only from the browser except for
// the review_lead_asset_candidate RPC) --------------------------------------
// lead_research_reports / lead_research_sources / lead_asset_candidates are
// written only by netlify/functions/lead-research.js using the service-role
// key, after it independently verifies the caller's session and
// public.is_admin() itself (see supabase-lead-research-schema.sql for the
// RLS that enforces this — there is no browser INSERT/UPDATE policy on
// these tables at all). runLeadResearch() below only ever calls that
// function; it never talks to OpenAI directly and never sees an API key.

export const researchReportColumns = [
  "id",
  "lead_id",
  "created_at",
  "updated_at",
  "status",
  "is_mock",
  "error_message",
  "business_summary",
  "activity_evidence",
  "verified_details",
  "website_findings",
  "brand_cues",
  "recommended_customer_action",
  "personalization_detail",
  "missing_or_conflicting_information",
  "mockup_brief",
  "model_used",
  "requested_by_actor",
  "completed_at",
].join(", ");

export const researchSourceColumns = [
  "id",
  "report_id",
  "lead_id",
  "created_at",
  "source_url",
  "source_title",
  "source_type",
  "supports_fields",
  "notes",
].join(", ");

export const assetCandidateColumns = [
  "id",
  "report_id",
  "lead_id",
  "created_at",
  "asset_url",
  "source_page_url",
  "asset_type",
  "description",
  "ownership_context",
  "approved_for_mockup",
  "rejection_reason",
].join(", ");

// The most recent research report for a lead, or null if AI research has
// never been run. lead-detail.html always shows this one, not a history —
// older reports remain in the database (and in lead_activity_log) but
// Phase 2A's UI only surfaces the latest.
export async function getLatestResearchReport(leadId) {
  const { data, error } = await supabase
    .from("lead_research_reports")
    .select(researchReportColumns)
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Supabase lead_research_reports select failed:", error);
    throw error;
  }
  return data || null;
}

export async function getResearchSources(reportId) {
  if (!reportId) return [];
  const { data, error } = await supabase
    .from("lead_research_sources")
    .select(researchSourceColumns)
    .eq("report_id", reportId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Supabase lead_research_sources select failed:", error);
    throw error;
  }
  return data || [];
}

export async function getResearchAssetCandidates(reportId) {
  if (!reportId) return [];
  const { data, error } = await supabase
    .from("lead_asset_candidates")
    .select(assetCandidateColumns)
    .eq("report_id", reportId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Supabase lead_asset_candidates select failed:", error);
    throw error;
  }
  return data || [];
}

// The only browser write path onto lead_asset_candidates — narrowly scoped
// to approve/reject, enforced server-side by review_lead_asset_candidate()
// (SECURITY DEFINER) in supabase-lead-research-schema.sql.
export async function reviewAssetCandidate(assetId, approved, rejectionReason) {
  const { data, error } = await supabase.rpc("review_lead_asset_candidate", {
    p_asset_id: assetId,
    p_approved: approved,
    p_rejection_reason: rejectionReason || null,
  });
  if (error) {
    console.error("Supabase review_lead_asset_candidate RPC failed:", error);
    throw error;
  }
  return data;
}

// Calls the server-side Netlify Function that performs AI research — never
// OpenAI directly, and OPENAI_API_KEY never reaches this file or the
// browser. Runs whichever mode the server is explicitly configured for:
// real research when OPENAI_API_KEY is set, or a clearly-labeled mock
// fixture (is_mock: true on the saved report) only when the server operator
// has explicitly set LEAD_RESEARCH_MOCK_MODE=true. If neither is
// configured, the server returns a configuration error rather than
// silently generating fake research.
export async function runLeadResearch(leadId) {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData || !sessionData.session) {
    throw new Error("Your session has expired. Sign in again to run AI research.");
  }

  const response = await fetch("/.netlify/functions/lead-research", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionData.session.access_token}`,
    },
    body: JSON.stringify({ lead_id: leadId }),
  });

  let responsePayload = {};
  try {
    responsePayload = await response.json();
  } catch (error) {
    // Fall through to the generic status-based error below.
  }

  if (!response.ok) {
    throw new Error(responsePayload.error || `AI research failed (HTTP ${response.status}).`);
  }
  return responsePayload;
}
