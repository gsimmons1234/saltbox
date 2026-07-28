// Saltbox Lead Engine — Phase 2A: AI-generated business research reports.
//
// Called from lead-detail.html's "Run AI Research" button (via
// runLeadResearch() in leads.js). Given an existing lead's id, this
// researches that business and saves a source-backed report to
// lead_research_reports / lead_research_sources / lead_asset_candidates
// (see supabase-lead-research-schema.sql).
//
// Security model:
// - The caller's Supabase session is verified against Supabase Auth itself
//   (authedClient.auth.getUser(token)), not just decoded/trusted.
// - public.is_admin() is checked through that same authenticated client, so
//   it runs with the caller's own auth.uid() context — exactly the RLS path
//   the browser itself would get, not an assumption this function makes on
//   its own.
// - SUPABASE_SERVICE_ROLE_KEY and OPENAI_API_KEY are read only from
//   process.env, are never included in any HTTP response, and are never
//   logged — see "Error sanitization" below.
// - Request validation accepts nothing but a JSON object with exactly one
//   property, `lead_id` (a UUID) — no arrays, no extra fields, one lead per
//   request, and a byte-size cap on the body before it is even parsed.
// - Only POST is handled; every other method (including OPTIONS — this
//   function is only ever called same-origin, so no CORS preflight is ever
//   sent for it) gets a plain 405.
// - Duplicate concurrent runs are blocked by a database constraint (the
//   partial unique index in supabase-lead-research-schema.sql, enforced
//   through begin_lead_research_run()), not just an in-memory check here.
// - A report can never get stuck at status='running' forever: every call to
//   begin_lead_research_run() first repairs any of that lead's running
//   reports older than a 10-minute staleness threshold (see that function's
//   own comment in the SQL file for why a Netlify Function can be killed
//   before its own catch block runs).
// - Report completion is atomic: complete_lead_research_run() writes the
//   report content and both child-row tables in one Postgres function
//   invocation, so a completed report can never end up missing its sources
//   or asset candidates.
// - This function never sends email and never generates a mockup — both are
//   out of scope for Phase 2A. It never writes to any local filesystem path
//   — a deployed Netlify Function has no access to the operator's laptop,
//   so future generated assets belong in Supabase Storage or a later Google
//   Drive integration, never a local folder.
//
// Testing mode: real research (calling OpenAI) only ever runs when
// OPENAI_API_KEY is set. Mock-fixture research (buildMockResearchResult()
// below, zero network calls, zero cost) only ever runs when the server
// operator has explicitly set LEAD_RESEARCH_MOCK_MODE=true. If neither is
// true, this function refuses the request with a configuration error and
// creates no report row at all — there is no implicit/automatic fallback to
// mock data. See isMockModeEnabled() below.

const { createClient } = require("@supabase/supabase-js");
const net = require("net");

// Supabase's anon/publishable key is not a secret — it is already shipped
// to every browser in supabase-client.js and is safe to read here in
// view-source. It carries no elevated privileges on its own; RLS (plus the
// is_admin() check this function performs through it) is what actually
// governs what it can do. Keep this in sync with SUPABASE_ANON_KEY in
// supabase-client.js — it must be the same project's anon key.
const SUPABASE_ANON_KEY = "sb_publishable_MJ12CHcOzQTd_yRrIAt3tQ_AAKEmEJ9";

const headers = { "Content-Type": "application/json" };

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Comfortably larger than `{"lead_id":"<uuid>"}` (well under 100 bytes) —
// rejects anything absurdly oversized before it is even JSON.parse'd.
const MAX_BODY_BYTES = 2048;
const MAX_URL_LENGTH = 2048;

// --- fixed, safe error classifications -------------------------------------
// Every failure this function can produce is mapped to exactly one of these
// before it ever reaches a log line, the database, or the browser. None of
// these strings can ever contain a raw provider response, a request body,
// or a secret — see classify*() and ResearchError below.
const CLASS = Object.freeze({
  PROVIDER_AUTH_ERROR: "provider_auth_error",
  PROVIDER_RATE_LIMITED: "provider_rate_limited",
  PROVIDER_TIMEOUT: "provider_timeout",
  PROVIDER_INVALID_RESPONSE: "provider_invalid_response",
  PROVIDER_REFUSAL: "provider_refusal",
  PROVIDER_INCOMPLETE: "provider_incomplete",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  RESEARCH_VALIDATION_FAILED: "research_validation_failed",
  INTERNAL_ERROR: "internal_error",
});

const HTTP_STATUS_BY_CLASS = {
  [CLASS.PROVIDER_AUTH_ERROR]: 502,
  [CLASS.PROVIDER_RATE_LIMITED]: 429,
  [CLASS.PROVIDER_TIMEOUT]: 504,
  [CLASS.PROVIDER_INVALID_RESPONSE]: 502,
  [CLASS.PROVIDER_REFUSAL]: 502,
  [CLASS.PROVIDER_INCOMPLETE]: 502,
  [CLASS.PROVIDER_UNAVAILABLE]: 503,
  [CLASS.RESEARCH_VALIDATION_FAILED]: 502,
  [CLASS.INTERNAL_ERROR]: 500,
};

// Log-only marker for when the fail_lead_research_run() RPC call itself
// fails (distinct from the classifications above, which describe why
// research failed in the first place — this describes a failure to even
// *record* that). Never persisted anywhere; never returned to the browser.
const FAIL_RPC_LOG_MARKER = "fail_rpc_write_failed";

const FRIENDLY_MESSAGE_BY_CLASS = {
  [CLASS.PROVIDER_AUTH_ERROR]: "The AI research provider rejected the server's credentials. An administrator needs to check OPENAI_API_KEY.",
  [CLASS.PROVIDER_RATE_LIMITED]: "The AI research provider is rate-limiting requests right now. Try again shortly.",
  [CLASS.PROVIDER_TIMEOUT]: "The AI research request timed out. Try again.",
  [CLASS.PROVIDER_INVALID_RESPONSE]: "The AI research provider returned an unexpected response. Try again.",
  [CLASS.PROVIDER_REFUSAL]: "The AI research provider declined to research this business. Try again later or review it manually.",
  [CLASS.PROVIDER_INCOMPLETE]: "The AI research response was incomplete. Try again.",
  [CLASS.PROVIDER_UNAVAILABLE]: "The AI research provider is temporarily unavailable. Try again shortly.",
  [CLASS.RESEARCH_VALIDATION_FAILED]: "The AI research result did not pass validation, so nothing was saved. Try again.",
  [CLASS.INTERNAL_ERROR]: "Something went wrong while running research. Try again.",
};

