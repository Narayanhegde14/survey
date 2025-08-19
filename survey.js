// survey.js — EV & BaaS interactive survey (with Honda plans)

// ------------------- tiny DOM helpers -------------------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

// wired DOM nodes from HTML
const bar = $("#bar");
const slideEl = $("#slide");
const nextBtn = $("#nextBtn");
const backBtn = $("#backBtn");
const stepPill = $("#stepPill");
const requirementTag = $("#requirementTag");
const validationMsg = $("#validationMsg");

// locale helpers
const rupee = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

// persistent state
const state = JSON.parse(localStorage.getItem("ev_baas_survey_state") || "{}");
function saveState() {
  localStorage.setItem("ev_baas_survey_state", JSON.stringify(state));
}
function val(id) {
  return state[id];
}
function setVal(id, v) {
  state[id] = v;
  saveState();
}

// --------------------------------------------------------
//  Energy economics + Honda subscription plans
// --------------------------------------------------------
const ECON = {
  // Vehicle / energy model
  KWH_PER_SWAP: 2.5, // kWh delivered per swap
  WH_PER_KM: 35, // Wh/km consumption

  // Ownership battery economics
  BATTERY_PRICE: 45000, // ₹ per pack
  WARRANTY_KM: 45000, // km per pack before replacement
  HORIZON_YEARS: 3, // comparison horizon

  // Honda plans
  GST_RATE: 0, //0.18,

  LITE_FEE_EXGST: 678, // ₹/mo (ex-GST)
  LITE_INCLUDED_SWAPS: 12, // swaps/mo included
  LITE_EXTRA_SWAP_EXGST: 180, // ₹ per extra swap (assume ex-GST)

  BASIC_FEE: 1999, // ₹/mo (as announced; treat as MRP)
  BASIC_KWH_CAP: 35, // kWh/mo

  ADV_FEE: 3599, // ₹/mo (as announced; treat as MRP)
  ADV_KWH_CAP: 87, // kWh/mo

  // Context-based over-cap rates (ex-GST)
  LITE_KWH_CAP: 20, // Lite energy cap per month (kWh)
  EXTRA_RATE_LITE_PER_KWH_EXGST: 70, // ₹/kWh over-cap for Lite (ex-GST)
  EXTRA_RATE_FIXED_PER_KWH_EXGST: 35, // ₹/kWh over-cap for Basic/Advanced (ex-GST)

  // Ownership battery amortization
  OWN_PACK_PRICE: 35000, // ₹ per pack
  OWN_PACK_KWH: 1.8, // kWh per pack (2000 Wh)
  OWN_CYCLES: 600, // cycle life before replacement
};

function estimateMonthlyKm(ans = state) {
  const d = Number(ans.commute?.daily_km || 0);
  const longest = Number(ans.commute?.longest_km || 0);
  // Simple model: ~26 commute days + one long ride
  return Math.max(0, Math.round(d * 26 + longest));
}

function computeUsage(ans = state) {
  const d = Number(ans.commute?.daily_km || 0);
  const days = Number(ans.commute?.days_used ?? 26);
  const longest = Number(ans.commute?.longest_km || 0);
  const whPerKm = Number(ans.commute?.wh_per_km ?? ECON.WH_PER_KM);

  const monthlyKm = Math.max(0, Math.round(d * days + longest));
  const kmPerSwap = (ECON.KWH_PER_SWAP * 1000) / whPerKm;
  const swapsNeededExact = kmPerSwap > 0 ? monthlyKm / kmPerSwap : 0;
  const swapsNeededCeil = Math.ceil(swapsNeededExact);
  const kWhPerMonth = (monthlyKm * whPerKm) / 1000;

  return {
    monthlyKm,
    kmPerSwap,
    swapsNeededExact,
    swapsNeededCeil,
    kWhPerMonth,
    whPerKm,
    days,
  };
}

// Cost if using the Honda Lite plan (includes 12 swaps; extra swaps billed)
function calcLiteEconomics(ans = state) {
  const u = computeUsage(ans);
  // Included energy via cap (context): 30 kWh
  const includedKWh =
    ECON.LITE_KWH_CAP ?? ECON.LITE_INCLUDED_SWAPS * ECON.KWH_PER_SWAP;
  const feeIncl = ECON.LITE_FEE_EXGST * (1 + ECON.GST_RATE);
  const rateIncl = ECON.EXTRA_RATE_LITE_PER_KWH_EXGST * (1 + ECON.GST_RATE);

  const extraKWh = Math.max(0, u.kWhPerMonth - includedKWh);
  const monthlyCost = feeIncl + extraKWh * rateIncl;

  const subPerKm = u.monthlyKm ? monthlyCost / u.monthlyKm : 0;
  const sub3y = monthlyCost * 12 * ECON.HORIZON_YEARS;

  // For display alongside swap thinking
  const virtualIncludedSwaps = includedKWh / ECON.KWH_PER_SWAP;
  return {
    ...u,
    includedKWh,
    virtualIncludedSwaps,
    feeIncl,
    rateIncl,
    extraKWh,
    monthlyCost,
    subPerKm,
    sub3y,
  };
}

// Ownership battery cost across the horizon
function calcOwnershipEconomics(ans = state) {
  const u = computeUsage(ans);
  const ratePerKWh =
    ECON.OWN_PACK_PRICE / (ECON.OWN_PACK_KWH * ECON.OWN_CYCLES); // ₹/kWh (battery amortization only)
  const ownMonthly = u.kWhPerMonth * ratePerKWh;
  const ownPerKm = u.monthlyKm ? ownMonthly / u.monthlyKm : 0;
  return {
    monthlyKm: u.monthlyKm,
    kWhPerMonth: u.kWhPerMonth,
    ratePerKWh,
    ownMonthly,
    ownPerKm,
  };
}

// Basic/Advanced caps helper (informational)
function planEnergyNote(kWhUsed, cap) {
  if (kWhUsed <= cap) return { within: true, over: 0 };
  return { within: false, over: +(kWhUsed - cap).toFixed(1) };
}

// ----------------------------------------
//  Shared visuals & UI helpers
// ----------------------------------------
function toast(msg) {
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.cssText =
    "position:fixed; bottom:16px; left:50%; transform:translateX(-50%); background:#111936; border:1px solid rgba(255,255,255,.15); padding:10px 14px; border-radius:12px; color:#e5e7eb; z-index:9999; box-shadow:0 10px 30px rgba(0,0,0,.35)";
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1600);
}
function download(filename, text) {
  const el = document.createElement("a");
  el.href = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
  el.download = filename;
  el.style.display = "none";
  document.body.appendChild(el);
  el.click();
  document.body.removeChild(el);
}

// default media image when help is empty
const DEFAULT_MEDIA_IMG =
  "https://lh3.googleusercontent.com/p/AF1QipODon_IrWq4LT3ycNfmLNLTA05I3ZYE_MjEDyXd=s1360-w1360-h1020";
function placeholderMedia() {
  return `
  <div class="media">
    <img src="${DEFAULT_MEDIA_IMG}" alt="Battery swapping station" style="max-height:320px; object-fit:cover; width:100%; border-radius:12px"/>
  </div>`;
}

