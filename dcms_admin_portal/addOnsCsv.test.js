const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appJsPath = path.resolve(__dirname, "../app.js");
const source = fs.readFileSync(appJsPath, "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) {
    throw new Error(`Unable to find function ${name}`);
  }

  let parameterStart = source.indexOf("(", start);
  let parameterDepth = 0;
  let braceIndex = -1;

  for (let index = parameterStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") {
      parameterDepth += 1;
    } else if (char === ")") {
      parameterDepth -= 1;
      if (parameterDepth === 0) {
        braceIndex = source.indexOf("{", index);
        break;
      }
    }
  }

  if (braceIndex < 0) {
    throw new Error(`Unable to find function body for ${name}`);
  }

  let depth = 0;

  for (let index = braceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Unable to parse function ${name}`);
}

function extractConst(name) {
  const match = source.match(
    new RegExp(`const ${name} = \\[[\\s\\S]*?\\];`, "m"),
  );
  if (!match) {
    throw new Error(`Unable to find const ${name}`);
  }
  return match[0];
}

const script = `
${extractConst("ADMIN_COUPON_ADD_ON_VALUES")}
${extractFunction("normalizeCouponAddOnsForAdmin")}
${extractFunction("formatCouponAddOns")}
${extractFunction("csvEscape")}
${extractFunction("buildCsv")}
module.exports = {
  normalizeCouponAddOnsForAdmin,
  formatCouponAddOns,
  csvEscape,
  buildCsv,
};
`;

const context = {
  module: { exports: {} },
  exports: {},
  JSON,
  String,
  Array,
  Set,
  RegExp,
};

vm.runInNewContext(script, context);

const {
  normalizeCouponAddOnsForAdmin,
  formatCouponAddOns,
  buildCsv,
} = context.module.exports;

test("admin formatter handles one add-on selected", () => {
  assert.equal(formatCouponAddOns(["Extra vege"]), "Extra vege");
});

test("admin formatter handles two add-ons selected", () => {
  assert.equal(
    formatCouponAddOns(["Extra vege", "Extra egg"]),
    "Extra vege, Extra egg",
  );
});

test("admin formatter handles all three add-ons selected", () => {
  assert.equal(
    formatCouponAddOns([
      "Extra vege",
      "Extra egg",
      "Extra chicken/fish",
    ]),
    "Extra vege, Extra egg, Extra chicken/fish",
  );
});

test("admin formatter handles no extra add on selected", () => {
  assert.equal(
    formatCouponAddOns(["No extra add on"]),
    "No extra add on",
  );
});

test("admin formatter handles null, empty array, and malformed legacy data", () => {
  assert.equal(formatCouponAddOns(null), "Not recorded");
  assert.equal(formatCouponAddOns([]), "Not recorded");
  assert.equal(formatCouponAddOns("[invalid-json"), "Not recorded");
});

test("admin normalizer keeps extra selections over contradictory no extra value", () => {
  assert.deepEqual(
    normalizeCouponAddOnsForAdmin([
      "Extra vege",
      "Extra egg",
      "No extra add on",
    ]),
    ["Extra vege", "Extra egg"],
  );
});

test("weekly and monthly csv export keep add-ons in one column", () => {
  const csv = buildCsv(
    [
      {
        studentId: "e2310101",
        couponType: "Economy",
        add_ons: ["Extra vege", "Extra egg", "Extra chicken/fish"],
        mealCode: "dinner",
      },
      {
        studentId: "e2310102",
        couponType: "Economy",
        add_ons: null,
        mealCode: "lunch",
      },
    ],
    [
      { label: "Student ID", resolve: (row) => row.studentId },
      { label: "Coupon Type", resolve: (row) => row.couponType },
      {
        label: "Add-ons",
        resolve: (row) =>
          formatCouponAddOns(row.addOns ?? row.add_ons, {
            separator: "; ",
          }),
      },
      { label: "Meal Code", resolve: (row) => row.mealCode },
    ],
  );

  const lines = csv.split("\n");
  assert.equal(
    lines[1],
    "\"e2310101\",\"Economy\",\"Extra vege; Extra egg; Extra chicken/fish\",\"dinner\"\r",
  );
  assert.equal(
    lines[2],
    "\"e2310102\",\"Economy\",\"Not recorded\",\"lunch\"",
  );
});
