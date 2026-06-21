const { query, withTransaction } = require("../db");
const { addMinutes, mapCouponRow, randomCouponCode } = require("../utils/coupon");

const ACTIVE = "ACTIVE";
const REDEEMED = "REDEEMED";
const EXPIRED = "EXPIRED";
const ORDER_TYPE = "ECONOMY_FOOD";

class AppError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function expireCoupons(connection) {
  // We keep expiry authoritative on the backend so the app and admin portal
  // always see the same coupon state even if a client is offline or delayed.
  
  // 1. Expire legacy coupons table
  await query(
    `
      UPDATE coupons
      SET status = ?
      WHERE status = ?
        AND expires_at <= NOW()
    `,
    [EXPIRED, ACTIVE],
    connection,
  );

  // 2. Expire new coupon_redemptions table used by mobile app
  await query(
    `
      UPDATE coupon_redemptions
      SET status = 'expired'
      WHERE status = 'issued'
        AND expires_at <= NOW()
    `,
    [],
    connection,
  ).catch(err => {
    // If table doesn't exist yet, ignore
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
  });
}

async function getStudentById(studentId, connection) {
  const rows = await query(
    `
      SELECT student_id, student_name, credit_balance
      FROM users
      WHERE student_id = ?
      LIMIT 1
    `,
    [studentId],
    connection,
  );

  return rows[0] || null;
}

async function getEconomyFoodItems({ onlyAvailable = true } = {}) {
  const params = [];
  let sql = `
    SELECT
      food_item_id,
      item_name,
      description,
      price,
      category,
      is_available,
      available_from,
      available_until,
      created_at
    FROM food_items
    WHERE category = 'ECONOMY_FOOD'
  `;

  if (onlyAvailable) {
    sql += " AND is_available = 1";
  }

  sql += " ORDER BY item_name ASC";

  const rows = await query(sql, params);
  return rows.map((row) => ({
    foodItemId: row.food_item_id,
    itemName: row.item_name,
    description: row.description,
    price: Number(row.price),
    category: row.category,
    isAvailable: Boolean(row.is_available),
    availableFrom: row.available_from,
    availableUntil: row.available_until,
    createdAt: row.created_at,
  }));
}

async function generateUniqueCouponCode(connection) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = randomCouponCode();
    const rows = await query(
      "SELECT coupon_id FROM coupons WHERE coupon_code = ? LIMIT 1",
      [candidate],
      connection,
    );

    if (!rows.length) {
      return candidate;
    }
  }

  throw new AppError(500, "Unable to generate a unique coupon code. Please try again.");
}

