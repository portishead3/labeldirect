export const REFUND_WINDOW_MINUTES = 120;

export const REFUND_REASONS = {
  login_incorrect: "Login incorrect",
  payment_expired: "Payment expired",
  cannot_make_label: "Can't make label",
  other: "Other",
};

const MAX_NOTE_LENGTH = 500;

export function refundReasonLabel(code) {
  return REFUND_REASONS[String(code || "")] || "Other";
}

export function refundDeadline(purchasedAt) {
  const start = new Date(purchasedAt);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + REFUND_WINDOW_MINUTES * 60 * 1000);
}

export function isRefundWindowOpen(purchasedAt, now) {
  const deadline = refundDeadline(purchasedAt);
  if (!deadline) return false;
  return (now ? new Date(now) : new Date()).getTime() < deadline.getTime();
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function parseScreenshotUrl(raw) {
  const value = String(raw == null ? "" : raw).trim();
  if (!value) {
    throw badRequest("Add a screenshot link so we can review the issue.");
  }
  let url;
  try {
    url = new URL(value);
  } catch (_err) {
    throw badRequest("That screenshot link is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest("Screenshot links must start with http:// or https://.");
  }
  return url.toString();
}

export function parseRefundRequest(body) {
  const data = body || {};
  const accountLogin = String(data.login || data.accountLogin || "").trim();
  if (!accountLogin) {
    throw badRequest("Select the account you want refunded.");
  }

  const reasonCode = String(data.reasonCode || data.reason_code || "").trim();
  if (!REFUND_REASONS[reasonCode]) {
    throw badRequest("Choose what went wrong with this account.");
  }

  const note = String(data.note || data.reasonNote || "").trim();
  if (reasonCode === "other" && !note) {
    throw badRequest("Describe the issue so we can review it.");
  }
  if (note.length > MAX_NOTE_LENGTH) {
    throw badRequest(`Keep the description under ${MAX_NOTE_LENGTH} characters.`);
  }

  return {
    accountId: data.accountId == null ? null : String(data.accountId).trim() || null,
    accountLogin,
    reasonCode,
    note: note || null,
    screenshotUrl: parseScreenshotUrl(data.screenshotUrl || data.screenshot_url),
  };
}
