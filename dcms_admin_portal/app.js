const config = window.DCMS_ADMIN_CONFIG || {};
const AUTH_STORAGE_KEY = "dcms_admin_token";
const API_BASE_STORAGE_KEY = "dcms_admin_api_base_url";

function normalizeApiBaseUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function resolveDefaultApiBaseUrl() {
  const configuredUrl = normalizeApiBaseUrl(config.apiBaseUrl);
  if (configuredUrl) {
    return configuredUrl;
  }

  const { protocol, hostname, origin } = window.location;
  if (protocol === "http:" || protocol === "https:") {
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return "http://localhost:3000";
    }
    return normalizeApiBaseUrl(origin);
  }

  return "http://localhost:3000";
}

function getStoredApiBaseUrl() {
  const storedUrl = normalizeApiBaseUrl(localStorage.getItem(API_BASE_STORAGE_KEY));
  return storedUrl || resolveDefaultApiBaseUrl();
}

function setApiBaseUrl(value) {
  const normalized = normalizeApiBaseUrl(value);
  state.apiBaseUrl = normalized || resolveDefaultApiBaseUrl();
  localStorage.setItem(API_BASE_STORAGE_KEY, state.apiBaseUrl);
}

const state = {
  token: localStorage.getItem(AUTH_STORAGE_KEY) || "",
  apiBaseUrl: getStoredApiBaseUrl(),
  dashboard: null,
  content: null,
  sessionQr: null,
  validationResult: null,
  sidebarOpen: false,
  profileMenuOpen: false,
  workspaceQuery: "",
  serverStatusMessage: "Backend connection pending",
  serverStatusTone: "neutral",
  loading: false,
};

const appRoot = document.getElementById("appRoot");
const serverStatus = document.getElementById("serverStatus");
const logoutButton = document.getElementById("logoutButton");
const shellTopbar = document.querySelector(".topbar");
const pageShell = document.querySelector(".page-shell");

const WORKSPACE_SECTIONS = [
  { key: "overview", label: "Dashboard", detail: "Cafeteria overview", terms: ["dashboard", "overview", "home", "summary"] },
  { key: "service", label: "Meal Hours", detail: "Opening times and counter QR", terms: ["service", "meal", "windows", "schedule", "hours", "qr", "counter"] },
  { key: "menu", label: "Daily Menu", detail: "Breakfast, lunch, and dinner", terms: ["menu", "publishing", "breakfast", "lunch", "dinner", "meals"] },
  { key: "news", label: "Notices", detail: "Student announcements", terms: ["news", "announcement", "broadcast", "draft", "published", "notice"] },
  { key: "validation", label: "Scan QR", detail: "Redeem student coupons", terms: ["validation", "redeem", "coupon", "token", "operator", "scan"] },
  { key: "activity", label: "Student Records", detail: "Recent coupon activity", terms: ["activity", "log", "redemption", "history", "audit", "records"] },
];

function pageUrl(sectionKey) {
  return sectionKey === "overview" ? "./index.html" : `./index.html?page=${encodeURIComponent(sectionKey)}`;
}

