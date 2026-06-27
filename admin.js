import { supabase, supabaseReady, supabaseConfigError } from "./supabase-client.js";

export const quoteRequestColumns = [
  "id",
  "created_at",
  "name",
  "email",
  "business_name",
  "business_type",
  "project_type",
  "package_interest",
  "care_plan_interest",
  "features_needed",
  "ideal_timeline",
  "notes",
  "status",
].join(", ");

export const customerColumns = [
  "id",
  "created_at",
  "updated_at",
  "name",
  "email",
  "phone",
  "business_name",
  "business_type",
  "status",
  "lead_source",
  "quote_request_id",
  "project_type",
  "package_interest",
  "selected_package",
  "package_price",
  "care_plan_interest",
  "selected_care_plan",
  "care_plan_price",
  "ideal_timeline",
  "features_needed",
  "notes",
  "discount_adjustment",
  "pricing_notes",
].join(", ");

export const ticketColumns = [
  "id",
  "created_at",
  "updated_at",
  "customer_id",
  "quote_request_id",
  "title",
  "description",
  "priority",
  "status",
  "assigned_to",
  "created_by",
  "customer:customers(name, business_name, email)",
].join(", ");

export const subscriptionColumns = [
  "id",
  "customer_id",
  "created_at",
  "updated_at",
  "status",
  "plan_name",
  "amount",
  "interval",
  "stripe_subscription_id",
  "stripe_customer_id",
  "customer:customers(name, business_name, email)",
].join(", ");

export function html(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}

export function titleCase(value) {
  return String(value || "New")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function statusClass(value) {
  const normalized = String(value || "New").toLowerCase().replace(/\s+/g, "-");
  if (["won", "active"].includes(normalized)) return "won";
  if (["in-progress", "progress"].includes(normalized)) return "progress";
  if (["closed", "lost"].includes(normalized)) return "closed";
  return "new";
}

export function formatDate(value) {
  if (!value) return "&mdash;";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "&mdash;";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function redirectToLogin() {
  window.location.replace("login.html");
}

export async function initAdminPage(activePage) {
  document.querySelectorAll("[data-page]").forEach((item) => {
    item.classList.toggle("active", item.dataset.page === activePage);
  });

  if (!supabaseReady) {
    console.error("Admin auth guard failed:", supabaseConfigError);
    document.querySelectorAll("[data-session-email]").forEach((node) => {
      node.textContent = "Supabase not configured";
    });
    redirectToLogin();
    return { supabase: null, session: null, configError: supabaseConfigError, redirecting: true };
  }

  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) {
    console.error("Admin auth guard session check failed:", error || new Error("No active Supabase session"));
    redirectToLogin();
    return { supabase, session: null, error, redirecting: true };
  }

  document.querySelectorAll("[data-session-email]").forEach((node) => {
    node.textContent = data.session.user.email || "";
  });

  document.querySelectorAll("[data-logout]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      await supabase.auth.signOut();
      redirectToLogin();
    });
  });

  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") redirectToLogin();
  });

  return { supabase, session: data.session, configError: null };
}

export async function getQuoteCounts() {
  const [totalResult, newResult] = await Promise.all([
    supabase.from("quote_requests").select("id", { count: "exact", head: true }),
    supabase.from("quote_requests").select("id", { count: "exact", head: true }).eq("status", "New"),
  ]);

  const error = totalResult.error || newResult.error;
  if (error) {
    console.error("Supabase quote_requests count failed:", error);
    throw error;
  }

  return {
    total: totalResult.count || 0,
    new: newResult.count || 0,
  };
}

export async function getQuoteRequests({ limit } = {}) {
  let query = supabase
    .from("quote_requests")
    .select(quoteRequestColumns)
    .order("created_at", { ascending: false });

  if (limit) query = query.limit(limit);

  const { data, error } = await query;
  if (error) {
    console.error("Supabase quote_requests select failed:", error);
    throw error;
  }

  return data || [];
}

export async function getCustomerCount() {
  const { count, error } = await supabase
    .from("customers")
    .select("id", { count: "exact", head: true });

  if (error) {
    console.error("Supabase customers count failed:", error);
    throw error;
  }

  return count || 0;
}