// A classified failure. `message` is always a short, sanitized,
// developer-facing string safe to log and to store in
// lead_research_reports.error_message — callers must never construct one
// from a raw provider response body or request payload.
class ResearchError extends Error {
  constructor(classification, message) {
    super(message);
    this.name = "ResearchError";
    this.classification = classification;
  }
}

// Strict, case-insensitive, literal opt-in. Any value other than exactly
// "true" (case-insensitive) leaves mock mode off — "1", "yes", and even
// " true " (surrounding whitespace) do not count. Deliberately no
// `.trim()`: a value with stray whitespace is not the literal string
// "true" and must not be treated as if it were.
function isMockModeEnabled() {
  return String(process.env.LEAD_RESEARCH_MOCK_MODE || "").toLowerCase() === "true";
}

function hasOpenAiApiKey() {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
}

// --- shared URL safety ------------------------------------------------------
// Applied to every research source URL, every asset URL, and every asset
// source-page URL before it is ever considered for saving. Deliberately
// strict: HTTPS only (no http:, javascript:, data:, file:, or any other
// scheme), a real parseable hostname, a length cap, and no localhost/loop-
// back/private/link-local/reserved network targets.
//
// Built once, module-level: the fixed set of non-public IP ranges that must
// never be treated as a real citation or asset source — a URL pointing here
// would be probing the server's own network (or another host on it), not
// citing a public web page. Two separate net.BlockList instances (one per
// address family) rather than one shared instance for both: on this Node
// version, registering both IPv4 and IPv6 subnets on a single BlockList was
// observed to make its IPv4 checks incorrectly match unrelated public IPv4
// addresses (verified with a standalone test) once any IPv6 subnet was also
// registered — using one instance per family avoids that failure mode
// entirely and was verified correct for every range below, including the
// public/private boundary cases (e.g. 100.63.255.255 vs. 100.64.0.0/10,
// 100.127.255.255 vs. 100.128.0.0).
const PRIVATE_IPV4_BLOCKLIST = new net.BlockList();
PRIVATE_IPV4_BLOCKLIST.addSubnet("0.0.0.0", 8, "ipv4"); // "this network" / unspecified
PRIVATE_IPV4_BLOCKLIST.addSubnet("10.0.0.0", 8, "ipv4"); // private (RFC 1918)
PRIVATE_IPV4_BLOCKLIST.addSubnet("100.64.0.0", 10, "ipv4"); // carrier-grade NAT (RFC 6598)
PRIVATE_IPV4_BLOCKLIST.addSubnet("127.0.0.0", 8, "ipv4"); // loopback (all of 127.0.0.0/8)
PRIVATE_IPV4_BLOCKLIST.addSubnet("169.254.0.0", 16, "ipv4"); // link-local
PRIVATE_IPV4_BLOCKLIST.addSubnet("172.16.0.0", 12, "ipv4"); // private (RFC 1918)
PRIVATE_IPV4_BLOCKLIST.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
PRIVATE_IPV4_BLOCKLIST.addSubnet("192.0.2.0", 24, "ipv4"); // documentation (TEST-NET-1)
PRIVATE_IPV4_BLOCKLIST.addSubnet("192.168.0.0", 16, "ipv4"); // private (RFC 1918)
PRIVATE_IPV4_BLOCKLIST.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
PRIVATE_IPV4_BLOCKLIST.addSubnet("198.51.100.0", 24, "ipv4"); // documentation (TEST-NET-2)
PRIVATE_IPV4_BLOCKLIST.addSubnet("203.0.113.0", 24, "ipv4"); // documentation (TEST-NET-3)
PRIVATE_IPV4_BLOCKLIST.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
PRIVATE_IPV4_BLOCKLIST.addSubnet("240.0.0.0", 4, "ipv4"); // reserved, including 255.255.255.255

const PRIVATE_IPV6_BLOCKLIST = new net.BlockList();
PRIVATE_IPV6_BLOCKLIST.addSubnet("::", 128, "ipv6"); // unspecified
PRIVATE_IPV6_BLOCKLIST.addSubnet("::1", 128, "ipv6"); // loopback
PRIVATE_IPV6_BLOCKLIST.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64 well-known prefix (embeds an IPv4 host)
// IPv4-mapped IPv6 (::ffff:a.b.c.d) — rejected unconditionally, including a
// mapped *public* IPv4, rather than extracting and re-checking the embedded
// address: no legitimate HTTPS citation or image URL is ever written using
// this form, so treating the whole /96 as an ambiguous IP literal and
// failing closed is the safer choice.
PRIVATE_IPV6_BLOCKLIST.addSubnet("::ffff:0:0", 96, "ipv6");
PRIVATE_IPV6_BLOCKLIST.addSubnet("fc00::", 7, "ipv6"); // unique local / private
PRIVATE_IPV6_BLOCKLIST.addSubnet("fe80::", 10, "ipv6"); // link-local
PRIVATE_IPV6_BLOCKLIST.addSubnet("ff00::", 8, "ipv6"); // multicast

function isSafeHttpsUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl || rawUrl.length > MAX_URL_LENGTH) return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    return false;
  }
  if (parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;

  // URL.hostname keeps brackets around an IPv6 literal (e.g. "[::1]");
  // net.isIPv4/isIPv6 and BlockList.check() both expect the bare address.
  // A malformed bracket form (e.g. "[not-an-ip]", an unclosed "[::1")
  // either fails `new URL()` outright (caught above) or fails both
  // net.isIPv4/isIPv6 below, in which case it falls through and is treated
  // as an ordinary (almost certainly invalid) hostname rather than a
  // special-cased IP — never silently unwrapped into something unsafe.
  const isBracketedIPv6 = host.startsWith("[") && host.endsWith("]");
  const bareHost = isBracketedIPv6 ? host.slice(1, -1) : host;

  if (net.isIPv4(bareHost)) {
    return !PRIVATE_IPV4_BLOCKLIST.check(bareHost, "ipv4");
  }
  if (net.isIPv6(bareHost)) {
    return !PRIVATE_IPV6_BLOCKLIST.check(bareHost, "ipv6");
  }

  // Not a literal IP — an ordinary domain name. Nothing further to
  // range-check here; this validates the literal URL a source/asset
  // claims, not where its DNS name might resolve at fetch time.
  return true;
}

