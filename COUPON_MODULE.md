# DCMS Coupon Redemption Module

This backend now includes a complete coupon-based economy food flow for your DCMS:

1. Students fetch available economy food items from `GET /api/food-items`
2. Students place one paid economy food order per day through `POST /api/orders`
3. The backend generates a unique coupon automatically, such as `DCMS-1024`
4. Coupons expire after 10 minutes and are auto-marked `EXPIRED`
5. Admin can search, filter, and redeem coupons through REST endpoints
6. Analytics are exposed through `GET /api/admin/analytics/summary`

## Sample JSON

### Create order

Request:

```json
{
  "studentId": "A12345",
  "foodItemId": 1
}
```

Response:

```json
{
  "status": "success",
  "message": "Economy food order created and coupon generated.",
  "data": {
    "order": {
      "orderId": 17,
      "studentId": "A12345",
      "studentName": "Lakshmi",
      "foodItemId": 1,
      "foodName": "Economy Rice Set A",
      "orderType": "ECONOMY_FOOD",
      "paymentStatus": "PAID",
      "price": 5,
      "claimDate": "2026-05-08T00:00:00.000Z",
      "createdAt": "2026-05-08T14:09:11.000Z"
    },
    "coupon": {
      "couponId": 8,
      "couponCode": "DCMS-1024",
      "studentId": "A12345",
      "studentName": "Lakshmi",
      "orderId": 17,
      "foodItemId": 1,
      "foodName": "Economy Rice Set A",
      "price": 5,
      "createdAt": "2026-05-08T14:09:11.000Z",
      "expiresAt": "2026-05-08T14:19:11.000Z",
      "redeemedAt": null,
      "redeemedBy": null,
      "status": "ACTIVE"
    }
  }
}
```

### Redeem coupon

Request:

```json
{
  "operatorName": "Counter 1"
}
```

Response:

```json
{
  "status": "success",
  "message": "Coupon redeemed successfully.",
  "data": {
    "couponId": 8,
    "couponCode": "DCMS-1024",
    "studentId": "A12345",
    "studentName": "Lakshmi",
    "orderId": 17,
    "foodItemId": 1,
    "foodName": "Economy Rice Set A",
    "price": 5,
    "createdAt": "2026-05-08T14:09:11.000Z",
    "expiresAt": "2026-05-08T14:19:11.000Z",
    "redeemedAt": "2026-05-08T14:12:03.000Z",
    "redeemedBy": "Counter 1",
    "status": "REDEEMED"
  }
}
```

### Analytics summary

```json
{
  "status": "success",
  "data": {
    "totals": {
      "economyFoodClaimsToday": 24,
      "redeemedCoupons": 18,
      "expiredCoupons": 3,
      "activeCoupons": 3
    },
    "peakOrderingHours": [
      { "hour": 12, "label": "12:00", "totalOrders": 9 },
      { "hour": 13, "label": "13:00", "totalOrders": 7 }
    ],
    "mostSelectedFood": [
      { "foodItemId": 1, "itemName": "Economy Rice Set A", "totalOrders": 12 }
    ]
  }
}
```

## Business rules enforced

- One economy food claim per student per day
- Duplicate redemption blocked
- Expired coupons cannot be redeemed
- Coupons auto-expire after 10 minutes
- Coupon status can be polled in real time from the mobile app
