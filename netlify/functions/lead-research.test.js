// Plain-Node tests for netlify/functions/lead-research.js — no framework,
// no new dependency, no Supabase/OpenAI network call. Run with:
//
//   node netlify/functions/lead-research.test.js
//
// Exercises only the pure, side-effect-free helpers exposed via
// exports.__internal in lead-research.js (see that file's own comment on
// __internal for why those exist). The handler itself (session
// verification, RPC calls, request routing) is not exercised here — it
// requires a live Supabase project and is covered by the manual testing
// checklist in handoff.md instead.
//
// Exits with code 0 if every assertion passes, 1 otherwise (safe to wire
// into a future CI step as-is).

const assert = require("assert");
const {
  isMockModeEnabled,
  isSafeHttpsUrl,
  extractCitationUrls,
  validateAndBuildResearchResult,
  buildMockResearchResult,
  CLASS,
} = require("./lead-research.js").__internal;

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
  }
}

function assertThrowsClassification(fn, expectedClassification, messageSubstring) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "expected a ResearchError to be thrown, but nothing was thrown");
  assert.strictEqual(thrown.classification, expectedClassification, `expected classification "${expectedClassification}", got "${thrown.classification}" (message: ${thrown.message})`);
  if (messageSubstring) {
    assert.ok(
      thrown.message.includes(messageSubstring),
      `expected error message to include "${messageSubstring}", got "${thrown.message}"`
    );
  }
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function citedResponse(urls) {
  return {
    model: "gpt-4.1-test",
    status: "completed",
    output: [
      {
        content: [
          {
            type: "output_text",
            text: "irrelevant",
            annotations: urls.map((url) => ({ type: "url_citation", url })),
          },
        ],
      },
    ],
  };
}

function baseParsed(overrides = {}) {
  return Object.assign(
    {
      business_summary: "A real business summary.",
      verified_details: {
        phone: null, email: null, address: null, service_area: null,
        services: [], hours: null, hours_conflict: null,
      },
      website_findings: {
        presence_type: "no_website_found", website_url: null,
        observations: [], homepage_opportunities: [],
      },
      activity_evidence: { appears_active: false, signals: [] },
      brand_cues: { personality: [], colors: [], notes: null },
      recommended_customer_action: "Call to book.",
      personalization_detail: "Something specific.",
      missing_or_conflicting_information: [],
      mockup_brief: { concept_direction: "x", key_sections: [], tone: "y", must_avoid: [] },
      // business_name and website_presence are always-required coverage
      // (see FACT_FIELD_TOKENS / validateAndBuildResearchResult), so the
      // baseline fixture always carries a source covering both — tests
      // that want to isolate a different failure add/override sources.
      sources: [
        { source_url: "https://covers.example.com/a", source_title: null, source_type: "other", supports_fields: ["business_name", "website_presence"], notes: null },
      ],
      asset_candidates: [],
    },
    overrides
  );
}
const BASE_CITATIONS = ["https://covers.example.com/a"];

// --- 1. non-url_citation annotations are ignored ------------------------

test("extractCitationUrls accepts a url_citation annotation", () => {
  const data = citedResponse(["https://real.example.com/a"]);
  assert.ok(extractCitationUrls(data).has("https://real.example.com/a"));
});

test("extractCitationUrls ignores an annotation with a different type", () => {
  const data = {
    model: "gpt-4.1-test",
    status: "completed",
    output: [{ content: [{ type: "output_text", text: "x", annotations: [
      { type: "file_citation", url: "https://not-a-real-citation.example.com/a" },
    ] }] }],
  };
  assert.strictEqual(extractCitationUrls(data).size, 0);
});

test("extractCitationUrls ignores an annotation with a url but no type at all", () => {
  const data = {
    model: "gpt-4.1-test",
    status: "completed",
    output: [{ content: [{ type: "output_text", text: "x", annotations: [
      { url: "https://no-type-at-all.example.com/a" },
    ] }] }],
  };
  assert.strictEqual(extractCitationUrls(data).size, 0);
});

// --- 2. malformed source objects fail validation, not silently dropped --