// Normalized form used only to compare a model-written source URL against
// the Responses API's own web-search citation URLs — never used as the
// value actually saved (the original, validated rawUrl is what's stored).
function normalizeUrlForComparison(rawUrl) {
  if (!isSafeHttpsUrl(rawUrl)) return null;
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    let normalized = parsed.toString();
    if (parsed.pathname === "/" && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch (error) {
    return null;
  }
}

// The exact shape the browser (lead-detail.html) renders and the shape both
// buildMockResearchResult() and the real OpenAI path must return.
// `sources` and `asset_candidates` are lifted out into their own tables by
// the handler; every other key maps 1:1 onto a lead_research_reports column.
const LEAD_RESEARCH_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    business_summary: { type: "string" },
    verified_details: {
      type: "object",
      additionalProperties: false,
      properties: {
        phone: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
        address: { type: ["string", "null"] },
        service_area: { type: ["string", "null"] },
        services: { type: "array", items: { type: "string" } },
        hours: { type: ["string", "null"] },
        hours_conflict: { type: ["string", "null"] },
      },
      required: ["phone", "email", "address", "service_area", "services", "hours", "hours_conflict"],
    },
    website_findings: {
      type: "object",
      additionalProperties: false,
      properties: {
        presence_type: { type: "string", enum: ["dedicated_website", "social_only", "no_website_found"] },
        website_url: { type: ["string", "null"] },
        observations: { type: "array", items: { type: "string" } },
        homepage_opportunities: { type: "array", items: { type: "string" } },
      },
      required: ["presence_type", "website_url", "observations", "homepage_opportunities"],
    },
    activity_evidence: {
      type: "object",
      additionalProperties: false,
      properties: {
        appears_active: { type: "boolean" },
        signals: { type: "array", items: { type: "string" } },
      },
      required: ["appears_active", "signals"],
    },
    brand_cues: {
      type: "object",
      additionalProperties: false,
      properties: {
        personality: { type: "array", items: { type: "string" } },
        colors: { type: "array", items: { type: "string" } },
        notes: { type: ["string", "null"] },
      },
      required: ["personality", "colors", "notes"],
    },
    recommended_customer_action: { type: "string" },
    personalization_detail: { type: "string" },
    missing_or_conflicting_information: { type: "array", items: { type: "string" } },
    mockup_brief: {
      type: "object",
      additionalProperties: false,
      properties: {
        concept_direction: { type: "string" },
        key_sections: { type: "array", items: { type: "string" } },
        tone: { type: "string" },
        must_avoid: { type: "array", items: { type: "string" } },
      },
      required: ["concept_direction", "key_sections", "tone", "must_avoid"],
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          source_url: { type: "string" },
          source_title: { type: ["string", "null"] },
          source_type: {
            type: "string",
            enum: ["business_website", "social_profile", "directory_listing", "review_platform", "maps_listing", "news_or_press", "other"],
          },
          supports_fields: { type: "array", items: { type: "string" } },
          notes: { type: ["string", "null"] },
        },
        required: ["source_url", "source_title", "source_type", "supports_fields", "notes"],
      },
    },
    asset_candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          asset_url: { type: "string" },
          source_page_url: { type: "string" },
          asset_type: {
            type: "string",
            enum: ["storefront_photo", "interior_photo", "service_photo", "logo", "staff_photo", "menu_or_pricing_board", "other"],
          },
          description: { type: ["string", "null"] },
          ownership_context: { type: ["string", "null"] },
        },
        required: ["asset_url", "source_page_url", "asset_type", "description", "ownership_context"],
      },
    },
  },
  required: [
    "business_summary", "verified_details", "website_findings", "activity_evidence",
    "brand_cues", "recommended_customer_action", "personalization_detail",
    "missing_or_conflicting_information", "mockup_brief", "sources", "asset_candidates",
  ],
};

const SOURCE_TYPES = LEAD_RESEARCH_JSON_SCHEMA.properties.sources.items.properties.source_type.enum;
const ASSET_TYPES = LEAD_RESEARCH_JSON_SCHEMA.properties.asset_candidates.items.properties.asset_type.enum;

// The fixed vocabulary a source's `supports_fields` entries must be drawn
// from — both a structural constraint (an unrecognized token fails
// validation outright, see validateAndBuildResearchResult()) and the same
// vocabulary used to require fact-specific citation coverage below. Maps
// 1:1 onto the verified-fact categories called out for Phase 2A: business
// identity/name, address/location, phone, email, hours, services, website
// presence, and activity evidence. This is a real-OpenAI-path-only concept
// — the mock fixture's supports_fields values are descriptive fixture text
// and are never validated against this list (buildMockResearchResult()'s
// output bypasses validateAndBuildResearchResult() entirely).
const FACT_FIELD_TOKENS = Object.freeze([
  "business_name", "address", "phone", "email", "hours", "services", "website_presence", "activity_evidence",
]);

