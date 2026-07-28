const express = require('express');
const bodyParser = require('body-parser');
const mysql = require('mysql');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Kuala_Lumpur';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || 'replace-this-admin-secret';
const COUPON_TOKEN_SECRET = process.env.COUPON_TOKEN_SECRET || 'replace-this-coupon-secret';
const PASSWORD_RESET_SECRET = process.env.PASSWORD_RESET_SECRET || ADMIN_TOKEN_SECRET;
const PASSWORD_RESET_CODE_TTL_MINUTES = 15;
const COUPON_TOKEN_TTL_MINUTES = Number(process.env.COUPON_TOKEN_TTL_MINUTES || 10);
const ECONOMY_COUPON_ADD_ON_OPTIONS = [
  'Extra vege',
  'Extra egg',
  'Extra chicken/fish',
  'No extra add on',
];
const ECONOMY_COUPON_ADD_ON_ALIASES = {
  'Extra chicken': 'Extra chicken/fish',
};

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('dcms_admin_portal'));

const db = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: process.env.TIDB_PORT,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  connectionLimit: 10, // Use a number here
  dateStrings: true,
  ssl: {
    rejectUnauthorized: false,
  },
});
function dbQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.query(query, params, (err, results) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(results);
    });
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

function verifyPassword(password, storedPassword) {
  const stored = String(storedPassword || '');
  const [scheme, saltHex, hashHex] = stored.split('$');

  if (scheme !== 'scrypt' || !saltHex || !hashHex) {
    return {
      matches: stored === String(password),
      needsUpgrade: stored === String(password),
    };
  }

  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return {
      matches: expected.length === actual.length && crypto.timingSafeEqual(expected, actual),
      needsUpgrade: false,
    };
  } catch (error) {
    return { matches: false, needsUpgrade: false };
  }
}

function hashPasswordResetCode(requestId, studentId, code) {
  return crypto
    .createHmac('sha256', PASSWORD_RESET_SECRET)
    .update(`${requestId}:${studentId}:${code}`)
    .digest('hex');
}

function sanitizeUser(user) {
  return {
    student_id: user.student_id,
    student_name: user.student_name,
    credit_balance: user.credit_balance,
    created_at: user.created_at,
  };
}

function verifyDatabaseConnection() {
  return new Promise((resolve, reject) => {
    db.getConnection((err, connection) => {
      if (err) {
        reject(err);
        return;
      }

      connection.ping((pingError) => {
        connection.release();

        if (pingError) {
          reject(pingError);
          return;
        }

        resolve();
      });
    });
  });
}

function getZonedNowParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') {
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
  const value = String(timeValue || '00:00:00');
  const [hours = '0', minutes = '0'] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

function isValidMealTime(timeValue) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(
    String(timeValue || '').trim(),
  );
  return Boolean(match);
}

function isValidDateKey(dateValue) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(
    String(dateValue || '').trim(),
  );
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