function getCurrentPageKey() {
  const page = new URLSearchParams(window.location.search).get("page");
  if (!page) return "overview";
  const matched = WORKSPACE_SECTIONS.find((section) => section.key === page);
  return matched ? matched.key : "overview";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDateTime(value) {
  if (!value) return "Not scheduled";
  return String(value).replace("T", " ").slice(0, 16);
}

function toDateTimeLocal(value) {
  if (!value) return "";
  return String(value).replace(" ", "T").slice(0, 16);
}

function setServerStatus(message, tone = "neutral") {
  state.serverStatusMessage = message;
  state.serverStatusTone = tone;
  serverStatus.textContent = message;
  serverStatus.dataset.tone = tone;

  const workspaceServerStatus = document.getElementById("workspaceServerStatus");
  if (workspaceServerStatus) {
    workspaceServerStatus.textContent = message;
    workspaceServerStatus.className = `toolbar-chip ${tone}`;
  }
}

function showFlash(message, tone = "info") {
  let flashStack = document.getElementById("flashStack");
  if (!flashStack) {
    flashStack = document.createElement("div");
    flashStack.id = "flashStack";
    flashStack.className = "flash-stack";
    document.body.appendChild(flashStack);
  }

  const flash = document.createElement("div");
  flash.className = `flash-card ${tone}`;
  flash.textContent = message;
  flashStack.appendChild(flash);

  window.setTimeout(() => {
    flash.classList.add("leaving");
    window.setTimeout(() => flash.remove(), 260);
  }, 3200);
}

function syncProfileMenu() {
  const profileMenu = document.querySelector(".profile-menu");
  const profileMenuButton = document.getElementById("profileMenuButton");
  const profileCaret = document.querySelector(".profile-caret");
  const profileDropdown = document.querySelector(".profile-dropdown");
  const dashboardLogoutButton = document.getElementById("dashboardLogoutButton");

  if (profileMenu) {
    profileMenu.classList.toggle("is-open", state.profileMenuOpen);
  }

  if (profileMenuButton) {
    profileMenuButton.setAttribute("aria-expanded", state.profileMenuOpen ? "true" : "false");
  }

  if (profileCaret) {
    profileCaret.textContent = state.profileMenuOpen ? "Ë„" : "Ë…";
  }

  if (profileDropdown) {
    profileDropdown.classList.toggle("is-open", state.profileMenuOpen);
  }
}

function setProfileMenuOpen(isOpen) {
  state.profileMenuOpen = Boolean(isOpen);
  syncProfileMenu();
}

function handleDocumentClick(event) {
  if (!state.profileMenuOpen) return;

  const profileMenu = document.querySelector(".profile-menu");
  if (profileMenu && profileMenu.contains(event.target)) {
    return;
  }

  setProfileMenuOpen(false);
}

async function api(path, options = {}) {
  const request = {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  };

  if (state.token && options.auth !== false) {
    request.headers.Authorization = `Bearer ${state.token}`;
  }

  if (options.body) {
    request.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(`${state.apiBaseUrl}${path}`, request);
  } catch (error) {
    throw new Error(`Cannot reach the admin API at ${state.apiBaseUrl}. Check the API base URL and backend availability.`);
  }

  const rawPayload = await response.text();
  if (!rawPayload.trim()) {
    const error = new Error(`The API at ${state.apiBaseUrl} returned an empty response for ${path}.`);
    error.status = response.status;
    throw error;
  }

  let payload = {};
  try {
    payload = JSON.parse(rawPayload);
  } catch (error) {
    const parseError = new Error(`The API at ${state.apiBaseUrl} did not return JSON for ${path}.`);
    parseError.status = response.status;
    throw parseError;
  }

  if (!response.ok || payload.status === "error") {
    const error = new Error(payload.message || "Request failed");
    error.status = response.status;
    throw error;
  }

  return payload.data ?? payload;
}

async function checkHealth() {
  try {
    const data = await api("/health", { auth: false });
    const label = data.activeMeal?.isActive
      ? `${data.activeMeal.mealName} is live`
      : `Connected Â· ${data.timeZone}`;
    setServerStatus(label, "success");
  } catch (error) {
    setServerStatus("Backend unavailable", "danger");
  }
}

async function login(username, password) {
  state.loading = true;
  render();

  try {
    const data = await api("/admin/login", {
      method: "POST",
      auth: false,
      body: { username, password },
    });

    const token = data?.token;

    if (!token) {
      throw new Error("Login response did not include an admin token");
    }

    state.token = token;
    localStorage.setItem(AUTH_STORAGE_KEY, state.token);
    showFlash("Admin session started", "success");
    await loadDashboard();
  } catch (error) {
    state.loading = false;
    render();
    showFlash(error.message || "Unable to sign in", "danger");
  }
}

function logout() {
  state.token = "";
  state.dashboard = null;
  state.content = null;
  state.sessionQr = null;
  state.validationResult = null;
  state.sidebarOpen = false;
  state.profileMenuOpen = false;
  state.loading = false;
  localStorage.removeItem(AUTH_STORAGE_KEY);
  render();
  showFlash("Logged out", "info");
}

async function loadDashboard() {
  state.loading = true;
  render();

  try {
    const [dashboard, content] = await Promise.all([
      api("/admin/dashboard"),
      api("/admin/content"),
    ]);

    state.dashboard = dashboard;
    state.content = content;
    state.loading = false;
    render();
  } catch (error) {
    state.loading = false;
    if (error.status === 401) {
      logout();
      showFlash("Your admin session expired. Please log in again.", "danger");
      return;
    }
    render();
    showFlash(error.message || "Unable to load dashboard", "danger");
  }
}

function loginMarkup() {
  return `
    <section class="login-shell">
      <div class="login-panel glass-card">
        <div class="login-copy">
          <p class="eyebrow">Cafeteria management dashboard</p>
          <h2>Manage meal hours, live QR service, daily menus, and student notices.</h2>
          <p>
            This website links directly to your cafeteria backend, so updates made here can flow into the student application.
          </p>
          <div class="feature-list">
            <div class="feature-chip">Live QR issue + validation</div>
            <div class="feature-chip">Daily menu publishing</div>
            <div class="feature-chip">News distribution to the app</div>
          </div>
        </div>
        <form id="loginForm" class="auth-form">
          <label>
            <span>API base URL</span>
            <input
              name="apiBaseUrl"
              type="url"
              placeholder="http://localhost:3000"
              value="${escapeHtml(state.apiBaseUrl)}"
              required
            />
          </label>
          <label>
            <span>Admin username</span>
            <input name="username" type="text" placeholder="admin" required />
          </label>
          <label>
            <span>Password</span>
            <input name="password" type="password" placeholder="Enter password" required />
          </label>
          <button type="submit" class="primary-button" ${state.loading ? "disabled" : ""}>
            ${state.loading ? "Signing in..." : "Enter Control Room"}
          </button>
          <p class="helper-copy">
            These credentials come from your backend <code>.env</code> file. The API base URL is saved in this browser so you can correct it without editing code again.
          </p>
        </form>
      </div>
    </section>
  `;
}

function statCardMarkup(label, value, detail) {
  return `
    <article class="stat-card glass-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </article>
  `;
}

function formatRelativeTime(value) {
  if (!value) return "just now";

  const parsed = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return "recently";

  const seconds = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 1000));
  if (seconds < 60) return `${seconds || 1}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function detailItemMarkup(label, value) {
  return `
    <div class="detail-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "Not available")}</strong>
    </div>
  `;
}

const NAV_ICON_LABELS = {
  overview: "H",
  service: "S",
  menu: "M",
  news: "N",
  validation: "Q",
  activity: "A",
};

function navLinkMarkup(section) {
  return `
    <a class="dashboard-nav-link ${state.currentPage === section.key ? "is-active" : ""}" data-key="${escapeHtml(section.key)}" href="${escapeHtml(pageUrl(section.key))}">
      <span class="nav-icon">${escapeHtml(NAV_ICON_LABELS[section.key] || section.label.charAt(0))}</span>
      <div class="nav-copy">
        <strong>${escapeHtml(section.label)}</strong>
        <small>${escapeHtml(section.detail)}</small>
      </div>
    </a>
  `;
}

function resolveWorkspaceSection(query) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return null;
  return WORKSPACE_SECTIONS.find((section) =>
    section.terms.some((term) => term.includes(normalizedQuery) || normalizedQuery.includes(term)),
  ) || null;
}

function overviewCardMarkup(sectionKey, title, detail, metricLabel, metricValue) {
  return `
    <article class="overview-card glass-card">
      <span>${escapeHtml(metricLabel)}</span>
      <strong>${escapeHtml(metricValue)}</strong>
      <p>${escapeHtml(detail)}</p>
      <a class="secondary-button link-button" href="${escapeHtml(pageUrl(sectionKey))}">Open ${escapeHtml(title)}</a>
    </article>
  `;
}

function appImpactCardMarkup(title, subtitle, body, items = []) {
  return `
    <article class="glass-card panel-card app-impact-card">
      <div class="section-row compact">
        <div>
          <p class="eyebrow">Student app link</p>
          <h3>${escapeHtml(title)}</h3>
        </div>
      </div>
      <p class="panel-copy">${escapeHtml(subtitle)}</p>
      ${items.length
        ? `<div class="app-impact-list">
            ${items
              .map(
                (item) => `
                  <div class="app-impact-item">
                    <span>${escapeHtml(item.label)}</span>
                    <strong>${escapeHtml(item.value)}</strong>
                  </div>
                `,
              )
              .join("")}
          </div>`
        : ""}
      <p class="app-impact-body">${escapeHtml(body)}</p>
    </article>
  `;
}

function menuPreviewMarkup(menus) {
  return `
    <article class="glass-card panel-card app-preview-card">
      <div class="section-row compact">
        <div>
          <p class="eyebrow">App preview</p>
          <h3>Menu tab snapshot</h3>
        </div>
      </div>
      <div class="app-preview-list">
        ${menus
          .map(
            (menu) => `
              <div class="app-preview-item">
                <strong>${escapeHtml(menu.mealName)}</strong>
                <span>${escapeHtml((menu.items || []).slice(0, 3).join(", ") || "No items published yet")}</span>
              </div>
            `,
          )
          .join("")}
      </div>
    </article>
  `;
}

function newsPreviewMarkup(news) {
  const visibleNews = news.filter((item) => item.status === "published").slice(0, 4);
  return `
    <article class="glass-card panel-card app-preview-card">
      <div class="section-row compact">
        <div>
          <p class="eyebrow">App preview</p>
          <h3>News feed snapshot</h3>
        </div>
      </div>
      <div class="app-preview-list">
        ${(visibleNews.length ? visibleNews : news.slice(0, 4))
          .map(
            (item) => `
              <div class="app-preview-item">
                <strong>${escapeHtml(item.title || "Announcement")}</strong>
                <span>${escapeHtml(item.status || "published")} Â· ${escapeHtml(formatDateTime(item.publishAt))}</span>
              </div>
            `,
          )
          .join("") || `<div class="empty-card">No announcement preview available yet.</div>`}
      </div>
    </article>
  `;
}

function pageHeaderMarkup(eyebrow, title, description, actionsMarkup = "", detailMarkup = "") {
  return `
    <section class="content-header glass-card page-view-header">
      <div class="content-heading">
        <p class="eyebrow">${escapeHtml(eyebrow)}</p>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(description)}</p>
      </div>
      <div class="content-meta">
        ${actionsMarkup ? `<div class="content-shortcuts">${actionsMarkup}</div>` : ""}
        ${detailMarkup ? `<p class="search-hint">${detailMarkup}</p>` : ""}
      </div>
    </section>
  `;
}

function mealWindowRows(windows) {
  return windows
    .map(
      (window) => `
        <div class="meal-row">
          <div>
            <strong>${escapeHtml(window.mealName)}</strong>
            <p>${escapeHtml(window.mealCode)}</p>
          </div>
          <label>
            <span>Start</span>
            <input type="time" name="${escapeHtml(window.mealCode)}_start" value="${escapeHtml(String(window.startTime).slice(0, 5))}" />
          </label>
          <label>
            <span>End</span>
            <input type="time" name="${escapeHtml(window.mealCode)}_end" value="${escapeHtml(String(window.endTime).slice(0, 5))}" />
          </label>
        </div>
      `,
    )
    .join("");
}

function menuEditors(menus) {
  return menus
    .map(
      (menu) => `
        <label class="menu-editor">
          <div class="section-row">
            <strong>${escapeHtml(menu.mealName)}</strong>
            <span>${escapeHtml(menu.timeLabel || "")}</span>
          </div>
          <textarea name="${escapeHtml(menu.mealCode)}_items" rows="5" placeholder="One menu item per line">${escapeHtml((menu.items || []).join("\n"))}</textarea>
        </label>
      `,
    )
    .join("");
}

function newsCards(news) {
  if (!news.length) {
    return `<div class="empty-card">No news announcements have been published yet.</div>`;
  }

  return news
    .map(
      (item) => `
        <article class="news-card glass-card">
          <div class="section-row">
            <div>
              <span class="news-badge">${escapeHtml(item.category || "General")}</span>
              <h4>${escapeHtml(item.title)}</h4>
            </div>
            <div class="news-actions">
              <button type="button" class="secondary-button" data-edit-news="${item.id}">Edit</button>
              <button type="button" class="danger-button" data-delete-news="${item.id}">Delete</button>
            </div>
          </div>
          <p>${escapeHtml(item.body)}</p>
          <div class="news-meta">
            <span>Status: ${escapeHtml(item.status)}</span>
            <span>Priority: ${escapeHtml(item.priority)}</span>
            <span>Publish: ${escapeHtml(formatDateTime(item.publishAt))}</span>
          </div>
        </article>
      `,
    )
    .join("");
}

function redemptionsMarkup(redemptions) {
  if (!redemptions.length) {
    return `<div class="empty-card">No QR redemptions have been recorded today.</div>`;
  }

  return `
    <div class="table-shell">
      <table>
        <thead>
          <tr>
            <th>Student</th>
            <th>Coupon</th>
            <th>Meal</th>
            <th>Status</th>
            <th>Issued</th>
            <th>Redeemed</th>
          </tr>
        </thead>
        <tbody>
          ${redemptions
            .map(
              (item) => `
                <tr>
                  <td>${escapeHtml(item.studentId)}</td>
                  <td>${escapeHtml(item.couponType)}</td>
                  <td>${escapeHtml(item.mealCode)}</td>
                  <td><span class="table-pill ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td>
                  <td>${escapeHtml(formatDateTime(item.issuedAt))}</td>
                  <td>${escapeHtml(item.redeemedAt ? formatDateTime(item.redeemedAt) : "--")}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function validatorResultMarkup() {
  if (!state.validationResult) {
    return `
      <div class="validator-result placeholder">
        Scan or paste a student coupon QR token here to verify it against the live cafeteria service window.
      </div>
    `;
  }

  return `
    <div class="validator-result success">
      <strong>Redeemed successfully</strong>
      <p>Student ID: ${escapeHtml(state.validationResult.studentId)}</p>
      <p>Coupon: ${escapeHtml(state.validationResult.couponType)}</p>
      <p>Meal: ${escapeHtml(state.validationResult.mealCode)}</p>
      <p>Time: ${escapeHtml(formatDateTime(state.validationResult.redeemedAt))}</p>
    </div>
  `;
}

function heroMetricMarkup(label, value, detail, modifier = "", accentMarkup = "") {
  return `
    <article class="hero-metric-card glass-card ${modifier}">
      <div class="hero-metric-label-row">
        <span>${escapeHtml(label)}</span>
        <span class="metric-arrow">></span>
      </div>
      <strong>${escapeHtml(value)}</strong>
      <p>${escapeHtml(detail)}</p>
      ${accentMarkup}
    </article>
  `;
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

function formatShortDay(value) {
  if (!value) return "";
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-US", { weekday: "short" });
}

function snapshotItemMarkup(label, value, detail) {
  return `
    <div class="snapshot-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </div>
  `;
}

function summaryKpiMarkup(label, value, detail, modifier = "") {
  return `
    <article class="glass-card summary-kpi-card ${modifier}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </article>
  `;
}

function barChartRowsMarkup(items, emptyMessage, valueSuffix = "") {
  if (!items.length) {
    return `<div class="empty-card">${escapeHtml(emptyMessage)}</div>`;
  }

  const maxValue = Math.max(1, ...items.map((item) => Number(item.total || item.value || 0)));

  return `
    <div class="bar-chart-list">
      ${items
        .map((item, index) => {
          const total = Number(item.total || item.value || 0);
          const width = Math.max(total > 0 ? 12 : 0, (total / maxValue) * 100);
          return `
            <div class="bar-chart-row">
              <div class="bar-chart-labels">
                <strong>${escapeHtml(item.label || item.mealName || item.couponType || "Item")}</strong>
                <span>${escapeHtml(item.detail || "Today")}</span>
              </div>
              <div class="bar-chart-track">
                <span class="bar-chart-fill bar-chart-fill--${(index % 4) + 1}" style="width:${width}%"></span>
              </div>
              <strong class="bar-chart-value">${escapeHtml(`${total}${valueSuffix}`)}</strong>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function studentTrendChartMarkup(weeklyTrend) {
  const trend = weeklyTrend.length
    ? weeklyTrend
    : Array.from({ length: 7 }, (_, index) => ({
        activityDate: `Day ${index + 1}`,
        couponsIssued: 0,
        studentsServed: 0,
      }));
  const maxValue = Math.max(
    1,
    ...trend.flatMap((item) => [Number(item.couponsIssued || 0), Number(item.studentsServed || 0)]),
  );

  return `
    <div class="trend-chart-shell">
      <div class="trend-chart-bars">
        ${trend
          .map((item) => {
            const issuedHeight = Math.max(item.couponsIssued ? 14 : 8, (Number(item.couponsIssued || 0) / maxValue) * 100);
            const studentsHeight = Math.max(item.studentsServed ? 14 : 8, (Number(item.studentsServed || 0) / maxValue) * 100);
            return `
              <div class="trend-bar-group">
                <div class="trend-bar-stack">
                  <span class="trend-bar trend-bar--issued" style="height:${issuedHeight}%"></span>
                  <span class="trend-bar trend-bar--students" style="height:${studentsHeight}%"></span>
                </div>
                <strong>${escapeHtml(formatShortDay(item.activityDate))}</strong>
              </div>
            `;
          })
          .join("")}
      </div>
      <div class="trend-legend">
        <span><i class="legend-swatch legend-swatch--issued"></i>Coupons issued</span>
        <span><i class="legend-swatch legend-swatch--students"></i>Students served</span>
      </div>
    </div>
  `;
}

function serviceSnapshotMarkup(activeMeal, serverStamp, stats, mealWindows) {
  const nextWindow = !activeMeal.isActive
    ? mealWindows.find((window) => window.mealCode === activeMeal.mealCode)
    : null;

  return `
    <article class="glass-card cafeteria-snapshot-card">
      <div class="section-row compact">
        <div>
          <p class="eyebrow">Service snapshot</p>
          <h3>${escapeHtml(activeMeal.isActive ? `${activeMeal.mealName} is live` : "Cafeteria service closed")}</h3>
        </div>
        <span class="service-badge ${activeMeal.isActive ? "live" : "waiting"}">${escapeHtml(activeMeal.isActive ? "Open now" : "Waiting")}</span>
      </div>
      <p class="panel-copy">
        ${escapeHtml(
          activeMeal.isActive
            ? `${activeMeal.timeLabel} is active, so students can generate and redeem valid coupons right now.`
            : nextWindow
              ? `Next window is ${nextWindow.mealName} (${nextWindow.timeLabel}). Staff can prepare the counter QR and menu before service starts.`
              : "No cafeteria window is active yet. Keep meal hours and menu ready before the next session begins.",
        )}
      </p>
      <div class="snapshot-grid">
        ${snapshotItemMarkup("Server time", serverStamp || "Unavailable", "Live backend time")}
        ${snapshotItemMarkup("Menus ready", String(stats.menusConfigured || 0), "Meals published today")}
        ${snapshotItemMarkup("News live", String(stats.publishedNews || 0), "Visible in the app")}
        ${snapshotItemMarkup("QR redeemed", String(stats.qrRedeemedToday || 0), "Successful scans today")}
      </div>
    </article>
  `;
}

function redemptionMiniListMarkup(redemptions) {
  if (!redemptions.length) {
    return `<div class="empty-card">Student coupon records will appear here after the first issue or redemption today.</div>`;
  }

  return `
    <div class="activity-mini-list">
      ${redemptions
        .slice(0, 5)
        .map(
          (item) => `
            <div class="activity-mini-item">
              <div>
                <strong>${escapeHtml(item.studentId)}</strong>
                <span>${escapeHtml(`${item.couponType} Â· ${item.mealCode}`)}</span>
              </div>
              <small>${escapeHtml(item.redeemedAt ? formatRelativeTime(item.redeemedAt) : formatRelativeTime(item.issuedAt))}</small>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function workflowTimelineMarkup(activeMeal, stats) {
  const activeIndex = activeMeal.isActive
    ? 3
    : (stats.menusConfigured || 0) > 0
      ? 2
      : 0;

  const steps = [
    "Hours Set",
    "QR Generated",
    "Menu Published",
    "Window Open",
    "Window Closed",
  ];

  return `
    <section class="glass-card workflow-panel">
      <div class="section-row compact workflow-header">
        <div>
          <p class="eyebrow">Service readiness</p>
          <h3>Meal Window Workflow Timeline</h3>
        </div>
        <span class="workflow-chip">Current step</span>
      </div>
      <div class="workflow-line">
        ${steps
          .map((step, index) => `
            <div class="workflow-step ${index <= activeIndex ? "is-complete" : ""} ${index === activeIndex ? "is-current" : ""}">
              <span class="workflow-dot"></span>
              <strong>${escapeHtml(step)}</strong>
            </div>
          `)
          .join("")}
      </div>
    </section>
  `;
}

function menuBarsMarkup(menus) {
  const safeMenus = menus.map((menu) => ({
    label: menu.mealName || "Meal",
    value: (menu.items || []).length,
  }));
  const maxValue = Math.max(1, ...safeMenus.map((item) => item.value));

  return `
    <div class="mini-bars">
      ${safeMenus
        .map((item, index) => `
          <div class="mini-bar-item">
            <span
              class="mini-bar-fill mini-bar-fill--${index + 1}"
              style="height:${Math.max(18, (item.value / maxValue) * 86)}px"
            ></span>
            <strong>${escapeHtml(String(item.value))}</strong>
            <small>${escapeHtml(item.label)}</small>
          </div>
        `)
        .join("")}
    </div>
  `;
}

function activityFeedMarkup(news, redemptions) {
  const operations = [
    ...news.slice(0, 2).map((item) => ({
      icon: "N",
      tone: "news",
      title: `${item.title || "Announcement"} published`,
      meta: formatRelativeTime(item.publishAt),
    })),
    ...redemptions.slice(0, 3).map((item) => ({
      icon: "Q",
      tone: "qr",
      title: `${item.studentId || "Student"} ${item.status || "updated"} ${item.couponType || "coupon"}`,
      meta: formatRelativeTime(item.redeemedAt || item.issuedAt),
    })),
  ].slice(0, 5);

  if (!operations.length) {
    return `<div class="empty-card">Recent admin actions will appear here after menu, news, and QR activity starts.</div>`;
  }

  return `
    <div class="activity-feed">
      ${operations
        .map((item) => `
          <div class="activity-item">
            <span class="activity-icon activity-icon--${escapeHtml(item.tone)}">${escapeHtml(item.icon)}</span>
            <div class="activity-copy">
              <strong>${escapeHtml(item.title)}</strong>
              <span>${escapeHtml(item.meta)}</span>
            </div>
          </div>
        `)
        .join("")}
    </div>
  `;
}

function dashboardMarkup() {
  if (state.loading && (!state.dashboard || !state.content)) {
    return `
      <section class="loading-shell glass-card">
        <div class="loader-ring"></div>
        <p>Loading control room...</p>
      </section>
    `;
  }

  const dashboard = state.dashboard || {};
  const content = state.content || {};
  const stats = dashboard.stats || {};
  const activeMeal = dashboard.activeMeal || {};
  const menus = content.menus || [];
  const mealWindows = content.mealWindows || [];
  const news = content.news || [];
  const redemptions = dashboard.recentRedemptions || [];
  const analytics = dashboard.analytics || {};
  const serverStamp = `${content.serverDate || dashboard.serverDate || ""} ${content.serverTime || dashboard.serverTime || ""}`.trim();
  const liveMealLabel = activeMeal.isActive ? activeMeal.mealName : "No active meal window";
  const liveMealDetail = activeMeal.timeLabel || "Waiting for next service window";
  const apiBaseLabel = state.apiBaseUrl || "Not configured";
  const registeredStudents = Number(stats.registeredStudents || analytics.registeredStudents || 0);
  const activeStudentsToday = Number(stats.activeStudentsToday || analytics.activeStudentsToday || 0);
  const mealBreakdown = (analytics.mealBreakdown || mealWindows.map((window) => ({
    mealName: window.mealName,
    total: 0,
  }))).map((item) => ({
    label: item.mealName || item.label,
    detail: "Coupons issued",
    total: Number(item.total || 0),
  }));
  const couponBreakdown = (analytics.couponBreakdown || [
    { couponType: "Economy", total: 0 },
    { couponType: "Coupon", total: 0 },
  ]).map((item) => ({
    label: item.couponType === "Coupon" ? "Food stall coupon" : item.couponType,
    detail: "Today's requests",
    total: Number(item.total || 0),
  }));
  const weeklyTrend = analytics.weeklyTrend || [];
  state.currentPage = getCurrentPageKey();
  const currentSection = WORKSPACE_SECTIONS.find((section) => section.key === state.currentPage) || WORKSPACE_SECTIONS[0];
  const dashboardPage = `
    <section class="control-room-overview cafeteria-overview">
      <section class="overview-intro-card glass-card">
        <div>
          <p class="eyebrow">Dashboard</p>
          <h2>DCMS cafeteria management</h2>
          <p class="panel-copy">Track student demand, meal readiness, and coupon activity in one place without extra dashboard clutter.</p>
        </div>
        <div class="overview-intro-meta">
          <span class="overview-meta-pill">${escapeHtml(content.serverDate || dashboard.serverDate || "Today")}</span>
          <span class="overview-meta-pill">${escapeHtml(activeMeal.isActive ? `${activeMeal.mealName} live` : "No live meal")}</span>
        </div>
      </section>

      <section class="overview-kpi-grid">
        ${summaryKpiMarkup("Registered students", formatCompactNumber(registeredStudents), "Users linked to the DCMS app", "summary-kpi-card--students")}
        ${summaryKpiMarkup("Students served today", formatCompactNumber(activeStudentsToday), "Distinct students with coupons today", "summary-kpi-card--served")}
        ${summaryKpiMarkup("Coupons issued today", formatCompactNumber(stats.qrIssuedToday || 0), "Generated from the student app", "summary-kpi-card--issued")}
        ${summaryKpiMarkup("Coupons redeemed today", formatCompactNumber(stats.qrRedeemedToday || 0), "Successfully scanned at the counter", "summary-kpi-card--redeemed")}
      </section>

      <section class="dashboard-chart-grid">
        ${serviceSnapshotMarkup(activeMeal, serverStamp, stats, mealWindows)}

        <article class="glass-card chart-card">
          <div class="section-row compact">
            <div>
              <p class="eyebrow">Meal demand</p>
              <h3>Today by meal window</h3>
            </div>
          </div>
          <p class="panel-copy">See which cafeteria session is attracting the most coupon requests today.</p>
          ${barChartRowsMarkup(mealBreakdown, "Meal demand will appear after students begin generating coupons.")}
        </article>
      </section>

      <section class="dashboard-chart-grid dashboard-chart-grid--wide">
        <article class="glass-card chart-card chart-card--wide">
          <div class="section-row compact">
            <div>
              <p class="eyebrow">Student traffic</p>
              <h3>Seven-day app activity</h3>
            </div>
          </div>
          <p class="panel-copy">Compare total coupons issued versus distinct students served across the last seven days.</p>
          ${studentTrendChartMarkup(weeklyTrend)}
        </article>

        <article class="glass-card chart-card">
          <div class="section-row compact">
            <div>
              <p class="eyebrow">Coupon mix</p>
              <h3>Economy vs food stall</h3>
            </div>
          </div>
          <p class="panel-copy">Monitor which coupon type students prefer today so service can prepare correctly.</p>
          ${barChartRowsMarkup(couponBreakdown, "Coupon type demand will appear after the first student request.")}
        </article>
      </section>

      ${workflowTimelineMarkup(activeMeal, stats)}

      <section class="dashboard-chart-grid">
        <article class="glass-card chart-card">
          <div class="section-row compact">
            <div>
              <p class="eyebrow">Recent student records</p>
              <h3>Latest coupon activity</h3>
            </div>
          </div>
          <p class="panel-copy">Quick view of the most recent student coupon actions without leaving the dashboard.</p>
          ${redemptionMiniListMarkup(redemptions)}
        </article>

        <section class="glass-card operations-panel">
          <div class="section-row compact">
            <div>
              <p class="eyebrow">Admin activity</p>
              <h3>Operations feed</h3>
            </div>
          </div>
          ${activityFeedMarkup(news, redemptions)}
        </section>
      </section>
    </section>
  `;
  const servicePage = `
    ${pageHeaderMarkup(
      "Service operations",
      "Meal Hours",
      "This page focuses only on cafeteria operating hours and the counter QR so staff can prepare service without extra distractions.",
      `<button type="button" class="secondary-button" id="saveScheduleButton">Save Hours</button>
       <button type="button" class="secondary-button" id="generateSessionQrButton">Generate QR</button>`,
      `Server time: ${escapeHtml(serverStamp || "Unavailable")}`,
    )}
    <section class="module-section">
      <div class="content-grid">
        ${appImpactCardMarkup(
          "Meal windows and QR flow",
          "These settings affect the student app coupon timing and cafeteria QR operations.",
          "Students can only generate meal coupons inside active meal windows, and staff validate those QR tokens against the same live backend.",
          [
            { label: "Active meal", value: liveMealLabel },
            { label: "Meal window", value: liveMealDetail },
            { label: "App surface", value: "Home tab + QR generation" },
          ],
        )}
      </div>
      <div class="content-grid">
        <article class="glass-card panel-card">
          <div class="section-row">
            <div>
              <p class="eyebrow">Schedule</p>
              <h3>Meal windows</h3>
            </div>
          </div>
          <p class="panel-copy">Update these hours carefully because they affect live student coupon generation and validation.</p>
          <form id="scheduleForm" class="stacked-form">
            ${mealWindowRows(mealWindows)}
          </form>
        </article>
        <article class="glass-card panel-card">
          <div class="section-row">
            <div>
              <p class="eyebrow">Counter</p>
              <h3>Session display QR</h3>
            </div>
          </div>
          <p class="panel-copy">Display this at the counter so operators know which meal service is active or prepared next.</p>
          <div class="session-qr-controls">
            <label>
              <span>Select meal</span>
              <select id="sessionMealCode">
                ${mealWindows
                  .map(
                    (window) => `
                      <option value="${escapeHtml(window.mealCode)}" ${activeMeal.mealCode === window.mealCode ? "selected" : ""}>
                        ${escapeHtml(window.mealName)}
                      </option>
                    `,
                  )
                  .join("")}
              </select>
            </label>
          </div>
          <div class="qr-shell">
            <canvas id="sessionQrCanvas" width="220" height="220"></canvas>
            <div class="qr-caption">
              <strong>${state.sessionQr ? escapeHtml(state.sessionQr.meal.mealName) : "Generate a live counter QR"}</strong>
              <p>${state.sessionQr ? escapeHtml(state.sessionQr.meal.timeLabel) : "Use this during breakfast, lunch, or dinner service."}</p>
            </div>
          </div>
        </article>
      </div>
    </section>
  `;
  const menuPage = `
    ${pageHeaderMarkup(
      "Student content",
      "Daily Menu",
      "This page is only for today's menu. Publish clean meal items here without mixing them with news or QR validation tasks.",
      `<button type="button" class="secondary-button" id="saveMenusButton">Publish Menu</button>`,
      `Student app reads these items from the shared backend after refresh.`,
    )}
    <section class="module-section">
      <div class="content-grid content-grid--sidebar">
        <article class="glass-card panel-card">
          <div class="section-row">
            <div>
              <p class="eyebrow">Menu board</p>
              <h3>Today's menu</h3>
            </div>
          </div>
          <form id="menuForm" class="stacked-form">
            ${menuEditors(menus)}
          </form>
        </article>
        <div class="page-aside">
          ${appImpactCardMarkup(
            "Menu tab sync",
            "Everything saved here appears in the student app menu tab for today's date.",
            "Students see breakfast, lunch, and dinner items directly from this backend payload after their app refreshes or reopens.",
            [
              { label: "Date", value: content.serverDate || "Today" },
              { label: "Menus ready", value: String(stats.menusConfigured || 0) },
              { label: "App tab", value: "Menu" },
            ],
          )}
          ${menuPreviewMarkup(menus)}
        </div>
      </div>
    </section>
  `;
  const newsPage = `
    ${pageHeaderMarkup(
      "Broadcast centre",
      "Notices",
      "Use this page to write, schedule, edit, and review student-facing announcements in one place.",
      `<button type="button" class="secondary-button" id="resetNewsFormButton">Clear Form</button>`,
      `Published news will appear in the app when its publish time is reached.`,
    )}
    <section class="module-section">
      <section class="news-layout">
        <article class="glass-card panel-card">
          <div class="section-row">
            <div>
              <p class="eyebrow">Composer</p>
              <h3>Announcement editor</h3>
            </div>
          </div>
          <form id="newsForm" class="stacked-form">
            <input type="hidden" name="newsId" value="" />
            <div class="dual-field-grid">
              <label>
                <span>Title</span>
                <input type="text" name="title" placeholder="Announcement title" required />
              </label>
              <label>
                <span>Category</span>
                <select name="category">
                  <option value="General">General</option>
                  <option value="Operations">Operations</option>
                  <option value="System">System</option>
                  <option value="Promotion">Promotion</option>
                </select>
              </label>
            </div>
            <div class="dual-field-grid">
              <label>
                <span>Status</span>
                <select name="status">
                  <option value="published">Published</option>
                  <option value="draft">Draft</option>
                </select>
              </label>
              <label>
                <span>Priority</span>
                <input type="number" name="priority" min="0" max="10" value="0" />
              </label>
            </div>
            <div class="dual-field-grid">
              <label>
                <span>Publish time</span>
                <input type="datetime-local" name="publishAt" />
              </label>
              <label>
                <span>Expire time</span>
                <input type="datetime-local" name="expiresAt" />
              </label>
            </div>
            <label>
              <span>Message</span>
              <textarea name="body" rows="6" placeholder="Write the cafeteria announcement here" required></textarea>
            </label>
            <button type="submit" class="primary-button">Save News</button>
          </form>
        </article>
        <article class="news-column">
          ${appImpactCardMarkup(
            "News feed sync",
            "This page controls what students read in the app news feed.",
            "Only published items whose publish time has started are visible to students. Draft items stay hidden until you publish them.",
            [
              { label: "Published", value: String(stats.publishedNews || 0) },
              { label: "App tab", value: "News" },
              { label: "Visibility", value: "Published + time reached" },
            ],
          )}
          ${newsPreviewMarkup(news)}
          ${newsCards(news)}
        </article>
      </section>
    </section>
  `;
  const validationPage = `
    ${pageHeaderMarkup(
      "Counter validation",
      "Scan QR",
      "This page is dedicated to validating and redeeming student QR tokens against the live backend.",
      "",
      `Use operator name plus the student token for a proper redemption record.`,
    )}
    <section class="module-section">
      <div class="content-grid content-grid--sidebar">
        <article class="glass-card panel-card">
          <form id="validatorForm" class="stacked-form">
            <label>
              <span>Operator name</span>
              <input type="text" name="operatorName" placeholder="Cafeteria staff name" />
            </label>
            <label>
              <span>Student QR token</span>
              <textarea name="token" rows="6" placeholder="Paste or scan the full QR token here"></textarea>
            </label>
            <button type="submit" class="primary-button">Validate And Redeem</button>
          </form>
          ${validatorResultMarkup()}
        </article>
        <div class="page-aside">
          ${appImpactCardMarkup(
            "Student QR sync",
            "The token validated here comes directly from the student app QR generation flow.",
            "If the student app generated the QR during an active meal window, this page can verify and redeem it against the shared backend immediately.",
            [
              { label: "QR issued today", value: String(stats.qrIssuedToday || 0) },
              { label: "Redeemed today", value: String(stats.qrRedeemedToday || 0) },
              { label: "App flow", value: "Home tab coupon QR" },
            ],
          )}
        </div>
      </div>
    </section>
  `;
  const activityPage = `
    ${pageHeaderMarkup(
      "Audit trail",
      "Student Records",
      "This page focuses on recent coupon history so staff can review what was issued or redeemed today.",
      "",
      `Table updates after live admin actions and dashboard refresh.`,
    )}
    <section class="module-section">
      <div class="content-grid content-grid--sidebar">
        <article class="glass-card panel-card">
          ${redemptionsMarkup(redemptions)}
        </article>
        <div class="page-aside">
          ${appImpactCardMarkup(
            "App coupon activity",
            "This log reflects coupon activity generated from the student app and redeemed by admin-side validation.",
            "Use this page to confirm whether the student app flow is working end to end for issuance and redemption.",
            [
              { label: "Issued", value: String(stats.qrIssuedToday || 0) },
              { label: "Redeemed", value: String(stats.qrRedeemedToday || 0) },
              { label: "Linked flow", value: "App QR + admin validation" },
            ],
          )}
        </div>
      </div>
    </section>
  `;
  const pageMarkupBySection = {
    overview: dashboardPage,
    service: servicePage,
    menu: menuPage,
    news: newsPage,
    validation: validationPage,
    activity: activityPage,
  };
  return `
    <div class="dashboard-shell">
      <button class="sidebar-overlay ${state.sidebarOpen ? "is-open" : ""}" id="sidebarOverlay" type="button" aria-label="Close navigation"></button>
      <aside class="dashboard-sidebar ${state.sidebarOpen ? "is-open" : ""}">
        <div class="dashboard-brand glass-card">
          <div class="brand-mark">DC</div>
          <div class="dashboard-brand-copy">
            <strong>${escapeHtml(config.portalName || "AIMST DCMS Control Room")}</strong>
            <span>Hostel cafeteria administration</span>
          </div>
        </div>

        <div class="dashboard-sidebar-panel glass-card">
          <div class="dashboard-nav-group">
            <span class="dashboard-nav-label">Overview</span>
            ${navLinkMarkup(WORKSPACE_SECTIONS[0])}
            ${navLinkMarkup(WORKSPACE_SECTIONS[1])}
            ${navLinkMarkup(WORKSPACE_SECTIONS[2])}
          </div>

          <div class="dashboard-nav-group">
            <span class="dashboard-nav-label">Operations</span>
            ${navLinkMarkup(WORKSPACE_SECTIONS[3])}
            ${navLinkMarkup(WORKSPACE_SECTIONS[4])}
            ${navLinkMarkup(WORKSPACE_SECTIONS[5])}
          </div>
        </div>

        <div class="dashboard-sidebar-panel glass-card dashboard-status-card">
          ${detailItemMarkup("API base", apiBaseLabel)}
          ${detailItemMarkup("Server time", serverStamp)}
          ${detailItemMarkup("Current meal", liveMealLabel)}
          ${detailItemMarkup("Meal window", liveMealDetail)}
        </div>
      </aside>

      <div class="dashboard-stage">
        <header class="dashboard-toolbar glass-card">
          <div class="toolbar-leading">
            <button class="toolbar-icon-button" id="toggleSidebarButton" type="button" aria-label="Open navigation menu">
              <span class="hamburger-icon" aria-hidden="true">
                <span></span>
                <span></span>
                <span></span>
              </span>
            </button>
            <div class="toolbar-context">
              <span class="toolbar-context-label">Cafeteria management</span>
              <strong>${escapeHtml(currentSection.label)}</strong>
              <small>${escapeHtml(currentSection.detail)}</small>
            </div>
          </div>
          <form class="toolbar-search-shell" id="toolbarSearchForm">
            <input
              class="toolbar-search-input"
              id="toolbarSearchInput"
              type="search"
              name="workspaceQuery"
              placeholder="Search menu, notices, qr, records"
              value="${escapeHtml(state.workspaceQuery)}"
            />
            <button class="toolbar-search-button" type="submit">Go</button>
          </form>
          <div class="toolbar-actions">
            <span class="toolbar-status-pill">${escapeHtml(content.serverDate || dashboard.serverDate || "Today")}</span>
            <button class="secondary-button toolbar-button" id="refreshDashboardButton" type="button">Refresh</button>
            <div class="profile-menu">
              <button class="profile-chip profile-chip-button" id="profileMenuButton" type="button" aria-haspopup="menu" aria-expanded="${state.profileMenuOpen ? "true" : "false"}">
                <div class="profile-avatar">A</div>
                <div class="profile-info">
                  <strong>Admin</strong>
                  <span>Cafeteria session</span>
                </div>
                <span class="profile-caret">Ë…</span>
              </button>
              <div class="profile-dropdown" role="menu" aria-label="Admin menu">
                <div class="profile-dropdown-header">
                  <strong>Administrator</strong>
                  <span>${escapeHtml(config.portalName || "AIMST DCMS Control Room")}</span>
                </div>
                <button class="profile-dropdown-item danger" id="dashboardLogoutButton" type="button" role="menuitem">Log Out</button>
              </div>
            </div>
          </div>
        </header>

        <main class="dashboard-content">
          ${pageMarkupBySection[state.currentPage] || dashboardPage}
        </main>
      </div>
    </div>
  `;
}

function render() {
  if (logoutButton) {
    logoutButton.classList.add("hidden");
  }

  if (shellTopbar) {
    shellTopbar.classList.toggle("hidden", Boolean(state.token));
  }
  if (pageShell) {
    pageShell.classList.toggle("dashboard-mode", Boolean(state.token));
  }
  appRoot.innerHTML = state.token ? dashboardMarkup() : loginMarkup();
  bindEvents();
  syncProfileMenu();
  renderSessionQr();
}

function bindEvents() {
  const loginForm = document.getElementById("loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(loginForm);
      setApiBaseUrl(formData.get("apiBaseUrl"));
      login(formData.get("username"), formData.get("password"));
    });
  }

  logoutButton.onclick = logout;
  const profileMenuButton = document.getElementById("profileMenuButton");
  if (profileMenuButton) {
    profileMenuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setProfileMenuOpen(!state.profileMenuOpen);
    });
  }

  const toolbarSearchForm = document.getElementById("toolbarSearchForm");
  if (toolbarSearchForm) {
    toolbarSearchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const query = new FormData(toolbarSearchForm).get("workspaceQuery");
      state.workspaceQuery = String(query || "");
      const matchedSection = resolveWorkspaceSection(state.workspaceQuery);
      if (matchedSection) {
        window.location.href = pageUrl(matchedSection.key);
        return;
      }
      showFlash("No matching section found for that search", "info");
    });
  }

  const dashboardLogoutButton = document.getElementById("dashboardLogoutButton");
  if (dashboardLogoutButton) {
    dashboardLogoutButton.addEventListener("click", (event) => {
      event.stopPropagation();
      logout();
    });
  }

  document.removeEventListener("click", handleDocumentClick);
  document.addEventListener("click", handleDocumentClick);

  const toggleSidebarButton = document.getElementById("toggleSidebarButton");
  if (toggleSidebarButton) {
    toggleSidebarButton.addEventListener("click", () => {
      setProfileMenuOpen(false);
      state.sidebarOpen = !state.sidebarOpen;
      render();
    });
  }

  const sidebarOverlay = document.getElementById("sidebarOverlay");
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener("click", () => {
      state.sidebarOpen = false;
      render();
    });
  }

  const refreshButton = document.getElementById("refreshDashboardButton");
  if (refreshButton) {
    refreshButton.addEventListener("click", () => {
      setProfileMenuOpen(false);
      loadDashboard();
    });
  }

  const saveScheduleButton = document.getElementById("saveScheduleButton");
  if (saveScheduleButton) {
    saveScheduleButton.addEventListener("click", saveSchedule);
  }

  const saveMenusButton = document.getElementById("saveMenusButton");
  if (saveMenusButton) {
    saveMenusButton.addEventListener("click", saveMenus);
  }

  const generateSessionQrButton = document.getElementById("generateSessionQrButton");
  if (generateSessionQrButton) {
    generateSessionQrButton.addEventListener("click", generateSessionQr);
  }

  const validatorForm = document.getElementById("validatorForm");
  if (validatorForm) {
    validatorForm.addEventListener("submit", validateCouponQr);
  }

  const newsForm = document.getElementById("newsForm");
  if (newsForm) {
    newsForm.addEventListener("submit", saveNews);
  }

  const resetNewsFormButton = document.getElementById("resetNewsFormButton");
  if (resetNewsFormButton) {
    resetNewsFormButton.addEventListener("click", resetNewsForm);
  }

  document.querySelectorAll("[data-edit-news]").forEach((button) => {
    button.addEventListener("click", () => editNews(button.dataset.editNews));
  });

  document.querySelectorAll("[data-delete-news]").forEach((button) => {
    button.addEventListener("click", () => deleteNews(button.dataset.deleteNews));
  });
}

async function saveSchedule() {
  const mealWindows = state.content?.mealWindows || [];
  const form = document.getElementById("scheduleForm");
  if (!form) return;

  const payload = mealWindows.map((window, index) => ({
    mealCode: window.mealCode,
    mealName: window.mealName,
    startTime: `${form.elements[`${window.mealCode}_start`].value}:00`,
    endTime: `${form.elements[`${window.mealCode}_end`].value}:00`,
    sortOrder: index + 1,
  }));

  try {
    await api("/admin/meal-windows", {
      method: "PUT",
      body: { mealWindows: payload },
    });
    showFlash("Meal windows updated", "success");
    await loadDashboard();
  } catch (error) {
    showFlash(error.message || "Unable to save schedule", "danger");
  }
}

async function saveMenus() {
  const menus = state.content?.menus || [];
  const form = document.getElementById("menuForm");
  if (!form) return;

  const payload = menus.map((menu) => ({
    mealCode: menu.mealCode,
    items: form.elements[`${menu.mealCode}_items`].value
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean),
  }));

  try {
    await api("/admin/menus/today", {
      method: "PUT",
      body: { menus: payload },
    });
    showFlash("Today's menu published to the app", "success");
    await loadDashboard();
  } catch (error) {
    showFlash(error.message || "Unable to save menu", "danger");
  }
}

async function generateSessionQr() {
  const selector = document.getElementById("sessionMealCode");
  const mealCode = selector ? selector.value : "";

  try {
    state.sessionQr = await api("/admin/qr/session", {
      method: "POST",
      body: { mealCode },
    });
    renderSessionQr();
    showFlash("Session QR generated", "success");
  } catch (error) {
    showFlash(error.message || "Unable to generate session QR", "danger");
  }
}

function renderSessionQr() {
  const canvas = document.getElementById("sessionQrCanvas");
  if (!canvas) return;

  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f7f7f7";
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (!state.sessionQr || !state.sessionQr.qrValue) {
    context.fillStyle = "#99a3c2";
    context.font = "15px Segoe UI";
    context.textAlign = "center";
    context.fillText("QR preview", canvas.width / 2, canvas.height / 2 - 10);
    context.fillText("will appear here", canvas.width / 2, canvas.height / 2 + 18);
    return;
  }

  if (!window.QRCode) {
    showFlash("QR library failed to load from CDN", "danger");
    return;
  }

  window.QRCode.toCanvas(
    canvas,
    state.sessionQr.qrValue,
    {
      width: 220,
      margin: 1,
      color: {
        dark: "#132042",
        light: "#f7f7f7",
      },
    },
    (error) => {
      if (error) {
        showFlash("Unable to render QR canvas", "danger");
      }
    },
  );
}

async function validateCouponQr(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);

  try {
    state.validationResult = await api("/admin/qr/validate", {
      method: "POST",
      body: {
        operatorName: formData.get("operatorName"),
        token: formData.get("token"),
      },
    });
    showFlash("Student QR redeemed successfully", "success");
    await loadDashboard();
  } catch (error) {
    showFlash(error.message || "Unable to validate QR", "danger");
  }
}

function resetNewsForm() {
  const form = document.getElementById("newsForm");
  if (!form) return;
  form.reset();
  form.elements.newsId.value = "";
}

function editNews(newsId) {
  const item = (state.content?.news || []).find((news) => String(news.id) === String(newsId));
  const form = document.getElementById("newsForm");
  if (!item || !form) return;

  form.elements.newsId.value = item.id;
  form.elements.title.value = item.title || "";
  form.elements.category.value = item.category || "General";
  form.elements.status.value = item.status || "published";
  form.elements.priority.value = item.priority || 0;
  form.elements.publishAt.value = toDateTimeLocal(item.publishAt);
  form.elements.expiresAt.value = toDateTimeLocal(item.expiresAt);
  form.elements.body.value = item.body || "";
  showFlash("Editing news post", "info");
  form.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function saveNews(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const newsId = formData.get("newsId");
  const payload = {
    title: formData.get("title"),
    body: formData.get("body"),
    category: formData.get("category"),
    status: formData.get("status"),
    priority: Number(formData.get("priority") || 0),
    publishAt: formData.get("publishAt") ? String(formData.get("publishAt")).replace("T", " ") + ":00" : null,
    expiresAt: formData.get("expiresAt") ? String(formData.get("expiresAt")).replace("T", " ") + ":00" : null,
  };

  try {
    await api(newsId ? `/admin/news/${newsId}` : "/admin/news", {
      method: newsId ? "PUT" : "POST",
      body: payload,
    });
    showFlash(newsId ? "News updated" : "News published", "success");
    resetNewsForm();
    await loadDashboard();
  } catch (error) {
    showFlash(error.message || "Unable to save news", "danger");
  }
}

async function deleteNews(newsId) {
  const confirmed = window.confirm("Delete this news item?");
  if (!confirmed) return;

  try {
    await api(`/admin/news/${newsId}`, {
      method: "DELETE",
    });
    showFlash("News deleted", "success");
    await loadDashboard();
  } catch (error) {
    showFlash(error.message || "Unable to delete news", "danger");
  }
}

async function initialise() {
  render();
  await checkHealth();
  if (state.token) {
    await loadDashboard();
  }
}

initialise();