// --- mock-fixture research (explicit opt-in only; see isMockModeEnabled) --
// Every fabricated (non-lead-record) claim below is prefixed "[TEST
// FIXTURE]" so it can never be mistaken for a real research finding in the
// UI. Real lead fields (name/address/phone/website on file) are reflected
// as-is since those are already-known facts about the lead, not something
// this mock is claiming to have discovered. Image URLs point at
// example.com placeholders rather than any real scraped image. This output
// deliberately bypasses validateAndBuildResearchResult()'s citation
// cross-checking below — it isn't model output, it's a static fixture, so
// there is nothing to cross-check it against.
function buildMockResearchResult(lead) {
  const cityState = [lead.city, lead.state].filter(Boolean).join(", ") || "Layton, UT";

  return {
    model_used: "mock-fixture-v1",
    business_summary:
      `${lead.business_name} is a nail salon in ${cityState} offering gel and dip powder manicures, ` +
      `nail art, and pedicure services. [TEST FIXTURE] The rest of this report is fictional fixture ` +
      `data generated for UI testing — no live web research was performed and no OpenAI API call was made.`,
    verified_details: {
      phone: lead.phone || null,
      email: lead.email || null,
      address: lead.address || null,
      service_area: `[TEST FIXTURE] ${cityState} and nearby communities`,
      services: ["Gel nails", "Gel nail extensions", "Dip powder nails", "Nail art", "Pedicures", "Spa pedicures"],
      hours: null,
      hours_conflict:
        "[TEST FIXTURE] Public listings disagree on Saturday hours — one directory lists 9am-6pm, " +
        "another lists 9am-7pm. Call to confirm current hours.",
    },
    website_findings: {
      presence_type: lead.website_url ? "dedicated_website" : "social_only",
      website_url: lead.website_url || null,
      observations: [
        "[TEST FIXTURE] No dedicated business website found in mock search — presence appears limited " +
          "to a social profile and directory listings.",
        "[TEST FIXTURE] Service names are listed inconsistently across the directory listings found.",
      ],
      homepage_opportunities: [
        "[TEST FIXTURE] A dedicated homepage could consolidate the service list, current promotions, " +
          "and a single call-to-book phone number that today is scattered across three directory listings.",
        "[TEST FIXTURE] No current listing highlights nail art specialty work, despite photo evidence " +
          "suggesting it is a strength.",
      ],
    },
    activity_evidence: {
      appears_active: true,
      signals: [
        "[TEST FIXTURE] Simulated Google Business Profile shows a review posted within the last 30 days.",
        "[TEST FIXTURE] Simulated social profile shows seasonal nail art photos posted within the last month.",
      ],
    },
    brand_cues: {
      personality: ["[TEST FIXTURE] warm", "[TEST FIXTURE] detail-oriented", "[TEST FIXTURE] locally established"],
      colors: ["[TEST FIXTURE] soft blush", "[TEST FIXTURE] muted mauve", "[TEST FIXTURE] warm ivory"],
      notes: "[TEST FIXTURE] This color palette is inferred from mock photo fixtures, not real brand assets.",
    },
    recommended_customer_action: "Call to book an appointment - no online booking presence was found.",
    personalization_detail:
      "[TEST FIXTURE] Recent nail art photos in the mock profile feature a seasonal floral design - a " +
      "genuine, specific detail an outreach draft could reference once real research replaces this fixture.",
    missing_or_conflicting_information: [
      "[TEST FIXTURE] Exact current hours are not confirmed - sources conflict.",
      "[TEST FIXTURE] No confirmed public email address was found.",
      "This entire report is mock fixture data generated for UI testing. No live web research was " +
        "performed and no OpenAI API call was made.",
    ],
    mockup_brief: {
      concept_direction:
        "[TEST FIXTURE] Elevated, editorial nail-salon homepage in warm ivory and muted mauve, leading " +
        "with a strong call-to-book CTA given the lack of an online booking presence.",
      key_sections: ["Hero with call-to-book CTA", "Services", "Gallery", "Visit/location"],
      tone: "Polished, warm, locally established - not childish or corporate.",
      must_avoid: ["Inventing pricing", "Inventing staff names", "Copying real photos without a clear ownership context"],
    },
    sources: [
      {
        source_url: "https://example.com/fixture/google-business-profile",
        source_title: "[TEST FIXTURE] Google Business Profile listing",
        source_type: "maps_listing",
        supports_fields: ["phone", "address", "hours"],
        notes: "Mock fixture - not a real source.",
      },
      {
        source_url: "https://example.com/fixture/directory-listing",
        source_title: "[TEST FIXTURE] Local directory listing",
        source_type: "directory_listing",
        supports_fields: ["services", "hours"],
        notes: "Mock fixture - not a real source.",
      },
      {
        source_url: "https://example.com/fixture/social-profile",
        source_title: "[TEST FIXTURE] Social profile",
        source_type: "social_profile",
        supports_fields: ["activity_evidence", "brand_cues"],
        notes: "Mock fixture - not a real source.",
      },
    ],
    asset_candidates: [
      {
        asset_url: "https://example.com/fixture/storefront.jpg",
        source_page_url: "https://example.com/fixture/google-business-profile",
        asset_type: "storefront_photo",
        description: "[TEST FIXTURE] Placeholder storefront photo for UI testing.",
        ownership_context: "[TEST FIXTURE] Simulated Google Business Profile photo - not a real image.",
      },
      {
        asset_url: "https://example.com/fixture/nail-art.jpg",
        source_page_url: "https://example.com/fixture/social-profile",
        asset_type: "service_photo",
        description: "[TEST FIXTURE] Placeholder seasonal nail art photo for UI testing.",
        ownership_context: "[TEST FIXTURE] Simulated social profile upload - not a real image.",
      },
    ],
  };
}

