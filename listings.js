(function (global) {
  var COLUMNS = ["login", "country", "state", "outbound", "inbound", "card_number", "expiry", "price", "account_status", "vendor"];

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

  function carrierOf(row) {
    var carrier = String((row && row.carrier) || "fedex").toLowerCase();
    return carrier === "ups" ? "ups" : "fedex";
  }

  function renderPanel(panel, rows) {
    if (!panel) return;
    var empty = panel.querySelector(".empty-state");
    var wrap = panel.querySelector(".table-wrap");
    var tbody = panel.querySelector("tbody");
    if (!tbody) return;
    tbody.textContent = "";

    if (!rows.length) {
      if (empty) empty.hidden = false;
      if (wrap) wrap.hidden = true;
      return;
    }

    if (empty) empty.hidden = true;
    if (wrap) wrap.hidden = false;

    rows.forEach(function (row) {
      var tr = document.createElement("tr");
      COLUMNS.forEach(function (key) {
        if (key === "account_status") {
          tr.appendChild(statusTd(row[key]));
        } else {
          tr.appendChild(td(row[key]));
        }
      });
      tbody.appendChild(tr);
    });
  }

  function renderAccounts(rows) {
    var fedex = [];
    var ups = [];
    (rows || []).forEach(function (row) {
      if (carrierOf(row) === "ups") ups.push(row);
      else fedex.push(row);
    });
    renderPanel(document.querySelector('[data-panel="fedex"]'), fedex);
    renderPanel(document.querySelector('[data-panel="ups"]'), ups);
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
    dash: dash,
    setStatus: setStatus,
    WALLET_MIN_DEPOSIT_USD: WALLET_MIN_DEPOSIT_USD,
    formatUsd: formatUsd,
    setBalanceDisplay: setBalanceDisplay,
    fetchWallet: fetchWallet,
    createDeposit: createDeposit,
    loadBalanceDisplays: loadBalanceDisplays,
    parseDepositAmount: parseDepositAmount,
    formatAccountStatus: formatAccountStatus
  };
})(window);