async function createCouponForOrder({ studentId, orderId }, connection) {
  const existingRows = await query(
    `
      SELECT
        c.*,
        o.food_item_id,
        f.item_name AS food_name,
        o.price,
        u.student_name
      FROM coupons c
      INNER JOIN orders o ON o.order_id = c.order_id
      INNER JOIN food_items f ON f.food_item_id = o.food_item_id
      INNER JOIN users u ON u.student_id = c.student_id
      WHERE c.order_id = ?
      LIMIT 1
    `,
    [orderId],
    connection,
  );

  if (existingRows.length) {
    return mapCouponRow(existingRows[0]);
  }

  const couponCode = await generateUniqueCouponCode(connection);
  const createdAt = new Date();
  const expiresAt = addMinutes(createdAt, 5);

  const insertResult = await query(
    `
      INSERT INTO coupons (
        coupon_code,
        student_id,
        order_id,
        created_at,
        expires_at,
        status
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    [couponCode, studentId, orderId, createdAt, expiresAt, ACTIVE],
    connection,
  );

  const rows = await query(
    `
      SELECT
        c.*,
        o.food_item_id,
        f.item_name AS food_name,
        o.price,
        u.student_name
      FROM coupons c
      INNER JOIN orders o ON o.order_id = c.order_id
      INNER JOIN food_items f ON f.food_item_id = o.food_item_id
      INNER JOIN users u ON u.student_id = c.student_id
      WHERE c.coupon_id = ?
      LIMIT 1
    `,
    [insertResult.insertId],
    connection,
  );

  return mapCouponRow(rows[0]);
}

async function createOrder({ studentId, foodItemId }) {
  return withTransaction(async (connection) => {
    await expireCoupons(connection);

    const student = await getStudentById(studentId, connection);
    if (!student) {
      throw new AppError(404, "Student not found.");
    }

    const foodRows = await query(
      `
        SELECT food_item_id, item_name, description, price, category, is_available
        FROM food_items
        WHERE food_item_id = ?
        LIMIT 1
      `,
      [foodItemId],
      connection,
    );

    const foodItem = foodRows[0];
    if (!foodItem || foodItem.category !== ORDER_TYPE || !foodItem.is_available) {
      throw new AppError(400, "Selected food item is not available for economy food redemption.");
    }

    const duplicateRows = await query(
      `
        SELECT order_id
        FROM orders
        WHERE student_id = ?
          AND order_type = ?
          AND claim_date = CURDATE()
        LIMIT 1
      `,
      [studentId, ORDER_TYPE],
      connection,
    );

    if (duplicateRows.length) {
      throw new AppError(409, "Only one economy food order is allowed per student per day.");
    }

    const orderResult = await query(
      `
        INSERT INTO orders (
          student_id,
          food_item_id,
          order_type,
          payment_status,
          price,
          claim_date,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, 'PAID', ?, CURDATE(), NOW(), NOW())
      `,
      [studentId, foodItemId, ORDER_TYPE, foodItem.price],
      connection,
    );

    const orderRows = await query(
      `
        SELECT
          o.order_id,
          o.student_id,
          u.student_name,
          o.food_item_id,
          f.item_name AS food_name,
          o.order_type,
          o.payment_status,
          o.price,
          o.claim_date,
          o.created_at
        FROM orders o
        INNER JOIN users u ON u.student_id = o.student_id
        INNER JOIN food_items f ON f.food_item_id = o.food_item_id
        WHERE o.order_id = ?
        LIMIT 1
      `,
      [orderResult.insertId],
      connection,
    );

    const coupon = await createCouponForOrder(
      {
        studentId,
        orderId: orderResult.insertId,
      },
      connection,
    );

    return {
      order: {
        orderId: orderRows[0].order_id,
        studentId: orderRows[0].student_id,
        studentName: orderRows[0].student_name,
        foodItemId: orderRows[0].food_item_id,
        foodName: orderRows[0].food_name,
        orderType: orderRows[0].order_type,
        paymentStatus: orderRows[0].payment_status,
        price: Number(orderRows[0].price),
        claimDate: orderRows[0].claim_date,
        createdAt: orderRows[0].created_at,
      },
      coupon,
    };
  });
}

async function generateCoupon({ studentId, orderId }) {
  return withTransaction(async (connection) => {
    await expireCoupons(connection);

    const orderRows = await query(
      `
        SELECT order_id, student_id, payment_status
        FROM orders
        WHERE order_id = ?
        LIMIT 1
      `,
      [orderId],
      connection,
    );

    const order = orderRows[0];
    if (!order) {
      throw new AppError(404, "Order not found.");
    }

    if (String(order.student_id) !== String(studentId)) {
      throw new AppError(400, "Order does not belong to the provided student.");
    }

    if (order.payment_status !== "PAID") {
      throw new AppError(400, "Coupon can only be generated for a paid order.");
    }

    return createCouponForOrder({ studentId, orderId }, connection);
  });
}

async function getCouponByCode(couponCode, connection) {
  if (connection) {
    await expireCoupons(connection);
  } else {
    await expireCoupons();
  }

  const rows = await query(
    `
      SELECT
        c.*,
        o.food_item_id,
        f.item_name AS food_name,
        o.price,
        u.student_name
      FROM coupons c
      INNER JOIN orders o ON o.order_id = c.order_id
      INNER JOIN food_items f ON f.food_item_id = o.food_item_id
      INNER JOIN users u ON u.student_id = c.student_id
      WHERE c.coupon_code = ?
      LIMIT 1
    `,
    [couponCode],
    connection,
  );

  return mapCouponRow(rows[0]);
}

async function getLatestCouponForStudent(studentId) {
  await expireCoupons();

  const rows = await query(
    `
      SELECT
        c.*,
        o.food_item_id,
        f.item_name AS food_name,
        o.price,
        u.student_name
      FROM coupons c
      INNER JOIN orders o ON o.order_id = c.order_id
      INNER JOIN food_items f ON f.food_item_id = o.food_item_id
      INNER JOIN users u ON u.student_id = c.student_id
      WHERE c.student_id = ?
      ORDER BY c.created_at DESC
      LIMIT 1
    `,
    [studentId],
  );

  return mapCouponRow(rows[0]);
}

async function redeemCoupon({ couponCode, operatorName }) {
  return withTransaction(async (connection) => {
    await expireCoupons(connection);

    const rows = await query(
      `
        SELECT
          c.*,
          o.food_item_id,
          f.item_name AS food_name,
          o.price,
          u.student_name
        FROM coupons c
        INNER JOIN orders o ON o.order_id = c.order_id
        INNER JOIN food_items f ON f.food_item_id = o.food_item_id
        INNER JOIN users u ON u.student_id = c.student_id
        WHERE c.coupon_code = ?
        LIMIT 1
      `,
      [couponCode],
      connection,
    );

    const coupon = mapCouponRow(rows[0]);
    if (!coupon) {
      throw new AppError(404, "Coupon not found.");
    }

    if (coupon.status === REDEEMED) {
      throw new AppError(409, "This coupon has already been redeemed.");
    }

    if (coupon.status === EXPIRED) {
      throw new AppError(410, "This coupon has expired and can no longer be redeemed.");
    }

    // The status guard in the WHERE clause prevents double redemption if two
    // admins try to redeem the same coupon at nearly the same moment.
    const redemptionTime = new Date();
    await query(
      `
        UPDATE coupons
        SET status = ?, redeemed_at = ?, redeemed_by = ?
        WHERE coupon_id = ?
          AND status = ?
      `,
      [REDEEMED, redemptionTime, operatorName || "Admin", coupon.couponId, ACTIVE],
      connection,
    );

    const updatedCoupon = await getCouponByCode(couponCode, connection);
    return updatedCoupon;
  });
}

async function listCoupons({ status, search, limit = 100 }) {
  await expireCoupons();

  const whereClauses = [];
  const params = [];

  if (status) {
    whereClauses.push("c.status = ?");
    params.push(status);
  }

  if (search) {
    whereClauses.push("(c.coupon_code LIKE ? OR c.student_id LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }

  const sql = `
    SELECT
      c.*,
      o.food_item_id,
      f.item_name AS food_name,
      o.price,
      u.student_name
    FROM coupons c
    INNER JOIN orders o ON o.order_id = c.order_id
    INNER JOIN food_items f ON f.food_item_id = o.food_item_id
    INNER JOIN users u ON u.student_id = c.student_id
    ${whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : ""}
    ORDER BY c.created_at DESC
    LIMIT ?
  `;

  params.push(Number(limit) || 100);
  const rows = await query(sql, params);
  return rows.map(mapCouponRow);
}

async function getActiveCoupons() {
  return listCoupons({ status: ACTIVE });
}

async function getAnalyticsSummary() {
  await expireCoupons();

  const [totalsRows, peakHoursRows, popularFoodRows, activeRows] = await Promise.all([
    query(
      `
        SELECT
          SUM(CASE WHEN DATE(o.created_at) = CURDATE() THEN 1 ELSE 0 END) AS claims_today,
          SUM(CASE WHEN c.status = 'REDEEMED' THEN 1 ELSE 0 END) AS redeemed_total,
          SUM(CASE WHEN c.status = 'EXPIRED' THEN 1 ELSE 0 END) AS expired_total
        FROM orders o
        LEFT JOIN coupons c ON c.order_id = o.order_id
        WHERE o.order_type = 'ECONOMY_FOOD'
      `,
    ),
    query(
      `
        SELECT
          HOUR(created_at) AS hour_slot,
          COUNT(*) AS total_orders
        FROM orders
        WHERE order_type = 'ECONOMY_FOOD'
          AND DATE(created_at) = CURDATE()
        GROUP BY HOUR(created_at)
        ORDER BY total_orders DESC, hour_slot ASC
        LIMIT 5
      `,
    ),
    query(
      `
        SELECT
          f.food_item_id,
          f.item_name,
          COUNT(*) AS total_orders
        FROM orders o
        INNER JOIN food_items f ON f.food_item_id = o.food_item_id
        WHERE o.order_type = 'ECONOMY_FOOD'
        GROUP BY f.food_item_id, f.item_name
        ORDER BY total_orders DESC, f.item_name ASC
        LIMIT 5
      `,
    ),
    query(
      `
        SELECT COUNT(*) AS active_total
        FROM coupons
        WHERE status = 'ACTIVE'
      `,
    ),
  ]);

  const totals = totalsRows[0] || {};
  return {
    totals: {
      economyFoodClaimsToday: Number(totals.claims_today || 0),
      redeemedCoupons: Number(totals.redeemed_total || 0),
      expiredCoupons: Number(totals.expired_total || 0),
      activeCoupons: Number(activeRows[0]?.active_total || 0),
    },
    peakOrderingHours: peakHoursRows.map((row) => ({
      hour: row.hour_slot,
      label: `${String(row.hour_slot).padStart(2, "0")}:00`,
      totalOrders: Number(row.total_orders),
    })),
    mostSelectedFood: popularFoodRows.map((row) => ({
      foodItemId: row.food_item_id,
      itemName: row.item_name,
      totalOrders: Number(row.total_orders),
    })),
  };
}

module.exports = {
  ACTIVE,
  AppError,
  EXPIRED,
  REDEEMED,
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
};