function toTimeLabel(timeValue) {
  const [hoursText = '0', minutesText = '0'] = String(timeValue || '00:00:00').split(':');
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const twelveHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${String(twelveHour).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function createSignedToken(payload, secret, prefix) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
  return `${prefix}.${encoded}.${signature}`;
}

function verifySignedToken(token, secret, prefix) {
  const [tokenPrefix, encoded, signature] = String(token || '').split('.');
  if (!tokenPrefix || !encoded || !signature || tokenPrefix !== prefix) {
    return null;
  }

  const expectedSignature = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
  if (expectedSignature !== signature) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (error) {
    return null;
  }
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
  const orderedWindows = [...mealWindows].sort((a, b) => a.sortOrder - b.sortOrder);

  for (const window of orderedWindows) {
    const startMinutes = parseTimeToMinutes(window.startTime);
    const endMinutes = parseTimeToMinutes(window.endTime);

    if (totalMinutes >= startMinutes && totalMinutes <= endMinutes) {
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

  const nextMealToday = orderedWindows.find(
    (window) => totalMinutes < parseTimeToMinutes(window.startTime),
  );
  const nextMeal = nextMealToday || orderedWindows[0] || null;

  return {
    isActive: false,
    mealCode: nextMeal ? nextMeal.mealCode : null,
    mealName: nextMeal ? nextMeal.mealName : null,
    startTime: nextMeal ? nextMeal.startTime : null,
    endTime: nextMeal ? nextMeal.endTime : null,
    timeLabel: nextMeal ? nextMeal.timeLabel : null,
    nextMealDay: nextMeal ? (nextMealToday ? 'today' : 'tomorrow') : null,
  };
}

function minutesToTimeString(totalMinutes) {
  const normalizedMinutes = Math.max(0, Math.min(totalMinutes, (24 * 60) - 1));
  const hours = Math.floor(normalizedMinutes / 60);
  const minutes = normalizedMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
}

function getMealReservationEndMinutes(mealWindows = []) {
  const dinnerWindow = mealWindows.find(
    (window) => String(window.mealCode || '').toLowerCase() === 'dinner',
  );
  if (dinnerWindow && isValidMealTime(dinnerWindow.endTime)) {
    return parseTimeToMinutes(dinnerWindow.endTime);
  }
  return null;
}

function getMealClaimWindow(nowParts = getZonedNowParts(), mealWindows = []) {
  const date = nowParts.date;
  const lunchWindow = mealWindows.find(
    (window) => String(window.mealCode || '').toLowerCase() === 'lunch',
  );
  const hasLunchWindow =
    lunchWindow &&
    isValidMealTime(lunchWindow.startTime) &&
    isValidMealTime(lunchWindow.endTime);
  const claimStartMinutes = hasLunchWindow
    ? parseTimeToMinutes(lunchWindow.startTime)
    : null;
  const initialClaimEndMinutes = hasLunchWindow
    ? parseTimeToMinutes(lunchWindow.endTime)
    : null;
  const reservationEndMinutes = getMealReservationEndMinutes(mealWindows);
  const isConfigured =
    claimStartMinutes != null &&
    initialClaimEndMinutes != null &&
    reservationEndMinutes != null &&
    initialClaimEndMinutes > claimStartMinutes &&
    reservationEndMinutes > initialClaimEndMinutes;
  const isInitialClaimOpen = isConfigured &&
    nowParts.totalMinutes >= claimStartMinutes &&
    nowParts.totalMinutes <= initialClaimEndMinutes;
  const isActivationOpen = isConfigured &&
    nowParts.totalMinutes >= claimStartMinutes &&
    nowParts.totalMinutes <= reservationEndMinutes;
  return {
    startsAt: isConfigured
      ? `${date} ${minutesToTimeString(claimStartMinutes)}`
      : null,
    initialClaimEndsAt: isConfigured
      ? `${date} ${minutesToTimeString(initialClaimEndMinutes)}`
      : null,
    endsAt: isConfigured
      ? `${date} ${minutesToTimeString(reservationEndMinutes)}`
      : null,
    isConfigured,
    isBefore: isConfigured && nowParts.totalMinutes < claimStartMinutes,
    isInitialClaimOpen,
    isActivationOpen,
    isOpen: isActivationOpen,
    isAfter: isConfigured && nowParts.totalMinutes > initialClaimEndMinutes,
  };
}

function normalizeResponseCouponStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'claimed') return 'CLAIMED';
  if (normalized === 'issued' || normalized === 'active') return 'ACTIVE';
  if (normalized === 'redeemed') return 'REDEEMED';
  if (normalized === 'expired') return 'EXPIRED';
  return String(status || '').toUpperCase();
}

function buildPublicCouponCode({ tokenSignature, token } = {}) {
  let signature = String(tokenSignature || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();

  if (!signature && token) {
    signature = crypto
      .createHash('sha256')
      .update(String(token))
      .digest('hex')
      .toUpperCase();
  }

  return signature ? `DCMS-${signature.slice(0, 4).padEnd(4, '0')}` : null;
}

function sanitizeCouponType(value) {
  const lowerValue = String(value || '').trim().toLowerCase();

  if (lowerValue === 'economy') {
    return 'Economy';
  }

  if (lowerValue === 'coupon' || lowerValue === 'food stall coupon' || lowerValue === 'food stall') {
    return 'Coupon';
  }

  return null;
}

function normalizeCouponAddOns(value) {
  const rawSelections = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? (() => {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [value];
          } catch (_error) {
            return [value];
          }
        })()
      : [];

  const uniqueSelections = Array.from(
    new Set(
      rawSelections
        .map((item) => {
          const normalizedItem = String(item || '').trim();
          return ECONOMY_COUPON_ADD_ON_ALIASES[normalizedItem] || normalizedItem;
        })
        .filter((item) => ECONOMY_COUPON_ADD_ON_OPTIONS.includes(item)),
    ),
  );

  if (!uniqueSelections.length) {
    return [];
  }

  const extraSelections = uniqueSelections.filter((item) => item !== 'No extra add on');
  if (extraSelections.length) {
    return extraSelections;
  }

  if (uniqueSelections.includes('No extra add on')) {
    return ['No extra add on'];
  }

  return [];
}

function getCouponAddOnsSelectSql(alias = 'addOnsRaw') {
  return `CAST(add_ons AS CHAR) AS ${alias}`;
}

async function initialiseDatabase() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS users (
      student_id VARCHAR(50) PRIMARY KEY,
      password VARCHAR(255) NOT NULL,
      student_name VARCHAR(120) DEFAULT 'New Student',
      credit_balance DECIMAL(10,2) DEFAULT 0.00,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS password_reset_requests (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      student_id VARCHAR(50) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      code_hash CHAR(64) NULL,
      requested_at DATETIME NOT NULL,
      approved_at DATETIME NULL,
      expires_at DATETIME NULL,
      used_at DATETIME NULL,
      cancelled_at DATETIME NULL,
      INDEX idx_password_reset_student (student_id, requested_at),
      INDEX idx_password_reset_status (status, requested_at)
    )
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS meal_windows (
      meal_code VARCHAR(30) PRIMARY KEY,
      meal_name VARCHAR(50) NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      sort_order INT NOT NULL
    )
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS daily_menus (
      id INT AUTO_INCREMENT PRIMARY KEY,
      menu_date DATE NOT NULL,
      meal_code VARCHAR(30) NOT NULL,
      items_json TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_menu_per_day (menu_date, meal_code)
    )
  `);

  await dbQuery(`
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

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS meal_feedback (
      id INT AUTO_INCREMENT PRIMARY KEY,
      student_id VARCHAR(50) NOT NULL,
      meal_code VARCHAR(30) NOT NULL,
      rating INT NOT NULL,
      comment TEXT NOT NULL,
      submitted_at DATETIME NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      student_id VARCHAR(50) NOT NULL,
      coupon_type VARCHAR(30) NOT NULL,
      meal_code VARCHAR(30) NOT NULL,
      add_ons JSON NULL,
      meal_date DATE NULL,
      claim_option VARCHAR(10) NULL,
      token TEXT NULL,
      token_signature VARCHAR(64) NULL,
      claimed_at DATETIME NULL,
      activated_at DATETIME NULL,
      deadline_at DATETIME NULL,
      issued_at DATETIME NOT NULL,
      expires_at DATETIME NOT NULL,
      redeemed_at DATETIME NULL,
      redeemed_by VARCHAR(120) NULL,
      status VARCHAR(20) DEFAULT 'issued',
      UNIQUE KEY unique_token_signature (token_signature),
      UNIQUE KEY unique_student_coupon_per_meal (
        student_id,
        coupon_type,
        meal_date,
        meal_code
      ),
      UNIQUE KEY unique_student_meal_claim (
        student_id,
        meal_date,
        meal_code
      )
    )
  `);

  await dbQuery(`
    ALTER TABLE coupon_redemptions
    ADD COLUMN IF NOT EXISTS add_ons JSON NULL
  `).catch(() => {});

  await dbQuery(`
    ALTER TABLE coupon_redemptions
    ADD COLUMN IF NOT EXISTS meal_date DATE NULL
  `).catch(() => {});

  await dbQuery(`
    ALTER TABLE coupon_redemptions
    ADD COLUMN IF NOT EXISTS claim_option VARCHAR(10) NULL
  `).catch(() => {});

  await dbQuery(`
    ALTER TABLE coupon_redemptions
    ADD COLUMN IF NOT EXISTS claimed_at DATETIME NULL
  `).catch(() => {});

  await dbQuery(`
    ALTER TABLE coupon_redemptions
    ADD COLUMN IF NOT EXISTS activated_at DATETIME NULL
  `).catch(() => {});

  await dbQuery(`
    ALTER TABLE coupon_redemptions
    ADD COLUMN IF NOT EXISTS deadline_at DATETIME NULL
  `).catch(() => {});

  await dbQuery(`
    ALTER TABLE coupon_redemptions
    MODIFY COLUMN token TEXT NULL
  `).catch(() => {});

  await dbQuery(`
    ALTER TABLE coupon_redemptions
    MODIFY COLUMN token_signature VARCHAR(64) NULL
  `).catch(() => {});

  await dbQuery(`
    ALTER TABLE coupon_redemptions
    ADD UNIQUE KEY unique_student_coupon_per_meal (
      student_id,
      coupon_type,
      meal_date,
      meal_code
    )
  `).catch(() => {});

  await dbQuery(`
    ALTER TABLE coupon_redemptions
    ADD UNIQUE KEY unique_student_meal_claim (
      student_id,
      meal_date,
      meal_code
    )
  `).catch(() => {});

  const now = getZonedNowParts();
  const defaultMenus = [
    ['breakfast', ['Nasi Lemak', 'Roti Canai', 'Toast & Jam', 'Coffee or Teh Tarik']],
    ['lunch', ['Chicken Rice', 'Mixed Rice (15+ dishes)', 'Vegetarian Set', 'Seasonal Fruits']],
    ['dinner', ['Fried Noodles', 'Soup Special', 'Grilled Chicken', 'Fresh Juices']],
  ];

  for (const [mealCode, menuItems] of defaultMenus) {
    await dbQuery(
      `
        INSERT IGNORE INTO daily_menus (menu_date, meal_code, items_json)
        VALUES (?, ?, ?)
      `,
      [now.date, mealCode, JSON.stringify(menuItems)],
    );
  }

  const existingNewsRows = await dbQuery('SELECT COUNT(*) AS total FROM news_posts');
  if (Number(existingNewsRows[0]?.total || 0) === 0) {
    await dbQuery(
      `
        INSERT INTO news_posts (title, body, category, status, priority, publish_at)
        VALUES
          (?, ?, ?, 'published', 2, ?),
          (?, ?, ?, 'published', 1, ?)
      `,
      [
        'Welcome to the digital cafeteria system',
        'Admin announcements that you publish from the new dashboard will appear in the mobile app automatically.',
        'System',
        now.dateTime,
        'Counter service reminder',
        'Students can redeem their breakfast, lunch, or dinner coupons only during the configured meal windows.',
        'Operations',
        now.dateTime,
      ],
    );
  }
}

async function getMealWindows() {
  const rows = await dbQuery(`
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
  const rows = await dbQuery(
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
  const rows = await dbQuery(
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

  return rows;
}

async function getAllNews() {
  const rows = await dbQuery(
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

  return rows;
}

async function getMealFeedback(limit = 100) {
  const rows = await dbQuery(
    `
      SELECT
        id,
        student_id AS studentId,
        meal_code AS mealCode,
        rating,
        comment,
        submitted_at AS submittedAt
      FROM meal_feedback
      ORDER BY submitted_at DESC
      LIMIT ?
    `,
    [Number(limit || 100)],
  );

  return rows;
}

async function expireStaleCouponRows(nowParts = getZonedNowParts()) {
  await dbQuery(
    `
      UPDATE coupon_redemptions
      SET status = 'expired'
      WHERE status = 'claimed'
        AND deadline_at IS NOT NULL
        AND deadline_at < ?
    `,
    [nowParts.dateTime],
  );

  await dbQuery(
    `
      UPDATE coupon_redemptions
      SET status = 'expired'
      WHERE status IN ('issued', 'active')
        AND expires_at IS NOT NULL
        AND expires_at < ?
    `,
    [nowParts.dateTime],
  );
}

async function syncTodayMealReservationDeadlines(
  nowParts = getZonedNowParts(),
  mealWindows = [],
) {
  const mealClaimWindow = getMealClaimWindow(nowParts, mealWindows);
  if (!mealClaimWindow.isConfigured || !mealClaimWindow.endsAt) {
    return;
  }

  const synchronizedStatus =
    nowParts.dateTime <= mealClaimWindow.endsAt ? 'claimed' : 'expired';

  await dbQuery(
    `
      UPDATE coupon_redemptions
      SET
        deadline_at = ?,
        expires_at = ?,
        status = ?
      WHERE coupon_type = 'Coupon'
        AND claim_option = 'LATER'
        AND activated_at IS NULL
        AND redeemed_at IS NULL
        AND COALESCE(meal_date, DATE(issued_at)) = ?
        AND status IN ('claimed', 'expired')
        AND (
          deadline_at IS NULL
          OR deadline_at <> ?
          OR expires_at IS NULL
          OR expires_at <> ?
          OR status <> ?
        )
    `,
    [
      mealClaimWindow.endsAt,
      mealClaimWindow.endsAt,
      synchronizedStatus,
      nowParts.date,
      mealClaimWindow.endsAt,
      mealClaimWindow.endsAt,
      synchronizedStatus,
    ],
  );
}

function mapCouponRow(row) {
  const status = normalizeResponseCouponStatus(row.status);
  return {
    ...row,
    status,
    couponCode: buildPublicCouponCode(row),
    addOns: normalizeCouponAddOns(row.addOnsRaw),
    add_ons: normalizeCouponAddOns(row.addOnsRaw),
  };
}

async function getRedemptions({
  startDate = null,
  endDate = null,
  limit = null,
} = {}) {
  await expireStaleCouponRows();
  const rangeFilter = startDate && endDate
    ? 'WHERE DATE(issued_at) BETWEEN ? AND ?'
    : '';
  const normalizedLimit = Number.isInteger(Number(limit)) && Number(limit) > 0
    ? Math.min(Number(limit), 10000)
    : null;
  const limitClause = normalizedLimit ? 'LIMIT ?' : '';
  const params = startDate && endDate ? [startDate, endDate] : [];
  if (normalizedLimit) params.push(normalizedLimit);

  const rows = await dbQuery(
    `
      SELECT
        id,
        id AS couponId,
        student_id AS studentId,
        coupon_type AS couponType,
        ${getCouponAddOnsSelectSql('addOnsRaw')},
        meal_code AS mealCode,
        meal_date AS mealDate,
        claim_option AS claimOption,
        token AS token,
        token_signature AS tokenSignature,
        issued_at AS issuedAt,
        claimed_at AS claimedAt,
        activated_at AS activatedAt,
        expires_at AS expiresAt,
        deadline_at AS deadlineAt,
        redeemed_at AS redeemedAt,
        redeemed_by AS redeemedBy,
        status
      FROM coupon_redemptions
      ${rangeFilter}
      ORDER BY COALESCE(redeemed_at, issued_at) DESC
      ${limitClause}
    `,
    params,
  );

  return rows.map(mapCouponRow);
}

async function getRecentRedemptions(selectedDate) {
  return getRedemptions({
    startDate: selectedDate,
    endDate: selectedDate,
    limit: 20,
  });
}

async function getStudentCoupons(studentId) {
  await expireStaleCouponRows();
  const rows = await dbQuery(
    `
      SELECT
        id,
        id AS couponId,
        student_id AS studentId,
        coupon_type AS couponType,
        ${getCouponAddOnsSelectSql('addOnsRaw')},
        meal_code AS mealCode,
        meal_date AS mealDate,
        claim_option AS claimOption,
        token AS token,
        token_signature AS tokenSignature,
        issued_at AS issuedAt,
        claimed_at AS claimedAt,
        activated_at AS activatedAt,
        expires_at AS expiresAt,
        deadline_at AS deadlineAt,
        redeemed_at AS redeemedAt,
        redeemed_by AS redeemedBy,
        status
      FROM coupon_redemptions
      WHERE student_id = ?
      ORDER BY issued_at DESC
      LIMIT 50
    `,
    [studentId],
  );

  return rows.map(mapCouponRow);
}

async function buildAppPayload(studentId) {
  const now = getZonedNowParts();
  const mealWindows = await getMealWindows();
  await syncTodayMealReservationDeadlines(now, mealWindows);
  const [menus, news, studentCoupons] = await Promise.all([
    getMenusForDate(now.date),
    getPublishedNews(now.dateTime),
    getStudentCoupons(studentId),
  ]);

  const activeMeal = getActiveMeal(mealWindows, now.totalMinutes);
  const mealClaimWindow = getMealClaimWindow(now, mealWindows);
  const todayCoupons = studentCoupons.filter(
    (coupon) => (coupon.mealDate || String(coupon.issuedAt || '').slice(0, 10)) === now.date,
  );
  const latestCoupons = [];
  const latestByType = new Set();
  for (const coupon of todayCoupons) {
    if (latestByType.has(coupon.couponType)) continue;
    latestCoupons.push(coupon);
    latestByType.add(coupon.couponType);
  }
  const users = await dbQuery(
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
    mealClaimWindow,
    latestCoupons,
    availableCoupons: todayCoupons.filter(
      (coupon) => coupon.status === 'CLAIMED' || coupon.status === 'ACTIVE',
    ),
    usedCoupons: studentCoupons.filter(
      (coupon) => coupon.status === 'REDEEMED' || coupon.status === 'EXPIRED',
    ),
    couponHistory: studentCoupons,
  };
}

function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';

  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ status: 'error', message: 'Admin authorization required' });
    return;
  }

  const token = authHeader.replace('Bearer ', '').trim();
  const payload = verifySignedToken(token, ADMIN_TOKEN_SECRET, 'dcms-admin');

  if (!payload || payload.exp < Date.now()) {
    res.status(401).json({ status: 'error', message: 'Admin session expired or invalid' });
    return;
  }

  req.admin = payload;
  next();
}

