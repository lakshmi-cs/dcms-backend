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
          <p class="eyebrow">Premium operations dashboard</p>
          <h2>Control meal windows, live QR service, menus, and cafeteria news.</h2>
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

function detailItemMarkup(label, value) {
  return `
    <div class="detail-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "Not available")}</strong>
    </div>
  `;
}

function navLinkMarkup(target, label, detail) {
  return `
    <a class="dashboard-nav-link" href="${escapeHtml(target)}">
      <strong>${escapeHtml(label)}</strong>
      <small>${escapeHtml(detail)}</small>
    </a>
  `;
}

function matchesWorkspaceQuery(...values) {
  const query = String(state.workspaceQuery || "").trim().toLowerCase();
  if (!query) return true;
  return values.some((value) => String(value || "").toLowerCase().includes(query));
}

function sectionVisibilityClass(...values) {
  return matchesWorkspaceQuery(...values) ? "" : " section-hidden";
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
  const serverStamp = `${content.serverDate || dashboard.serverDate || ""} ${content.serverTime || dashboard.serverTime || ""}`.trim();
  const liveMealLabel = activeMeal.isActive ? activeMeal.mealName : "No active meal window";
  const liveMealDetail = activeMeal.timeLabel || "Waiting for next service window";
  const apiBaseLabel = state.apiBaseUrl || "Not configured";
  return `
    <div class="dashboard-shell">
      <aside class="dashboard-sidebar">
        <div class="dashboard-brand glass-card">
          <div class="brand-mark">DC</div>
          <div>
            <strong>${escapeHtml(config.portalName || "AIMST DCMS Control Room")}</strong>
            <span>Digital cafeteria admin</span>
          </div>
        </div>

        <div class="dashboard-sidebar-panel glass-card">
          <div class="dashboard-nav-group">
            <span class="dashboard-nav-label">Core</span>
            ${navLinkMarkup("#overviewSection", "Dashboard", "Live overview and service health")}
            ${navLinkMarkup("#serviceSection", "Service Control", "Hours and counter QR")}
            ${navLinkMarkup("#menuSection", "Menu Publishing", "Daily meal items")}
          </div>

          <div class="dashboard-nav-group">
            <span class="dashboard-nav-label">Operations</span>
            ${navLinkMarkup("#newsSection", "News Centre", "Student announcements")}
            ${navLinkMarkup("#validationSection", "QR Validation", "Redeem and verify")}
            ${navLinkMarkup("#activitySection", "Activity Log", "Recent redemptions")}
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
          <label class="toolbar-search">
            <input
              id="workspaceSearch"
              type="search"
              placeholder="Search sections, for example menu, news, qr, schedule..."
              value="${escapeHtml(state.workspaceQuery)}"
            />
          </label>
          <div class="toolbar-actions">
            <span class="toolbar-chip ${escapeHtml(state.serverStatusTone)}">${escapeHtml(state.serverStatusMessage)}</span>
            <span class="toolbar-chip subtle">${escapeHtml(content.timeZone || "Asia/Kuala_Lumpur")}</span>
            <button class="secondary-button toolbar-button" id="refreshDashboardButton" type="button">Refresh</button>
            <button class="ghost-button toolbar-button" id="dashboardLogoutButton" type="button">Logout</button>
            <div class="profile-chip">
              <div class="profile-avatar">A</div>
              <div>
                <strong>Admin</strong>
                <span>Control room session</span>
              </div>
            </div>
          </div>
        </header>

        <main class="dashboard-content">
          <section class="content-header glass-card" id="overviewSection">
            <div class="content-heading">
              <p class="eyebrow">Dashboard overview</p>
              <h2>${escapeHtml(config.portalName || "AIMST DCMS Control Room")}</h2>
              <p>
                This layout keeps the same DCMS workflow but organizes it like a proper admin console:
                schedule service, publish menu, manage announcements, then validate live QR activity.
              </p>
            </div>
            <div class="content-meta">
              <div class="hero-tags">
                <span class="hero-tag">${escapeHtml(content.timeZone || "Asia/Kuala_Lumpur")}</span>
                <span class="hero-tag">${activeMeal.isActive ? `${escapeHtml(activeMeal.mealName)} live now` : "No active meal window"}</span>
                <span class="hero-tag">Student app linked to shared backend</span>
              </div>
              <div class="content-shortcuts">
                <a class="secondary-button link-button" href="#menuSection">Go To Menu</a>
                <a class="secondary-button link-button" href="#newsSection">Go To News</a>
              </div>
              <p class="search-hint" id="workspaceSearchHint">Quick jump across menu, news, QR, schedule, and activity</p>
            </div>
          </section>

          <section class="stats-grid">
            ${statCardMarkup("Live meal status", activeMeal.isActive ? activeMeal.mealName : "Closed", activeMeal.timeLabel || "Waiting for next window")}
            ${statCardMarkup("Menus ready", stats.menusConfigured || 0, "Published for today's service")}
            ${statCardMarkup("News published", stats.publishedNews || 0, "Visible to students")}
            ${statCardMarkup("QR issued today", stats.qrIssuedToday || 0, "Student coupons generated")}
            ${statCardMarkup("QR redeemed today", stats.qrRedeemedToday || 0, "Counter scans completed")}
          </section>

          <section class="module-section${sectionVisibilityClass("service meal windows qr schedule counter operations")}" id="serviceSection" data-search="service meal windows qr schedule counter operations">
            <div class="module-header">
              <div>
                <p class="eyebrow">Service operations</p>
                <h3>Service control</h3>
              </div>
              <p class="module-copy">
                The cafeteria depends on these service windows and the counter QR for breakfast, lunch, and dinner flow.
              </p>
            </div>
            <div class="content-grid">
              <article class="glass-card panel-card">
                <div class="section-row">
                  <div>
                    <p class="eyebrow">Schedule</p>
                    <h3>Meal windows</h3>
                  </div>
                  <button type="button" class="secondary-button" id="saveScheduleButton">Save Hours</button>
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
                  <button type="button" class="secondary-button" id="generateSessionQrButton">Generate QR</button>
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

          <section class="module-section${sectionVisibilityClass("menu publishing daily menu meals breakfast lunch dinner")}" id="menuSection" data-search="menu publishing daily menu meals breakfast lunch dinner">
            <div class="module-header">
              <div>
                <p class="eyebrow">Student content</p>
                <h3>Menu publishing</h3>
              </div>
              <p class="module-copy">
                This is the menu board students see in the app once their dashboard refreshes.
              </p>
            </div>
            <article class="glass-card panel-card">
              <div class="section-row">
                <div>
                  <p class="eyebrow">Menu board</p>
                  <h3>Today's menu</h3>
                </div>
                <button type="button" class="secondary-button" id="saveMenusButton">Publish Menu</button>
              </div>
              <form id="menuForm" class="stacked-form">
                ${menuEditors(menus)}
              </form>
            </article>
          </section>

          <section class="module-section${sectionVisibilityClass("news announcement publish draft promotion operations system")}" id="newsSection" data-search="news announcement publish draft promotion operations system">
            <div class="module-header">
              <div>
                <p class="eyebrow">Broadcast centre</p>
                <h3>News centre</h3>
              </div>
              <p class="module-copy">
                Create, schedule, edit, and review announcements without losing the current DCMS workflow.
              </p>
            </div>
            <section class="news-layout">
              <article class="glass-card panel-card">
                <div class="section-row">
                  <div>
                    <p class="eyebrow">Composer</p>
                    <h3>Announcement editor</h3>
                  </div>
                  <button type="button" class="secondary-button" id="resetNewsFormButton">Clear Form</button>
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
                ${newsCards(news)}
              </article>
            </section>
          </section>

          <section class="module-section${sectionVisibilityClass("validation qr redeem operator token coupon")}" id="validationSection" data-search="validation qr redeem operator token coupon">
            <div class="module-header">
              <div>
                <p class="eyebrow">Counter validation</p>
                <h3>QR validation</h3>
              </div>
              <p class="module-copy">
                Verify the scanned student QR token against the live backend and immediately record redemption.
              </p>
            </div>
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
          </section>

          <section class="module-section${sectionVisibilityClass("activity log redemption issued redeemed history table")}" id="activitySection" data-search="activity log redemption issued redeemed history table">
            <div class="module-header">
              <div>
                <p class="eyebrow">Audit trail</p>
                <h3>Recent QR activity</h3>
              </div>
              <p class="module-copy">
                Review today's issuance and redemption flow in a table-style activity log, similar to classic admin dashboards.
              </p>
            </div>
            <article class="glass-card panel-card">
              ${redemptionsMarkup(redemptions)}
            </article>
          </section>
        </main>
      </div>
    </div>
  `;
}