// Wrapped label bar chart
function drawBarChart(canvas, labels, values) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width,
    H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0b122a";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,.08)";
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

  const padL = 48,
    padR = 20,
    padT = 28,
    padB = 56;
  const chartW = W - padL - padR,
    chartH = H - padT - padB;

  const max = Math.max(1, ...values.map((v) => Number(v) || 0));
  const n = Math.max(1, values.length);
  const slot = chartW / n;
  const barW = Math.max(8, slot * 0.55);
  const x0 = padL + (slot - barW) / 2;

  ctx.strokeStyle = "rgba(255,255,255,.15)";
  ctx.beginPath();
  ctx.moveTo(padL, padT + chartH);
  ctx.lineTo(padL + chartW, padT + chartH);
  ctx.stroke();

  for (let i = 0; i < n; i++) {
    const v = Number(values[i]) || 0;
    const h = (v / max) * chartH;
    const x = x0 + i * slot,
      y = padT + chartH - h;

    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, "#6ee7ff");
    g.addColorStop(1, "#a78bfa");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, barW, h);

    ctx.fillStyle = "rgba(255,255,255,.9)";
    ctx.font = "bold 14px system-ui,Segoe UI";
    const valStr = String(v);
    ctx.fillText(valStr, x + (barW - ctx.measureText(valStr).width) / 2, y - 6);

    const label = String(labels[i] || "");
    const maxWidth = Math.min(slot, 160);
    const lines = wrapText(label, ctx, maxWidth, "12px system-ui,Segoe UI", 2);
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.font = "12px system-ui,Segoe UI";
    const baseY = padT + chartH + 16;
    lines.forEach((ln, j) => {
      ctx.fillText(
        ln,
        x + (barW - ctx.measureText(ln).width) / 2,
        baseY + j * 14
      );
    });
  }

  function wrapText(text, ctx, maxWidth, font, maxLines) {
    ctx.font = font;
    const words = text.split(" ");
    let lines = [],
      cur = "";
    for (const w of words) {
      const test = cur ? cur + " " + w : w;
      if (ctx.measureText(test).width <= maxWidth) cur = test;
      else {
        lines.push(cur || w);
        cur = ctx.measureText(w).width > maxWidth ? truncate(w) : w;
      }
      if (lines.length === maxLines) break;
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    return lines;
    function truncate(str) {
      let s = str;
      while (ctx.measureText(s + "…").width > maxWidth && s.length > 1)
        s = s.slice(0, -1);
      return s + "…";
    }
  }
}

