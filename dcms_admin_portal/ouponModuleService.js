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