app.get('/health', async (req, res) => {
  try {
    const now = getZonedNowParts();
    const mealWindows = await getMealWindows();
    res.json({
      status: 'success',
      data: {
        database: 'connected',
        serverDate: now.date,
        serverTime: now.time,
        timeZone: APP_TIME_ZONE,
        activeMeal: getActiveMeal(mealWindows, now.totalMinutes),
      },
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/login', async (req, res) => {
  const { studentId, password } = req.body;

  if (!studentId || !password) {
    res.status(400).json({ status: 'error', message: 'Student ID and password are required' });
    return;
  }

  try {
    const results = await dbQuery(
      'SELECT * FROM users WHERE student_id = ? LIMIT 1',
      [String(studentId).trim()],
    );

    const user = results[0];
    const passwordResult = user
      ? verifyPassword(password, user.password)
      : { matches: false, needsUpgrade: false };

    if (!user || !passwordResult.matches) {
      res.status(401).json({ status: 'error', message: 'Invalid credentials' });
      return;
    }

    if (passwordResult.needsUpgrade) {
      await dbQuery(
        'UPDATE users SET password = ? WHERE student_id = ?',
        [hashPassword(password), user.student_id],
      );
    }

    res.json({ status: 'success', data: sanitizeUser(user) });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ status: 'error', message: `Database error: ${error.message}` });
  }
});

app.post('/register', async (req, res) => {
  const { studentId, password, studentName } = req.body;

  if (!studentId || !password) {
    res.status(400).json({ status: 'error', message: 'Student ID and password are required' });
    return;
  }
  if (String(password).length < 6 || String(password).length > 128) {
    res.status(400).json({
      status: 'error',
      message: 'Password must be between 6 and 128 characters',
    });
    return;
  }

  try {
    const normalizedStudentId = String(studentId).trim();
    const existingUsers = await dbQuery('SELECT student_id FROM users WHERE student_id = ? LIMIT 1', [normalizedStudentId]);

    if (existingUsers.length > 0) {
      res.status(400).json({ status: 'error', message: 'Student ID already registered' });
      return;
    }

    await dbQuery(
      'INSERT INTO users (student_id, password, student_name, credit_balance) VALUES (?, ?, ?, ?)',
      [
        normalizedStudentId,
        hashPassword(password),
        String(studentName || 'New Student').trim() || 'New Student',
        0.0,
      ],
    );

    res.json({ status: 'success', message: 'User registered successfully' });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ status: 'error', message: `Database error: ${error.message}` });
  }
});