test("source missing source_url throws research_validation_failed", () => {
  const parsed = baseParsed({ sources: [{ source_title: "x", source_type: "other", supports_fields: [], notes: null }] });
  assertThrowsClassification(
    () => validateAndBuildResearchResult(parsed, citedResponse([]), "gpt-4.1"),
    CLASS.RESEARCH_VALIDATION_FAILED,
    "sources[0].source_url"
  );
});

test("source with non-string source_url throws", () => {
  const parsed = baseParsed({ sources: [{ source_url: 12345, source_title: "x", source_type: "other", supports_fields: [], notes: null }] });
  assertThrowsClassification(
    () => validateAndBuildResearchResult(parsed, citedResponse([]), "gpt-4.1"),
    CLASS.RESEARCH_VALIDATION_FAILED,
    "sources[0].source_url"
  );
});

test("source with an unapproved source_type throws", () => {
  const parsed = baseParsed({ sources: [{ source_url: "https://a.example.com", source_title: "x", source_type: "not_a_real_type", supports_fields: [], notes: null }] });
  assertThrowsClassification(
    () => validateAndBuildResearchResult(parsed, citedResponse(["https://a.example.com"]), "gpt-4.1"),
    CLASS.RESEARCH_VALIDATION_FAILED,
    "sources[0].source_type"
  );
});

test("source with an unapproved supports_fields token throws", () => {
  const parsed = baseParsed({ sources: [{ source_url: "https://a.example.com", source_title: "x", source_type: "other", supports_fields: ["not_a_real_field"], notes: null }] });
  assertThrowsClassification(
    () => validateAndBuildResearchResult(parsed, citedResponse(["https://a.example.com"]), "gpt-4.1"),
    CLASS.RESEARCH_VALIDATION_FAILED,
    "sources[0].supports_fields"
  );
});

test("a source that is not an object throws", () => {
  const parsed = baseParsed({ sources: ["just a string"] });
  assertThrowsClassification(
    () => validateAndBuildResearchResult(parsed, citedResponse([]), "gpt-4.1"),
    CLASS.RESEARCH_VALIDATION_FAILED,
    "sources[0]"
  );
});

test("a structurally valid source with an unsafe URL is excluded, not thrown for that reason", () => {
  const parsed = baseParsed({
    sources: [
      { source_url: "https://covers.example.com/a", source_title: null, source_type: "other", supports_fields: ["business_name", "website_presence"], notes: null },
      { source_url: "https://127.0.0.1/internal", source_title: null, source_type: "other", supports_fields: ["business_name"], notes: null },
    ],
  });
  const result = validateAndBuildResearchResult(parsed, citedResponse(BASE_CITATIONS), "gpt-4.1");
  assert.strictEqual(result.sources.length, 1);
  assert.strictEqual(result.sources[0].source_url, "https://covers.example.com/a");
});

// --- 3. malformed asset candidates fail validation -----------------------

test("asset missing asset_url throws research_validation_failed", () => {
  const parsed = baseParsed({ asset_candidates: [{ source_page_url: "https://a.example.com", asset_type: "other", description: null, ownership_context: null }] });
  assertThrowsClassification(
    () => validateAndBuildResearchResult(parsed, citedResponse(BASE_CITATIONS), "gpt-4.1"),
    CLASS.RESEARCH_VALIDATION_FAILED,
    "asset_candidates[0].asset_url"
  );
});

test("asset with an unapproved asset_type throws", () => {
  const parsed = baseParsed({ asset_candidates: [{ asset_url: "https://a.example.com/x.jpg", source_page_url: "https://a.example.com", asset_type: "not_real", description: null, ownership_context: null }] });
  assertThrowsClassification(
    () => validateAndBuildResearchResult(parsed, citedResponse(BASE_CITATIONS), "gpt-4.1"),
    CLASS.RESEARCH_VALIDATION_FAILED,
    "asset_candidates[0].asset_type"
  );
});

