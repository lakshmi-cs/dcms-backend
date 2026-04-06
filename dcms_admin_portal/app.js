const config = window.DCMS_ADMIN_CONFIG || {};
const API_BASE_URL = String(config.apiBaseUrl || "http://localhost:3000").replace(/\/$/, "");
const AUTH_STORAGE_KEY = "dcms_admin_token";

const state = {
  token: localStorage.getItem(AUTH_STORAGE_KEY) || "",
  dashboard: null,
  content: null,
  sessionQr: null,
  validationResult: null,
  loading: false,
};

const appRoot = document.getElementById("appRoot");
const serverStatus = document.getElementById("serverStatus");
const logoutButton = document.getElementById("logoutButton");

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

  const response = await fetch(`${API_BASE_URL}${path}`, request);
  let payload = {};

  try {
    payload = await response.json();
  } catch (error) {
    payload = {};
  }

  if (!response.ok || payload.status === "error") {
    const error = new Error(payload.message || "Request failed");
    error.status = response.status;
    throw error;
  }

  return payload.data;
}

async function checkHealth() {
  try {
    const data = await api("/health", { auth: false });
    const label = data.activeMeal?.isActive
      ? `${data.activeMeal.mealName} is live`
      : `Connected · ${data.timeZone}`;
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

    state.token = data.token;
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
          <p class="helper-copy">These credentials come from your backend <code>.env</code> file.</p>
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

  return `
    <section class="hero-panel glass-card">
      <div class="hero-copy">
        <p class="eyebrow">Control room</p>
        <h2>${escapeHtml(config.portalName || "AIMST DCMS Control Room")}</h2>
        <p>
          Keep cafeteria operations synchronized with the mobile application by publishing live menus, updating announcements,
          managing service windows, and validating student QR redemptions.
        </p>
        <div class="hero-tags">
          <span class="hero-tag">${escapeHtml(content.timeZone || "Asia/Kuala_Lumpur")}</span>
          <span class="hero-tag">${activeMeal.isActive ? `${escapeHtml(activeMeal.mealName)} live now` : "No active meal window"}</span>
          <span class="hero-tag">Student app linked through shared API</span>
        </div>
      </div>
      <div class="hero-actions">
        <button class="primary-button" id="refreshDashboardButton" type="button">Refresh Live Data</button>
        <p>Server time: ${escapeHtml(`${content.serverDate || ""} ${content.serverTime || ""}`.trim())}</p>
      </div>
    </section>

    <section class="stats-grid">
      ${statCardMarkup("Live meal status", activeMeal.isActive ? activeMeal.mealName : "Closed", activeMeal.timeLabel || "Waiting for next window")}
      ${statCardMarkup("Menus ready", stats.menusConfigured || 0, "Published for today's service")}
      ${statCardMarkup("News published", stats.publishedNews || 0, "Visible to students")}
      ${statCardMarkup("QR issued today", stats.qrIssuedToday || 0, "Student coupons generated")}
      ${statCardMarkup("QR redeemed today", stats.qrRedeemedToday || 0, "Counter scans completed")}
    </section>

    <section class="content-grid">
      <article class="glass-card panel-card">
        <div class="section-row">
          <div>
            <p class="eyebrow">Service schedule</p>
            <h3>Meal windows</h3>
          </div>
          <button type="button" class="secondary-button" id="saveScheduleButton">Save Hours</button>
        </div>
        <form id="scheduleForm" class="stacked-form">
          ${mealWindowRows(mealWindows)}
        </form>
      </article>

      <article class="glass-card panel-card">
        <div class="section-row">
          <div>
            <p class="eyebrow">Counter QR</p>
            <h3>Session display QR</h3>
          </div>
          <button type="button" class="secondary-button" id="generateSessionQrButton">Generate QR</button>
        </div>
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
            <p>${state.sessionQr ? escapeHtml(state.sessionQr.meal.timeLabel) : "Use this at the cafeteria counter during breakfast, lunch, or dinner service."}</p>
          </div>
        </div>
      </article>
    </section>

    <section class="content-grid">
      <article class="glass-card panel-card">
        <div class="section-row">
          <div>
            <p class="eyebrow">Daily publishing</p>
            <h3>Today's menu</h3>
          </div>
          <button type="button" class="secondary-button" id="saveMenusButton">Update Menu</button>
        </div>
        <form id="menuForm" class="stacked-form">
          ${menuEditors(menus)}
        </form>
      </article>

      <article class="glass-card panel-card">
        <div class="section-row">
          <div>
            <p class="eyebrow">Counter validation</p>
            <h3>Redeem student QR</h3>
          </div>
        </div>
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

    <section class="news-layout">
      <article class="glass-card panel-card">
        <div class="section-row">
          <div>
            <p class="eyebrow">Broadcast centre</p>
            <h3>Publish cafeteria news</h3>
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

    <section class="glass-card panel-card">
      <div class="section-row">
        <div>
          <p class="eyebrow">Scan history</p>
          <h3>Recent QR activity</h3>
        </div>
      </div>
      ${redemptionsMarkup(redemptions)}
    </section>
  `;
}

function render() {
  logoutButton.classList.toggle("hidden", !state.token);
  appRoot.innerHTML = state.token ? dashboardMarkup() : loginMarkup();
  bindEvents();
  renderSessionQr();
}

function bindEvents() {
  const loginForm = document.getElementById("loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(loginForm);
      login(formData.get("username"), formData.get("password"));
    });
  }

  logoutButton.onclick = logout;

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