app.post('/password-reset/request', async (req, res) => {
  const studentId = String(req.body?.studentId || '').trim();

  if (!studentId || studentId.length > 50) {
    res.status(400).json({ status: 'error', message: 'Enter a valid Student ID' });
    return;
  }

  try {
    const users = await dbQuery(
      'SELECT student_id FROM users WHERE student_id = ? LIMIT 1',
      [studentId],
    );

    if (users.length) {
      const now = getZonedNowParts();
      await dbQuery(
        `
          UPDATE password_reset_requests
          SET status = 'cancelled', cancelled_at = ?
          WHERE student_id = ? AND status IN ('pending', 'approved')
        `,
        [now.dateTime, studentId],
      );
      await dbQuery(
        `
          INSERT INTO password_reset_requests (student_id, status, requested_at)
          VALUES (?, 'pending', ?)
        `,
        [studentId, now.dateTime],
      );
    }

    res.json({
      status: 'success',
      message: 'If the Student ID exists, the reset request has been sent to the administrator.',
    });
  } catch (error) {
    console.error('Password reset request error:', error);
    res.status(500).json({ status: 'error', message: 'Unable to submit the reset request' });
  }
});

app.post('/password-reset/confirm', async (req, res) => {
  const studentId = String(req.body?.studentId || '').trim();
  const code = String(req.body?.code || '').trim();
  const newPassword = String(req.body?.newPassword || '');

  if (!studentId || !/^\d{6}$/.test(code)) {
    res.status(400).json({ status: 'error', message: 'Enter your Student ID and the 6-digit reset code' });
    return;
  }
  if (newPassword.length < 6 || newPassword.length > 128) {
    res.status(400).json({
      status: 'error',
      message: 'New password must be between 6 and 128 characters',
    });
    return;
  }

  try {
    const now = getZonedNowParts();
    const requests = await dbQuery(
      `
        SELECT id, student_id AS studentId, code_hash AS codeHash, expires_at AS expiresAt
        FROM password_reset_requests
        WHERE student_id = ? AND status = 'approved' AND expires_at >= ?
        ORDER BY approved_at DESC, id DESC
        LIMIT 1
      `,
      [studentId, now.dateTime],
    );
    const resetRequest = requests[0];

    if (!resetRequest) {
      res.status(400).json({
        status: 'error',
        message: 'The reset code is invalid or expired. Ask the administrator for a new code.',
      });
      return;
    }

    const suppliedHash = hashPasswordResetCode(resetRequest.id, studentId, code);
    const expectedHash = Buffer.from(String(resetRequest.codeHash || ''), 'hex');
    const actualHash = Buffer.from(suppliedHash, 'hex');
    const codeMatches = expectedHash.length === actualHash.length &&
      crypto.timingSafeEqual(expectedHash, actualHash);

    if (!codeMatches) {
      res.status(400).json({ status: 'error', message: 'The reset code is invalid or expired.' });
      return;
    }

    const updatedRequest = await dbQuery(
      `
        UPDATE password_reset_requests
        SET status = 'used', used_at = ?
        WHERE id = ? AND status = 'approved' AND expires_at >= ?
      `,
      [now.dateTime, resetRequest.id, now.dateTime],
    );

    if (updatedRequest.affectedRows !== 1) {
      res.status(400).json({ status: 'error', message: 'This reset code has already been used or expired.' });
      return;
    }

    const updatedUser = await dbQuery(
      'UPDATE users SET password = ? WHERE student_id = ?',
      [hashPassword(newPassword), studentId],
    );

    if (updatedUser.affectedRows !== 1) {
      res.status(404).json({ status: 'error', message: 'Student account not found' });
      return;
    }

    res.json({
      status: 'success',
      message: 'Password updated successfully. You can now sign in.',
    });
  } catch (error) {
    console.error('Password reset confirmation error:', error);
    res.status(500).json({ status: 'error', message: 'Unable to update the password' });
  }
});

