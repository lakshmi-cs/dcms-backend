const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeCouponAddOns } = require("./couponAddOns");

test("normalizeCouponAddOns keeps multiple extra selections", () => {
  assert.deepEqual(
    normalizeCouponAddOns(["Extra vege", "Extra egg"]),
    ["Extra vege", "Extra egg"],
  );
});

test("normalizeCouponAddOns keeps each single extra selection", () => {
  assert.deepEqual(normalizeCouponAddOns(["Extra vege"]), ["Extra vege"]);
  assert.deepEqual(normalizeCouponAddOns(["Extra egg"]), ["Extra egg"]);
  assert.deepEqual(normalizeCouponAddOns(["Extra chicken/fish"]), [
    "Extra chicken/fish",
  ]);
});

test("normalizeCouponAddOns keeps all three selected add-ons", () => {
  assert.deepEqual(
    normalizeCouponAddOns([
      "Extra vege",
      "Extra egg",
      "Extra chicken/fish",
    ]),
    ["Extra vege", "Extra egg", "Extra chicken/fish"],
  );
});

test("normalizeCouponAddOns makes no extra add on exclusive", () => {
  assert.deepEqual(
    normalizeCouponAddOns([
      "Extra vege",
      "No extra add on",
      "Extra chicken/fish",
    ]),
    ["Extra vege", "Extra chicken/fish"],
  );
});

test("normalizeCouponAddOns parses JSON arrays safely", () => {
  assert.deepEqual(
    normalizeCouponAddOns('["Extra chicken/fish","Extra egg","Extra egg"]'),
    ["Extra chicken/fish", "Extra egg"],
  );
});

test("normalizeCouponAddOns maps legacy extra chicken values", () => {
  assert.deepEqual(
    normalizeCouponAddOns(["Extra chicken"]),
    ["Extra chicken/fish"],
  );
});

test("normalizeCouponAddOns keeps extra egg when selected after no extra add on", () => {
  assert.deepEqual(
    normalizeCouponAddOns(["No extra add on", "Extra egg"]),
    ["Extra egg"],
  );
});

test("normalizeCouponAddOns returns empty for null, empty, and malformed legacy data", () => {
  assert.deepEqual(normalizeCouponAddOns(null), []);
  assert.deepEqual(normalizeCouponAddOns([]), []);
  assert.deepEqual(normalizeCouponAddOns("[invalid-json"), []);
});
