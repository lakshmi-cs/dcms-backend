const crypto = require("crypto");
const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const cors = require("cors");
require("dotenv").config();

const { ping, query } = require("./db");
const {
  AppError,
  createOrder,
  expireCoupons,
  generateCoupon,
  getActiveCoupons,
  getAnalyticsSummary,
  getCouponByCode,
  getEconomyFoodItems,
  getLatestCouponForStudent,
  getStudentById,
  listCoupons,
  redeemCoupon,
} = require("./services/couponModuleService");

const APP_TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Kuala_Lumpur";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const ADMIN_TOKEN_SECRET =
  process.env.ADMIN_TOKEN_SECRET || "replace-this-admin-secret";
const COUPON_TOKEN_SECRET =
  process.env.COUPON_TOKEN_SECRET || "replace-this-coupon-secret";
const COUPON_TOKEN_TTL_MINUTES = Number(
  process.env.COUPON_TOKEN_TTL_MINUTES || 10,
);

function getZonedNowParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});

  const totalMinutes = Number(parts.hour) * 60 + Number(parts.minute);

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    dateTime: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
    totalMinutes,
  };
}

function parseTimeToMinutes(timeValue) {
  const value = String(timeValue || "00:00:00");
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function toTimeLabel(timeValue) {
  const [hoursText = "0", minutesText = "0"] = String(
    timeValue || "00:00:00",
  ).split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const suffix = hours >= 12 ? "PM" : "AM";
  const twelveHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${String(twelveHour).padStart(2, "0")}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function buildMealWindow(windowRow) {
  return {
    mealCode: windowRow.mealCode || windowRow.meal_code,
    mealName: windowRow.mealName || windowRow.meal_name,
    startTime: String(windowRow.startTime || windowRow.start_time),
    endTime: String(windowRow.endTime || windowRow.end_time),
    sortOrder: Number(windowRow.sortOrder || windowRow.sort_order || 0),
    timeLabel: `${toTimeLabel(windowRow.startTime || windowRow.start_time)} - ${toTimeLabel(windowRow.endTime || windowRow.end_time)}`,
  };
}

function getActiveMeal(mealWindows, totalMinutes) {
  const orderedWindows = [...mealWindows].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );

  for (const window of orderedWindows) {
    const startMinutes = parseTimeToMinutes(window.startTime);
    const endMinutes = parseTimeToMinutes(window.endTime);
    const wrapsPastMidnight = endMinutes < startMinutes;

    const isActive = wrapsPastMidnight
      ? totalMinutes >= startMinutes || totalMinutes <= endMinutes
      : totalMinutes >= startMinutes && totalMinutes <= endMinutes;

    if (isActive) {
      return {
        isActive: true,
        mealCode: window.mealCode,
        mealName: window.mealName,
        startTime: window.startTime,
        endTime: window.endTime,
        timeLabel: window.timeLabel,
      };
    }
  }

  const futureWindows = orderedWindows
    .map((window) => ({
      ...window,
      startMinutes: parseTimeToMinutes(window.startTime),
    }))
    .filter((window) => window.startMinutes > totalMinutes)
    .sort((a, b) => a.startMinutes - b.startMinutes);

  const nextMeal = futureWindows[0] || orderedWindows[0] || null;

  return {
    isActive: false,
    mealCode: nextMeal ? nextMeal.mealCode : null,
    mealName: nextMeal ? nextMeal.mealName : null,
    startTime: nextMeal ? nextMeal.startTime : null,
    endTime: nextMeal ? nextMeal.endTime : null,
    timeLabel: nextMeal ? nextMeal.timeLabel : null,
  };
}

function sanitizeCouponType(value) {
  const lowerValue = String(value || "").trim().toLowerCase();

  if (lowerValue === "economy") {
    return "Economy";
  }

  if (
    lowerValue === "coupon" ||
    lowerValue === "food stall coupon" ||
    lowerValue === "food stall"
  ) {
    return "Coupon";
  }

  return null;
}

function createCouponCode() {
  return `DCMS-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

function createSignedToken(payload, secret, prefix) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("hex");
  return `${prefix}.${encoded}.${signature}`;
}

function verifySignedToken(token, secret, prefix) {
  const [tokenPrefix, encoded, signature] = String(token || "").split(".");
  if (!tokenPrefix || !encoded || !signature || tokenPrefix !== prefix) {
    return null;
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("hex");

  if (expectedSignature !== signature) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (_error) {
    return null;
  }
}

async function initialisePortalTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      student_id VARCHAR(50) PRIMARY KEY,
      password VARCHAR(100) NOT NULL,
      student_name VARCHAR(120) NOT NULL,
      credit_balance DECIMAL(10, 2) DEFAULT 0.00,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS meal_windows (
      meal_code VARCHAR(30) PRIMARY KEY,
      meal_name VARCHAR(50) NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      sort_order INT NOT NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS daily_menus (
      id INT AUTO_INCREMENT PRIMARY KEY,
      menu_date DATE NOT NULL,
      meal_code VARCHAR(30) NOT NULL,
      items_json TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_menu_per_day (menu_date, meal_code)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS news_posts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(180) NOT NULL,
      body TEXT NOT NULL,
      category VARCHAR(50) DEFAULT 'General',
      status VARCHAR(20) DEFAULT 'published',
      priority INT DEFAULT 0,
      publish_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      coupon_code VARCHAR(20) NULL,
      student_id VARCHAR(50) NOT NULL,
      coupon_type VARCHAR(30) NOT NULL,
      meal_code VARCHAR(30) NOT NULL,
      token TEXT NOT NULL,
      token_signature VARCHAR(64) NOT NULL,
      issued_at DATETIME NOT NULL,
      expires_at DATETIME NOT NULL,
      redeemed_at DATETIME NULL,
      redeemed_by VARCHAR(120) NULL,
      status VARCHAR(20) DEFAULT 'issued',
      UNIQUE KEY unique_token_signature (token_signature)
    )
  `);

  await query(`
    ALTER TABLE coupon_redemptions
    ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(20) NULL
  `).catch(() => {});

  await query(`
    ALTER TABLE coupon_redemptions
    ADD UNIQUE KEY IF NOT EXISTS unique_coupon_code (coupon_code)
  `).catch(() => {});

  const defaultMealWindows = [
    ["breakfast", "Breakfast", "07:00:00", "10:30:00", 1],
    ["lunch", "Lunch", "12:00:00", "15:00:00", 2],
    ["dinner", "Dinner", "18:00:00", "22:00:00", 3],
  ];

  for (const mealWindow of defaultMealWindows) {
    await query(
      `
        INSERT INTO meal_windows (meal_code, meal_name, start_time, end_time, sort_order)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          meal_name = VALUES(meal_name),
          start_time = VALUES(start_time),
          end_time = VALUES(end_time),
          sort_order = VALUES(sort_order)
      `,
      mealWindow,
    );
  }

  const now = getZonedNowParts();
  const defaultMenus = [
    [
      "breakfast",
      ["Nasi Lemak", "Roti Canai", "Toast & Jam", "Coffee or Teh Tarik"],
    ],
    [
      "lunch",
      [
        "Chicken Rice",
        "Mixed Rice (15+ dishes)",
        "Vegetarian Set",
        "Seasonal Fruits",
      ],
    ],
    [
      "dinner",
      ["Fried Noodles", "Soup Special", "Grilled Chicken", "Fresh Juices"],
    ],
  ];

  for (const [mealCode, menuItems] of defaultMenus) {
    await query(
      `
        INSERT IGNORE INTO daily_menus (menu_date, meal_code, items_json)
        VALUES (?, ?, ?)
      `,
      [now.date, mealCode, JSON.stringify(menuItems)],
    );
  }

  const existingNewsRows = await query(
    "SELECT COUNT(*) AS total FROM news_posts",
  );
  if (Number(existingNewsRows[0]?.total || 0) === 0) {
    await query(
      `
        INSERT INTO news_posts (title, body, category, status, priority, publish_at)
        VALUES
          (?, ?, ?, 'published', 2, ?),
          (?, ?, ?, 'published', 1, ?)
      `,
      [
        "Welcome to the digital cafeteria system",
        "Admin announcements that you publish from the dashboard will appear in the mobile app automatically.",
        "System",
        now.dateTime,
        "Counter service reminder",
        "Students can redeem breakfast, lunch, or dinner coupons only during the configured meal windows.",
        "Operations",
        now.dateTime,
      ],
    );
  }
}