// --- real research via the OpenAI Responses API + web search --------------
// NOTE: this path has never been exercised against the live OpenAI API in
// this environment (no OPENAI_API_KEY is configured here, and the testing
// instructions for this phase explicitly forbid calling a paid API). The
// endpoint, `tools: [{ type: "web_search" }]`, `text.format` structured
// -output shape, and the citation/annotation shape extractCitationUrls()
// below expects all reflect the Responses API's documented contract as of
// this writing — confirm against current OpenAI docs and do a small live
// test before flipping this on for real traffic. Because
// validateAndBuildResearchResult() fails closed (rejects everything if
// citations aren't found in the expected shape), a shape mismatch here
// produces a loud research_validation_failed error rather than silently
// accepting unverified model-written URLs as "sources" — see that
// function's own comment.
async function runOpenAiResearch(lead) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_RESEARCH_MODEL || "gpt-4.1";

  const instructions = `You are a factual business research assistant for Saltbox, a web design agency that builds websites for small local businesses. Research the business described below using web search and produce ONLY verifiable, source-backed information about it.

Rules:
- Never invent pricing, staff names, owner history, business age, awards, certifications, or guarantees.
- Never quote or paraphrase customer reviews anywhere in your output.
- If hours conflict across sources, leave "hours" null and explain the conflict in "hours_conflict" instead of guessing.
- Every factual claim must be traceable to a URL you include in "sources", and that URL must be one of your actual web-search results, never a guessed or remembered URL.
- Clearly separate verified facts from your own observations/inferences (this is what "business_summary" vs. the rest of the report is for).
- Only include a candidate image in "asset_candidates" if you can point to the specific page you found it on.

Business as recorded by the sales team (verify, correct, and expand using web search):
Name: ${lead.business_name}
Address: ${[lead.address, lead.city, lead.state, lead.postal_code].filter(Boolean).join(", ") || "unknown"}
Phone: ${lead.phone || "unknown"}
Website on file: ${lead.website_url || "none on file"}
Category: ${lead.category || "unknown"}

Return a single JSON object matching the given schema. No prose outside the JSON.`;

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: instructions,
        tools: [{ type: "web_search" }],
        text: {
          format: {
            type: "json_schema",
            name: "lead_research_report",
            schema: LEAD_RESEARCH_JSON_SCHEMA,
            strict: true,
          },
        },
      }),
      // Node 18+ (Netlify's runtime). Comfortably inside a typical
      // synchronous Netlify Function ceiling; an abort here is classified
      // as PROVIDER_TIMEOUT rather than surfacing as an unhandled rejection.
      signal: AbortSignal.timeout(25000),
    });
  } catch (error) {
    if (error && error.name === "TimeoutError") {
      throw new ResearchError(CLASS.PROVIDER_TIMEOUT, "OpenAI research request timed out before responding.");
    }
    throw new ResearchError(CLASS.PROVIDER_UNAVAILABLE, "OpenAI research request could not be sent.");
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ResearchError(CLASS.PROVIDER_AUTH_ERROR, `OpenAI rejected the request credentials (HTTP ${response.status}).`);
    }
    if (response.status === 429) {
      throw new ResearchError(CLASS.PROVIDER_RATE_LIMITED, "OpenAI rate-limited the research request.");
    }
    if (response.status >= 500) {
      throw new ResearchError(CLASS.PROVIDER_UNAVAILABLE, `OpenAI research request failed (HTTP ${response.status}).`);
    }
    // Deliberately never includes the response body — see "Error
    // sanitization" in the module header comment.
    throw new ResearchError(CLASS.PROVIDER_INVALID_RESPONSE, `OpenAI research request failed (HTTP ${response.status}).`);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new ResearchError(CLASS.PROVIDER_INVALID_RESPONSE, "OpenAI response body was not valid JSON.");
  }

  if (data && data.status === "incomplete") {
    throw new ResearchError(CLASS.PROVIDER_INCOMPLETE, "OpenAI research response was marked incomplete by the API.");
  }
  if (data && data.status === "failed") {
    throw new ResearchError(CLASS.PROVIDER_INVALID_RESPONSE, "OpenAI research response reported a failed status.");
  }
  if (responseContainsRefusal(data)) {
    throw new ResearchError(CLASS.PROVIDER_REFUSAL, "OpenAI declined to produce a research result for this business.");
  }

  const outputText = extractResponsesOutputText(data);
  if (!outputText) {
    throw new ResearchError(CLASS.PROVIDER_INVALID_RESPONSE, "OpenAI research response did not include structured output text.");
  }

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    throw new ResearchError(CLASS.PROVIDER_INVALID_RESPONSE, "OpenAI research response text was not valid JSON.");
  }

  return validateAndBuildResearchResult(parsed, data, model);
}

function responseContainsRefusal(data) {
  const items = Array.isArray(data && data.output) ? data.output : [];
  for (const item of items) {
    const content = Array.isArray(item && item.content) ? item.content : [];
    for (const part of content) {
      if (part && part.type === "refusal") return true;
    }
  }
  return false;
}

function extractResponsesOutputText(data) {
  if (data && typeof data.output_text === "string" && data.output_text) return data.output_text;
  const items = Array.isArray(data && data.output) ? data.output : [];
  for (const item of items) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (typeof part.text === "string" && part.text) return part.text;
    }
  }
  return "";
}

// Walks every content part of every output item looking specifically for
// `url_citation`-type annotations (the Responses API's web-search citation
// shape) and returns the set of citation URLs, normalized for comparison.
// An annotation that merely happens to carry a `url` property but isn't
// `type === "url_citation"` (e.g. a future/unrelated annotation type) is
// never treated as a verified web-search citation — only the exact type
// tag counts. If the live response shape ever differs from what's expected
// here, this simply returns an empty set — which, by design, causes every
// model-claimed source below to be rejected (fail closed, never fail open
// into trusting an unverified URL).
function extractCitationUrls(data) {
  const urls = new Set();
  const items = Array.isArray(data && data.output) ? data.output : [];
  for (const item of items) {
    const content = Array.isArray(item && item.content) ? item.content : [];
    for (const part of content) {
      const annotations = Array.isArray(part && part.annotations) ? part.annotations : [];
      for (const annotation of annotations) {
        if (!annotation || annotation.type !== "url_citation") continue;
        const rawUrl = typeof annotation.url === "string" ? annotation.url : null;
        const normalized = rawUrl ? normalizeUrlForComparison(rawUrl) : null;
        if (normalized) urls.add(normalized);
      }
    }
  }
  return urls;
}

// --- strict structural + type validation, then citation cross-checking ----
// Nothing here silently coerces a missing/malformed field into an empty
// string, an empty array, `false`, or a stock fallback claim — every
// structural problem throws a RESEARCH_VALIDATION_FAILED ResearchError
// instead. This is the last line of defense before anything reaches the
// database, even though the OpenAI request above already asks for
// `strict: true` structured output — an API contract is not a guarantee.
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((item) => typeof item === "string");
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const isNullableString = (v) => v === null || typeof v === "string";