app.get('/user/:studentId', async (req, res) => {
  const { studentId } = req.params;

  try {
    const results = await dbQuery(
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

    if (results.length === 0) {
      res.status(404).json({ status: 'error', message: 'User not found' });
      return;
    }

    res.json({ status: 'success', data: results[0] });
  } catch (error) {
    console.error('Fetch user details error:', error);
    res.status(500).json({ status: 'error', message: `Database error: ${error.message}` });
  }
});

app.get('/app/content/:studentId', async (req, res) => {
  try {
    const payload = await buildAppPayload(req.params.studentId);

    if (!payload.user) {
      res.status(404).json({ status: 'error', message: 'User not found' });
      return;
    }

    res.json({ status: 'success', data: payload });
  } catch (error) {
    console.error('App content error:', error);
    res.status(500).json({ status: 'error', message: `Unable to load app content: ${error.message}` });
  }
});

app.get('/menus/today', async (req, res) => {
  try {
    const now = getZonedNowParts();
    const menus = await getMenusForDate(now.date);
    res.json({ status: 'success', data: { date: now.date, menus } });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/news', async (req, res) => {
  try {
    const now = getZonedNowParts();
    const news = await getPublishedNews(now.dateTime);
    res.json({ status: 'success', data: news });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/feedback', async (req, res) => {
  const { studentId, mealCode, rating, comment } = req.body;
  const normalizedMealCode = String(mealCode || '').trim().toLowerCase();
  const normalizedRating = Number(rating);
  const normalizedComment = String(comment || '').trim();

  if (!studentId || !['breakfast', 'lunch', 'dinner'].includes(normalizedMealCode)) {
    res.status(400).json({ status: 'error', message: 'Student ID and a valid meal are required.' });
    return;
  }

  if (!Number.isInteger(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
    res.status(400).json({ status: 'error', message: 'Rating must be between 1 and 5.' });
    return;
  }

  if (normalizedComment.length < 5) {
    res.status(400).json({ status: 'error', message: 'Please enter at least 5 characters of feedback.' });
    return;
  }

  try {
    const students = await dbQuery('SELECT student_id FROM users WHERE student_id = ? LIMIT 1', [studentId]);
    if (students.length === 0) {
      res.status(404).json({ status: 'error', message: 'Student not found' });
      return;
    }

    const now = getZonedNowParts();
    await dbQuery(
      `
        INSERT INTO meal_feedback (
          student_id,
          meal_code,
          rating,
          comment,
          submitted_at
        ) VALUES (?, ?, ?, ?, ?)
      `,
      [
        studentId,
        normalizedMealCode,
        normalizedRating,
        normalizedComment,
        now.dateTime,
      ],
    );

    res.json({
      status: 'success',
      data: {
        studentId,
        mealCode: normalizedMealCode,
        rating: normalizedRating,
        comment: normalizedComment,
        submittedAt: now.dateTime,
      },
      message: 'Food feedback submitted successfully.',
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/coupons/issue', async (req, res) => {
  const { studentId, couponType } = req.body;
  const claimOption = String(req.body.claimOption || 'NOW').trim().toUpperCase();
  const requestedCouponId = req.body.couponId ?? req.body.id;
  const addOns = req.body.addOns ?? req.body.add_ons ?? req.body.addons;
  const normalizedCouponType = sanitizeCouponType(couponType);

  if (!studentId || !normalizedCouponType) {
    res.status(400).json({ status: 'error', message: 'Student ID and a valid coupon type are required' });
    return;
  }

  try {
    const now = getZonedNowParts();
    const mealWindows = await getMealWindows();
    await syncTodayMealReservationDeadlines(now, mealWindows);
    await expireStaleCouponRows(now);
    const activeMeal = getActiveMeal(mealWindows, now.totalMinutes);
    const mealClaimWindow = getMealClaimWindow(now, mealWindows);
    const requestedAddOns = normalizeCouponAddOns(addOns);
    const lunchMeal =
      mealWindows.find((window) => String(window.mealCode || '').toLowerCase() === 'lunch');

    if (!lunchMeal || !mealClaimWindow.isConfigured) {
      res.status(503).json({
        status: 'error',
        message: 'Meal Coupon timing is not configured. Please ask an administrator to update Lunch and Dinner hours.',
      });
      return;
    }

    if (
      normalizedCouponType === 'Coupon' &&
      !requestedCouponId &&
      !mealClaimWindow.isInitialClaimOpen
    ) {
      res.status(400).json({
        status: 'error',
        message: mealClaimWindow.isBefore
          ? `Meal Coupon claiming opens at ${toTimeLabel(lunchMeal.startTime)}.`
          : `Today's Meal Coupon claiming ended at ${toTimeLabel(lunchMeal.endTime)}.`,
      });
      return;
    }

    if (claimOption === 'LATER' && normalizedCouponType !== 'Coupon') {
      res.status(400).json({ status: 'error', message: 'Claim Later is only available for Meal Coupon.' });
      return;
    }

    if (claimOption !== 'NOW' && claimOption !== 'LATER') {
      res.status(400).json({ status: 'error', message: 'Claim option must be NOW or LATER.' });
      return;
    }

    if (normalizedCouponType !== 'Coupon' && !activeMeal.isActive) {
      res.status(400).json({ status: 'error', message: 'Coupons can only be generated during cafeteria operating hours' });
      return;
    }

    const couponMeal = normalizedCouponType === 'Coupon' ? lunchMeal : activeMeal;

    const shouldPersistAddOns =
      normalizedCouponType === 'Economy' &&
      ['lunch', 'dinner'].includes(String(activeMeal.mealCode || '').toLowerCase());
    const normalizedAddOns = shouldPersistAddOns ? requestedAddOns : [];

    if (shouldPersistAddOns && normalizedAddOns.length === 0) {
      res.status(400).json({ status: 'error', message: 'Please select at least one add-on option.' });
      return;
    }

    const students = await dbQuery('SELECT student_id FROM users WHERE student_id = ? LIMIT 1', [studentId]);
    if (students.length === 0) {
      res.status(404).json({ status: 'error', message: 'Student not found' });
      return;
    }

    const isLunchClaim =
      !requestedCouponId &&
      String(couponMeal.mealCode || '').toLowerCase() === 'lunch';
    if (isLunchClaim) {
      const lunchCouponRows = await dbQuery(
        `
          SELECT id, coupon_type AS couponType, status
          FROM coupon_redemptions
          WHERE student_id = ?
            AND COALESCE(meal_date, DATE(issued_at)) = ?
            AND meal_code = 'lunch'
          LIMIT 1
        `,
        [studentId, now.date],
      );

      if (lunchCouponRows.length > 0) {
        res.status(409).json({
          status: 'error',
          message: "You have already claimed today's lunch coupon. Only one coupon can be claimed during lunch.",
        });
        return;
      }
    }

    const existingRows = await dbQuery(
      normalizedCouponType === 'Coupon' && requestedCouponId
        ? `
          SELECT
            id,
            status,
            meal_code AS mealCode,
            meal_date AS mealDate,
            claimed_at AS claimedAt,
            deadline_at AS deadlineAt
          FROM coupon_redemptions
          WHERE id = ?
            AND student_id = ?
            AND coupon_type = ?
          LIMIT 1
        `
        : normalizedCouponType === 'Coupon'
        ? `
          SELECT
            id,
            status,
            meal_code AS mealCode,
            meal_date AS mealDate,
            claimed_at AS claimedAt,
            deadline_at AS deadlineAt
          FROM coupon_redemptions
          WHERE student_id = ?
            AND coupon_type = ?
            AND COALESCE(meal_date, DATE(issued_at)) = ?
          LIMIT 1
        `
        : `
          SELECT id, status
          FROM coupon_redemptions
          WHERE student_id = ?
            AND coupon_type = ?
            AND meal_code = ?
            AND DATE(issued_at) = ?
          LIMIT 1
        `,
      normalizedCouponType === 'Coupon' && requestedCouponId
        ? [requestedCouponId, studentId, normalizedCouponType]
        : normalizedCouponType === 'Coupon'
        ? [studentId, normalizedCouponType, now.date]
        : [studentId, normalizedCouponType, couponMeal.mealCode, now.date],
    );

    if (requestedCouponId && existingRows.length === 0) {
      res.status(404).json({ status: 'error', message: 'Meal reservation not found' });
      return;
    }

    if (existingRows.length > 0) {
      const existingStatus = String(existingRows[0].status || '').toLowerCase();
      if (
        normalizedCouponType === 'Coupon' &&
        claimOption === 'NOW' &&
        existingStatus === 'claimed'
      ) {
        const reservation = existingRows[0];
        if (reservation.deadlineAt && now.dateTime > reservation.deadlineAt) {
          await dbQuery('UPDATE coupon_redemptions SET status = ? WHERE id = ?', ['expired', reservation.id]);
          res.status(400).json({
            status: 'error',
            message: 'Meal reservation expired. Not activated before cafeteria closing time.',
          });
          return;
        }

        const reservationMeal =
          mealWindows.find((window) => window.mealCode === reservation.mealCode) ||
          lunchMeal;
        const activatedAtDate = new Date();
        const activatedAtParts = getZonedNowParts(activatedAtDate);
        const activatedExpiresAtDate = new Date(
          activatedAtDate.getTime() + COUPON_TOKEN_TTL_MINUTES * 60 * 1000,
        );
        const activatedExpiresAtParts = getZonedNowParts(activatedExpiresAtDate);
        const tokenPayload = {
          studentId,
          couponType: normalizedCouponType,
          mealCode: reservationMeal.mealCode,
          mealName: reservationMeal.mealName,
          issuedAt: activatedAtParts.dateTime,
          expiresAt: activatedExpiresAtParts.dateTime,
          nonce: crypto.randomBytes(8).toString('hex'),
        };
        const token = createSignedToken(tokenPayload, COUPON_TOKEN_SECRET, 'dcms-coupon');
        const tokenSignature = crypto.createHash('sha256').update(token).digest('hex');

        await dbQuery(
          `
            UPDATE coupon_redemptions
            SET
              meal_code = ?,
              token = ?,
              token_signature = ?,
              claim_option = 'NOW',
              activated_at = ?,
              expires_at = ?,
              status = 'issued'
            WHERE id = ?
          `,
          [
            reservationMeal.mealCode,
            token,
            tokenSignature,
            activatedAtParts.dateTime,
            activatedExpiresAtParts.dateTime,
            reservation.id,
          ],
        );

        res.json({
          status: 'success',
          data: {
            couponId: reservation.id,
            token,
            couponCode: buildPublicCouponCode({ tokenSignature }),
            couponType: normalizedCouponType,
            meal: reservationMeal,
            mealCode: reservationMeal.mealCode,
            mealDate: reservation.mealDate || now.date,
            claimOption: 'NOW',
            claimedAt: reservation.claimedAt,
            activatedAt: activatedAtParts.dateTime,
            issuedAt: activatedAtParts.dateTime,
            expiresAt: activatedExpiresAtParts.dateTime,
            deadlineAt: reservation.deadlineAt,
            ttlMinutes: COUPON_TOKEN_TTL_MINUTES,
            status: 'ACTIVE',
          },
        });
        return;
      }

      const message = existingStatus === 'redeemed'
        ? `This ${couponMeal.mealName.toLowerCase()} ${normalizedCouponType.toLowerCase()} has already been redeemed today`
        : existingStatus === 'expired'
          ? `This ${couponMeal.mealName.toLowerCase()} ${normalizedCouponType.toLowerCase()} was already claimed today and has expired`
        : existingStatus === 'claimed'
          ? "Today's meal has already been claimed. Open it from the Coupons tab to activate it."
          : `This ${couponMeal.mealName.toLowerCase()} ${normalizedCouponType.toLowerCase()} QR has already been issued today`;

      const existingCoupons = await getStudentCoupons(studentId);
      const existingCoupon = existingCoupons.find(
        (coupon) => String(coupon.couponId) === String(existingRows[0].id),
      );
      res.status(409).json({
        status: 'error',
        message,
        data: existingCoupon || null,
      });
      return;
    }

    const issuedAtDate = new Date();
    const issuedAtParts = getZonedNowParts(issuedAtDate);
    const deadlineAt = mealClaimWindow.endsAt;

    if (claimOption === 'LATER') {
      const insertResult = await dbQuery(
        `
          INSERT INTO coupon_redemptions (
            student_id,
            coupon_type,
            meal_code,
            meal_date,
            claim_option,
            claimed_at,
            issued_at,
            expires_at,
            deadline_at,
            status
          ) VALUES (?, ?, ?, ?, 'LATER', ?, ?, ?, ?, 'claimed')
        `,
        [
          studentId,
          normalizedCouponType,
          couponMeal.mealCode || 'lunch',
          now.date,
          now.dateTime,
          now.dateTime,
          deadlineAt,
          deadlineAt,
        ],
      );

      res.json({
        status: 'success',
        data: {
          couponId: insertResult?.insertId,
          couponType: normalizedCouponType,
          mealCode: couponMeal.mealCode || 'lunch',
          meal: couponMeal,
          mealDate: now.date,
          claimOption: 'LATER',
          claimedAt: now.dateTime,
          issuedAt: now.dateTime,
          deadlineAt,
          expiresAt: deadlineAt,
          status: 'CLAIMED',
        },
      });
      return;
    }

    const expiresAtDate = new Date(issuedAtDate.getTime() + COUPON_TOKEN_TTL_MINUTES * 60 * 1000);
    const expiresAtParts = getZonedNowParts(expiresAtDate);

    const tokenPayload = {
      studentId,
      couponType: normalizedCouponType,
      mealCode: couponMeal.mealCode,
      mealName: couponMeal.mealName,
      issuedAt: issuedAtParts.dateTime,
      expiresAt: expiresAtParts.dateTime,
      nonce: crypto.randomBytes(8).toString('hex'),
    };

    const token = createSignedToken(tokenPayload, COUPON_TOKEN_SECRET, 'dcms-coupon');
    const tokenSignature = crypto.createHash('sha256').update(token).digest('hex');

    const insertResult = await dbQuery(
      `
        INSERT INTO coupon_redemptions (
          student_id,
          coupon_type,
          meal_code,
          add_ons,
          meal_date,
          claim_option,
          token,
          token_signature,
          activated_at,
          issued_at,
          expires_at,
          deadline_at,
          status
        ) VALUES (?, ?, ?, ?, ?, 'NOW', ?, ?, ?, ?, ?, ?, 'issued')
      `,
      [
        studentId,
        normalizedCouponType,
        couponMeal.mealCode,
        normalizedCouponType === 'Economy' ? JSON.stringify(normalizedAddOns) : null,
        now.date,
        token,
        tokenSignature,
        issuedAtParts.dateTime,
        issuedAtParts.dateTime,
        expiresAtParts.dateTime,
        deadlineAt,
      ],
    );

    res.json({
      status: 'success',
      data: {
        couponId: insertResult?.insertId,
        token,
        couponCode: buildPublicCouponCode({ tokenSignature }),
        couponType: normalizedCouponType,
        addOns: normalizedCouponType === 'Economy' ? normalizedAddOns : [],
        add_ons: normalizedCouponType === 'Economy' ? normalizedAddOns : [],
        meal: couponMeal,
        mealCode: couponMeal.mealCode,
        mealDate: now.date,
        claimOption: 'NOW',
        issuedAt: issuedAtParts.dateTime,
        activatedAt: issuedAtParts.dateTime,
        expiresAt: expiresAtParts.dateTime,
        deadlineAt,
        ttlMinutes: COUPON_TOKEN_TTL_MINUTES,
        status: 'ACTIVE',
      },
    });
  } catch (error) {
    console.error('Coupon issue error:', error);
    if (error?.code === 'ER_DUP_ENTRY') {
      res.status(409).json({
        status: 'error',
        message: 'You have already claimed a coupon for this meal today.',
      });
      return;
    }
    res.status(500).json({ status: 'error', message: `Unable to issue coupon: ${error.message}` });
  }
});

app.post('/coupons/activate', async (req, res) => {
  const studentId = String(req.body.studentId || '').trim();
  const couponId = req.body.couponId;

  if (!studentId || !couponId) {
    res.status(400).json({ status: 'error', message: 'Student ID and coupon ID are required' });
    return;
  }

  try {
    const now = getZonedNowParts();
    const mealWindows = await getMealWindows();
    await syncTodayMealReservationDeadlines(now, mealWindows);
    await expireStaleCouponRows(now);
    const mealClaimWindow = getMealClaimWindow(now, mealWindows);
    if (!mealClaimWindow.isConfigured) {
      res.status(503).json({
        status: 'error',
        message: 'Meal Coupon timing is not configured. Please ask an administrator to update Lunch and Dinner hours.',
      });
      return;
    }
    if (!mealClaimWindow.isOpen) {
      res.status(400).json({
        status: 'error',
        message: mealClaimWindow.isBefore
          ? `Meal Coupon activation opens at ${toTimeLabel(mealWindows.find(
              (window) => String(window.mealCode || '').toLowerCase() === 'lunch',
            )?.startTime)}.`
          : `Meal reservation expired at ${toTimeLabel(mealWindows.find(
              (window) => String(window.mealCode || '').toLowerCase() === 'dinner',
            )?.endTime)}.`,
      });
      return;
    }

    const activeMeal = getActiveMeal(mealWindows, now.totalMinutes);

    const rows = await dbQuery(
      `
        SELECT
          id,
          student_id AS studentId,
          coupon_type AS couponType,
          meal_code AS mealCode,
          meal_date AS mealDate,
          claim_option AS claimOption,
          claimed_at AS claimedAt,
          deadline_at AS deadlineAt,
          status
        FROM coupon_redemptions
        WHERE id = ?
          AND student_id = ?
          AND coupon_type = 'Coupon'
        LIMIT 1
      `,
      [couponId, studentId],
    );

    const reservation = rows[0];
    if (!reservation) {
      res.status(404).json({ status: 'error', message: 'Meal reservation not found' });
      return;
    }

    if (String(reservation.status || '').toLowerCase() !== 'claimed') {
      res.status(409).json({ status: 'error', message: 'This meal coupon is no longer waiting for activation.' });
      return;
    }

    if (reservation.deadlineAt && now.dateTime > reservation.deadlineAt) {
      await dbQuery('UPDATE coupon_redemptions SET status = ? WHERE id = ?', ['expired', reservation.id]);
      res.status(400).json({ status: 'error', message: 'Meal reservation expired. Not activated before cafeteria closing time.' });
      return;
    }

    const issuedAtDate = new Date();
    const expiresAtDate = new Date(issuedAtDate.getTime() + COUPON_TOKEN_TTL_MINUTES * 60 * 1000);
    const issuedAtParts = getZonedNowParts(issuedAtDate);
    const expiresAtParts = getZonedNowParts(expiresAtDate);
    const reservationMeal =
      mealWindows.find((window) => window.mealCode === reservation.mealCode) ||
      (activeMeal.isActive ? activeMeal : null) ||
      {
        mealCode: reservation.mealCode || 'lunch',
        mealName: 'Lunch',
        timeLabel: reservation.deadlineAt
          ? `Valid until ${reservation.deadlineAt.slice(11, 16)}`
          : 'Valid until cafeteria closing time',
      };

    const tokenPayload = {
      studentId,
      couponType: 'Coupon',
      mealCode: reservationMeal.mealCode,
      mealName: reservationMeal.mealName,
      issuedAt: issuedAtParts.dateTime,
      expiresAt: expiresAtParts.dateTime,
      nonce: crypto.randomBytes(8).toString('hex'),
    };

    const token = createSignedToken(tokenPayload, COUPON_TOKEN_SECRET, 'dcms-coupon');
    const tokenSignature = crypto.createHash('sha256').update(token).digest('hex');

    await dbQuery(
      `
        UPDATE coupon_redemptions
        SET
          meal_code = ?,
          token = ?,
          token_signature = ?,
          claim_option = 'NOW',
          activated_at = ?,
          expires_at = ?,
          status = 'issued'
        WHERE id = ?
      `,
      [
        reservationMeal.mealCode,
        token,
        tokenSignature,
        issuedAtParts.dateTime,
        expiresAtParts.dateTime,
        reservation.id,
      ],
    );

    res.json({
      status: 'success',
      data: {
        couponId: reservation.id,
        token,
        couponCode: buildPublicCouponCode({ tokenSignature }),
        couponType: 'Coupon',
        meal: reservationMeal,
        mealCode: reservationMeal.mealCode,
        mealDate: reservation.mealDate,
        claimOption: 'NOW',
        claimedAt: reservation.claimedAt,
        activatedAt: issuedAtParts.dateTime,
        issuedAt: reservation.claimedAt || issuedAtParts.dateTime,
        expiresAt: expiresAtParts.dateTime,
        deadlineAt: reservation.deadlineAt,
        ttlMinutes: COUPON_TOKEN_TTL_MINUTES,
        status: 'ACTIVE',
      },
    });
  } catch (error) {
    console.error('Coupon activation error:', error);
    res.status(500).json({ status: 'error', message: `Unable to activate coupon: ${error.message}` });
  }
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    res.status(401).json({ status: 'error', message: 'Invalid admin credentials' });
    return;
  }

  const token = createSignedToken(
    {
      sub: username,
      role: 'admin',
      exp: Date.now() + 12 * 60 * 60 * 1000,
    },
    ADMIN_TOKEN_SECRET,
    'dcms-admin',
  );

  res.json({
    status: 'success',
    data: {
      token,
      profile: {
        username,
        timeZone: APP_TIME_ZONE,
      },
    },
  });
});

app.get('/admin/content', authenticateAdmin, async (req, res) => {
  try {
    const now = getZonedNowParts();
    const [mealWindows, menus, news, mealFeedback] = await Promise.all([
      getMealWindows(),
      getMenusForDate(now.date),
      getAllNews(),
      getMealFeedback(100),
    ]);

    res.json({
      status: 'success',
      data: {
        serverDate: now.date,
        serverTime: now.time,
        timeZone: APP_TIME_ZONE,
        activeMeal: getActiveMeal(mealWindows, now.totalMinutes),
        mealWindows,
        menus,
        news,
        mealFeedback,
      },
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/admin/dashboard', authenticateAdmin, async (req, res) => {
  try {
    const now = getZonedNowParts();
    const [mealWindows, menus, news, recentRedemptions, issuedSummaryRows, redeemedSummaryRows, feedbackCountRows] = await Promise.all([
      getMealWindows(),
      getMenusForDate(now.date),
      getAllNews(),
      getRecentRedemptions(now.date),
      dbQuery('SELECT COUNT(*) AS total FROM coupon_redemptions WHERE DATE(issued_at) = ?', [now.date]),
      dbQuery('SELECT COUNT(*) AS total FROM coupon_redemptions WHERE DATE(redeemed_at) = ?', [now.date]),
      dbQuery('SELECT COUNT(*) AS total FROM meal_feedback WHERE DATE(submitted_at) = ?', [now.date]),
    ]);

    res.json({
      status: 'success',
      data: {
        serverDate: now.date,
        serverTime: now.time,
        timeZone: APP_TIME_ZONE,
        activeMeal: getActiveMeal(mealWindows, now.totalMinutes),
        stats: {
          menusConfigured: menus.filter((menu) => menu.items.length > 0).length,
          publishedNews: news.filter((item) => item.status === 'published').length,
          qrIssuedToday: Number(issuedSummaryRows[0]?.total || 0),
          qrRedeemedToday: Number(redeemedSummaryRows[0]?.total || 0),
          feedbackToday: Number(feedbackCountRows[0]?.total || 0),
        },
        mealWindows,
        menus,
        news: news.slice(0, 8),
        recentRedemptions,
      },
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.put('/admin/meal-windows', authenticateAdmin, async (req, res) => {
  const { mealWindows } = req.body;

  if (!Array.isArray(mealWindows) || mealWindows.length === 0) {
    res.status(400).json({ status: 'error', message: 'Meal windows are required' });
    return;
  }

  try {
    const normalizedMealWindows = mealWindows.map((mealWindow) => ({
      ...mealWindow,
      mealCode: String(mealWindow.mealCode || '').trim().toLowerCase(),
      mealName: String(mealWindow.mealName || '').trim(),
      startTime: String(mealWindow.startTime || '').trim(),
      endTime: String(mealWindow.endTime || '').trim(),
    }));

    for (const mealWindow of normalizedMealWindows) {
      const { mealCode, mealName, startTime, endTime, sortOrder } = mealWindow;

      if (!mealCode || !mealName || !startTime || !endTime) {
        res.status(400).json({ status: 'error', message: 'Each meal window needs mealCode, mealName, startTime, and endTime' });
        return;
      }
      if (!isValidMealTime(startTime) || !isValidMealTime(endTime)) {
        res.status(400).json({
          status: 'error',
          message: `${mealName} must use a valid 24-hour start and end time.`,
        });
        return;
      }
      if (parseTimeToMinutes(endTime) <= parseTimeToMinutes(startTime)) {
        res.status(400).json({
          status: 'error',
          message: `${mealName} end time must be later than its start time.`,
        });
        return;
      }
    }

    const lunchWindow = normalizedMealWindows.find(
      (window) => window.mealCode === 'lunch',
    );
    const dinnerWindow = normalizedMealWindows.find(
      (window) => window.mealCode === 'dinner',
    );
    if (!lunchWindow || !dinnerWindow) {
      res.status(400).json({
        status: 'error',
        message: 'Lunch and Dinner windows are required for Meal Coupon timing.',
      });
      return;
    }
    if (
      parseTimeToMinutes(dinnerWindow.endTime) <=
      parseTimeToMinutes(lunchWindow.endTime)
    ) {
      res.status(400).json({
        status: 'error',
        message: 'Dinner closing time must be later than Lunch closing time for Claim Later activation.',
      });
      return;
    }

    for (const mealWindow of normalizedMealWindows) {
      const { mealCode, mealName, startTime, endTime, sortOrder } = mealWindow;
      await dbQuery(
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

    const now = getZonedNowParts();
    await syncTodayMealReservationDeadlines(now, normalizedMealWindows);
    await expireStaleCouponRows(now);

    res.json({ status: 'success', message: 'Meal windows updated successfully' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.put('/admin/menus/today', authenticateAdmin, async (req, res) => {
  const { menus } = req.body;
  const now = getZonedNowParts();

  if (!Array.isArray(menus) || menus.length === 0) {
    res.status(400).json({ status: 'error', message: 'Menus payload is required' });
    return;
  }

  try {
    for (const menu of menus) {
      if (!menu.mealCode || !Array.isArray(menu.items)) {
        res.status(400).json({ status: 'error', message: 'Each menu must contain mealCode and items' });
        return;
      }

      const sanitizedItems = menu.items
        .map((item) => String(item || '').trim())
        .filter(Boolean);

      await dbQuery(
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

    res.json({ status: 'success', message: 'Today\'s menu updated successfully' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/admin/news', authenticateAdmin, async (req, res) => {
  const { title, body, category, status, priority, publishAt, expiresAt } = req.body;

  if (!title || !body) {
    res.status(400).json({ status: 'error', message: 'Title and body are required' });
    return;
  }

  try {
    const now = getZonedNowParts();
    await dbQuery(
      `
        INSERT INTO news_posts (title, body, category, status, priority, publish_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        title,
        body,
        category || 'General',
        status || 'published',
        Number(priority || 0),
        publishAt || now.dateTime,
        expiresAt || null,
      ],
    );

    res.json({ status: 'success', message: 'News published successfully' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.put('/admin/news/:id', authenticateAdmin, async (req, res) => {
  const { title, body, category, status, priority, publishAt, expiresAt } = req.body;

  if (!title || !body) {
    res.status(400).json({ status: 'error', message: 'Title and body are required' });
    return;
  }

  try {
    await dbQuery(
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
        category || 'General',
        status || 'published',
        Number(priority || 0),
        publishAt || getZonedNowParts().dateTime,
        expiresAt || null,
        req.params.id,
      ],
    );

    res.json({ status: 'success', message: 'News updated successfully' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.delete('/admin/news/:id', authenticateAdmin, async (req, res) => {
  try {
    await dbQuery('DELETE FROM news_posts WHERE id = ?', [req.params.id]);
    res.json({ status: 'success', message: 'News deleted successfully' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/admin/qr/session', authenticateAdmin, async (req, res) => {
  const { mealCode } = req.body;

  try {
    const now = getZonedNowParts();
    const mealWindows = await getMealWindows();
    const activeMeal = getActiveMeal(mealWindows, now.totalMinutes);
    const selectedMeal = mealCode
      ? mealWindows.find((window) => window.mealCode === mealCode)
      : activeMeal.isActive
        ? mealWindows.find((window) => window.mealCode === activeMeal.mealCode)
        : mealWindows[0];

    if (!selectedMeal) {
      res.status(404).json({ status: 'error', message: 'Meal session not found' });
      return;
    }

    const qrValue = createSignedToken(
      {
        mealCode: selectedMeal.mealCode,
        mealName: selectedMeal.mealName,
        generatedAt: now.dateTime,
        timeZone: APP_TIME_ZONE,
      },
      ADMIN_TOKEN_SECRET,
      'dcms-session',
    );

    res.json({
      status: 'success',
      data: {
        qrValue,
        meal: selectedMeal,
        serverDate: now.date,
        serverTime: now.time,
      },
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/admin/qr/validate', authenticateAdmin, async (req, res) => {
  const token = String(req.body.token || '').trim();
  const operatorName = String(req.body.operatorName || req.admin.sub || 'Admin').trim();

  if (!token) {
    res.status(400).json({ status: 'error', message: 'A coupon QR token is required' });
    return;
  }

  try {
    const couponPayload = verifySignedToken(token, COUPON_TOKEN_SECRET, 'dcms-coupon');
    if (!couponPayload) {
      res.status(400).json({ status: 'error', message: 'Invalid coupon QR payload' });
      return;
    }

    const tokenSignature = crypto.createHash('sha256').update(token).digest('hex');
    const rows = await dbQuery(
      `
        SELECT
          id,
          student_id AS studentId,
          coupon_type AS couponType,
          ${getCouponAddOnsSelectSql('addOnsRaw')},
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

    if (rows.length === 0) {
      res.status(404).json({ status: 'error', message: 'This QR token does not exist in the redemption log' });
      return;
    }

    const record = rows[0];
    const now = getZonedNowParts();
    const mealWindows = await getMealWindows();
    const activeMeal = getActiveMeal(mealWindows, now.totalMinutes);

    if (record.status === 'redeemed') {
      res.status(409).json({ status: 'error', message: 'This QR code has already been redeemed' });
      return;
    }

    if (
      record.couponType !== 'Coupon' &&
      (!activeMeal.isActive || activeMeal.mealCode !== record.mealCode)
    ) {
      res.status(400).json({ status: 'error', message: 'This QR can only be scanned during the matching cafeteria meal window' });
      return;
    }

    if (now.dateTime > record.expiresAt) {
      await dbQuery('UPDATE coupon_redemptions SET status = ? WHERE id = ?', ['expired', record.id]);
      res.status(400).json({ status: 'error', message: 'This QR code has expired' });
      return;
    }

    await dbQuery(
      `
        UPDATE coupon_redemptions
        SET redeemed_at = ?, redeemed_by = ?, status = 'redeemed'
        WHERE id = ?
      `,
      [now.dateTime, operatorName, record.id],
    );

    res.json({
      status: 'success',
      data: {
        studentId: record.studentId,
        couponType: record.couponType,
        addOns: normalizeCouponAddOns(record.addOnsRaw),
        add_ons: normalizeCouponAddOns(record.addOnsRaw),
        mealCode: record.mealCode,
        redeemedAt: now.dateTime,
        redeemedBy: operatorName,
      },
      message: 'Coupon redeemed successfully',
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/admin/redemptions', authenticateAdmin, async (req, res) => {
  try {
    const selectedDate = String(req.query.date || '').trim();
    const startDate = String(req.query.startDate || '').trim();
    const endDate = String(req.query.endDate || '').trim();
    const requestedLimit = Number(req.query.limit || 5000);

    if (selectedDate && !isValidDateKey(selectedDate)) {
      res.status(400).json({ status: 'error', message: 'date must use YYYY-MM-DD.' });
      return;
    }
    if ((startDate || endDate) && (!isValidDateKey(startDate) || !isValidDateKey(endDate))) {
      res.status(400).json({
        status: 'error',
        message: 'startDate and endDate are both required in YYYY-MM-DD format.',
      });
      return;
    }
    if (startDate && endDate && startDate > endDate) {
      res.status(400).json({
        status: 'error',
        message: 'startDate must be on or before endDate.',
      });
      return;
    }

    const redemptions = await getRedemptions({
      startDate: selectedDate || startDate || null,
      endDate: selectedDate || endDate || null,
      limit: startDate && endDate ? null : requestedLimit,
    });
    res.json({ status: 'success', data: redemptions });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/admin/password-resets', authenticateAdmin, async (req, res) => {
  try {
    const resetRequests = await dbQuery(`
      SELECT
        request.id,
        request.student_id AS studentId,
        user.student_name AS studentName,
        request.status,
        request.requested_at AS requestedAt,
        request.approved_at AS approvedAt,
        request.expires_at AS expiresAt,
        request.used_at AS usedAt,
        request.cancelled_at AS cancelledAt
      FROM password_reset_requests request
      LEFT JOIN users user ON user.student_id = request.student_id
      ORDER BY request.requested_at DESC, request.id DESC
      LIMIT 200
    `);

    res.json({ status: 'success', data: resetRequests });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/admin/password-resets/:id/approve', authenticateAdmin, async (req, res) => {
  try {
    const requestId = Number(req.params.id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      res.status(400).json({ status: 'error', message: 'Invalid reset request' });
      return;
    }

    const requests = await dbQuery(
      `
        SELECT id, student_id AS studentId, status
        FROM password_reset_requests
        WHERE id = ?
        LIMIT 1
      `,
      [requestId],
    );
    const resetRequest = requests[0];
    if (!resetRequest || !['pending', 'approved'].includes(resetRequest.status)) {
      res.status(404).json({ status: 'error', message: 'Pending reset request not found' });
      return;
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const approvedAt = getZonedNowParts();
    const expiresAt = getZonedNowParts(
      new Date(Date.now() + PASSWORD_RESET_CODE_TTL_MINUTES * 60 * 1000),
    );
    const codeHash = hashPasswordResetCode(requestId, resetRequest.studentId, code);

    await dbQuery(
      `
        UPDATE password_reset_requests
        SET status = 'approved', code_hash = ?, approved_at = ?, expires_at = ?,
            used_at = NULL, cancelled_at = NULL
        WHERE id = ?
      `,
      [codeHash, approvedAt.dateTime, expiresAt.dateTime, requestId],
    );

    res.json({
      status: 'success',
      data: {
        id: requestId,
        studentId: resetRequest.studentId,
        code,
        expiresAt: expiresAt.dateTime,
      },
      message: 'One-time reset code generated',
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/admin/password-resets/:id/cancel', authenticateAdmin, async (req, res) => {
  try {
    const requestId = Number(req.params.id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      res.status(400).json({ status: 'error', message: 'Invalid reset request' });
      return;
    }

    const now = getZonedNowParts();
    const result = await dbQuery(
      `
        UPDATE password_reset_requests
        SET status = 'cancelled', cancelled_at = ?, code_hash = NULL, expires_at = NULL
        WHERE id = ? AND status IN ('pending', 'approved')
      `,
      [now.dateTime, requestId],
    );

    if (result.affectedRows !== 1) {
      res.status(404).json({ status: 'error', message: 'Active reset request not found' });
      return;
    }

    res.json({ status: 'success', message: 'Password reset request cancelled' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

async function bootstrapDatabase() {
  try {
    await verifyDatabaseConnection();
    await initialiseDatabase();
    console.log(`Connected to TiDB Cloud and initialised DCMS tables (${APP_TIME_ZONE})`);
  } catch (error) {
    console.error('Database initialisation error:', error);
  }
}

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});

bootstrapDatabase();
