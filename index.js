Index.js

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
const COUPON_TOKEN_TTL_MINUTES = Number(process.env.COUPON_TOKEN_TTL_MINUTES || 10);

app.use(cors());
app.use(bodyParser.json());

const db = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: process.env.TIDB_PORT,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  waitForConnections: true,
  queueLimit: 0,
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

  const nextMeal = orderedWindows.find((window) => totalMinutes < parseTimeToMinutes(window.startTime));

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
  const lowerValue = String(value || '').trim().toLowerCase();

  if (lowerValue === 'economy') {
    return 'Economy';
  }

  if (lowerValue === 'coupon' || lowerValue === 'food stall coupon' || lowerValue === 'food stall') {
    return 'Coupon';
  }

  return null;
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
    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
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

  const defaultMealWindows = [
    ['breakfast', 'Breakfast', '07:00:00', '10:30:00', 1],
    ['lunch', 'Lunch', '12:00:00', '15:00:00', 2],
    ['dinner', 'Dinner', '18:00:00', '22:00:00', 3],
  ];

  for (const mealWindow of defaultMealWindows) {
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
      mealWindow,
    );
  }

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

async function getRecentRedemptions(selectedDate) {
  const rows = await dbQuery(
    `
      SELECT
        id,
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

  return rows;
}

async function buildAppPayload(studentId) {
  const now = getZonedNowParts();
  const [mealWindows, menus, news] = await Promise.all([
    getMealWindows(),
    getMenusForDate(now.date),
    getPublishedNews(now.dateTime),
  ]);

  const activeMeal = getActiveMeal(mealWindows, now.totalMinutes);
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

  try {
    const results = await dbQuery(
      'SELECT * FROM users WHERE student_id = ? AND password = ? LIMIT 1',
      [studentId, password],
    );

    if (results.length === 0) {
      res.status(401).json({ status: 'error', message: 'Invalid credentials' });
      return;
    }

    res.json({ status: 'success', data: results[0] });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ status: 'error', message: `Database error: ${error.message}` });
  }
});

app.post('/register', async (req, res) => {
  const { studentId, password } = req.body;

  if (!studentId || !password) {
    res.status(400).json({ status: 'error', message: 'Student ID and password are required' });
    return;
  }

  try {
    const existingUsers = await dbQuery('SELECT student_id FROM users WHERE student_id = ? LIMIT 1', [studentId]);

    if (existingUsers.length > 0) {
      res.status(400).json({ status: 'error', message: 'Student ID already registered' });
      return;
    }

    await dbQuery(
      'INSERT INTO users (student_id, password, student_name, credit_balance) VALUES (?, ?, ?, ?)',
      [studentId, password, 'New Student', 0.0],
    );

    res.json({ status: 'success', message: 'User registered successfully' });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ status: 'error', message: `Database error: ${error.message}` });
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

app.post('/coupons/issue', async (req, res) => {
  const { studentId, couponType } = req.body;
  const normalizedCouponType = sanitizeCouponType(couponType);

  if (!studentId || !normalizedCouponType) {
    res.status(400).json({ status: 'error', message: 'Student ID and a valid coupon type are required' });
    return;
  }

  try {
    const now = getZonedNowParts();
    const mealWindows = await getMealWindows();
    const activeMeal = getActiveMeal(mealWindows, now.totalMinutes);

    if (!activeMeal.isActive) {
      res.status(400).json({ status: 'error', message: 'Coupons can only be generated during cafeteria operating hours' });
      return;
    }

    const students = await dbQuery('SELECT student_id FROM users WHERE student_id = ? LIMIT 1', [studentId]);
    if (students.length === 0) {
      res.status(404).json({ status: 'error', message: 'Student not found' });
      return;
    }

    const existingRows = await dbQuery(
      `
        SELECT status
        FROM coupon_redemptions
        WHERE student_id = ?
          AND coupon_type = ?
          AND meal_code = ?
          AND DATE(issued_at) = ?
          AND status IN ('issued', 'redeemed')
        LIMIT 1
      `,
      [studentId, normalizedCouponType, activeMeal.mealCode, now.date],
    );

    if (existingRows.length > 0) {
      const message = existingRows[0].status === 'redeemed'
        ? `This ${activeMeal.mealName.toLowerCase()} ${normalizedCouponType.toLowerCase()} has already been redeemed today`
        : `This ${activeMeal.mealName.toLowerCase()} ${normalizedCouponType.toLowerCase()} QR has already been issued today`;

      res.status(409).json({ status: 'error', message });
      return;
    }

    const issuedAtDate = new Date();
    const expiresAtDate = new Date(issuedAtDate.getTime() + COUPON_TOKEN_TTL_MINUTES * 60 * 1000);
    const issuedAtParts = getZonedNowParts(issuedAtDate);
    const expiresAtParts = getZonedNowParts(expiresAtDate);

    const tokenPayload = {
      studentId,
      couponType: normalizedCouponType,
      mealCode: activeMeal.mealCode,
      mealName: activeMeal.mealName,
      issuedAt: issuedAtParts.dateTime,
      expiresAt: expiresAtParts.dateTime,
      nonce: crypto.randomBytes(8).toString('hex'),
    };

    const token = createSignedToken(tokenPayload, COUPON_TOKEN_SECRET, 'dcms-coupon');
    const tokenSignature = crypto.createHash('sha256').update(token).digest('hex');

    await dbQuery(
      `
        INSERT INTO coupon_redemptions (
          student_id,
          coupon_type,
          meal_code,
          token,
          token_signature,
          issued_at,
          expires_at,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'issued')
      `,
      [
        studentId,
        normalizedCouponType,
        activeMeal.mealCode,
        token,
        tokenSignature,
        issuedAtParts.dateTime,
        expiresAtParts.dateTime,
      ],
    );

    res.json({
      status: 'success',
      data: {
        token,
        couponType: normalizedCouponType,
        meal: activeMeal,
        issuedAt: issuedAtParts.dateTime,
        expiresAt: expiresAtParts.dateTime,
        ttlMinutes: COUPON_TOKEN_TTL_MINUTES,
      },
    });
  } catch (error) {
    console.error('Coupon issue error:', error);
    res.status(500).json({ status: 'error', message: `Unable to issue coupon: ${error.message}` });
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
    const [mealWindows, menus, news] = await Promise.all([
      getMealWindows(),
      getMenusForDate(now.date),
      getAllNews(),
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
      },
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/admin/dashboard', authenticateAdmin, async (req, res) => {
  try {
    const now = getZonedNowParts();
    const [mealWindows, menus, news, recentRedemptions, issuedSummaryRows, redeemedSummaryRows] = await Promise.all([
      getMealWindows(),
      getMenusForDate(now.date),
      getAllNews(),
      getRecentRedemptions(now.date),
      dbQuery('SELECT COUNT(*) AS total FROM coupon_redemptions WHERE DATE(issued_at) = ?', [now.date]),
      dbQuery('SELECT COUNT(*) AS total FROM coupon_redemptions WHERE DATE(redeemed_at) = ?', [now.date]),
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
    for (const mealWindow of mealWindows) {
      const { mealCode, mealName, startTime, endTime, sortOrder } = mealWindow;

      if (!mealCode || !mealName || !startTime || !endTime) {
        res.status(400).json({ status: 'error', message: 'Each meal window needs mealCode, mealName, startTime, and endTime' });
        return;
      }

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

    if (!activeMeal.isActive || activeMeal.mealCode !== record.mealCode) {
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
    const selectedDate = req.query.date || getZonedNowParts().date;
    const redemptions = await getRecentRedemptions(selectedDate);
    res.json({ status: 'success', data: redemptions });
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