test("asset with a non-string/non-null description throws", () => {
  const parsed = baseParsed({ asset_candidates: [{ asset_url: "https://a.example.com/x.jpg", source_page_url: "https://a.example.com", asset_type: "other", description: 42, ownership_context: null }] });
  assertThrowsClassification(
    () => validateAndBuildResearchResult(parsed, citedResponse(BASE_CITATIONS), "gpt-4.1"),
    CLASS.RESEARCH_VALIDATION_FAILED,
    "asset_candidates[0].description"
  );
});

test("a structurally valid asset with an unsafe source_page_url is excluded, not thrown", () => {
  const parsed = baseParsed({
    asset_candidates: [{ asset_url: "https://a.example.com/x.jpg", source_page_url: "https://192.168.1.1/internal", asset_type: "other", description: null, ownership_context: null }],
  });
  const result = validateAndBuildResearchResult(parsed, citedResponse(BASE_CITATIONS), "gpt-4.1");
  assert.strictEqual(result.asset_candidates.length, 0);
});

test("approved_for_mockup is never present on a validated asset candidate (DB column default false applies)", () => {
  const parsed = baseParsed({
    asset_candidates: [{ asset_url: "https://a.example.com/x.jpg", source_page_url: "https://a.example.com", asset_type: "other", description: null, ownership_context: null, approved_for_mockup: true }],
  });
  const result = validateAndBuildResearchResult(parsed, citedResponse(BASE_CITATIONS), "gpt-4.1");
  assert.strictEqual(result.asset_candidates.length, 1);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result.asset_candidates[0], "approved_for_mockup"), false);
});

// --- 4. fact-specific citation coverage -----------------------------------

test("a populated field with no source covering that exact field fails", () => {
  const parsed = baseParsed({
    verified_details: { phone: "555-1212", email: null, address: "123 Main St", service_area: null, services: [], hours: null, hours_conflict: null },
    sources: [
      { source_url: "https://covers.example.com/a", source_title: null, source_type: "other", supports_fields: ["business_name", "website_presence", "address"], notes: null },
    ],
  });
  assertThrowsClassification(
    () => validateAndBuildResearchResult(parsed, citedResponse(BASE_CITATIONS), "gpt-4.1"),
    CLASS.RESEARCH_VALIDATION_FAILED,
    'Verified field "phone"'
  );
});

test("a source supporting only one field cannot validate a different populated field", () => {
  const parsed = baseParsed({
    verified_details: { phone: "555-1212", email: null, address: null, service_area: null, services: ["Haircuts"], hours: null, hours_conflict: null },
    sources: [
      { source_url: "https://covers.example.com/a", source_title: null, source_type: "other", supports_fields: ["business_name", "website_presence", "phone"], notes: null },
    ],
  });
  assertThrowsClassification(
    () => validateAndBuildResearchResult(parsed, citedResponse(BASE_CITATIONS), "gpt-4.1"),
    CLASS.RESEARCH_VALIDATION_FAILED,
    'Verified field "services"'
  );
});

test("every populated field with matching per-field coverage succeeds", () => {
  const parsed = baseParsed({
    verified_details: { phone: "555-1212", email: "hi@example.com", address: "123 Main St", service_area: null, services: ["Haircuts"], hours: "9-5", hours_conflict: null },
    activity_evidence: { appears_active: true, signals: ["recent review"] },
    sources: [
      {
        source_url: "https://covers.example.com/a",
        source_title: null,
        source_type: "other",
        supports_fields: ["business_name", "website_presence", "phone", "email", "address", "services", "hours", "activity_evidence"],
        notes: null,
      },
    ],
  });
  const result = validateAndBuildResearchResult(parsed, citedResponse(BASE_CITATIONS), "gpt-4.1");
  assert.strictEqual(result.verified_details.phone, "555-1212");
  assert.strictEqual(result.sources.length, 1);
});

test("minimal report (nothing populated beyond always-required fields) with proper coverage succeeds", () => {
  const parsed = baseParsed({});
  const result = validateAndBuildResearchResult(parsed, citedResponse(BASE_CITATIONS), "gpt-4.1");
  assert.strictEqual(result.sources.length, 1);
  assert.strictEqual(result.model_used, "gpt-4.1-test");
});

