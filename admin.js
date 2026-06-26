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
