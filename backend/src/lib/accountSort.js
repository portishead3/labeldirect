const US_ALIASES = new Set(["us", "usa", "united states", "u.s", "u.s.a", "unitedstates"]);

export function isUsCountry(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "");
  return US_ALIASES.has(text);
}

function outboundOf(row) {
  const n = Number(row && row.outbound);
  return Number.isFinite(n) ? n : 0;
}

function countryOf(row) {
  return String((row && row.country) || "").trim();
}

function loginOf(row) {
  return String((row && row.login) || "");
}

function sortOrderValue(row) {
  if (!row || row.sort_order == null || row.sort_order === "") return null;
  const n = Number(row.sort_order);
  return Number.isFinite(n) ? n : null;
}

export function defaultAccountCompare(a, b) {
  const aUs = isUsCountry(a && a.country);
  const bUs = isUsCountry(b && b.country);
  if (aUs !== bUs) return aUs ? -1 : 1;
  const out = outboundOf(b) - outboundOf(a);
  if (out !== 0) return out;
  const country = countryOf(a).localeCompare(countryOf(b), undefined, { sensitivity: "base" });
  if (country !== 0) return country;
  return loginOf(a).localeCompare(loginOf(b), undefined, { sensitivity: "base" });
}

export function sortAccounts(rows) {
  const list = (rows || []).slice();
  list.sort((a, b) => {
    const ao = sortOrderValue(a);
    const bo = sortOrderValue(b);
    if (ao != null && bo != null && ao !== bo) return ao - bo;
    if (ao != null && bo == null) return -1;
    if (ao == null && bo != null) return 1;
    return defaultAccountCompare(a, b);
  });
  return list;
}
