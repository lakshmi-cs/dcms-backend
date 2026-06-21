const DCMS_MALAYSIA_TIME_ZONE = "Asia/Kuala_Lumpur";
const DCMS_MALAYSIA_OFFSET_MINUTES = 8 * 60;

const malaysiaDateTimeFormatter = new Intl.DateTimeFormat("en-MY", {
  timeZone: DCMS_MALAYSIA_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

const malaysiaDateFormatter = new Intl.DateTimeFormat("en-MY", {
  timeZone: DCMS_MALAYSIA_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const malaysiaWeekdayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: DCMS_MALAYSIA_TIME_ZONE,
  weekday: "short",
});

const malaysiaDateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DCMS_MALAYSIA_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

function parseMalaysiaDateTime(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }

  const raw = String(value || "").trim();
  if (!raw || raw === "null" || raw === "undefined") {
    return null;
  }

  const normalized = raw.replace(" ", "T");
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized);

  if (hasExplicitTimezone) {
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const dateTimeMatch =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (dateTimeMatch) {
    const year = Number(dateTimeMatch[1]);
    const month = Number(dateTimeMatch[2]) - 1;
    const day = Number(dateTimeMatch[3]);
    const hour = Number(dateTimeMatch[4] || 0);
    const minute = Number(dateTimeMatch[5] || 0);
    const second = Number(dateTimeMatch[6] || 0);

    return new Date(
      Date.UTC(
        year,
        month,
        day,
        hour - Math.floor(DCMS_MALAYSIA_OFFSET_MINUTES / 60),
        minute - (DCMS_MALAYSIA_OFFSET_MINUTES % 60),
        second,
      ),
    );
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getMalaysiaDateTimeParts(value) {
  const parsed = parseMalaysiaDateTime(value);
  if (!parsed) return null;

  return malaysiaDateTimeFormatter.formatToParts(parsed).reduce((acc, part) => {
    if (part.type !== "literal") {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});
}

function formatMalaysiaDateTime(value, { emptyLabel = "Not recorded" } = {}) {
  const parts = getMalaysiaDateTimeParts(value);
  if (!parts) {
    return emptyLabel;
  }

  const hour = String(Number(parts.hour || "0"));
  const minute = String(parts.minute || "00").padStart(2, "0");
  const dayPeriod = String(parts.dayPeriod || "").toUpperCase();

  return `${parts.day}/${parts.month}/${parts.year} ${hour}:${minute} ${dayPeriod}`.trim();
}

function formatMalaysiaDateOnly(value, { emptyLabel = "Not recorded" } = {}) {
  const parsed = parseMalaysiaDateTime(value);
  if (!parsed) {
    return emptyLabel;
  }

  const parts = malaysiaDateFormatter.formatToParts(parsed).reduce((acc, part) => {
    if (part.type !== "literal") {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});

  return `${parts.day}/${parts.month}/${parts.year}`;
}

function formatMalaysiaRelativeTime(value, { now = new Date() } = {}) {
  const parsed = parseMalaysiaDateTime(value);
  if (!parsed) return "recently";

  const referenceNow =
    now instanceof Date && !Number.isNaN(now.getTime())
      ? now
      : parseMalaysiaDateTime(now) || new Date();

  const seconds = Math.max(
    0,
    Math.floor((referenceNow.getTime() - parsed.getTime()) / 1000),
  );

  if (seconds < 60) return `${seconds || 1}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatMalaysiaShortDay(value, { emptyLabel = "" } = {}) {
  const parsed = parseMalaysiaDateTime(value);
  if (!parsed) return emptyLabel;
  return malaysiaWeekdayFormatter.format(parsed);
}

function toMalaysiaDateInputValue(value) {
  const parsed = parseMalaysiaDateTime(value);
  if (!parsed) return "";

  const parts = malaysiaDateKeyFormatter.formatToParts(parsed).reduce((acc, part) => {
    if (part.type !== "literal") {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

window.DCMSTime = {
  MALAYSIA_TIME_ZONE: DCMS_MALAYSIA_TIME_ZONE,
  parseMalaysiaDateTime,
  formatMalaysiaDateTime,
  formatMalaysiaDateOnly,
  formatMalaysiaRelativeTime,
  formatMalaysiaShortDay,
  toMalaysiaDateInputValue,
};