// --------------------------------------------------------
//       Components (each returns a DOM fragment)
// --------------------------------------------------------
const components = {
  // 1) Contact (replaces old video intro)
  introContact: (s) => {
    const prev = val(s.id) || {};
    const div = document.createElement("div");
    div.className = "content";
    div.innerHTML = `
      <div class="vstack">
        <h2 class="title">${s.title}</h2>
        <p class="subtitle">${s.subtitle || ""}</p>
        <div class="vstack">
          <label>Name <input type="text" id="${s.id}_name" value="${
      prev.name || ""
    }" placeholder="Your name"/></label>
          <label>Phone <input type="tel" id="${s.id}_phone" value="${
      prev.phone || ""
    }" placeholder="10-digit mobile"/></label>
          <label>Email <input type="email" id="${s.id}_email" value="${
      prev.email || ""
    }" placeholder="you@example.com"/></label>
          <label>Age <input type="number" min="12" max="100" id="${
            s.id
          }_age" value="${prev.age || ""}"/></label>
          <label>City / Area <input type="text" id="${s.id}_place" value="${
      prev.place || ""
    }" placeholder="e.g., Indiranagar, Bengaluru"/></label>
          <label><input type="checkbox" id="${s.id}_consent" ${
      prev.consent ? "checked" : ""
    }/> I agree to be contacted only to share survey goodies and relevant EV/BaaS updates. No spam.</label>
        </div>
      </div>
      ${placeholderMedia()}
    `;
    function collect() {
      setVal(s.id, {
        name: $(`#${s.id}_name`, div).value.trim(),
        phone: $(`#${s.id}_phone`, div).value.trim(),
        email: $(`#${s.id}_email`, div).value.trim(),
        age: Number($(`#${s.id}_age`, div).value || ""),
        place: $(`#${s.id}_place`, div).value.trim(),
        consent: $(`#${s.id}_consent`, div).checked,
      });
      validateAndToggle(s);
    }
    div.addEventListener("input", collect);
    div.addEventListener("change", collect);
    setTimeout(collect, 0);
    return div;
  },

  radioGrid: (s) => {
    const div = document.createElement("div");
    div.className = "content";
    div.innerHTML = `
      <div class="vstack">
        <h2 class="title">${s.title}</h2>
        <p class="subtitle">${s.subtitle || ""}</p>
        <div class="optgrid" role="radiogroup" aria-label="${s.title}">
          ${s.options
            .map((opt) => {
              const checked = val(s.id) === opt ? "checked" : "";
              return `<label class="cardopt"><input type="radio" name="${s.id}" value="${opt}" ${checked}/> ${opt}</label>`;
            })
            .join("")}
        </div>
      </div>
      ${s.mediaHTML || placeholderMedia()}
    `;
    div.addEventListener("change", (e) => {
      if (e.target.name === s.id) {
        setVal(s.id, e.target.value);
        validateAndToggle(s);
      }
    });
    return div;
  },

  checkboxGrid: (s) => {
    const div = document.createElement("div");
    div.className = "content";
    const prev = new Set(val(s.id) || []);
    div.innerHTML = `
      <div class="vstack">
        <h2 class="title">${s.title}</h2>
        <p class="subtitle">${s.subtitle || ""}</p>
        <div class="optgrid">
          ${s.options
            .map((opt) => {
              const checked = prev.has(opt) ? "checked" : "";
              return `<label class="cardopt"><input type="checkbox" value="${opt}" ${checked}/> ${opt}</label>`;
            })
            .join("")}
        </div>
        ${
          s.allowOther
            ? `<input type="text" id="${s.id}_other" placeholder="${
                s.otherPlaceholder || "Other (optional)"
              }" />`
            : ""
        }
        ${s.max ? `<div class="note">Select up to ${s.max}.</div>` : ""}
      </div>
      ${s.mediaHTML || placeholderMedia()}
    `;

    function collect(e) {
      const chosen = $$("input[type=checkbox]", div)
        .filter((x) => x.checked)
        .map((x) => x.value);
      if (s.max && chosen.length > s.max) {
        if (e && e.target && e.target.type === "checkbox") {
          e.target.checked = false;
          return;
        }
      }
      if (s.allowOther) {
        const ov = $(`#${s.id}_other`, div)?.value.trim();
        if (ov) chosen.push(ov);
      }
      setVal(s.id, chosen);
      validateAndToggle(s);
    }
    div.addEventListener("change", collect);
    div.addEventListener("input", collect);
    setTimeout(collect, 0);
    return div;
  },

  fixedSumSliders: (s) => {
    const TOTAL = s.total ?? 100;
    const MAX = s.maxPer ?? 25;
    const keys = s.metrics.map((m) => m.key);
    const labels = Object.fromEntries(s.metrics.map((m) => [m.key, m.label]));
    const prev = val(s.id) || {};
    const data = { ...prev };

    if (Object.keys(prev).length === 0) {
      const n = keys.length;
      let base = Math.floor(TOTAL / n),
        rem = TOTAL - base * n;
      keys.forEach(
        (k, i) => (data[k] = Math.min(MAX, base + (i < rem ? 1 : 0)))
      );
      setVal(s.id, data);
    }

    const div = document.createElement("div");
    div.className = "content";
    div.innerHTML = `
      <div class="vstack">
        <h2 class="title">${s.title}</h2>
        <p class="subtitle">${s.subtitle || ""}</p>
        <div class="pill">Total must equal ${TOTAL} to continue — cap ${MAX} per slider.</div>
        <div class="vstack">
          ${keys
            .map((k) => {
              const v = Number(data[k] ?? 0);
              return `<div class="range">
              <label><span>${labels[k]}</span><span><b id="${s.id}_${k}_val">${v}</b> / ${MAX}</span></label>
              <input type="range" min="0" max="${MAX}" step="1" value="${v}" data-key="${k}"/>
            </div>`;
            })
            .join("")}
          <button class="btn" id="${s.id}_even">Reset even split</button>
        </div>
      </div>
      <div class="media"><canvas id="${
        s.id
      }_chart" width="560" height="320"></canvas></div>
    `;

    const canvas = $(`#${s.id}_chart`, div);

    function total() {
      return keys.reduce((a, k) => a + Number(data[k] || 0), 0);
    }
    function updateUI() {
      drawBarChart(
        canvas,
        keys.map((k) => labels[k]),
        keys.map((k) => Number(data[k] || 0))
      );
      keys.forEach((k) => {
        const inp = div.querySelector(`input[data-key="${k}"]`);
        const lbl = div.querySelector(`#${s.id}_${k}_val`);
        if (inp) inp.value = data[k];
        if (lbl) lbl.textContent = data[k];
      });
      setVal(s.id, data);
      validateAndToggle(s);
    }

    function setValue(key, newVal) {
      newVal = Math.max(0, Math.min(MAX, Math.round(Number(newVal) || 0)));
      const cur = Number(data[key] || 0);
      if (newVal === cur) return;
      const before = total();
      const delta = newVal - cur;
      data[key] = newVal;

      if (delta > 0) {
        const others = keys.filter((k) => k !== key);
        let need = Math.max(0, before + delta - TOTAL);
        if (need > 0) {
          let sumOthers = others.reduce((a, k) => a + Number(data[k] || 0), 0);
          if (sumOthers > 0) {
            const ratio = (sumOthers - need) / sumOthers;
            const parts = others.map((k) => {
              const f = Math.max(0, data[k] * ratio);
              return { k, base: Math.floor(f), frac: f - Math.floor(f) };
            });
            let floorSum = parts.reduce((a, p) => a + p.base, 0);
            let target = sumOthers - need;
            let toAdd = target - floorSum;
            parts.sort((a, b) => b.frac - a.frac);
            for (let i = 0; i < toAdd; i++) parts[i % parts.length].base += 1;
            parts.forEach((p) => (data[p.k] = p.base));
          } else {
            data[key] = Math.max(0, cur + (TOTAL - before));
          }
        }
      }
      updateUI();
    }

    div.addEventListener("input", (e) => {
      if (e.target.matches("input[type=range][data-key]"))
        setValue(e.target.dataset.key, e.target.value);
    });
    div.addEventListener("click", (e) => {
      if (e.target.id === `${s.id}_even`) {
        const n = keys.length;
        let base = Math.floor(TOTAL / n),
          rem = TOTAL - base * n;
        keys.forEach(
          (k, i) => (data[k] = Math.min(MAX, base + (i < rem ? 1 : 0)))
        );
        updateUI();
      }
    });

    setTimeout(updateUI, 0);
    return div;
  },

  // Generic ranges with right info panel support
  ranges: (s) => {
    const prev = val(s.id) || {};
    const div = document.createElement("div");
    div.className = "content";
    div.innerHTML = `
      <div class="vstack">
        <h2 class="title">${s.title}</h2>
        <p class="subtitle">${s.subtitle || ""}</p>
        <div class="vstack">
          ${s.items
            .map((m) => {
              const v = prev[m.key] ?? m.default ?? m.min ?? 0;
              return `<div class="range">
              <label class="${m.required ? "req" : ""}">
                <span>${m.label}${
                m.key === "wh_per_km"
                  ? ' <span class="modechip" id="' + s.id + '_mode">City</span>'
                  : ""
              }</span>
                <span><b id="${s.id}_${m.key}_val">${fmt(m, v)}</b></span>
              </label>
              <input aria-label="${m.label}" type="range" min="${m.min}" max="${
                m.max
              }" step="${m.step || 1}" value="${v}" data-key="${m.key}"/>
              ${
                m.key === "wh_per_km"
                  ? '<div class="rangelabels"><span>Eco</span><span>City</span><span>Sports</span><span>Blaze</span></div>'
                  : ""
              }
            </div>`;
            })
            .join("")}
        </div>
      </div>
      <div class="media">
        <div id="${s.id}_info" class="infobox" style="width:100%">
          ${s.infoDefaultHTML || defaultHelpBox()}
        </div>
      </div>
    `;

    const data = { ...prev };
    s.items.forEach((m) => {
      if (data[m.key] === undefined) data[m.key] = m.default ?? m.min ?? 0;
    });
    setVal(s.id, data);
    setTimeout(() => {
      s.items.forEach((m) => {
        const valEl = $(`#${s.id}_${m.key}_val`, div);
        const rangeEl = div.querySelector(`input[data-key="${m.key}"]`);
        if (valEl) valEl.textContent = fmt(m, data[m.key]);
        if (rangeEl) rangeEl.value = data[m.key];
      });
      validateAndToggle(s);
    }, 0);

    function fmt(m, v) {
      return m.currency
        ? rupee.format(v)
        : m.suffix
        ? `${v}${m.suffix}`
        : `${v}`;
    }

    function setHelp(key) {
      const box = $(`#${s.id}_info`, div);
      if (!box) return;
      if (s.help && s.help[key]) box.innerHTML = s.help[key];
      else box.innerHTML = s.infoDefaultHTML || defaultHelpBox();
    }

    div.addEventListener("input", (e) => {
      if (e.target.matches("input[type=range]")) {
        const key = e.target.dataset.key;
        const item = s.items.find((i) => i.key === key);
        data[key] = Number(e.target.value);
        $(`#${s.id}_${key}_val`, div).textContent = fmt(item, data[key]);
        setVal(s.id, data);
        validateAndToggle(s);
        setHelp(key);
      }
    });
    div.addEventListener("mouseover", (e) => {
      if (e.target.matches("input[type=range]")) setHelp(e.target.dataset.key);
    });
    div.addEventListener("focusin", (e) => {
      if (e.target.matches("input[type=range]")) setHelp(e.target.dataset.key);
    });

    // --- Commute-specific live summary and mode chip ---
    function whMode(v) {
      v = Number(v) || 0;
      if (v <= 24) return ["Eco", "eco"];
      if (v <= 30) return ["Eco–City", "mix"];
      if (v <= 32.72) return ["City", "city"];
      if (v <= 36) return ["City–Sports", "mix"];
      if (v <= 40) return ["Sports", "sports"];
      return ["Blaze", "blaze"];
    }
    function renderSummary() {
      if (s.id !== "commute") return;
      const u = computeUsage(state);
      const box = document.getElementById(`${s.id}_info`);
      if (!box) return;
      const [label, cls] = whMode(state.commute?.wh_per_km ?? ECON.WH_PER_KM);
      const mc = document.getElementById(`${s.id}_mode`);
      if (mc) {
        mc.textContent = label;
        mc.className = `modechip ${cls}`;
      }
      const htmlHelp =
        s.help && s.help.__current
          ? s.help.__current
          : s.infoDefaultHTML || defaultHelpBox();
      box.innerHTML = `
        <div class="helpbox">
          <div class="help-title">This month at your settings</div>
          <div class="statgrid">
            <div class="stat"><div class="kv"><span class="k">Monthly km</span><span class="v">${u.monthlyKm.toLocaleString()}</span></div></div>
            <div class="stat"><div class="kv"><span class="k">Energy use</span><span class="v">${u.kWhPerMonth.toFixed(
              1
            )} kWh</span></div></div>
            <div class="stat"><div class="kv"><span class="k">Swaps needed</span><span class="v">${Math.ceil(
              u.swapsNeededExact
            )}/mo</span></div></div>
            <div class="stat"><div class="kv"><span class="k">~ km per swap</span><span class="v">${u.kmPerSwap.toFixed(
              1
            )}</span></div></div>
          </div>
          <div class="help-card">
            <div class="hc-title">Mode</div>
            <div class="kv"><span class="v"><span class="modechip ${cls}">${label}</span> · ${u.whPerKm.toFixed(
        1
      )} Wh/km</span></div>
            
          </div>
        </div>`;
    }

    // Keep track of latest help content to re-show alongside summary
    function setHelpWithSummary(key) {
      if (!s.help) {
        renderSummary();
        return;
      }
      s.help.__current = s.help[key] || s.infoDefaultHTML || defaultHelpBox();
      renderSummary();
    }
    // Override existing hooks for commute
    if (s.id === "commute") {
      // Initial render
      setTimeout(renderSummary, 0);
      // Replace setHelp function behavior
      setHelp = setHelpWithSummary;
      // Trigger once to seed
      setHelpWithSummary("wh_per_km");
    }

    return div;
  },

  // Subscription appeal with Honda plan math + chart

  // Subscription appeal with Honda plan math + chart (cleaned)

  // Subscription appeal with Honda plan math + chart (full-width plans)

  // Subscription appeal with Honda plan math + chart (full-width plans + richer Basic/Advanced)

  // Subscription appeal with Honda plan math + chart (full-width plans + richer all cards)

  // Subscription appeal with context-based caps & overage (Lite in kWh; Basic/Adv overage ₹/kWh)

  // Subscription appeal with context-based caps & overage + Home comparator & break-even

  // Subscription appeal with horizon control + ownership amortization (per-kWh battery cost)
  subscriptionAppeal: (s) => {
    const div = document.createElement("div");
    div.className = "content";

    const selected = val(s.id);
    div.innerHTML = `
      <div class="vstack">
        <h2 class="title">${s.title}</h2>
        <p class="subtitle">${s.subtitle || ""}</p>
      </div>

      <!-- Top row: options (2x2) + chart -->
      <div class="subgrid twoCols">
        <div>
          <div class="optgrid two" role="radiogroup" aria-label="${s.title}">
            ${s.options
              .map((opt) => {
                const checked = selected === opt ? "checked" : "";
                return `<label class="cardopt"><input type="radio" name="${s.id}" value="${opt}" ${checked}/> ${opt}</label>`;
              })
              .join("")}
          </div>
        </div>
        <div class="media"><canvas id="${
          s.id
        }_chart" width="700" height="360"></canvas></div>
      </div>

      <!-- Second row: monthly usage under options (left) and Home charging full-width below -->
      <div class="subgrid twoCols">
        <div class="infocard" id="${
          s.id
        }_assump" style="grid-column:1/2;"></div>
        <div class="spacer"></div>
      </div>
       <!-- <div class="infocard fullwidth" id="${s.id}_compare"></div> -->

      <div class="planGrid fullwidth" id="${s.id}_grid">
        <div class="infocard" id="${s.id}_lite"></div>
        <div class="infocard" id="${s.id}_basic"></div>
        <div class="infocard" id="${s.id}_adv"></div>
      </div>

      
      <div class="smallnote fullwidth" id="${
        s.id
      }_note" style="margin-top:8px;"></div>
    `;

    const fmtR = (n) =>
      new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
      }).format(Math.round(Number(n) || 0));
    const fmt1 = (n) => (Number(n) || 0).toFixed(1);
    const fmt2 = (n) => (Number(n) || 0).toFixed(2);
    const fmtInt = (n) => Number(n || 0).toLocaleString();

    // Delegate input/change events so controls keep working across re-renders
    function onInputChange(e) {
      const t = e.target;
      if (!t) return;
      if (t.id === `${s.id}_yrs`) {
        setVal("horizon_years", Number(t.value || 3));
        refresh();
      }
      if (t.id === `${s.id}_tariff` || t.id === `${s.id}_loss`) {
        const tval = Number(
          document.getElementById(`${s.id}_tariff`)?.value || 8
        );
        const lval = Number(
          document.getElementById(`${s.id}_loss`)?.value || 12
        );
        setVal("compare", { home_tariff: tval, home_loss_pc: lval });
        refresh();
      }
    }
    div.addEventListener("input", onInputChange);
    div.addEventListener("change", onInputChange);

    function refresh() {
      const years = Number(val("horizon_years") || ECON.HORIZON_YEARS || 3);
      const lite = calcLiteEconomics();
      const own = calcOwnershipEconomics();
      const u = computeUsage();

      // Assumptions + horizon control
      const includedKm =
        (ECON.LITE_KWH_CAP * 1000) / (u.whPerKm || ECON.WH_PER_KM);
      $(`#${s.id}_assump`, div).innerHTML = `
        <div class="title-row">Your monthly usage</div>
        <div class="kv"><span class="k">Monthly km</span><span class="v">${fmtInt(
          u.monthlyKm
        )}</span></div>
        <div class="kv"><span class="k">~ km per swap <span class="tip" tabindex="0" data-tip="Battery has ~3.0 kWh installed but you are billed for 2.5 kWh usable per swap. All calculations use 2.5 kWh/swap.">ℹ︎</span></span><span class="v">${fmt1(
          u.kmPerSwap
        )}</span></div>
        <div class="kv"><span class="k">Swaps needed</span><span class="v">${
          u.swapsNeededCeil
        }/mo</span></div>
        <div class="kv"><span class="k">Energy use</span><span class="v">${fmt1(
          u.kWhPerMonth
        )} kWh/mo</span></div>
        <div class="kv"><span class="k">Horizon</span>
          <span class="v">
            <input type="range" id="${
              s.id
            }_yrs" min="1" max="10" step="1" value="${Number(
        val("horizon_years") || ECON.HORIZON_YEARS || 3
      )}" style="width:160px; vertical-align:middle"/>
            <b id="${s.id}_yrs_lbl">${Number(
        val("horizon_years") || ECON.HORIZON_YEARS || 3
      )}</b> yrs
          </span>
        </div>
      `;

      // --- Lite block (as before) ---
      const liteStatus =
        lite.extraKWh <= 0
          ? '<span class="status ok">Within cap</span>'
          : `<span class="status warn">Exceeds by ${fmt1(
              lite.extraKWh
            )} kWh</span>`;

      const rateFixedIncl =
        ECON.EXTRA_RATE_FIXED_PER_KWH_EXGST * (1 + ECON.GST_RATE);
      const basicOver = Math.max(0, u.kWhPerMonth - ECON.BASIC_KWH_CAP);
      const advOver = Math.max(0, u.kWhPerMonth - ECON.ADV_KWH_CAP);
      const basicMonthlyTotal = ECON.BASIC_FEE + basicOver * rateFixedIncl;
      const advMonthlyTotal = ECON.ADV_FEE + advOver * rateFixedIncl;
      let liteRec = "";
      const minMonthly = Math.min(
        lite.monthlyCost,
        basicMonthlyTotal,
        advMonthlyTotal
      );
      if (minMonthly === lite.monthlyCost)
        liteRec = '<span class="status ok">Best for current usage</span>';
      else if (minMonthly === basicMonthlyTotal)
        liteRec = '<span class="status info">Basic likely cheaper</span>';
      else liteRec = '<span class="status info">Advanced likely cheaper</span>';

      $(`#${s.id}_lite`, div).innerHTML = `
        <div class="title-row">Honda <span class="tag">Lite</span></div>
        <div class="sub">Cap: ${ECON.LITE_KWH_CAP} kWh · Fee: ${fmtR(
        lite.feeIncl
      )}/mo</div>
        <div class="kv"><span class="k">Status</span><span class="v">${liteStatus}</span></div>
        <div class="kv"><span class="k">Over-cap rate</span><span class="v">${fmtR(
          lite.rateIncl
        )} /kWh</span></div>
        <div class="kv"><span class="k">Est. extra this month</span><span class="v">${
          lite.extraKWh > 0 ? fmtR(lite.extraKWh * lite.rateIncl) : "—"
        }</span></div>
        <div class="kv"><span class="k">Total per month</span><span class="v">${fmtR(
          lite.monthlyCost
        )}</span></div>
        <div class="kv"><span class="k">Est. ₹/km</span><span class="v">${fmt2(
          lite.subPerKm
        )} ₹/km</span></div>
      `;

      // --- Basic / Advanced ---
      const basic = planEnergyNote(u.kWhPerMonth, ECON.BASIC_KWH_CAP);
      const adv = planEnergyNote(u.kWhPerMonth, ECON.ADV_KWH_CAP);

      function perKm(total) {
        return u.monthlyKm ? total / u.monthlyKm : 0;
      }

      $(`#${s.id}_basic`, div).innerHTML = `
        <div class="title-row">Honda <span class="tag">Basic</span></div>
        <div class="sub">Cap: ${ECON.BASIC_KWH_CAP} kWh · Fee: ${fmtR(
        ECON.BASIC_FEE
      )}/mo</div>
        <div class="kv"><span class="k">Status</span><span class="v"><span class="status ${
          basic.within ? "ok" : "warn"
        }">${
        basic.within ? "Within cap" : "Exceeds by " + fmt1(basic.over) + " kWh"
      }</span></span></div>
        <div class="kv"><span class="k">Over-cap rate</span><span class="v">${fmtR(
          rateFixedIncl
        )} /kWh</span></div>
        <div class="kv"><span class="k">Est. extra this month</span><span class="v">${
          basicOver > 0 ? fmtR(basicOver * rateFixedIncl) : "—"
        }</span></div>
        <div class="kv"><span class="k">Total per month</span><span class="v">${fmtR(
          basicMonthlyTotal
        )}</span></div>
        <div class="kv"><span class="k">Est. ₹/km</span><span class="v">${fmt2(
          perKm(basicMonthlyTotal)
        )} ₹/km</span></div>
      `;

      $(`#${s.id}_adv`, div).innerHTML = `
        <div class="title-row">Honda <span class="tag">Advanced</span></div>
        <div class="sub">Cap: ${ECON.ADV_KWH_CAP} kWh · Fee: ${fmtR(
        ECON.ADV_FEE
      )}/mo</div>
        <div class="kv"><span class="k">Status</span><span class="v"><span class="status ${
          adv.within ? "ok" : "warn"
        }">${
        adv.within ? "Within cap" : "Exceeds by " + fmt1(adv.over) + " kWh"
      }</span></span></div>
        <div class="kv"><span class="k">Over-cap rate</span><span class="v">${fmtR(
          rateFixedIncl
        )} /kWh</span></div>
        <div class="kv"><span class="k">Est. extra this month</span><span class="v">${
          advOver > 0 ? fmtR(advOver * rateFixedIncl) : "—"
        }</span></div>
        <div class="kv"><span class="k">Total per month</span><span class="v">${fmtR(
          advMonthlyTotal
        )}</span></div>
        <div class="kv"><span class="k">Est. ₹/km</span><span class="v">${fmt2(
          perKm(advMonthlyTotal)
        )} ₹/km</span></div>
      `;

      // --- Comparator and horizon logic (reused from previous version) ---
      const compareState = Object.assign(
        { home_tariff: 8, home_loss_pc: 12 },
        val("compare") || {}
      );
      const homeEffKWh = u.kWhPerMonth * (1 + compareState.home_loss_pc / 100);
      const homeMonthly = homeEffKWh * compareState.home_tariff;
      const homePerKm = perKm(homeMonthly);

      const feeL = ECON.LITE_FEE_EXGST * (1 + ECON.GST_RATE);
      const rL = ECON.EXTRA_RATE_LITE_PER_KWH_EXGST * (1 + ECON.GST_RATE);
      const feeB = ECON.BASIC_FEE,
        capB = ECON.BASIC_KWH_CAP;
      const feeA = ECON.ADV_FEE,
        capA = ECON.ADV_KWH_CAP;
      const rF = rateFixedIncl;

      function breakEvenAgainst(feeFixed, capFixed) {
        const capL = ECON.LITE_KWH_CAP;
        let U = 30 + (feeFixed - feeL) / rL;
        if (U > 30 && U <= capFixed) return U;
        U = (feeFixed - feeL + 30 * rL - capFixed * rF) / (rL - rF);
        if (!isFinite(U)) return null;
        if (U > capFixed) return U;
        return null;
      }
      function beDetails(U) {
        if (!U) return "—";
        const dKWh = U - u.kWhPerMonth;
        const km = (U * 1000) / ECON.WH_PER_KM;
        const swaps = U / ECON.KWH_PER_SWAP;
        const delta = (dKWh >= 0 ? "+" : "") + fmt1(dKWh) + " kWh from now";
        return `${fmt1(U)} kWh/mo (~${fmtInt(Math.round(km))} km, ${fmt1(
          swaps
        )} swaps) · ${delta}`;
      }
      const beB = breakEvenAgainst(feeB, capB);
      const beA = breakEvenAgainst(feeA, capA);
      setVal("compare", compareState);

      //       $(`#${s.id}_compare`, div).innerHTML = `
      //         <div class="title-row">Home charging vs plans</div>
      //         <div class="statgrid">
      //           <div class="stat">
      //             <h4>Home settings</h4>
      //             <div class="kv"><span class="k">Tariff</span><span class="v">
      //               <input type="number" id="${s.id}_tariff" min="3" max="20" step="0.1" value="${compareState.home_tariff}" style="width:92px"/> ₹/kWh
      //             </span></div>
      //             <div class="kv"><span class="k">Charging loss</span><span class="v">
      //               <input type="number" id="${s.id}_loss" min="0" max="30" step="1" value="${compareState.home_loss_pc}" style="width:92px"/> %
      //             </span></div>
      //           </div>
      //           <div class="stat">
      //             <h4>Your cost at home</h4>
      //             <div class="kv"><span class="k">Energy billed</span><span class="v">${fmt1(homeEffKWh)} kWh/mo</span></div>
      //             <div class="kv"><span class="k">Monthly cost</span><span class="v">${fmtR(homeMonthly)}</span></div>
      //             <div class="kv"><span class="k">₹/km</span><span class="v">${fmt2(homePerKm)} ₹/km</span></div>
      //           </div>
      // </div>
      // </div>
      //         </div>
      //         <div class="smallnote">Horizon: <b>${Number(val('horizon_years') || ECON.HORIZON_YEARS || 3)} years</b>. Home tariff defaults to 8 ₹/kWh and 12% charging loss; adjust to your local rate.</div>
      //       `;

      // Year slider handlers
      const yr = document.getElementById(`${s.id}_yrs`);
      if (yr) {
        yr.addEventListener("input", () => {
          setVal("horizon_years", Number(yr.value || 3));
          refresh();
        });
      }
      ["_tariff", "_loss"].forEach((suf) => {
        const el = document.getElementById(`${s.id}${suf}`);
        if (el) {
          el.addEventListener("input", () => {
            const t = Number(
              document.getElementById(`${s.id}_tariff`).value || 8
            );
            const l = Number(
              document.getElementById(`${s.id}_loss`).value || 12
            );
            setVal("compare", { home_tariff: t, home_loss_pc: l });
            refresh();
          });
        }
      });

      // --- Bars: include ownership with upfront packs (used vs leftover) and chosen horizon
      const lifetimeKWhPerPack = ECON.OWN_PACK_KWH * ECON.OWN_CYCLES; // total deliverable kWh per pack
      const totalKWhHorizon = u.kWhPerMonth * 12 * years;
      const packsNeededStep =
        lifetimeKWhPerPack > 0
          ? Math.ceil(totalKWhHorizon / lifetimeKWhPerPack)
          : 0;
      const investedStep = packsNeededStep * ECON.OWN_PACK_PRICE;
      const lastPackUsedKWh = Math.max(
        0,
        totalKWhHorizon - Math.max(0, packsNeededStep - 1) * lifetimeKWhPerPack
      );
      const lastPackFracUsed = packsNeededStep
        ? Math.min(1, lastPackUsedKWh / lifetimeKWhPerPack)
        : 0;
      const usedCostStep =
        (Math.max(0, packsNeededStep - 1) + lastPackFracUsed) *
        ECON.OWN_PACK_PRICE;
      const wasteCostStep = Math.max(0, investedStep - usedCostStep);

      const bars = [
        {
          label: `Lite (${years}y)`,
          value: Math.round(lite.monthlyCost * 12 * years),
        },
        {
          label: `Basic (${years}y)`,
          value: Math.round(basicMonthlyTotal * 12 * years),
        },
        {
          label: `Advanced (${years}y)`,
          value: Math.round(advMonthlyTotal * 12 * years),
        },
        {
          label: `Ownership — used (${years}y)`,
          value: Math.round(usedCostStep),
        },
        {
          label: `Ownership — leftover (${years}y)`,
          value: Math.round(wasteCostStep),
        },
      ];
      const canvas = $(`#${s.id}_chart`, div);
      drawBarChart(
        canvas,
        bars.map((b) => b.label),
        bars.map((b) => b.value)
      );

      // Note
      $(
        `#${s.id}_note`,
        div
      ).innerHTML = `Ownership amortization uses ₹${ECON.OWN_PACK_PRICE.toLocaleString()} per ${
        ECON.OWN_PACK_KWH
      } kWh pack over ${ECON.OWN_CYCLES} cycles (~₹${Math.round(
        ECON.OWN_PACK_PRICE / (ECON.OWN_PACK_KWH * ECON.OWN_CYCLES)
      )}/kWh). Bars reflect monthly totals × ${Number(
        val("horizon_years") || ECON.HORIZON_YEARS || 3
      )} years at your current usage.`;
    }

    div.addEventListener("change", (e) => {
      if (e.target.name === s.id) {
        setVal(s.id, e.target.value);
        validateAndToggle(s);
      }
    });
    refresh();
    return div;
  },
  form: (s) => {
    const prev = val(s.id) || {};
    const div = document.createElement("div");
    div.className = "content";
    div.innerHTML = `
      <div class="vstack">
        <h2 class="title">${s.title}</h2>
        <p class="subtitle">${s.subtitle || ""}</p>
        <div class="vstack">
          <label class="${s.required?.includes("name") ? "req" : ""}">Name
            <input type="text" id="${s.id}_name" value="${
      prev.name || ""
    }" placeholder="Optional"/>
          </label>
          <label class="${s.required?.includes("email") ? "req" : ""}">Email
            <input type="email" id="${s.id}_email" value="${
      prev.email || ""
    }" placeholder="Optional"/>
          </label>
          <label>Phone
            <input type="tel" id="${s.id}_phone" value="${
      prev.phone || ""
    }" placeholder="Optional"/>
          </label>
          <label><input type="checkbox" id="${s.id}_consent" ${
      prev.consent ? "checked" : ""
    }/> I consent to be contacted about EV/BaaS updates.</label>
        </div>
      </div>
      ${placeholderMedia()}
    `;
    function collect() {
      setVal(s.id, {
        name: $(`#${s.id}_name`, div).value.trim(),
        email: $(`#${s.id}_email`, div).value.trim(),
        phone: $(`#${s.id}_phone`, div).value.trim(),
        consent: $(`#${s.id}_consent`, div).checked,
      });
    }
    div.addEventListener("input", collect);
    div.addEventListener("change", collect);
    return div;
  },

  review: (s) => {
    const div = document.createElement("div");
    div.className = "content";
    const payload = buildPayload();
    div.innerHTML = `
      <div class="vstack">
        <h2 class="title">${s.title}</h2>
        <p class="subtitle">${s.subtitle || ""}</p>
        <div class="summary">
          <div><span class="tag">Vehicle</span> <b>${
            payload.current_vehicle || "—"
          }</b></div>
          <div><span class="tag">Daily Commute</span> ${
            payload.commute?.daily_km ?? "—"
          } km • Longest ${payload.commute?.longest_km ?? "—"} km</div>
          <div><span class="tag">Subscription Appeal</span> ${
            payload.subscription_appeal || "—"
          }</div>
          <details><summary>Full JSON (click to expand)</summary><pre id="jsonOut"></pre></details>
          <div style="display:flex; gap:10px; flex-wrap: wrap;">
            <button class="btn" id="downloadBtn">Download JSON</button>
            <button class="btn" id="copyBtn">Copy JSON</button>
            <button class="btn primary" id="submitBtn">Submit</button>
          </div>
        </div>
      </div>
      <div class="media"><canvas id="reviewChart" width="520" height="320"></canvas></div>
    `;
    setTimeout(() => {
      $("#jsonOut", div).textContent = JSON.stringify(payload, null, 2);
      const pr = payload.priorities || {};
      const labels = Object.keys(pr),
        vals = Object.values(pr).map(Number);
      if (labels.length) drawBarChart($("#reviewChart", div), labels, vals);
      $("#downloadBtn", div).addEventListener("click", () =>
        download("ev-baas-survey.json", JSON.stringify(payload, null, 2))
      );
      $("#copyBtn", div).addEventListener("click", async () => {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        toast("Copied to clipboard");
      });
      $("#submitBtn", div).addEventListener("click", submit);
    }, 0);
    return div;
  },
};

