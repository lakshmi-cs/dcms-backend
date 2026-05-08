const config = window.DCMS_ADMIN_CONFIG || {};
const API_BASE_STORAGE_KEY = "dcms_coupon_api_base_url";

const state = {
  apiBaseUrl: normalizeApiBaseUrl(localStorage.getItem(API_BASE_STORAGE_KEY) || config.apiBaseUrl || "http://localhost:3000"),
  status: "ACTIVE",
  search: "",
  analytics: null,
  coupons: [],
};

const serverStatus = document.getElementById("serverStatus");
const flashMessage = document.getElementById("flashMessage");
const statsGrid = document.getElementById("statsGrid");
const couponTableShell = document.getElementById("couponTableShell");
const peakHoursList = document.getElementById("peakHoursList");
const popularFoodList = document.getElementById("popularFoodList");
const apiBaseUrlInput = document.getElementById("apiBaseUrlInput");
const searchInput = document.getElementById("searchInput");
const operatorInput = document.getElementById("operatorInput");

apiBaseUrlInput.value = state.apiBaseUrl;

function normalizeApiBaseUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

async function api(path, options = {}) {
  const response = await fetch(`${state.apiBaseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json();
  if (!response.ok || payload.status === "error") {
    throw new Error(payload.message || "Request failed");
  }

  return payload.data;
}

function setFlash(message, tone = "neutral") {
  flashMessage.className = `flash-inline ${tone}`;
  flashMessage.textContent = message;
}

function setServerStatus(message, tone = "neutral") {
  serverStatus.textContent = message;
  serverStatus.dataset.tone = tone;
}

function formatDateTime(value) {
  if (!value) return "--";
  return String(value).replace("T", " ").slice(0, 19);
}

function statCardMarkup(label, value, detail) {
  return `
    <article class="coupon-stat-card">
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${detail}</small>
    </article>
  `;
}

function barRowsMarkup(items, valueKey, labelKey, emptyText) {
  if (!items.length) {
    return `<div class="empty-card">${emptyText}</div>`;
  }

  const maxValue = Math.max(...items.map((item) => Number(item[valueKey] || 0)), 1);
  return items
    .map((item, index) => {
      const total = Number(item[valueKey] || 0);
      const width = Math.max(10, (total / maxValue) * 100);
      return `
        <div class="bar-chart-row">
          <div class="bar-chart-labels">
            <strong>${item[labelKey]}</strong>
            <span>${total} orders</span>
          </div>
          <div class="bar-chart-track">
            <span class="bar-chart-fill bar-chart-fill--${(index % 4) + 1}" style="width:${width}%"></span>
          </div>
          <strong class="bar-chart-value">${total}</strong>
        </div>
      `;
    })
    .join("");
}

function renderAnalytics() {
  const totals = state.analytics?.totals || {
    economyFoodClaimsToday: 0,
    redeemedCoupons: 0,
    expiredCoupons: 0,
    activeCoupons: 0,
  };

  statsGrid.innerHTML = [
    statCardMarkup("Claims today", totals.economyFoodClaimsToday, "Economy food orders today"),
    statCardMarkup("Redeemed", totals.redeemedCoupons, "Coupons successfully redeemed"),
    statCardMarkup("Expired", totals.expiredCoupons, "Coupons auto-expired"),
    statCardMarkup("Active", totals.activeCoupons, "Coupons still valid"),
  ].join("");

  peakHoursList.innerHTML = barRowsMarkup(
    state.analytics?.peakOrderingHours || [],
    "totalOrders",
    "label",
    "No peak ordering data yet.",
  );

  popularFoodList.innerHTML = barRowsMarkup(
    state.analytics?.mostSelectedFood || [],
    "totalOrders",
    "itemName",
    "No food selection data yet.",
  );
}

function renderCoupons() {
  if (!state.coupons.length) {
    couponTableShell.innerHTML = `<div class="empty-card">No coupons matched the current filter.</div>`;
    return;
  }

  couponTableShell.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Coupon Code</th>
          <th>Student ID</th>
          <th>Food</th>
          <th>Status</th>
          <th>Created</th>
          <th>Expires</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${state.coupons
          .map(
            (coupon) => `
              <tr>
                <td>${coupon.couponCode}</td>
                <td>${coupon.studentId}</td>
                <td>${coupon.foodName}</td>
                <td><span class="coupon-status-pill ${coupon.status}">${coupon.status}</span></td>
                <td>${formatDateTime(coupon.createdAt)}</td>
                <td>${formatDateTime(coupon.expiresAt)}</td>
                <td>
                  <div class="coupon-table-actions">
                    ${
                      coupon.status === "ACTIVE"
                        ? `<button class="primary-button redeem-button" data-code="${coupon.couponCode}" type="button">Redeem</button>`
                        : `<span class="helper-copy">Locked</span>`
                    }
                  </div>
                </td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;

  document.querySelectorAll(".redeem-button").forEach((button) => {
    button.addEventListener("click", async () => {
      const couponCode = button.dataset.code;
      await redeemCoupon(couponCode);
    });
  });
}

async function loadHealth() {
  try {
    const result = await api("/health");
    setServerStatus(`Connected · ${formatDateTime(result.timestamp)}`, "success");
  } catch (error) {
    setServerStatus("Backend unavailable", "danger");
  }
}

async function loadAnalytics() {
  state.analytics = await api("/api/admin/analytics/summary");
  renderAnalytics();
}

async function loadCoupons() {
  const params = new URLSearchParams();
  if (state.status) params.set("status", state.status);
  if (state.search) params.set("search", state.search);

  state.coupons = await api(`/api/admin/coupons?${params.toString()}`);
  renderCoupons();
}

async function redeemCoupon(couponCode) {
  const operatorName = operatorInput.value.trim() || "Admin Portal";

  try {
    await api(`/api/coupons/${encodeURIComponent(couponCode)}/redeem`, {
      method: "POST",
      body: {
        operatorName,
      },
    });

    setFlash(`Coupon ${couponCode} redeemed successfully.`, "success");
    await Promise.all([loadCoupons(), loadAnalytics()]);
  } catch (error) {
    setFlash(error.message || "Unable to redeem coupon.", "danger");
  }
}

async function refreshAll() {
  state.apiBaseUrl = normalizeApiBaseUrl(apiBaseUrlInput.value);
  localStorage.setItem(API_BASE_STORAGE_KEY, state.apiBaseUrl);

  setFlash("Refreshing coupon dashboard...", "neutral");

  try {
    await Promise.all([loadHealth(), loadAnalytics(), loadCoupons()]);
    setFlash("Coupon dashboard updated.", "success");
  } catch (error) {
    setFlash(error.message || "Unable to load coupon dashboard.", "danger");
  }
}

document.getElementById("refreshButton").addEventListener("click", refreshAll);

document.getElementById("searchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.search = searchInput.value.trim();
  await refreshAll();
});

document.querySelectorAll("[data-status]").forEach((button) => {
  button.addEventListener("click", async () => {
    document.querySelectorAll("[data-status]").forEach((node) => node.classList.remove("active"));
    button.classList.add("active");
    state.status = button.dataset.status || "";
    await refreshAll();
  });
});

refreshAll();