async function getMealWindows() {
  const rows = await query(`
    SELECT
      meal_code AS mealCode,
      meal_name AS mealName,
      start_time AS startTime,
      end_time AS endTime,
      sort_order AS sortOrder
    FROM meal_windows
    ORDER BY sort_order ASC
  `);

  return rows.map(buildMealWindow);
}

async function getMenusForDate(menuDate) {
  const rows = await query(
    `
      SELECT
        mw.meal_code AS mealCode,
        mw.meal_name AS mealName,
        mw.start_time AS startTime,
        mw.end_time AS endTime,
        mw.sort_order AS sortOrder,
        dm.items_json AS itemsJson,
        dm.updated_at AS updatedAt
      FROM meal_windows mw
      LEFT JOIN daily_menus dm
        ON dm.meal_code = mw.meal_code
       AND dm.menu_date = ?
      ORDER BY mw.sort_order ASC
    `,
    [menuDate],
  );

  return rows.map((row) => ({
    ...buildMealWindow(row),
    items: row.itemsJson ? JSON.parse(row.itemsJson) : [],
    updatedAt: row.updatedAt || null,
  }));
}

async function getPublishedNews(nowDateTime) {
  return query(
    `
      SELECT
        id,
        title,
        body,
        category,
        status,
        priority,
        publish_at AS publishAt,
        expires_at AS expiresAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM news_posts
      WHERE status = 'published'
        AND publish_at <= ?
        AND (expires_at IS NULL OR expires_at >= ?)
      ORDER BY priority DESC, publish_at DESC, created_at DESC
      LIMIT 20
    `,
    [nowDateTime, nowDateTime],
  );
}