function defaultHelpBox() {
  return `
    <div class="vstack" style="gap:10px; width:100%;">
      <div class="pill">Slide help</div>
      <div class="note">Hover, focus, or drag a slider to see details here.</div>
      <img src="${DEFAULT_MEDIA_IMG}" alt="Battery swap station" style="max-width:100%; border-radius:12px; opacity:.9"/>
    </div>`;
}

// --------------------------------------------------------
// Slides with branching
// --------------------------------------------------------
const slides = [
  {
    id: "intro_contact",
    required: false,
    component: "introContact",
    title: "Let’s get you your goodies 🎁",
    subtitle:
      "We will not spam. We need these details only to share digital goodies and key takeaways at the end.",
  },
  {
    id: "current_vehicle",
    required: true,
    component: "radioGrid",
    title: "What best describes your current vehicle situation?",
    options: [
      "I own an EV",
      "I own a petrol/diesel vehicle",
      "I own both",
      "I don't own a vehicle",
    ],
  },
  {
    id: "ev_experience",
    required: false,
    component: "checkboxGrid",
    title: "If you use an EV, what are your biggest pain points?",
    subtitle: "(Choose all that apply)",
    options: [
      "Limited range",
      "Charging downtime",
      "Charger reliability",
      "Battery degradation",
      "Service/repairs",
      "Cost of replacement battery",
    ],
    allowOther: true,
    otherPlaceholder: "Other (optional)",
    condition: (ans) =>
      ["I own an EV", "I own both"].includes(ans.current_vehicle),
  },
  {
    id: "why_not_ev",
    required: false,
    component: "radioGrid",
    title: "Main reason you haven’t chosen an EV yet?",
    options: [
      "Upfront cost is high",
      "Range anxiety",
      "Charging access",
      "Waiting for better models",
      "Battery life concerns",
      "Other",
    ],
    condition: (ans) =>
      ["I own a petrol/diesel vehicle", "I don't own a vehicle"].includes(
        ans.current_vehicle
      ),
  },
  {
    id: "commute",
    required: true,
    component: "ranges",
    title: "Tell us about your commute",
    items: [
      {
        key: "daily_km",
        label: "Average daily distance",
        min: 0,
        max: 150,
        step: 1,
        suffix: " km",
        default: 15,
        required: true,
      },
      {
        key: "days_used",
        label: "Days used per month",
        min: 0,
        max: 31,
        step: 1,
        suffix: " days",
        default: 26,
        required: true,
      },
      {
        key: "longest_km",
        label: "Longest typical one-way trip (per month)",
        min: 0,
        max: 300,
        step: 5,
        suffix: " km",
        default: 60,
      },
      {
        key: "wh_per_km",
        label: "Typical energy use (consumption)",
        min: 21.1,
        max: 51.4,
        step: 0.1,
        suffix: " Wh/km",
        default: 32,
        required: true,
      },
    ],
    help: {
      wh_per_km: `
        <div class="vstack">
          <div class="pill">Energy use guide (Wh/km)</div>
          <div class="help-card">
            <div class="kv"><span class="k">Eco</span><span class="v">21.1 – 24</span></div>
            <div class="kv"><span class="k">City</span><span class="v">30 – 32.72</span></div>
            <div class="kv"><span class="k">Sports</span><span class="v">36 – 40</span></div>
            <div class="kv"><span class="k">Blaze</span><span class="v">40 – 51.4</span></div>
          </div>
          <div class="note">Your mode updates as you slide.</div>
        </div>`,
    },
    infoDefaultHTML: defaultHelpBox(),
  },
  {
    id: "priorities",
    required: true,
    component: "fixedSumSliders",
    title: "What matters most to you?",
    subtitle:
      "Distribute exactly 20 points (max 5 per slider). The chart updates live.",
    total: 20,
    maxPer: 5,
    metrics: [
      { key: "upfront", label: "Upfront price" },
      { key: "monthly", label: "Monthly running cost" },
      { key: "range", label: "Real-world range" },
      { key: "perf", label: "Acceleration & performance" },
      { key: "charge", label: "Charging / swap time" },
      { key: "brand", label: "Brand trust" },
    ],
  },
  {
    id: "performance",
    required: true,
    component: "ranges",
    title: "Performance expectations for your ideal EV",
    items: [
      {
        key: "accel_0_40",
        label: "0–40 km/h time",
        min: 2,
        max: 12,
        step: 0.5,
        suffix: " s",
        default: 5,
        required: true,
      },
      {
        key: "top_speed",
        label: "Top speed",
        min: 45,
        max: 120,
        step: 5,
        suffix: " km/h",
        default: 80,
      },
      {
        key: "hill",
        label: "Hill-climb priority",
        min: 0,
        max: 10,
        step: 1,
        suffix: " /10",
        default: 5,
      },
    ],
    help: {
      accel_0_40: `
        <div class="vstack">
          <div class="pill">0–40 km/h (seconds)</div>
          <div class="note">Lower = quicker launches. Useful for city gaps, pillion, inclines. Typical scooters ~4–7 s.</div>
          <ul class="note">
            <li>Sporty feel: 3–5 s</li><li>Calmer starts: 6–8 s</li><li>Faster accel may reduce range if used often.</li>
          </ul>
        </div>`,
      top_speed: `
        <div class="vstack">
          <div class="pill">Top speed (km/h)</div>
          <ul class="note">
            <li>City: 60–80</li>
            <li>Mixed/peri-urban: 80–100</li>
            <li>Frequent highways: 100+</li>
          </ul>
          <div class="note">Higher top speed can trade with range & price.</div>
        </div>`,
      hill: `
        <div class="vstack">
          <div class="pill">Hill-climb priority (0–10)</div>
          <ul class="note">
            <li>0–3: Mostly flat city</li>
            <li>4–7: Some flyovers / short inclines</li>
            <li>8–10: Regular steep hills or heavy loads</li>
          </ul>
        </div>`,
    },
    infoDefaultHTML: defaultHelpBox(),
  },
  {
    id: "cost",
    required: true,
    component: "ranges",
    title: "Cost expectations",
    items: [
      {
        key: "upfront",
        label: "Budget for vehicle (on-road)",
        min: 30000,
        max: 300000,
        step: 5000,
        currency: true,
        default: 120000,
        required: true,
      },
      {
        key: "monthly",
        label: "Expected monthly operating cost (fuel/energy + service)",
        min: 200,
        max: 6000,
        step: 100,
        currency: true,
        default: 1200,
      },
    ],
    help: {
      upfront: `
        <div class="vstack">
          <div class="pill">On-road budget</div>
          <div class="note">Includes taxes, insurance, basic accessories. Use this to benchmark models later.</div>
        </div>`,
      monthly: `
        <div class="vstack">
          <div class="pill">Monthly operating cost</div>
          <div class="note">Fuel/energy + routine service. For EVs: mostly energy + occasional wear items.</div>
        </div>`,
    },
    infoDefaultHTML: defaultHelpBox(),
  },
  {
    id: "conversion_concerns",
    required: false,
    component: "checkboxGrid",
    title:
      "What are your top concerns about converting an ICE vehicle to electric?",
    subtitle: "Select up to two.",
    options: [
      "Conversion cost",
      "Reliability after conversion",
      "Performance compared to petrol",
      "Availability of service/support",
    ],
    allowOther: true,
    otherPlaceholder: "Other (e.g., Range)",
    max: 2,
  },
  {
    id: "subscription_appeal",
    required: true,
    component: "subscriptionAppeal",
    title: "How appealing is a monthly battery subscription?",
    subtitle:
      "We compare Honda’s Lite plan (with extra swaps if you exceed 12/mo) vs owning the battery for 3 years.",
    options: [
      "Very appealing",
      "Somewhat appealing",
      "Neutral",
      "Not appealing",
    ],
  },
  {
    id: "review",
    required: false,
    component: "review",
    title: "Review & Submit",
    subtitle: "Check the summary and export or submit your responses.",
  },
];

