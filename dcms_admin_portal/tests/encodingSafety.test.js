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

  const pageDetectionIndex = appSource.indexOf(
    "state.currentPage = getCurrentPageKey();",
    appSource.indexOf("function dashboardMarkup"),
  );
  const recordSelectionIndex = appSource.indexOf(
    'state.currentPage === "activity"',
    appSource.indexOf("function dashboardMarkup"),
  );
  assert.ok(pageDetectionIndex >= 0);
  assert.ok(recordSelectionIndex >= 0);
  assert.ok(
    pageDetectionIndex < recordSelectionIndex,
    "the current page must be detected before choosing the record data source",
  );
});

test("admin portal includes keyboard navigation and high-contrast support", () => {
  const htmlSource = fs.readFileSync(
    path.join(__dirname, "..", "index.html"),
    "utf8",
  );
  const cssSource = fs.readFileSync(
    path.join(__dirname, "..", "styles.css"),
    "utf8",
  );

  assert.match(htmlSource, /class="skip-link" href="#appRoot"/);
  assert.match(htmlSource, /id="appRoot" tabindex="-1"/);
  assert.match(cssSource, /:focus-visible/);
  assert.match(cssSource, /@media \(prefers-contrast: more\)/);
});