test("model_used prefers the response's own model field over the requested model", () => {
  const parsed = baseParsed({});
  const result = validateAndBuildResearchResult(parsed, citedResponse(BASE_CITATIONS), "gpt-4.1-requested");
  assert.strictEqual(result.model_used, "gpt-4.1-test");
});

// --- 5. literal (untrimmed) mock-mode matching ----------------------------

test('"true" enables mock mode', () => {
  assert.strictEqual(withEnv("LEAD_RESEARCH_MOCK_MODE", "true", isMockModeEnabled), true);
});

test('"TRUE" enables mock mode (case-insensitive)', () => {
  assert.strictEqual(withEnv("LEAD_RESEARCH_MOCK_MODE", "TRUE", isMockModeEnabled), true);
});

test('" true " (with whitespace) does NOT enable mock mode', () => {
  assert.strictEqual(withEnv("LEAD_RESEARCH_MOCK_MODE", " true ", isMockModeEnabled), false);
});

test('"1" does not enable mock mode', () => {
  assert.strictEqual(withEnv("LEAD_RESEARCH_MOCK_MODE", "1", isMockModeEnabled), false);
});

test('"yes" does not enable mock mode', () => {
  assert.strictEqual(withEnv("LEAD_RESEARCH_MOCK_MODE", "yes", isMockModeEnabled), false);
});

test("unset does not enable mock mode", () => {
  assert.strictEqual(withEnv("LEAD_RESEARCH_MOCK_MODE", undefined, isMockModeEnabled), false);
});

// --- 6. private/loopback/reserved URL rejection, public domains unaffected

const URL_SAFETY_CASES = [
  ["https://example.com/page", true],
  ["https://sub.example.com/page", true],
  ["http://example.com/page", false],
  ["javascript:alert(1)", false],
  ["data:text/html,x", false],
  ["file:///etc/passwd", false],
  ["https://localhost/x", false],
  ["https://foo.localhost/x", false],
  ["https://foo.local/x", false],
  ["https://127.0.0.1/x", false],
  ["https://127.255.255.255/x", false],
  ["https://0x7f000001/x", false],
  ["https://2130706433/x", false],
  ["https://10.1.2.3/x", false],
  ["https://172.16.5.5/x", false],
  ["https://172.31.255.255/x", false],
  ["https://172.32.0.1/x", true],
  ["https://192.168.1.1/x", false],
  ["https://169.254.1.1/x", false],
  ["https://100.64.0.1/x", false],
  ["https://100.127.255.255/x", false],
  ["https://100.128.0.1/x", true],
  ["https://0.0.0.0/x", false],
  ["https://8.8.8.8/x", true],
  ["https://1.1.1.1/x", true],
  ["https://[::1]/x", false],
  ["https://[::]/x", false],
  ["https://[fe80::1]/x", false],
  ["https://[fc00::1]/x", false],
  ["https://[fd12:3456::1]/x", false],
  ["https://[::ffff:127.0.0.1]/x", false],
  ["https://[::ffff:8.8.8.8]/x", false],
  ["https://[2606:4700:4700::1111]/x", true],
  ["https://[gibberish]/x", false],
  ["not a url", false],
  [`https://${"a".repeat(3000)}.com/x`, false],
];

for (const [url, expected] of URL_SAFETY_CASES) {
  test(`isSafeHttpsUrl(${JSON.stringify(url).slice(0, 60)}) === ${expected}`, () => {
    assert.strictEqual(isSafeHttpsUrl(url), expected);
  });
}

// --- mock fixture is untouched by any of the above (bypasses validation) -

test("buildMockResearchResult still produces a complete, well-shaped fixture", () => {
  const lead = { business_name: "Amy's Nails", phone: "(801) 771-8888", address: "1320 E 3000 N", city: "Layton", state: "UT", website_url: null };
  const mock = buildMockResearchResult(lead);
  assert.strictEqual(mock.model_used, "mock-fixture-v1");
  assert.strictEqual(mock.sources.length, 3);
  assert.strictEqual(mock.asset_candidates.length, 2);
});

// --- summary ---------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const { name, error } of failures) {
    console.log(`- ${name}\n  ${error.message}`);
  }
  process.exitCode = 1;
}