// payload builder
function buildPayload() {
  return {
    intro_contact: state.intro_contact,
    current_vehicle: state.current_vehicle,
    ev_experience: state.ev_experience,
    why_not_ev: state.why_not_ev,
    commute: state.commute,
    priorities: state.priorities,
    performance: state.performance,
    cost: state.cost,
    conversion_concerns: state.conversion_concerns,
    subscription_appeal: state.subscription_appeal,
    meta: {
      userAgent: navigator.userAgent,
      ts: new Date().toISOString(),
      version: "split-0.4-honda",
    },
  };
}

// compute flow w/ conditions
function computeFlow() {
  const ans = state;
  return slides.filter((s) => !s.condition || s.condition(ans));
}

let flow = computeFlow();
let idx = Math.min(
  Number(localStorage.getItem("ev_baas_slide_idx") || 0),
  flow.length - 1
);

function go(i) {
  idx = Math.max(0, Math.min(i, flow.length - 1));
  localStorage.setItem("ev_baas_slide_idx", idx);
  render();
}

function render() {
  flow = computeFlow();
  if (idx >= flow.length) idx = flow.length - 1;
  const s = flow[idx];

  stepPill.textContent = `Slide ${idx + 1} / ${flow.length}`;
  const pct = Math.round((idx / (flow.length - 1)) * 100);
  bar.style.width = `${pct}%`;

  requirementTag.textContent = s.required ? "Required" : "Optional";
  validationMsg.textContent = "";

  slideEl.innerHTML = "";
  const comp = components[s.component];
  if (!comp) {
    slideEl.innerHTML = `<div class="content"><h2 class="title">Unknown component: ${s.component}</h2></div>`;
    return;
  }
  const fragment = comp(s);
  slideEl.appendChild(fragment);

  backBtn.disabled = idx === 0;
  nextBtn.textContent = idx === flow.length - 1 ? "Finish ✅" : "Next ▶";
  validateAndToggle(s);
}