export async function getOpenTicketCount() {
  const { count, error } = await supabase
    .from("tickets")
    .select("id", { count: "exact", head: true })
    .neq("status", "Closed");

  if (error) {
    console.error("Supabase tickets count failed:", error);
    throw error;
  }

  return count || 0;
}

export async function getActiveSubscriptionCount() {
  const { count, error } = await supabase
    .from("subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("status", "Active");

  if (error) {
    console.error("Supabase subscriptions count failed:", error);
    throw error;
  }

  return count || 0;
}

export async function getCustomers() {
  const { data, error } = await supabase
    .from("customers")
    .select(customerColumns)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Supabase customers select failed:", error);
    throw error;
  }

  return data || [];
}

export async function getCustomer(id) {
  const { data, error } = await supabase
    .from("customers")
    .select(customerColumns)
    .eq("id", id)
    .single();

  if (error) {
    console.error("Supabase customer select failed:", error);
    throw error;
  }

  return data;
}

export async function createCustomer(payload) {
  const { data, error } = await supabase
    .from("customers")
    .insert(payload)
    .select("id")
    .single();

  if (error) {
    console.error("Supabase customer insert failed:", error);
    throw error;
  }

  return data;
}

export async function updateCustomer(id, payload) {
  const { data, error } = await supabase
    .from("customers")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(customerColumns)
    .single();

  if (error) {
    console.error("Supabase customer update failed:", error);
    throw error;
  }

  return data;
}

export async function createCustomerFromQuoteRequest(row) {
  return createCustomer({
    name: row.name || null,
    email: row.email || null,
    business_name: row.business_name || null,
    business_type: row.business_type || null,
    status: "Lead",
    lead_source: "Quote request",
    quote_request_id: row.id || null,
    project_type: row.project_type || null,
    package_interest: row.package_interest || null,
    care_plan_interest: row.care_plan_interest || null,
    ideal_timeline: row.ideal_timeline || null,
    features_needed: row.features_needed || null,
    notes: row.notes || null,
  });
}

export async function getCustomerNotes(customerId) {
  const { data, error } = await supabase
    .from("customer_notes")
    .select("id, customer_id, created_at, created_by, note")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Supabase customer_notes select failed:", error);
    throw error;
  }

  return data || [];
}

export async function addCustomerNote(customerId, note, createdBy) {
  const { data, error } = await supabase
    .from("customer_notes")
    .insert({ customer_id: customerId, note, created_by: createdBy || null })
    .select("id, customer_id, created_at, created_by, note")
    .single();

  if (error) {
    console.error("Supabase customer_notes insert failed:", error);
    throw error;
  }

  return data;
}

export async function getCustomerFiles(customerId) {
  const { data, error } = await supabase
    .from("customer_files")
    .select("id, customer_id, created_at, file_name, file_path, file_type, uploaded_by")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Supabase customer_files select failed:", error);
    throw error;
  }

  return data || [];
}

export async function uploadCustomerFile(customerId, file, uploadedBy) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
  const filePath = `${customerId}/${Date.now()}-${safeName}`;
  const upload = await supabase.storage.from("customer-files").upload(filePath, file);

  if (upload.error) {
    console.error("Supabase customer file upload failed:", upload.error);
    throw upload.error;
  }

  const { data, error } = await supabase
    .from("customer_files")
    .insert({
      customer_id: customerId,
      file_name: file.name,
      file_path: filePath,
      file_type: file.type || null,
      uploaded_by: uploadedBy || null,
    })
    .select("id, customer_id, created_at, file_name, file_path, file_type, uploaded_by")
    .single();

  if (error) {
    console.error("Supabase customer_files insert failed:", error);
    throw error;
  }

  return data;
}

export async function getCustomerInvoices(customerId) {
  const { data, error } = await supabase
    .from("customer_invoices")
    .select("id, customer_id, created_at, title, description, amount, status, due_date, stripe_invoice_id, stripe_invoice_url")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Supabase customer_invoices select failed:", error);
    throw error;
  }

  return data || [];
}

