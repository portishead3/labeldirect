(function (global) {
  var COLUMNS = ["country", "state", "outbound", "inbound", "address", "billing", "price", "vendor"];

  function supabaseConfig() {
    return global.LABELDIRECT_SUPABASE || {};
  }

  function apiConfig() {
    return global.LABELDIRECT_API || {};
  }

  function apiBase() {
    return String(apiConfig().baseUrl || "").replace(/\/$/, "");
  }

  function isAuthConfigured() {
    var cfg = supabaseConfig();
    return Boolean(cfg.url && cfg.anonKey);
  }

  function isApiConfigured() {
    return Boolean(apiBase());
  }

  function isConfigured() {
    return isApiConfigured();
  }

  function getClient() {
    if (!isAuthConfigured()) return null;
    if (!global.supabase) {
      throw new Error("Supabase library failed to load.");
    }
    var cfg = supabaseConfig();
    return global.supabase.createClient(cfg.url, cfg.anonKey);
  }

  var ACCOUNTS_SESSION_KEY = "labeldirect_accounts_session";

  function parseJsonResponse(res) {
    return res.text().then(function (text) {
      var data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (_e) {
          data = null;
        }
      }
      if (!res.ok) {
        var msg =
          (data && data.error) ||
          res.statusText ||
          "Request failed.";
        var err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return data;
    });
  }

  function getAccountsSession() {
    try {
      return sessionStorage.getItem(ACCOUNTS_SESSION_KEY) || "";
    } catch (_e) {
      return "";
    }
  }

  function setAccountsSession(token) {
    sessionStorage.setItem(ACCOUNTS_SESSION_KEY, token);
  }

  function clearAccountsSession() {
    try {
      sessionStorage.removeItem(ACCOUNTS_SESSION_KEY);
    } catch (_e) {
      /* ignore */
    }
  }

  function loginWithToken(token) {
    return fetch(apiBase() + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token })
    })
      .then(parseJsonResponse)
      .then(function (data) {
        if (!data || !data.accessToken) {
          throw new Error("Could not sign in.");
        }
        setAccountsSession(data.accessToken);
        return data.accessToken;
      });
  }

  function fetchAccountsFromApi(accessToken) {
    var token = accessToken || getAccountsSession();
    var headers = {};
    if (token) headers.Authorization = "Bearer " + token;
    return fetch(apiBase() + "/api/accounts", { headers: headers }).then(parseJsonResponse);
  }

  function adminRequest(accessToken, path, options) {
    var opts = options || {};
    var headers = Object.assign({ Authorization: "Bearer " + accessToken }, opts.headers || {});
    var body = opts.body;
    if (body instanceof FormData) {
      delete headers["Content-Type"];
    } else if (body != null) {
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
      if (typeof body !== "string") body = JSON.stringify(body);
    }
    return fetch(apiBase() + path, {
      method: opts.method || "GET",
      headers: headers,
      body: body
    }).then(parseJsonResponse);
  }

  function dash(value) {
    var text = value == null ? "" : String(value).trim();
    return text || "—";
  }

  function formatAccountStatus(value) {
    var raw = String(value == null ? "" : value).trim().toLowerCase();
    if (raw === "cash") return "Cash";
    if (raw === "active") return "Active";
    return "";
  }

  function td(value) {
    var cell = document.createElement("td");
    cell.textContent = dash(value);
    return cell;
  }

  function statusTd(value) {
    var cell = document.createElement("td");
    var raw = String(value == null ? "" : value).trim().toLowerCase();
    var label = formatAccountStatus(raw);
    if (!label) {
      cell.textContent = "—";
      return cell;
    }
    var pill = document.createElement("span");
    pill.className = "status-pill status-pill--" + raw;
    pill.textContent = label;
    cell.appendChild(pill);
    return cell;
  }

  var US_ALIASES = {
    us: true,
    usa: true,
    "united states": true,
    unitedstates: true
  };

  function isUsCountry(value) {
    var text = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\./g, "");
    return Boolean(US_ALIASES[text]);
  }

  function countryKey(value) {
    if (isUsCountry(value)) return "__us__";
    return String(value || "").trim().toLowerCase();
  }

  function vendorKey(value) {
    var text = String(value == null ? "" : value).trim();
    return text ? text : "__none__";
  }

  function outboundOf(row) {
    var n = Number(row && row.outbound);
    return Number.isFinite(n) ? n : 0;
  }

  function carrierOf(row) {
    var carrier = String((row && row.carrier) || "fedex").toLowerCase();
    return carrier === "ups" ? "ups" : "fedex";
  }

  function rowsForCarrier(rows, carrier) {
    var wanted = carrier === "ups" ? "ups" : "fedex";
    return (rows || []).filter(function (row) {
      return carrierOf(row) === wanted;
    });
  }

  function matchesCountry(row, selected) {
    if (!selected) return true;
    return countryKey(row && row.country) === selected;
  }

  function matchesBase(row, selected) {
    if (!selected) return true;
    var key = vendorKey(row && row.vendor);
    if (selected === "__none__" || key === "__none__") return key === selected;
    return key.toLowerCase() === selected.toLowerCase();
  }

  function matchesOutboundBand(row, band) {
    if (!band || band === "all") return true;
    var n = outboundOf(row);
    if (band === "0") return n === 0;
    if (band === "below10") return n >= 1 && n <= 9;
    if (band === "10plus") return n >= 10;
    return true;
  }

  function applyAccountFilters(rows, filters) {
    var f = filters || {};
    return (rows || []).filter(function (row) {
      return (
        matchesCountry(row, f.country) &&
        matchesBase(row, f.base) &&
        matchesOutboundBand(row, f.outbound)
      );
    });
  }

  function countryOptions(rows) {
    var counts = {};
    var labels = {};
    (rows || []).forEach(function (row) {
      var raw = String((row && row.country) || "").trim();
      if (!raw) return;
      var key = countryKey(raw);
      counts[key] = (counts[key] || 0) + 1;
      if (!labels[key]) labels[key] = key === "__us__" ? "US" : raw;
    });
    return Object.keys(counts)
      .sort(function (a, b) {
        var aUs = a === "__us__";
        var bUs = b === "__us__";
        if (aUs !== bUs) return aUs ? -1 : 1;
        if (counts[b] !== counts[a]) return counts[b] - counts[a];
        return labels[a].localeCompare(labels[b], undefined, { sensitivity: "base" });
      })
      .map(function (key) {
        return { value: key, label: labels[key] };
      });
  }

  function baseOptions(rows) {
    var seen = {};
    var hasNone = false;
    (rows || []).forEach(function (row) {
      var text = String((row && row.vendor) || "").trim();
      if (!text) {
        hasNone = true;
        return;
      }
      var key = text.toLowerCase();
      if (!seen[key]) seen[key] = text;
    });
    var opts = Object.keys(seen)
      .map(function (key) {
        return { value: seen[key], label: seen[key] };
      })
      .sort(function (a, b) {
        return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
      });
    if (hasNone) opts.push({ value: "__none__", label: "No base" });
    return opts;
  }

  function fillFilterSelect(select, options, currentValue, allLabel) {
    if (!select) return "";
    select.textContent = "";
    var all = document.createElement("option");
    all.value = "";
    all.textContent = allLabel;
    select.appendChild(all);
    (options || []).forEach(function (opt) {
      var el = document.createElement("option");
      el.value = opt.value;
      el.textContent = opt.label;
      select.appendChild(el);
    });
    var exists = Boolean(
      currentValue &&
        (options || []).some(function (opt) {
          return opt.value === currentValue;
        })
    );
    select.value = exists ? currentValue : "";
    return select.value;
  }

  function renderPanel(panel, rows, options) {
    if (!panel) return;
    var empty = panel.querySelector(".empty-state");
    var wrap = panel.querySelector(".table-wrap");
    var tbody = panel.querySelector("tbody");
    if (!tbody) return;
    tbody.textContent = "";
    var carrier = (options && options.carrier) || panel.getAttribute("data-panel") || "fedex";

    if (!rows.length) {
      if (empty) {
        empty.hidden = false;
        var p = empty.querySelector("p");
        if (p) {
          var fallback = p.getAttribute("data-empty-default") || p.textContent;
          p.textContent = (options && options.emptyMessage) || fallback;
        }
      }
      if (wrap) wrap.hidden = true;
      return;
    }

    if (empty) empty.hidden = true;
    if (wrap) wrap.hidden = false;

    rows.forEach(function (row, index) {
      var tr = document.createElement("tr");
      tr.className = "accounts-table__row";
      if (row.id) tr.setAttribute("data-account-id", row.id);
      tr.setAttribute("data-price", String(Number(row.price) || 0));
      tr.setAttribute("data-carrier", carrier);

      var numTd = document.createElement("td");
      numTd.className = "accounts-table__num-cell";
      numTd.textContent = String(index + 1);
      tr.appendChild(numTd);

      var cartTd = document.createElement("td");
      cartTd.className = "accounts-table__cart-cell";
      var cart = document.createElement("button");
      cart.type = "button";
      cart.className = "account-cart";
      cart.setAttribute("data-account-id", row.id || "");
      cart.setAttribute("data-price", String(Number(row.price) || 0));
      cart.setAttribute("data-carrier", carrier);
      cart.setAttribute("aria-pressed", "false");
      cart.setAttribute("aria-label", "Add to cart");
      cart.innerHTML =
        '<svg class="account-cart__icon" viewBox="0 0 24 24" aria-hidden="true">' +
          '<path class="account-cart__fill" d="M7.1 7.4h13.05l-1.55 7.05H8.55z"/>' +
          '<path class="account-cart__line" d="M3.2 4.2h2.15l1.85 9.2a1.7 1.7 0 0 0 1.67 1.35h8.55a1.7 1.7 0 0 0 1.66-1.3L20.8 7.4H6.35"/>' +
          '<circle class="account-cart__wheel" cx="9.15" cy="18.85" r="1.35"/>' +
          '<circle class="account-cart__wheel" cx="16.85" cy="18.85" r="1.35"/>' +
        "</svg>";
      cartTd.appendChild(cart);
      tr.appendChild(cartTd);

      COLUMNS.forEach(function (key) {
        var cell = td(row[key]);
        if (key === "address") cell.className = "accounts-table__address";
        if (key === "billing") cell.className = "accounts-table__billing";
        tr.appendChild(cell);
      });
      tbody.appendChild(tr);
    });
  }

  function renderAccounts(rows, filters) {
    var fedex = [];
    var ups = [];
    (rows || []).forEach(function (row) {
      if (carrierOf(row) === "ups") ups.push(row);
      else fedex.push(row);
    });
    var filteredFedex = applyAccountFilters(fedex, filters);
    var filteredUps = applyAccountFilters(ups, filters);
    var filterEmpty = "No accounts match these filters.";
    renderPanel(document.querySelector('[data-panel="fedex"]'), filteredFedex, {
      carrier: "fedex",
      emptyMessage: fedex.length && !filteredFedex.length ? filterEmpty : ""
    });
    renderPanel(document.querySelector('[data-panel="ups"]'), filteredUps, {
      carrier: "ups",
      emptyMessage: ups.length && !filteredUps.length ? filterEmpty : ""
    });
  }

  function setStatus(el, message, kind) {
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
    el.classList.remove("is-error", "is-ok");
    if (kind) el.classList.add(kind === "error" ? "is-error" : "is-ok");
  }

  var WALLET_MIN_DEPOSIT_USD = 10;

  function formatUsd(amountDollars) {
    var n = Number(amountDollars);
    if (!Number.isFinite(n)) n = 0;
    return n.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function resolveBalanceEl(target) {
    if (!target) return null;
    if (typeof target === "string") return document.querySelector(target);
    if (target.nodeType === 1) return target;
    return null;
  }

  function setBalanceDisplay(target, amountDollars) {
    var el = resolveBalanceEl(target);
    if (!el) return;
    var formatted = formatUsd(amountDollars);
    el.textContent = formatted;
    el.setAttribute("data-balance-usd", String(Number(amountDollars) || 0));
    var host = el.closest("[data-balance-control]");
    if (host) {
      host.setAttribute("aria-label", "Balance " + formatted + ", add funds");
    }
  }

  function fetchWallet(accessToken) {
    var token = accessToken || getAccountsSession();
    if (!token || !isApiConfigured()) {
      return Promise.resolve({ balance: 0, currency: "USD" });
    }
    return fetch(apiBase() + "/api/wallet", {
      headers: { Authorization: "Bearer " + token }
    }).then(parseJsonResponse);
  }

  function createDeposit(amountDollars, accessToken) {
    var token = accessToken || getAccountsSession();
    return fetch(apiBase() + "/api/wallet/deposits", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ amount: amountDollars })
    }).then(parseJsonResponse);
  }

  function loadBalanceDisplays(selector) {
    var sel = selector || "[data-balance-display]";
    return fetchWallet().then(function (wallet) {
      var amount = wallet && wallet.balance != null ? wallet.balance : 0;
      document.querySelectorAll(sel).forEach(function (el) {
        setBalanceDisplay(el, amount);
      });
      return wallet;
    });
  }

  function parseDepositAmount(input) {
    var raw = String(input == null ? "" : input).trim().replace(/,/g, "");
    if (!raw) return { ok: false, error: "Enter an amount." };
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      return { ok: false, error: "Use up to two decimal places (e.g. 50 or 50.00)." };
    }
    var dollars = Number(raw);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      return { ok: false, error: "Enter a positive amount." };
    }
    if (dollars < WALLET_MIN_DEPOSIT_USD) {
      return {
        ok: false,
        error: "Minimum deposit is " + formatUsd(WALLET_MIN_DEPOSIT_USD) + "."
      };
    }
    return { ok: true, dollars: Math.round(dollars * 100) / 100 };
  }

  function purchaseAccounts(payload, accessToken) {
    var token = accessToken || getAccountsSession();
    var body = Array.isArray(payload) ? { ids: payload } : payload || {};
    return fetch(apiBase() + "/api/accounts/purchase", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }).then(parseJsonResponse);
  }

  var REFUND_WINDOW_MINUTES = 120;

  var REFUND_REASONS = [
    { value: "login_incorrect", label: "Login incorrect" },
    { value: "payment_expired", label: "Payment expired" },
    { value: "cannot_make_label", label: "Can't make label" },
    { value: "other", label: "Other" }
  ];

  function fetchOrders(accessToken) {
    var token = accessToken || getAccountsSession();
    return fetch(apiBase() + "/api/orders", {
      headers: { Authorization: "Bearer " + token }
    }).then(parseJsonResponse);
  }

  function requestRefund(purchaseId, payload, accessToken) {
    var token = accessToken || getAccountsSession();
    return fetch(apiBase() + "/api/orders/" + encodeURIComponent(purchaseId) + "/refunds", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload || {})
    }).then(parseJsonResponse);
  }

  global.ListingsApp = {
    COLUMNS: COLUMNS,
    apiBase: apiBase,
    isConfigured: isConfigured,
    isAuthConfigured: isAuthConfigured,
    isApiConfigured: isApiConfigured,
    getClient: getClient,
    fetchAccounts: fetchAccountsFromApi,
    fetchAccountsFromApi: fetchAccountsFromApi,
    getAccountsSession: getAccountsSession,
    setAccountsSession: setAccountsSession,
    clearAccountsSession: clearAccountsSession,
    loginWithToken: loginWithToken,
    adminRequest: adminRequest,
    renderAccounts: renderAccounts,
    applyAccountFilters: applyAccountFilters,
    countryOptions: countryOptions,
    baseOptions: baseOptions,
    rowsForCarrier: rowsForCarrier,
    fillFilterSelect: fillFilterSelect,
    dash: dash,
    setStatus: setStatus,
    WALLET_MIN_DEPOSIT_USD: WALLET_MIN_DEPOSIT_USD,
    formatUsd: formatUsd,
    setBalanceDisplay: setBalanceDisplay,
    fetchWallet: fetchWallet,
    createDeposit: createDeposit,
    loadBalanceDisplays: loadBalanceDisplays,
    parseDepositAmount: parseDepositAmount,
    formatAccountStatus: formatAccountStatus,
    purchaseAccounts: purchaseAccounts,
    REFUND_WINDOW_MINUTES: REFUND_WINDOW_MINUTES,
    REFUND_REASONS: REFUND_REASONS,
    fetchOrders: fetchOrders,
    requestRefund: requestRefund
  };
})(window);