// validation
function validateAndToggle(s) {
  let ok = true;
  const v = val(s.id);

  if (s.component === "fixedSumSliders") {
    const obj = v && typeof v === "object" ? v : {};
    const total = Object.values(obj).reduce((a, b) => a + (Number(b) || 0), 0);
    const requiredTotal = s.total ?? 100;
    const isOk = total === requiredTotal;
    nextBtn.disabled = !isOk;
    validationMsg.textContent = isOk
      ? ""
      : `Please allocate exactly ${requiredTotal} points (current total ${total}).`;
    return;
  }

  if (s.required) {
    if (
      v === undefined ||
      v === null ||
      v === "" ||
      (Array.isArray(v) && v.length === 0)
    )
      ok = false;
    if (typeof v === "object" && !Array.isArray(v)) {
      if (s.component === "ranges" && s.items) {
        ok = s.items.every(
          (item) =>
            !item.required ||
            (v[item.key] !== undefined && v[item.key] !== null)
        );
      }
    }
  }
  nextBtn.disabled = !ok;
  validationMsg.textContent = ok ? "" : "Please complete this slide.";
}

// navigation buttons
nextBtn.addEventListener("click", () => {
  if (idx === flow.length - 1) {
    toast("Thanks! Your responses are ready.");
    return;
  }
  go(idx + 1);
});
backBtn.addEventListener("click", () => go(idx - 1));