async function getAllNews() {
  return query(
    `
      SELECT
        id,
        title,
        body,
        category,
        status,
        priority,
        publish_at AS publishAt,
        expires_at AS expiresAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM news_posts
      ORDER BY publish_at DESC, created_at DESC
      LIMIT 50
    `,
  );
}

async function getRecentRedemptions(selectedDate) {
  return query(
    `
      SELECT
        id,
        coupon_code AS couponCode,
        student_id AS studentId,
        coupon_type AS couponType,
        meal_code AS mealCode,
        issued_at AS issuedAt,
        expires_at AS expiresAt,
        redeemed_at AS redeemedAt,
        redeemed_by AS redeemedBy,
        status
      FROM coupon_redemptions
      WHERE DATE(issued_at) = ?
      ORDER BY COALESCE(redeemed_at, issued_at) DESC
      LIMIT 20
    `,
    [selectedDate],
  );
}

async function getLatestCouponsForStudentCode(studentId, mealCode = null, date = null) {
  let sql = `
      SELECT
        id,
        coupon_code AS couponCode,
        student_id AS studentId,
        coupon_type AS couponType,
        meal_code AS mealCode,
        issued_at AS issuedAt,
        expires_at AS expiresAt,
        redeemed_at AS redeemedAt,
        redeemed_by AS redeemedBy,
        status
      FROM coupon_redemptions
      WHERE student_id = ?
  `;
  const params = [studentId];

  if (mealCode && date) {
    sql += " AND meal_code = ? AND DATE(issued_at) = ? ";
    params.push(mealCode, date);
  }

  sql += " ORDER BY issued_at DESC ";

  const rows = await query(sql, params);

  if (!rows.length) {
    return [];
  }

  const latestByType = new Map();
  const now = getZonedNowParts().dateTime;

  for (const row of rows) {
    const key = String(row.couponType || "");
    if (!key || latestByType.has(key)) {
      continue;
    }

    const expiresAt = new Date(row.expiresAt);
    const serverNow = new Date(getZonedNowParts().dateTime);

    if (row.status === "issued" && expiresAt < serverNow) {
      await query(
        "UPDATE coupon_redemptions SET status = 'expired' WHERE id = ?",
        [row.id],
      );
      row.status = "expired";
    }

    latestByType.set(key, row);
  }

  return Array.from(latestByType.values());
}

function normalizeCouponStatus(value) {
  const status = String(value || "").toLowerCase();
  if (status === "issued") {
    return "ACTIVE";
  }
  if (status === "redeemed") {
    return "REDEEMED";
  }
  if (status === "expired") {
    return "EXPIRED";
  }
  return String(value || "").toUpperCase();
}

async function getStudentCoupons(studentId) {
  const rows = await query(
    `
      SELECT
        id,
        coupon_code AS couponCode,
        student_id AS studentId,
        coupon_type AS couponType,
        meal_code AS mealCode,
        issued_at AS issuedAt,
        expires_at AS expiresAt,
        redeemed_at AS redeemedAt,
        redeemed_by AS redeemedBy,
        status
      FROM coupon_redemptions
      WHERE student_id = ?
      ORDER BY issued_at DESC
      LIMIT 20
    `,
    [studentId],
  );

  const serverNow = new Date(getZonedNowParts().dateTime);
  const normalizedCoupons = [];

  for (const row of rows) {
    const expiresAt = new Date(row.expiresAt);
    if (row.status === "issued" && expiresAt < serverNow) {
      await query(
        "UPDATE coupon_redemptions SET status = 'expired' WHERE id = ?",
        [row.id],
      );
      row.status = "expired";
    }

    normalizedCoupons.push({
      ...row,
      status: normalizeCouponStatus(row.status),
    });
  }

  return normalizedCoupons;
}

async function getStudentCouponByCode(couponCode) {
  const rows = await query(
    `
      SELECT
        id,
        coupon_code AS couponCode,
        student_id AS studentId,
        coupon_type AS couponType,
        meal_code AS mealCode,
        issued_at AS issuedAt,
        expires_at AS expiresAt,
        redeemed_at AS redeemedAt,
        redeemed_by AS redeemedBy,
        status
      FROM coupon_redemptions
      WHERE coupon_code = ?
      LIMIT 1
    `,
    [couponCode],
  );

  const row = rows[0];
  if (!row) {
    return null;
  }

  const expiresAt = new Date(row.expiresAt);
  const serverNow = new Date(getZonedNowParts().dateTime);

  if (row.status === "issued" && expiresAt < serverNow) {
    await query("UPDATE coupon_redemptions SET status = 'expired' WHERE id = ?", [
      row.id,
    ]);
    row.status = "expired";
  }

  return {
    ...row,
    status: normalizeCouponStatus(row.status),
  };
}

