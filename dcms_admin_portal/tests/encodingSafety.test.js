const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("admin portal source does not contain common UTF-8 mojibake", () => {
  const appSource = fs.readFileSync(
    path.join(__dirname, "..", "app.js"),
    "utf8",
  );

  for (const corruptedSequence of ["â", "Ã", "Â"]) {
    assert.equal(
      appSource.includes(corruptedSequence),
      false,
      `app.js contains corrupted sequence: ${corruptedSequence}`,
    );
  }
});

test("student record controls remain stable while an administrator is typing", () => {
  const appSource = fs.readFileSync(
    path.join(__dirname, "..", "app.js"),
    "utf8",
  );

  assert.match(appSource, /recordPageSize:\s*15/);
  assert.match(
    appSource,
    /autoRefreshEnabledPages\s*=\s*new Set\(\["overview"\]\)/,
  );
});