// keyboard navigation
document.addEventListener("keydown", (e) => {
  const tag = (e.target || {}).tagName || "";
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
  if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") {
    if (!nextBtn.disabled) nextBtn.click();
  }
  if (e.key === "ArrowLeft") {
    backBtn.click();
  }
});

// submit (hook to Apps Script later)
async function submit() {
  const payload = buildPayload();
  // const ENDPOINT = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';
  // try {
  //   const res = await fetch(ENDPOINT, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  //   if(!res.ok) throw new Error(await res.text());
  //   toast('Submitted successfully');
  // } catch(err){ toast('Submit failed: '+ err.message); }
  download("ev-baas-survey.json", JSON.stringify(payload, null, 2));
}

// default help box
function defaultHelpBox() {
  return `
    <div class="vstack" style="gap:10px; width:100%;">
      <div class="pill">Slide help</div>
      <div class="note">Hover, focus, or drag a slider to see details here.</div>
      <img src="${DEFAULT_MEDIA_IMG}" alt="Battery swap station" style="max-width:100%; border-radius:12px; opacity:.9"/>
    </div>`;
}

// first render
render();

// --- injected: brandStars component (rate 1-5 per brand) ---
if (typeof components === "object") {
  components.brandStars = (s) => {
    const brands = s.brands || [
      "Ather",
      "Ola",
      "TVS",
      "Bajaj",
      "Hero",
      "Honda",
    ];
    const prev = val(s.id) || {};
    const div = document.createElement("div");
    div.className = "content";
    const starPath =
      "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z";
    div.innerHTML = `
      <div class="vstack">
        <h2 class="title">${s.title}</h2>
        <p class="subtitle">${s.subtitle || ""}</p>
        <div class="vstack" style="gap:10px;">
          ${brands
            .map(
              (b) => `
            <label style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
              <span>${b}</span>
              <div class="stars" data-brand="${b}">
                ${[1, 2, 3, 4, 5]
                  .map(
                    (n) => `
                  <button class="star" type="button" data-brand="${b}" data-val="${n}" aria-label="${b} ${n} star" title="${n}">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${starPath}"/></svg>
                  </button>`
                  )
                  .join("")}
              </div>
            </label>
          `
            )
            .join("")}
        </div>
      </div>
    `;
    function paint() {
      $$(".star", div).forEach((btn) => {
        const b = btn.dataset.brand,
          n = Number(btn.dataset.val);
        const sel = Number((prev || {})[b] || 0);
        btn.style.opacity = n <= sel ? 1 : 0.35;
        btn.style.filter =
          n <= sel
            ? "drop-shadow(0 2px 6px rgba(0,0,0,.35))"
            : "grayscale(0.4)";
      });
    }
    div.addEventListener("click", (e) => {
      const btn = e.target.closest(".star");
      if (!btn) return;
      const b = btn.dataset.brand,
        n = Number(btn.dataset.val);
      const cur = Number((prev || {})[b] || 0);
      prev[b] = n === cur ? 0 : n; // toggle off if clicking same
      setVal(s.id, { ...prev });
      paint();
      validateAndToggle(s);
    });
    setTimeout(paint, 0);
    return div;
  };
}

