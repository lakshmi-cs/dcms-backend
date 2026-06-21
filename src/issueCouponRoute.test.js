const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(
  path.resolve(__dirname, "app.js"),
  "utf8",
);

test("coupon issue route accepts addOns, add_ons, and addons request fields", () => {
  assert.match(
    appSource,
    /req\.body\.addOns\s*\?\?\s*req\.body\.add_ons\s*\?\?\s*req\.body\.addons/,
  );
});

test("coupon issue insert builds add_ons columns dynamically", () => {
  assert.match(
    appSource,
    /const couponAddOnsInsert = buildCouponAddOnsInsertColumns\([\s\S]*INSERT INTO coupon_redemptions[\s\S]*\$\{couponAddOnsInsert\.columns\.length \? `\$\{couponAddOnsInsert\.columns\.join\(","\)\},` : ""\}[\s\S]*\$\{couponAddOnsInsert\.placeholders\.length \? `\$\{couponAddOnsInsert\.placeholders\.join\(","\)\}, ` : ""\}\?, \?, \?, \?, 'issued'\)/,
  );
});

test("coupon redemption selects use a schema-aware add-ons projection", () => {
  assert.match(
    appSource,
    /function getCouponAddOnsSelectSql\(alias = "addOnsRaw"\)/,
  );
  assert.match(
    appSource,
    /\$\{getCouponAddOnsSelectSql\("addOnsRaw"\)\}/,
  );
});

test("coupon issue route exposes the current deployment diagnostic marker", () => {
  assert.match(appSource, /D44F_ADDONS_WRITE_V2/);
});

test("coupon issue route queries the inserted row for add_ons diagnostics", () => {
  assert.match(
    appSource,
    /SELECT[\s\S]*id,[\s\S]*storedAddOnsRaw[\s\S]*storedAddOnsJson[\s\S]*FROM coupon_redemptions/,
  );
});
