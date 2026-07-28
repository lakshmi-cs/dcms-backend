const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../app.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`Unable to find function ${name}`);
  const braceStart = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to parse function ${name}`);
}

const context = {
  module: { exports: {} },
  exports: {},
  String,
};
vm.runInNewContext(
  `
    ${extractFunction("csvEscape")}
    ${extractFunction("buildCsv")}
    module.exports = { buildCsv };
  `,
  context,
);

test("food feedback CSV preserves ratings, comments, and Malaysia timestamps", () => {
  const csv = context.module.exports.buildCsv(
    [{
      studentId: "e23101011",
      mealCode: "lunch",
      rating: 4,
      comment: "Good food, please add fruit",
      submittedAt: "29/7/2026 1.30 PM",
    }],
    [
      { label: "Student ID", resolve: (row) => row.studentId },
      { label: "Meal", resolve: (row) => row.mealCode },
      { label: "Rating (out of 5)", resolve: (row) => row.rating },
      { label: "Comment", resolve: (row) => row.comment },
      { label: "Submitted At (MYT)", resolve: (row) => row.submittedAt },
    ],
  );

  assert.match(csv, /"Rating \(out of 5\)"/);
  assert.match(csv, /"Good food, please add fruit"/);
  assert.match(csv, /"29\/7\/2026 1\.30 PM"/);
});

test("food feedback exports use separate monthly and complete endpoints", () => {
  assert.match(source, /exportFeedbackMonthlyButton/);
  assert.match(source, /exportFeedbackAllButton/);
  assert.match(source, /\/admin\/feedback\?startDate=/);
  assert.match(source, /\/admin\/feedback\?limit=10000/);
});