async function buildAppPayload(studentId) {
  const now = getZonedNowParts();
  const mealWindows = await getMealWindows();
  const activeMeal = getActiveMeal(mealWindows, now.totalMinutes);

  const [menus, news, studentCoupons] = await Promise.all([
    getMenusForDate(now.date),
    getPublishedNews(now.dateTime),
    getStudentCoupons(studentId),
  ]);

  // If a meal is active, prioritize that meal's coupons.
  // Otherwise, get the latest coupons of the day to show the last used one until the next window.
  const latestCoupons = await getLatestCouponsForStudentCode(
    studentId,
    activeMeal.isActive ? activeMeal.mealCode : null,
    now.date,
  );

  const users = await query(
    `
      SELECT
        student_id AS studentId,
        student_name AS studentName,
        credit_balance AS creditBalance
      FROM users
      WHERE student_id = ?
      LIMIT 1
    `,
    [studentId],
  );

  return {
    timeZone: APP_TIME_ZONE,
    serverDate: now.date,
    serverTime: now.time,
    couponTtlMinutes: COUPON_TOKEN_TTL_MINUTES,
    activeMeal,
    mealWindows,
    menus,
    news,
    user: users[0] || null,
    latestCoupons,
    availableCoupons: studentCoupons.filter((coupon) => coupon.status === "ACTIVE"),
    usedCoupons: studentCoupons.filter(
      (coupon) => coupon.status === "REDEEMED" || coupon.status === "EXPIRED",
    ),
    couponHistory: studentCoupons,
  };
}

function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    res
      .status(401)
      .json({ status: "error", message: "Admin authorization required" });
    return;
  }

  const token = authHeader.replace("Bearer ", "").trim();
  const payload = verifySignedToken(token, ADMIN_TOKEN_SECRET, "dcms-admin");

  if (!payload || payload.exp < Date.now()) {
    res
      .status(401)
      .json({ status: "error", message: "Admin session expired or invalid" });
    return;
  }

  req.admin = payload;
  next();
}

