const ECONOMY_COUPON_ADD_ON_OPTIONS = [
  "Extra vege",
  "Extra egg",
  "Extra chicken/fish",
  "No extra add on",
];

const ECONOMY_COUPON_ADD_ON_ALIASES = {
  "Extra chicken": "Extra chicken/fish",
};

function normalizeCouponAddOns(value) {
  const rawSelections = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim()
      ? (() => {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [value];
          } catch (_error) {
            return [value];
          }
        })()
      : [];

  const uniqueSelections = Array.from(
    new Set(
      rawSelections
        .map((item) => {
          const normalizedItem = String(item || "").trim();
          return ECONOMY_COUPON_ADD_ON_ALIASES[normalizedItem] || normalizedItem;
        })
        .filter((item) => ECONOMY_COUPON_ADD_ON_OPTIONS.includes(item)),
    ),
  );

  if (!uniqueSelections.length) {
    return [];
  }

  const extraSelections = uniqueSelections.filter(
    (item) => item !== "No extra add on",
  );

  if (extraSelections.length) {
    return extraSelections;
  }

  if (uniqueSelections.includes("No extra add on")) {
    return ["No extra add on"];
  }

  return [];
}

module.exports = {
  ECONOMY_COUPON_ADD_ON_OPTIONS,
  normalizeCouponAddOns,
};