export async function createCustomerInvoice(payload) {
  const { data, error } = await supabase
    .from("customer_invoices")
    .insert(payload)
    .select("id, customer_id, created_at, title, description, amount, status, due_date, stripe_invoice_id, stripe_invoice_url")
    .single();

  if (error) {
    console.error("Supabase customer_invoices insert failed:", error);
    throw error;
  }

  return data;
}

export async function getTickets({ customerId } = {}) {
  let query = supabase
    .from("tickets")
    .select(ticketColumns)
    .order("updated_at", { ascending: false });

  if (customerId) query = query.eq("customer_id", customerId);

  const { data, error } = await query;
  if (error) {
    console.error("Supabase tickets select failed:", error);
    throw error;
  }

  return data || [];
}

export async function getSubscriptions() {
  const { data, error } = await supabase
    .from("subscriptions")
    .select(subscriptionColumns)
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("Supabase subscriptions select failed:", error);
    throw error;
  }

  return data || [];
}

export async function getTicket(id) {
  const { data, error } = await supabase
    .from("tickets")
    .select(ticketColumns)
    .eq("id", id)
    .single();

  if (error) {
    console.error("Supabase ticket select failed:", error);
    throw error;
  }

  return data;
}

export async function createTicket(payload) {
  const { data, error } = await supabase
    .from("tickets")
    .insert(payload)
    .select(ticketColumns)
    .single();

  if (error) {
    console.error("Supabase ticket insert failed:", error);
    throw error;
  }

  return data;
}

export async function updateTicket(id, payload) {
  const { data, error } = await supabase
    .from("tickets")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(ticketColumns)
    .single();

  if (error) {
    console.error("Supabase ticket update failed:", error);
    throw error;
  }

  return data;
}

export async function getTicketComments(ticketId) {
  const { data, error } = await supabase
    .from("ticket_comments")
    .select("id, ticket_id, created_at, created_by, comment")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Supabase ticket_comments select failed:", error);
    throw error;
  }

  return data || [];
}

export async function addTicketComment(ticketId, comment, createdBy) {
  const { data, error } = await supabase
    .from("ticket_comments")
    .insert({ ticket_id: ticketId, comment, created_by: createdBy || null })
    .select("id, ticket_id, created_at, created_by, comment")
    .single();

  if (error) {
    console.error("Supabase ticket_comments insert failed:", error);
    throw error;
  }

  return data;
}

export function quoteRequestRow(row, includeEmail = false) {
  const status = row.status || "New";
  const cells = [
    `<td class="entity">${html(row.name || "Unnamed")}</td>`,
    `<td>${html(row.business_name || "-")}</td>`,
  ];

  if (includeEmail) cells.push(`<td>${html(row.email || "-")}</td>`);

  if (includeEmail) cells.push(`<td>${html(row.project_type || "-")}</td>`);

  cells.push(
    `<td>${html(row.package_interest || "Not sure yet")}</td>`,
    `<td>${html(row.care_plan_interest || "Not sure yet")}</td>`,
    `<td><span class="status ${statusClass(status)}">${html(titleCase(status))}</span></td>`,
    `<td class="muted">${formatDate(row.created_at)}</td>`
  );

  return `<tr data-search-text="${html([
    row.name,
    row.email,
    row.business_name,
    row.business_type,
    row.project_type,
    row.package_interest,
    row.care_plan_interest,
    row.status,
  ].join(" ").toLowerCase())}">${cells.join("")}</tr>`;
}

export function setTableState(tbody, message, isError = false, colspan = 6) {
  tbody.innerHTML = `<tr class="table-state${isError ? " error" : ""}"><td colspan="${colspan}">${html(message)}</td></tr>`;
}

export function bindTableSearch(input, rowsContainer, emptyNode, emptyMessage) {
  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    let visible = 0;

    rowsContainer.querySelectorAll("tr[data-search-text]").forEach((row) => {
      const matches = row.dataset.searchText.includes(query);
      row.hidden = !matches;
      if (matches) visible += 1;
    });

    emptyNode.textContent = query && visible === 0 ? "No matching results." : emptyMessage;
    emptyNode.classList.toggle("visible", visible === 0);
  });
}