function validateAndBuildResearchResult(parsed, rawResponseData, requestedModel) {
  const F = CLASS.RESEARCH_VALIDATION_FAILED;
  const fail = (message) => {
    throw new ResearchError(F, message);
  };

  if (!isPlainObject(parsed)) fail("Research output was not a JSON object.");

  const REQUIRED_TOP_KEYS = [
    "business_summary", "verified_details", "website_findings", "activity_evidence",
    "brand_cues", "recommended_customer_action", "personalization_detail",
    "missing_or_conflicting_information", "mockup_brief", "sources", "asset_candidates",
  ];
  for (const key of REQUIRED_TOP_KEYS) {
    if (!(key in parsed)) fail(`Research output is missing required field "${key}".`);
  }

  if (!isNonEmptyString(parsed.business_summary)) fail("business_summary must be a non-empty string.");
  if (!isNonEmptyString(parsed.recommended_customer_action)) fail("recommended_customer_action must be a non-empty string.");
  if (typeof parsed.personalization_detail !== "string") fail("personalization_detail must be a string.");
  if (!isStringArray(parsed.missing_or_conflicting_information)) fail("missing_or_conflicting_information must be an array of strings.");

  const vd = parsed.verified_details;
  if (!isPlainObject(vd)) fail("verified_details must be an object.");
  for (const key of ["phone", "email", "address", "service_area", "hours", "hours_conflict"]) {
    if (!isNullableString(vd[key])) fail(`verified_details.${key} must be a string or null.`);
  }
  if (!isStringArray(vd.services)) fail("verified_details.services must be an array of strings.");

  const wf = parsed.website_findings;
  if (!isPlainObject(wf)) fail("website_findings must be an object.");
  if (!["dedicated_website", "social_only", "no_website_found"].includes(wf.presence_type)) {
    fail("website_findings.presence_type must be a recognized value.");
  }
  if (!isNullableString(wf.website_url)) fail("website_findings.website_url must be a string or null.");
  if (!isStringArray(wf.observations)) fail("website_findings.observations must be an array of strings.");
  if (!isStringArray(wf.homepage_opportunities)) fail("website_findings.homepage_opportunities must be an array of strings.");

  const ae = parsed.activity_evidence;
  if (!isPlainObject(ae)) fail("activity_evidence must be an object.");
  if (typeof ae.appears_active !== "boolean") fail("activity_evidence.appears_active must be a boolean.");
  if (!isStringArray(ae.signals)) fail("activity_evidence.signals must be an array of strings.");

  const bc = parsed.brand_cues;
  if (!isPlainObject(bc)) fail("brand_cues must be an object.");
  if (!isStringArray(bc.personality)) fail("brand_cues.personality must be an array of strings.");
  if (!isStringArray(bc.colors)) fail("brand_cues.colors must be an array of strings.");
  if (!isNullableString(bc.notes)) fail("brand_cues.notes must be a string or null.");

  const mb = parsed.mockup_brief;
  if (!isPlainObject(mb)) fail("mockup_brief must be an object.");
  if (!isNonEmptyString(mb.concept_direction)) fail("mockup_brief.concept_direction must be a non-empty string.");
  if (!isNonEmptyString(mb.tone)) fail("mockup_brief.tone must be a non-empty string.");
  if (!isStringArray(mb.key_sections)) fail("mockup_brief.key_sections must be an array of strings.");
  if (!isStringArray(mb.must_avoid)) fail("mockup_brief.must_avoid must be an array of strings.");

  if (!Array.isArray(parsed.sources)) fail("sources must be an array.");
  if (!Array.isArray(parsed.asset_candidates)) fail("asset_candidates must be an array.");

  // --- sources: full structural validation first. A malformed source entry
  // is not silently dropped or repaired — it fails the entire run, exactly
  // like every other structural problem above. Only after every entry has
  // been confirmed structurally valid does URL-safety/citation filtering
  // (which legitimately excludes individual entries without failing the
  // whole run) ever run. ---
  const structurallyValidSources = parsed.sources.map((rawSource, index) => {
    if (!isPlainObject(rawSource)) fail(`sources[${index}] must be an object.`);
    if (typeof rawSource.source_url !== "string") fail(`sources[${index}].source_url must be a string.`);
    if (!isNullableString(rawSource.source_title)) fail(`sources[${index}].source_title must be a string or null.`);
    if (typeof rawSource.source_type !== "string" || !SOURCE_TYPES.includes(rawSource.source_type)) {
      fail(`sources[${index}].source_type must be one of the approved source types.`);
    }
    if (!isStringArray(rawSource.supports_fields) || !rawSource.supports_fields.every((f) => FACT_FIELD_TOKENS.includes(f))) {
      fail(`sources[${index}].supports_fields must be an array containing only approved field names.`);
    }
    if (!isNullableString(rawSource.notes)) fail(`sources[${index}].notes must be a string or null.`);

    return {
      source_url: rawSource.source_url,
      source_title: rawSource.source_title,
      source_type: rawSource.source_type,
      supports_fields: rawSource.supports_fields,
      notes: rawSource.notes,
    };
  });

  // --- now that every source is structurally valid, a source may still be
  // excluded (not a run failure by itself) if its URL is unsafe or it does
  // not correlate to an actual web-search citation/annotation from this
  // same response. ---
  const citationUrls = extractCitationUrls(rawResponseData);
  const seenSourceUrls = new Set();
  const validSources = [];
  for (const source of structurallyValidSources) {
    if (!isSafeHttpsUrl(source.source_url)) continue;
    const normalized = normalizeUrlForComparison(source.source_url);
    if (!normalized || !citationUrls.has(normalized)) continue;
    if (seenSourceUrls.has(normalized)) continue;
    seenSourceUrls.add(normalized);
    validSources.push(source);
  }

  // --- fact-specific citation coverage: report-wide coverage is not
  // enough. For every verified field the report actually populated, at
  // least one surviving, citation-backed source must explicitly list that
  // field in its own supports_fields — a source that supports only
  // "phone" can never validate a separately-claimed address. Business
  // identity and website-presence are always in scope (business_summary
  // and website_findings.presence_type are both always-required, non-empty
  // fields); the rest only gate when the report actually populated them.
  // Free-form AI observations, recommendations, gaps, and the creative
  // brief are never subject to this — only verified_details/
  // website_findings/activity_evidence facts are. ---
  const hasSupportFor = (token) => validSources.some((source) => source.supports_fields.includes(token));
  const FACT_COVERAGE_CHECKS = [
    { token: "business_name", populated: true },
    { token: "address", populated: Boolean(vd.address) || Boolean(vd.service_area) },
    { token: "phone", populated: Boolean(vd.phone) },
    { token: "email", populated: Boolean(vd.email) },
    { token: "hours", populated: Boolean(vd.hours) },
    { token: "services", populated: vd.services.length > 0 },
    { token: "website_presence", populated: true },
    { token: "activity_evidence", populated: ae.appears_active === true || ae.signals.length > 0 },
  ];
  for (const { token, populated } of FACT_COVERAGE_CHECKS) {
    if (populated && !hasSupportFor(token)) {
      fail(`Verified field "${token}" has no citation-backed source whose supports_fields includes "${token}".`);
    }
  }

  // --- asset candidates: same "structural validation first" shape as
  // sources above. A malformed entry fails the whole run; only a
  // structurally valid entry may then be excluded (not a run failure) for
  // an unsafe URL. No citation requirement — these are for admin review,
  // never treated as verified facts, and approved_for_mockup always starts
  // false (the DB column default; never set here). ---
  const structurallyValidAssets = parsed.asset_candidates.map((rawAsset, index) => {
    if (!isPlainObject(rawAsset)) fail(`asset_candidates[${index}] must be an object.`);
    if (typeof rawAsset.asset_url !== "string") fail(`asset_candidates[${index}].asset_url must be a string.`);
    if (typeof rawAsset.source_page_url !== "string") fail(`asset_candidates[${index}].source_page_url must be a string.`);
    if (typeof rawAsset.asset_type !== "string" || !ASSET_TYPES.includes(rawAsset.asset_type)) {
      fail(`asset_candidates[${index}].asset_type must be one of the approved asset types.`);
    }
    if (!isNullableString(rawAsset.description)) fail(`asset_candidates[${index}].description must be a string or null.`);
    if (!isNullableString(rawAsset.ownership_context)) fail(`asset_candidates[${index}].ownership_context must be a string or null.`);

    return {
      asset_url: rawAsset.asset_url,
      source_page_url: rawAsset.source_page_url,
      asset_type: rawAsset.asset_type,
      description: rawAsset.description,
      ownership_context: rawAsset.ownership_context,
    };
  });

  const validAssets = structurallyValidAssets.filter(
    (asset) => isSafeHttpsUrl(asset.asset_url) && isSafeHttpsUrl(asset.source_page_url)
  );

  // The model actually served may differ from the one requested (aliasing,
  // e.g. a dated snapshot). Prefer what the API says it used; the requested
  // name is only a fallback if the response doesn't say.
  const actualModel = (rawResponseData && typeof rawResponseData.model === "string" && rawResponseData.model) || requestedModel;

  return {
    model_used: actualModel,
    business_summary: parsed.business_summary,
    verified_details: {
      phone: vd.phone, email: vd.email, address: vd.address, service_area: vd.service_area,
      services: vd.services, hours: vd.hours, hours_conflict: vd.hours_conflict,
    },
    website_findings: {
      presence_type: wf.presence_type, website_url: wf.website_url,
      observations: wf.observations, homepage_opportunities: wf.homepage_opportunities,
    },
    activity_evidence: { appears_active: ae.appears_active, signals: ae.signals },
    brand_cues: { personality: bc.personality, colors: bc.colors, notes: bc.notes },
    recommended_customer_action: parsed.recommended_customer_action,
    personalization_detail: parsed.personalization_detail,
    missing_or_conflicting_information: parsed.missing_or_conflicting_information,
    mockup_brief: { concept_direction: mb.concept_direction, key_sections: mb.key_sections, tone: mb.tone, must_avoid: mb.must_avoid },
    sources: validSources,
    asset_candidates: validAssets,
  };
}