function createApp() {
  const app = express();

  app.use(cors());
  app.use(bodyParser.json());
  app.use(
    express.static(path.resolve(__dirname, "../../../dcms_admin_portal")),
  );

  initialisePortalTables().catch((error) => {
    console.error("Portal bootstrap error:", error.message);
  });

  app.get("/health", async (_req, res, next) => {
    try {
      await ping();
      await expireCoupons();
      const now = getZonedNowParts();
      const mealWindows = await getMealWindows();
      res.json({
        status: "success",
        data: {
          database: "connected",
          serverDate: now.date,
          serverTime: now.time,
          timeZone: APP_TIME_ZONE,
          activeMeal: getActiveMeal(mealWindows, now.totalMinutes),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/login", async (req, res, next) => {
    const { studentId, password } = req.body;

    try {
      const student = await getStudentById(studentId);
      if (!student) {
        throw new AppError(401, "Invalid credentials");
      }

      const rows = await query(
        "SELECT student_id, student_name, credit_balance FROM users WHERE student_id = ? AND password = ? LIMIT 1",
        [studentId, password],
      );

      if (!rows.length) {
        throw new AppError(401, "Invalid credentials");
      }

      res.json({
        status: "success",
        data: rows[0],
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/register", async (req, res, next) => {
    const { studentId, password, studentName } = req.body;

    try {
      if (!studentId || !password) {
        throw new AppError(400, "Student ID and password are required.");
      }

      const existing = await query(
        "SELECT student_id FROM users WHERE student_id = ? LIMIT 1",
        [studentId],
      );
      if (existing.length) {
        throw new AppError(409, "Student ID already registered.");
      }

      await query(
        `
          INSERT INTO users (student_id, password, student_name, credit_balance)
          VALUES (?, ?, ?, ?)
        `,
        [studentId, password, studentName || "New Student", 0],
      );

      res.status(201).json({
        status: "success",
        message: "User registered successfully",
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/user/:studentId", async (req, res, next) => {
    try {
      const student = await getStudentById(req.params.studentId);
      if (!student) {
        throw new AppError(404, "User not found.");
      }

      res.json({
        status: "success",
        data: student,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/app/content/:studentId", async (req, res, next) => {
    try {
      const payload = await buildAppPayload(req.params.studentId);
      if (!payload.user) {
        throw new AppError(404, "User not found");
      }
      res.json({ status: "success", data: payload });
    } catch (error) {
      next(error);
    }
  });

  app.get("/menus/today", async (_req, res, next) => {
    try {
      const now = getZonedNowParts();
      const menus = await getMenusForDate(now.date);
      res.json({ status: "success", data: { date: now.date, menus } });
    } catch (error) {
      next(error);
    }
  });

  app.get("/news", async (_req, res, next) => {
    try {
      const now = getZonedNowParts();
      const news = await getPublishedNews(now.dateTime);
      res.json({ status: "success", data: news });
    } catch (error) {
      next(error);
    }
  });

  app.post("/coupons/issue", async (req, res, next) => {
    const { studentId, couponType } = req.body;
    const normalizedCouponType = sanitizeCouponType(couponType);

    try {
      if (!studentId || !normalizedCouponType) {
        throw new AppError(
          400,
          "Student ID and a valid coupon type are required",
        );
      }

      const now = getZonedNowParts();
      const mealWindows = await getMealWindows();
      const activeMeal = getActiveMeal(mealWindows, now.totalMinutes);

      if (!activeMeal.isActive) {
        throw new AppError(
          400,
          "Coupons can only be generated during cafeteria operating hours",
        );
      }

      const students = await query(
        "SELECT student_id FROM users WHERE student_id = ? LIMIT 1",
        [studentId],
      );
      if (!students.length) {
        throw new AppError(404, "Student not found");
      }

      const existingMealCoupons = await query(
        `
          SELECT
            coupon_type AS couponType,
            status,
            coupon_code AS couponCode,
            expires_at AS expiresAt
          FROM coupon_redemptions
          WHERE student_id = ?
            AND meal_code = ?
            AND DATE(issued_at) = ?
            AND status IN ('issued', 'redeemed', 'expired')
          ORDER BY issued_at DESC
        `,
        [studentId, activeMeal.mealCode, now.date],
      );

      const liveMealCoupons = [];
      for (const coupon of existingMealCoupons) {
        const expiresAt = new Date(coupon.expiresAt);
        const serverNow = new Date(now.dateTime);

        if (coupon.status === "issued" && serverNow > expiresAt) {
          await query(
            "UPDATE coupon_redemptions SET status = 'expired' WHERE coupon_code = ?",
            [coupon.couponCode],
          );
          coupon.status = "expired";
        }

        if (coupon.status !== "expired") {
          liveMealCoupons.push(coupon);
        }
      }

      if (liveMealCoupons.length) {
        const chosenCoupon = liveMealCoupons[0];
        if (chosenCoupon.couponType !== normalizedCouponType) {
          throw new AppError(
            409,
            `You already selected the ${String(chosenCoupon.couponType || "").toLowerCase()} option for ${activeMeal.mealName.toLowerCase()}. Only one coupon option can be used per meal window.`,
          );
        }
      }

      const existingRows = await query(
        `
          SELECT status, coupon_code AS couponCode, expires_at AS expiresAt
          FROM coupon_redemptions
          WHERE student_id = ?
            AND coupon_type = ?
            AND meal_code = ?
            AND DATE(issued_at) = ?
            AND status IN ('issued', 'redeemed', 'expired')
          LIMIT 1
        `,
        [studentId, normalizedCouponType, activeMeal.mealCode, now.date],
      );

      if (existingRows.length) {
        const existing = existingRows[0];
        const expiresAt = new Date(existing.expiresAt);
        const serverNow = new Date(now.dateTime);

        if (existing.status === "issued" && serverNow > expiresAt) {
          await query(
            "UPDATE coupon_redemptions SET status = 'expired' WHERE coupon_code = ?",
            [existing.couponCode],
          );
        } else {
        const message =
          existing.status === "redeemed"
            ? `This ${activeMeal.mealName.toLowerCase()} ${normalizedCouponType.toLowerCase()} has already been redeemed today`
            : existing.status === "expired"
              ? `The previous ${normalizedCouponType.toLowerCase()} coupon already expired. Please contact cafeteria staff if reissue is needed.`
              : `This ${activeMeal.mealName.toLowerCase()} ${normalizedCouponType.toLowerCase()} coupon has already been issued today`;
        throw new AppError(409, message);
        }
      }

      const issuedAtDate = new Date();
      const ttlExpiresAtDate = new Date(
        issuedAtDate.getTime() + COUPON_TOKEN_TTL_MINUTES * 60 * 1000,
      );

      let finalExpiresAtDate = ttlExpiresAtDate;
      if (activeMeal && activeMeal.endTime) {
        try {
          const [endH, endM] = activeMeal.endTime.split(":");
          const windowEndDate = new Date(issuedAtDate);
          windowEndDate.setHours(parseInt(endH, 10), parseInt(endM, 10), 0, 0);

          if (windowEndDate > issuedAtDate && windowEndDate < ttlExpiresAtDate) {
            finalExpiresAtDate = windowEndDate;
          }
        } catch (e) {
          console.error("Error capping expiry by meal window:", e);
        }
      }

      const issuedAtParts = getZonedNowParts(issuedAtDate);
      const expiresAtParts = getZonedNowParts(finalExpiresAtDate);

      let couponCode = createCouponCode();
      let duplicateFound = true;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const duplicate = await query(
          "SELECT id FROM coupon_redemptions WHERE coupon_code = ? LIMIT 1",
          [couponCode],
        );
        if (!duplicate.length) {
          duplicateFound = false;
          break;
        }
        couponCode = createCouponCode();
      }

      if (duplicateFound) {
        throw new AppError(
          500,
          "Unable to generate a unique coupon code. Please try again.",
        );
      }

      const tokenSignature = crypto
        .createHash("sha256")
        .update(couponCode)
        .digest("hex");

      await query(
        `
          INSERT INTO coupon_redemptions (
            coupon_code,
            student_id,
            coupon_type,
            meal_code,
            token,
            token_signature,
            issued_at,
            expires_at,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued')
        `,
        [
          couponCode,
          studentId,
          normalizedCouponType,
          activeMeal.mealCode,
          couponCode,
          tokenSignature,
          issuedAtParts.dateTime,
          expiresAtParts.dateTime,
        ],
      );

      res.json({
        status: "success",
        data: {
          couponCode,
          couponId: couponCode,
          couponType: normalizedCouponType,
          meal: activeMeal,
          issuedAt: issuedAtParts.dateTime,
          expiresAt: expiresAtParts.dateTime,
          ttlMinutes: COUPON_TOKEN_TTL_MINUTES,
          status: "ACTIVE",
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/coupons/:couponCode/status", async (req, res, next) => {
    try {
      const coupon = await getStudentCouponByCode(req.params.couponCode);
      if (!coupon) {
        throw new AppError(404, "Coupon not found");
      }

      res.json({
        status: "success",
        data: coupon,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/admin/login", async (req, res, next) => {
    try {
      const { username, password } = req.body;

      if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
        throw new AppError(401, "Invalid admin credentials");
      }

      const token = createSignedToken(
        {
          sub: username,
          role: "admin",
          exp: Date.now() + 12 * 60 * 60 * 1000,
        },
        ADMIN_TOKEN_SECRET,
        "dcms-admin",
      );

      res.json({
        status: "success",
        data: {
          token,
          profile: {
            username,
            timeZone: APP_TIME_ZONE,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/admin/content", authenticateAdmin, async (_req, res, next) => {
    try {
      const now = getZonedNowParts();
      const [mealWindows, menus, news] = await Promise.all([
        getMealWindows(),
        getMenusForDate(now.date),
        getAllNews(),
      ]);

      res.json({
        status: "success",
        data: {
          serverDate: now.date,
          serverTime: now.time,
          timeZone: APP_TIME_ZONE,
          activeMeal: getActiveMeal(mealWindows, now.totalMinutes),
          mealWindows,
          menus,
          news,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/admin/dashboard", authenticateAdmin, async (_req, res, next) => {
    try {
      const now = getZonedNowParts();
      const [
        mealWindows,
        menus,
        news,
        recentRedemptions,
        issuedSummaryRows,
        redeemedSummaryRows,
        registeredStudentsRows,
      ] = await Promise.all([
        getMealWindows(),
        getMenusForDate(now.date),
        getAllNews(),
        getRecentRedemptions(now.date),
        query(
          "SELECT COUNT(*) AS total FROM coupon_redemptions WHERE DATE(issued_at) = ?",
          [now.date],
        ),
        query(
          "SELECT COUNT(*) AS total FROM coupon_redemptions WHERE DATE(redeemed_at) = ?",
          [now.date],
        ),
        query("SELECT COUNT(*) AS total FROM users"),
      ]);

      res.json({
        status: "success",
        data: {
          serverDate: now.date,
          serverTime: now.time,
          timeZone: APP_TIME_ZONE,
          activeMeal: getActiveMeal(mealWindows, now.totalMinutes),
          stats: {
            menusConfigured: menus.filter((menu) => menu.items.length > 0).length,
            publishedNews: news.filter((item) => item.status === "published")
              .length,
            qrIssuedToday: Number(issuedSummaryRows[0]?.total || 0),
            qrRedeemedToday: Number(redeemedSummaryRows[0]?.total || 0),
            registeredStudents: Number(registeredStudentsRows[0]?.total || 0),
            activeStudentsToday: new Set(
              recentRedemptions.map((item) => item.studentId),
            ).size,
          },
          mealWindows,
          menus,
          news: news.slice(0, 8),
          recentRedemptions,
          analytics: {
            weeklyTrend: [],
            mealBreakdown: [],
            couponBreakdown: [],
          },
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.put("/admin/meal-windows", authenticateAdmin, async (req, res, next) => {
    try {
      const { mealWindows } = req.body;
      if (!Array.isArray(mealWindows) || !mealWindows.length) {
        throw new AppError(400, "Meal windows are required");
      }

      for (const mealWindow of mealWindows) {
        const { mealCode, mealName, startTime, endTime, sortOrder } =
          mealWindow;

        if (!mealCode || !mealName || !startTime || !endTime) {
          throw new AppError(
            400,
            "Each meal window needs mealCode, mealName, startTime, and endTime",
          );
        }

        await query(
          `
            INSERT INTO meal_windows (meal_code, meal_name, start_time, end_time, sort_order)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              meal_name = VALUES(meal_name),
              start_time = VALUES(start_time),
              end_time = VALUES(end_time),
              sort_order = VALUES(sort_order)
          `,
          [mealCode, mealName, startTime, endTime, Number(sortOrder || 0)],
        );
      }

      res.json({ status: "success", message: "Meal windows updated successfully" });
    } catch (error) {
      next(error);
    }
  });

  app.put("/admin/menus/today", authenticateAdmin, async (req, res, next) => {
    try {
      const { menus } = req.body;
      const now = getZonedNowParts();

      if (!Array.isArray(menus) || !menus.length) {
        throw new AppError(400, "Menus payload is required");
      }

      for (const menu of menus) {
        if (!menu.mealCode || !Array.isArray(menu.items)) {
          throw new AppError(
            400,
            "Each menu must contain mealCode and items",
          );
        }

        const sanitizedItems = menu.items
          .map((item) => String(item || "").trim())
          .filter(Boolean);

        await query(
          `
            INSERT INTO daily_menus (menu_date, meal_code, items_json)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE
              items_json = VALUES(items_json),
              updated_at = CURRENT_TIMESTAMP
          `,
          [now.date, menu.mealCode, JSON.stringify(sanitizedItems)],
        );
      }

      res.json({
        status: "success",
        message: "Today's menu updated successfully",
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/admin/news", authenticateAdmin, async (req, res, next) => {
    try {
      const { title, body, category, status, priority, publishAt, expiresAt } =
        req.body;

      if (!title || !body) {
        throw new AppError(400, "Title and body are required");
      }

      const now = getZonedNowParts();
      await query(
        `
          INSERT INTO news_posts (title, body, category, status, priority, publish_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          title,
          body,
          category || "General",
          status || "published",
          Number(priority || 0),
          publishAt || now.dateTime,
          expiresAt || null,
        ],
      );

      res.json({ status: "success", message: "News published successfully" });
    } catch (error) {
      next(error);
    }
  });

  app.put("/admin/news/:id", authenticateAdmin, async (req, res, next) => {
    try {
      const { title, body, category, status, priority, publishAt, expiresAt } =
        req.body;

      if (!title || !body) {
        throw new AppError(400, "Title and body are required");
      }

      await query(
        `
          UPDATE news_posts
          SET
            title = ?,
            body = ?,
            category = ?,
            status = ?,
            priority = ?,
            publish_at = ?,
            expires_at = ?
          WHERE id = ?
        `,
        [
          title,
          body,
          category || "General",
          status || "published",
          Number(priority || 0),
          publishAt || getZonedNowParts().dateTime,
          expiresAt || null,
          req.params.id,
        ],
      );

      res.json({ status: "success", message: "News updated successfully" });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/admin/news/:id", authenticateAdmin, async (req, res, next) => {
    try {
      await query("DELETE FROM news_posts WHERE id = ?", [req.params.id]);
      res.json({ status: "success", message: "News deleted successfully" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/admin/qr/session", authenticateAdmin, async (req, res, next) => {
    try {
      const { mealCode } = req.body;
      const now = getZonedNowParts();
      const mealWindows = await getMealWindows();
      const activeMeal = getActiveMeal(mealWindows, now.totalMinutes);
      const selectedMeal = mealCode
        ? mealWindows.find((window) => window.mealCode === mealCode)
        : activeMeal.isActive
          ? mealWindows.find(
              (window) => window.mealCode === activeMeal.mealCode,
            )
          : mealWindows[0];

      if (!selectedMeal) {
        throw new AppError(404, "Meal session not found");
      }

      const qrValue = createSignedToken(
        {
          mealCode: selectedMeal.mealCode,
          mealName: selectedMeal.mealName,
          generatedAt: now.dateTime,
          timeZone: APP_TIME_ZONE,
        },
        ADMIN_TOKEN_SECRET,
        "dcms-session",
      );

      res.json({
        status: "success",
        data: {
          qrValue,
          meal: selectedMeal,
          serverDate: now.date,
          serverTime: now.time,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/admin/qr/validate", authenticateAdmin, async (req, res, next) => {
    try {
      const token = String(req.body.token || "").trim();
      const operatorName = String(
        req.body.operatorName || req.admin.sub || "Admin",
      ).trim();

      if (!token) {
        throw new AppError(400, "A coupon QR token is required");
      }

      const couponPayload = verifySignedToken(
        token,
        COUPON_TOKEN_SECRET,
        "dcms-coupon",
      );
      if (!couponPayload) {
        throw new AppError(400, "Invalid coupon QR payload");
      }

      const tokenSignature = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

      const rows = await query(
        `
          SELECT
            id,
            student_id AS studentId,
            coupon_type AS couponType,
            meal_code AS mealCode,
            issued_at AS issuedAt,
            expires_at AS expiresAt,
            redeemed_at AS redeemedAt,
            status
          FROM coupon_redemptions
          WHERE token_signature = ?
          LIMIT 1
        `,
        [tokenSignature],
      );

      if (!rows.length) {
        throw new AppError(
          404,
          "This QR token does not exist in the redemption log",
        );
      }

      const record = rows[0];
      const now = getZonedNowParts();
      const mealWindows = await getMealWindows();
      const activeMeal = getActiveMeal(mealWindows, now.totalMinutes);

      if (record.status === "redeemed") {
        throw new AppError(409, "This QR code has already been redeemed");
      }

      if (!activeMeal.isActive || activeMeal.mealCode !== record.mealCode) {
        throw new AppError(
          400,
          "This QR can only be scanned during the matching cafeteria meal window",
        );
      }

      if (now.dateTime > record.expiresAt) {
        await query("UPDATE coupon_redemptions SET status = ? WHERE id = ?", [
          "expired",
          record.id,
        ]);
        throw new AppError(400, "This QR code has expired");
      }

      await query(
        `
          UPDATE coupon_redemptions
          SET redeemed_at = ?, redeemed_by = ?, status = 'redeemed'
          WHERE id = ?
        `,
        [now.dateTime, operatorName, record.id],
      );

      res.json({
        status: "success",
        data: {
          studentId: record.studentId,
          couponType: record.couponType,
          mealCode: record.mealCode,
          redeemedAt: now.dateTime,
          redeemedBy: operatorName,
        },
        message: "Coupon redeemed successfully",
      });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/admin/coupons/redeem",
    authenticateAdmin,
    async (req, res, next) => {
      try {
        const couponCode = String(req.body.couponCode || "").trim();
        const operatorName = String(
          req.body.operatorName || req.admin.sub || "Admin",
        ).trim();

        if (!couponCode) {
          throw new AppError(400, "Coupon code is required");
        }

        const rows = await query(
          `
            SELECT
              id,
              coupon_code AS couponCode,
              student_id AS studentId,
              coupon_type AS couponType,
              meal_code AS mealCode,
              issued_at AS issuedAt,
              expires_at AS expiresAt,
              redeemed_at AS redeemedAt,
              status
            FROM coupon_redemptions
            WHERE coupon_code = ?
            LIMIT 1
          `,
          [couponCode],
        );

        if (!rows.length) {
          throw new AppError(404, "Coupon not found");
        }

        const record = rows[0];
        const now = getZonedNowParts();

        if (record.status === "redeemed") {
          throw new AppError(409, "This coupon has already been redeemed");
        }

        if (record.expiresAt < now.dateTime || record.status === "expired") {
          await query(
            "UPDATE coupon_redemptions SET status = 'expired' WHERE id = ?",
            [record.id],
          );
          throw new AppError(400, "This coupon has expired");
        }

        await query(
          `
            UPDATE coupon_redemptions
            SET redeemed_at = ?, redeemed_by = ?, status = 'redeemed'
            WHERE id = ?
          `,
          [now.dateTime, operatorName, record.id],
        );

        res.json({
          status: "success",
          data: {
            couponCode: record.couponCode,
            studentId: record.studentId,
            couponType: record.couponType,
            mealCode: record.mealCode,
            redeemedAt: now.dateTime,
            redeemedBy: operatorName,
            status: "REDEEMED",
          },
          message: "Coupon redeemed successfully",
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/admin/redemptions", authenticateAdmin, async (req, res, next) => {
    try {
      const selectedDate = req.query.date || getZonedNowParts().date;
      const redemptions = await getRecentRedemptions(selectedDate);
      res.json({ status: "success", data: redemptions });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/food-items", async (req, res, next) => {
    try {
      const items = await getEconomyFoodItems({
        onlyAvailable: req.query.available !== "false",
      });

      res.json({
        status: "success",
        data: items,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/orders", async (req, res, next) => {
    try {
      const { studentId, foodItemId } = req.body;
      if (!studentId || !foodItemId) {
        throw new AppError(400, "studentId and foodItemId are required.");
      }

      const result = await createOrder({ studentId, foodItemId });
      res.status(201).json({
        status: "success",
        message: "Economy food order created and coupon generated.",
        data: result,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/coupons/generate", async (req, res, next) => {
    try {
      const { studentId, orderId } = req.body;
      if (!studentId || !orderId) {
        throw new AppError(400, "studentId and orderId are required.");
      }

      const coupon = await generateCoupon({ studentId, orderId });
      res.status(201).json({
        status: "success",
        data: coupon,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get(
    "/api/students/:studentId/coupons/latest",
    async (req, res, next) => {
      try {
        const coupon = await getLatestCouponForStudent(req.params.studentId);
        res.json({
          status: "success",
          data: coupon,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/api/coupons/:couponCode/status", async (req, res, next) => {
    try {
      const coupon = await getCouponByCode(req.params.couponCode);
      if (!coupon) {
        throw new AppError(404, "Coupon not found.");
      }

      res.json({
        status: "success",
        data: coupon,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/coupons/:couponCode/redeem", async (req, res, next) => {
    try {
      const coupon = await redeemCoupon({
        couponCode: req.params.couponCode,
        operatorName: req.body.operatorName,
      });

      res.json({
        status: "success",
        message: "Coupon redeemed successfully.",
        data: coupon,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/coupons/active", async (_req, res, next) => {
    try {
      const coupons = await getActiveCoupons();
      res.json({
        status: "success",
        data: coupons,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/coupons", async (req, res, next) => {
    try {
      const coupons = await listCoupons({
        status: req.query.status,
        search: req.query.search,
        limit: req.query.limit,
      });

      res.json({
        status: "success",
        data: coupons,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/analytics/summary", async (_req, res, next) => {
    try {
      const analytics = await getAnalyticsSummary();
      res.json({
        status: "success",
        data: analytics,
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      status: "error",
      message: error.message || "Internal server error",
    });
  });

  setInterval(() => {
    expireCoupons().catch((error) => {
      console.error("Auto-expiry job failed:", error.message);
    });
  }, 10 * 1000);

  return app;
}

module.exports = {
  createApp,
};
