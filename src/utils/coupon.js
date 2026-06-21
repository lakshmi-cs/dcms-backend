const crypto = require("crypto");

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function mapCouponRow(row) {
  if (!row) {
    return null;
  }

  return {
    couponId: row.coupon_id,
    couponCode: row.coupon_code,
    studentId: row.student_id,
    studentName: row.student_name,
    orderId: row.order_id,
    foodItemId: row.food_item_id,
    foodName: row.food_name,
    price: row.price,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
    redeemedBy: row.redeemed_by,
    status: row.status,
  };
}

function randomCouponCode() {
  const number = crypto.randomInt(1000, 10000);
  return `DCMS-${number}`;
}

function isCouponExpired(coupon) {
  if (!coupon || !coupon.expiresAt) {
    return false;
  }

  return new Date(coupon.expiresAt).getTime() <= Date.now();
}

module.exports = {
  addMinutes,
  isCouponExpired,
  mapCouponRow,
  randomCouponCode,
};