// --- injected: add Brand Trust slide before Review ---
try {
  const idxReview =
    typeof slides !== "undefined"
      ? Math.max(
          0,
          slides.findIndex((s) => s.id === "review")
        )
      : -1;
  const insertAt =
    idxReview >= 0 ? idxReview : Math.max(0, (slides?.length || 1) - 1);
  slides.splice(insertAt, 0, {
    id: "brand_trust",
    required: false,
    component: "brandStars",
    title: "Brand trust (2W EV)",
    subtitle: "Rate your perception of each brand (1–5, optional).",
    brands: ["Ather", "Ola", "TVS", "Bajaj", "Hero", "Honda"],
  });
} catch (e) {
  /* no-op */
}

// ===== Slide 9 layout auto-tag and grid placement =====
function fixSlide9Layout() {
  const s9 = document.getElementById("s9");
  if (!s9) return;

  const gridHost =
    s9.querySelector(".section-body, .slide-body, .card-body, .content") || s9;
  gridHost.classList.add("s9-grid");

  // Tag: Your monthly usage
  const usage = Array.from(
    s9.querySelectorAll(".card,.panel,.box,.section,.container")
  ).find((el) => /Your monthly usage/i.test(el.textContent || ""));
  if (usage) usage.classList.add("usage-card");

  // Tag: Home charging vs plans
  const home = Array.from(
    s9.querySelectorAll(".card,.panel,.box,.section,.container")
  ).find((el) => /Home charging vs plans/i.test(el.textContent || ""));
  if (home) home.classList.add("home-charging-card");

  // Tag: option pills container
  const optionsContainer =
    s9.querySelector(".choices-row, .option-group, .radio-group") ||
    Array.from(s9.children).find((el) =>
      el.querySelector('input[type="radio"]')
    );
  if (optionsContainer) optionsContainer.classList.add("choices-row");

  // Tag: chart container (the element that wraps a canvas)
  const chartCard =
    s9.querySelector(".chart-card") ||
    Array.from(
      s9.querySelectorAll(".card,.panel,.box,.section,.container")
    ).find((el) => el.querySelector("canvas"));
  if (chartCard) chartCard.classList.add("chart-card");
}

// Hook into lifecycle
document.addEventListener("DOMContentLoaded", fixSlide9Layout);
window.addEventListener("hashchange", fixSlide9Layout);
// If you have SPA slide rendering, call fixSlide9Layout() after slide 9 is rendered, too.