function render() {
  logoutButton.classList.toggle("hidden", !state.token);
  if (shellTopbar) {
    shellTopbar.classList.toggle("hidden", Boolean(state.token));
  }
  if (pageShell) {
    pageShell.classList.toggle("dashboard-mode", Boolean(state.token));
  }
  appRoot.innerHTML = state.token ? dashboardMarkup() : loginMarkup();
  bindEvents();
  applyWorkspaceFilter();
  renderSessionQr();
}

function applyWorkspaceFilter() {
  const query = String(state.workspaceQuery || "").trim().toLowerCase();
  const hint = document.getElementById("workspaceSearchHint");

  document.querySelectorAll("[data-search]").forEach((section) => {
    const haystack = String(section.dataset.search || "").toLowerCase();
    const visible = !query || haystack.includes(query);
    section.classList.toggle("section-hidden", !visible);
  });

  if (hint) {
    hint.textContent = query
      ? `Filtering sections for "${state.workspaceQuery}"`
      : "Quick jump across menu, news, QR, schedule, and activity";
  }
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

  const dashboardLogoutButton = document.getElementById("dashboardLogoutButton");
  if (dashboardLogoutButton) {
    dashboardLogoutButton.addEventListener("click", logout);
  }

  const workspaceSearch = document.getElementById("workspaceSearch");
  if (workspaceSearch) {
    workspaceSearch.addEventListener("input", (event) => {
      state.workspaceQuery = event.currentTarget.value;
      applyWorkspaceFilter();
    });
  }

  const refreshButton = document.getElementById("refreshDashboardButton");
  if (refreshButton) {
    refreshButton.addEventListener("click", loadDashboard);
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