exports.handler = async (event) => {
  // Only POST is handled. lead-detail.html only ever calls this same-origin
  // (a relative URL), which never triggers a CORS preflight OPTIONS request
  // regardless of headers sent — so there is nothing for this function to
  // legitimately do with OPTIONS, and it is not special-cased.
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return json(500, { error: "Server is not configured. Missing Supabase environment variables." });
  }

  // --- strict request validation, before body.lead_id is ever touched ----
  const rawBody = event.body || "";
  const bodyByteLength = Buffer.byteLength(rawBody, event.isBase64Encoded ? "base64" : "utf8");
  if (bodyByteLength > MAX_BODY_BYTES) {
    return json(400, { error: "Request body is too large." });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch (error) {
    return json(400, { error: "Invalid JSON body." });
  }

  if (!isPlainObject(payload)) {
    return json(400, { error: "Request body must be a JSON object." });
  }

  const payloadKeys = Object.keys(payload);
  if (payloadKeys.length !== 1 || payloadKeys[0] !== "lead_id") {
    return json(400, { error: "Request body must contain exactly one property: lead_id." });
  }

  const leadId = typeof payload.lead_id === "string" ? payload.lead_id.trim() : "";
  if (!UUID_RE.test(leadId)) {
    return json(400, { error: "A valid lead_id (UUID) is required." });
  }

  // --- verify the caller's Supabase session, then verify is_admin() through
  // that same authenticated context (not assumed, not decoded locally) ----
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    return json(401, { error: "Missing bearer token." });
  }

  const authedClient = createClient(supabaseUrl, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await authedClient.auth.getUser(token);
  if (userError || !userData || !userData.user) {
    console.error("lead-research: session verification failed", { lead_id: leadId });
    return json(401, { error: "Invalid or expired session." });
  }

  const { data: isAdmin, error: isAdminError } = await authedClient.rpc("is_admin");
  if (isAdminError || !isAdmin) {
    console.error("lead-research: caller is not an admin", { lead_id: leadId });
    return json(403, { error: "Not authorized." });
  }

  const actorLabel = userData.user.email || userData.user.id;

  // --- service-role client for the actual privileged reads/writes --------
  const service = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: lead, error: leadError } = await service
    .from("leads")
    .select("id, business_name, contact_name, email, phone, website_url, address, city, state, postal_code, country, category")
    .eq("id", leadId)
    .maybeSingle();

  if (leadError) {
    console.error("lead-research: could not load lead", { lead_id: leadId });
    return json(500, { error: "Could not load the lead." });
  }
  if (!lead) {
    return json(404, { error: "Lead not found." });
  }

  // --- decide research mode BEFORE creating any report row. Missing key +
  // mock mode not explicitly enabled is a hard configuration error, not a
  // silent fallback: no report is created, nothing is saved. ---
  const useMock = isMockModeEnabled();
  if (!useMock && !hasOpenAiApiKey()) {
    console.error("lead-research: configuration error - neither LEAD_RESEARCH_MOCK_MODE nor OPENAI_API_KEY is set", { lead_id: leadId });
    return json(500, {
      error: "AI research is not configured on this server. Set LEAD_RESEARCH_MOCK_MODE=true for local testing, or configure OPENAI_API_KEY for live research.",
      classification: "configuration_error",
    });
  }

  // --- begin the run: atomically repairs any stale running report for this
  // lead and creates the new one, or fails with 23505 if one is genuinely
  // already in flight (see begin_lead_research_run() in the SQL file). ----
  const { data: reportId, error: beginError } = await service.rpc("begin_lead_research_run", {
    p_lead_id: leadId,
    p_requested_by_actor: actorLabel,
  });

  if (beginError) {
    if (beginError.code === "23505") {
      return json(409, { error: "AI research is already running for this lead." });
    }
    console.error("lead-research: could not start research run", { lead_id: leadId });
    return json(500, { error: "Could not start research." });
  }

  await service.from("lead_activity_log").insert({
    lead_id: leadId,
    actor: actorLabel,
    action: "ai_research_started",
    detail: useMock ? "AI research report requested (mock mode)." : "AI research report requested.",
    metadata: { report_id: reportId },
  });

  try {
    // Real and mock content can never mix: useMock is decided once, above,
    // before either path can run, and each path's output goes straight to
    // complete_lead_research_run() with is_mock set to that same value.
    const result = useMock ? buildMockResearchResult(lead) : await runOpenAiResearch(lead);

    const { error: completeError } = await service.rpc("complete_lead_research_run", {
      p_report_id: reportId,
      p_lead_id: leadId,
      p_business_summary: result.business_summary,
      p_activity_evidence: result.activity_evidence,
      p_verified_details: result.verified_details,
      p_website_findings: result.website_findings,
      p_brand_cues: result.brand_cues,
      p_recommended_customer_action: result.recommended_customer_action,
      p_personalization_detail: result.personalization_detail,
      p_missing_or_conflicting_information: result.missing_or_conflicting_information,
      p_mockup_brief: result.mockup_brief,
      p_model_used: result.model_used,
      p_is_mock: useMock,
      p_sources: result.sources,
      p_asset_candidates: result.asset_candidates,
    });

    if (completeError) {
      throw new ResearchError(CLASS.INTERNAL_ERROR, "Could not save the completed research report.");
    }

    await service.from("lead_activity_log").insert({
      lead_id: leadId,
      actor: actorLabel,
      action: "ai_research_completed",
      detail: useMock ? "AI research report completed (mock fixture)." : "AI research report completed.",
      metadata: { report_id: reportId, is_mock: useMock },
    });

    return json(200, { report_id: reportId, status: "complete", is_mock: useMock });
  } catch (error) {
    const classification = error instanceof ResearchError ? error.classification : CLASS.INTERNAL_ERROR;
    const dbMessage = error instanceof ResearchError ? error.message : "An unexpected internal error occurred.";

    // Structured, sanitized log line only: classification, HTTP context,
    // report/lead ids. Never the raw error object, a provider response
    // body, an Authorization header, or the lead record itself.
    console.error("lead-research: research run failed", { classification, report_id: reportId, lead_id: leadId });

    const { error: failRpcError } = await service.rpc("fail_lead_research_run", {
      p_report_id: reportId,
      p_lead_id: leadId,
      p_error_classification: classification,
      p_error_message: dbMessage,
    });

    if (failRpcError) {
      // The failure-RPC itself failed to persist — the report row may be
      // left at status='running' instead of 'failed'. This must never
      // change what's returned to the browser below (still the friendly
      // message for the ORIGINAL classification, computed further down)
      // and is never retried here: begin_lead_research_run()'s stale-run
      // recovery (10-minute threshold, see supabase-lead-research-schema.sql)
      // is the fallback that eventually frees this lead for a new run
      // regardless. One sanitized, structured log line only — never the
      // raw failRpcError object, a database response body, a token, or the
      // lead record.
      console.error("lead-research: fail_lead_research_run itself failed", {
        classification,
        report_id: reportId,
        lead_id: leadId,
        fail_rpc: FAIL_RPC_LOG_MARKER,
      });
    }

    await service.from("lead_activity_log").insert({
      lead_id: leadId,
      actor: actorLabel,
      action: "ai_research_failed",
      detail: "AI research report failed.",
      metadata: { report_id: reportId, classification },
    });

    const statusCode = HTTP_STATUS_BY_CLASS[classification] || 500;
    const friendlyMessage = FRIENDLY_MESSAGE_BY_CLASS[classification] || FRIENDLY_MESSAGE_BY_CLASS[CLASS.INTERNAL_ERROR];
    return json(statusCode, { error: friendlyMessage, classification, report_id: reportId });
  }
};

// Exported for netlify/functions/lead-research.test.js only — every one of
// these is a pure, side-effect-free helper with no Supabase/OpenAI network
// dependency, so they can be exercised directly without calling a paid API
// or a live database. The handler itself never goes through these names
// (it closes over the same module-scope functions directly); this is a
// dedicated testing seam, not part of the function's runtime behavior.
exports.__internal = {
  isMockModeEnabled,
  isSafeHttpsUrl,
  normalizeUrlForComparison,
  extractCitationUrls,
  validateAndBuildResearchResult,
  buildMockResearchResult,
  CLASS,
  FACT_FIELD_TOKENS,
};
