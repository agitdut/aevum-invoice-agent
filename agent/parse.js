/**
 * Aevum Invoice Agent — natural-language invoice parser.
 *
 * Two layers:
 *  1. Rule-based parser (default, no API key needed). Handles English and
 *     Bahasa Indonesia: amounts, 0x payer addresses, due dates, memos.
 *  2. Optional LLM layer (OpenAI-compatible chat completions, e.g. xingchiapi
 *     gpt-6.1-sol): set OPENAI_API_KEY (+ OPENAI_BASE_URL / OPENAI_MODEL).
 *     Falls back to the rule parser on any failure.
 *
 * Output shape:
 *   { intent, amount, currency, payer, dueDate, dueDateISO, memo,
 *     invoiceId, confidence, missing[], source }
 *   intent: create_invoice | pay_invoice | confirm_invoice | check_status | unknown
 *   amount: number in tUSD8 (human units); dueDate: unix seconds (null if unknown)
 */

const MONTHS = {
  jan: 0, january: 0, januari: 0,
  feb: 1, february: 1, februari: 1,
  mar: 2, march: 2, maret: 2,
  apr: 3, april: 3,
  may: 4, mei: 4,
  jun: 5, june: 5, juni: 5,
  jul: 6, july: 6, juli: 6,
  aug: 7, august: 7, agustus: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, oktober: 9,
  nov: 10, november: 10,
  dec: 11, december: 11, desember: 11, des: 11,
};

/** Normalize a written number, accepting both 1,500.00 (EN) and 1.500,00 (ID). */
function normalizeNumber(raw) {
  let s = raw.trim().replace(/_/g, "");
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  if (hasDot && hasComma) {
    // The last separator is the decimal one.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    const parts = s.split(",");
    // "150,5" -> decimal; "1,500" -> thousands.
    s = parts.length === 2 && parts[1].length !== 3 ? parts.join(".") : parts.join("");
  } else if (hasDot) {
    const parts = s.split(".");
    // "1.500" -> thousands (ID style); "1.50" -> decimal.
    s = parts.length === 2 && parts[1].length === 3 ? parts.join("") : s;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function extractAmount(text) {
  // Never let the "0" of a 0x address read as an amount.
  const noAddr = text.replace(/0x[0-9a-fA-F]{40}/g, " ");
  // 1) Explicit amount near a cue word or a currency marker.
  const explicit =
    /(?:sebesar|senilai|amount|total|bayar|pay|tagih(?:kan)?|invoice(?:kan)?|for|untuk|of)\s*\$?\s*(\d[\d.,]*)\s*(k|m|ribu|juta|rb|jt)?\s*(tusd8|usdt|usd)?/i.exec(noAddr) ||
    /(\d[\d.,]*)\s*(k|m|ribu|juta|rb|jt)?\s*(tusd8|usdt|usd|\$)/i.exec(noAddr);
  if (explicit) {
    const value = normalizeNumber(explicit[1]);
    if (value === null || value <= 0) return null;
    const mult = explicit[2] ? { k: 1e3, m: 1e6, ribu: 1e3, rb: 1e3, juta: 1e6, jt: 1e6 }[explicit[2].toLowerCase()] || 1 : 1;
    return { amount: value * mult, currency: (explicit[3] || "tUSD8").replace(/^\$/, "USD") };
  }
  // 2) Fallback: largest standalone number that is not part of a date or an address.
  const cleaned = text.replace(/0x[0-9a-fA-F]{40}/g, " ").replace(/\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi, " ");
  const nums = [...cleaned.matchAll(/\b(\d[\d.,]*)\b/g)]
    .map((m) => normalizeNumber(m[1]))
    .filter((n) => n !== null && n > 0);
  if (!nums.length) return null;
  return { amount: Math.max(...nums), currency: "tUSD8" };
}

function extractPayer(text) {
  const m = /0x[0-9a-fA-F]{40}/.exec(text);
  return m ? m[0] : null;
}

function extractInvoiceId(text) {
  const m = /invoice\s*#?\s*(\d+)/i.exec(text) || /#(\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

function extractDueDate(text, now = new Date()) {
  const lower = text.toLowerCase();
  let m;
  if ((m = /(?:in|dalam)\s+(\d+)\s*(?:days?|hari)/.exec(lower))) {
    return Math.floor(now.getTime() / 1000) + Number(m[1]) * 86400;
  }
  if ((m = /(\d+)\s*(?:days?|hari)\s*(?:lagi|from now|ke depan)/.exec(lower))) {
    return Math.floor(now.getTime() / 1000) + Number(m[1]) * 86400;
  }
  if (/\btomorrow\b|\bbesok\b/.test(lower)) {
    return Math.floor(now.getTime() / 1000) + 86400;
  }
  if (/\bnext week\b|\bminggu depan\b/.test(lower)) {
    return Math.floor(now.getTime() / 1000) + 7 * 86400;
  }
  // ISO date 2026-12-05 or 05/12/2026 (D/M/Y).
  if ((m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text))) {
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000);
  }
  if ((m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text))) {
    return Math.floor(Date.UTC(+m[3], +m[2] - 1, +m[1]) / 1000);
  }
  // "5 Dec" / "Dec 5" / "5 Desember 2026".
  const monthNames = Object.keys(MONTHS).join("|");
  m =
    new RegExp(`(\\d{1,2})\\s+(${monthNames})\\s*(\\d{4})?`, "i").exec(text) ||
    new RegExp(`(${monthNames})\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?`, "i").exec(text);
  if (m) {
    const dayFirst = /^\d/.test(m[0]);
    const day = Number(dayFirst ? m[1] : m[2]);
    const month = MONTHS[(dayFirst ? m[2] : m[1]).toLowerCase()];
    let year = Number(dayFirst ? m[3] : m[3]) || now.getUTCFullYear();
    let ts = Date.UTC(year, month, day, 12, 0, 0) / 1000;
    if (ts < now.getTime() / 1000) ts = Date.UTC(year + 1, month, day, 12, 0, 0) / 1000;
    return Math.floor(ts);
  }
  return null;
}

function extractMemo(text, parsed) {
  // Take the text after the LAST cue — the memo usually comes after amount/address.
  const cueRe = /(?:for|untuk|atas|jasa|memo|keterangan|deskripsi|description)\s*[:\-]?\s*/gi;
  let memo = null;
  let m;
  let lastIdx = -1;
  while ((m = cueRe.exec(text)) !== null) lastIdx = m.index + m[0].length;
  if (lastIdx >= 0) memo = text.slice(lastIdx);
  if (memo) {
    memo = memo
      .replace(/0x[0-9a-fA-F]{40}/g, " ")
      .replace(/,?\s*(?:jatuh tempo|due|dalam\s+\d+\s*hari|in\s+\d+\s*days?|tomorrow|besok|next week|minggu depan)\b.*$/i, "")
      .replace(/\s+/g, " ")
      .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "")
      .trim();
  }
  if (!memo) {
    // Strip structured fragments; whatever readable text remains is the memo.
    // Date phrases go first, otherwise the amount strip eats their digits.
    const JUNK = new Set([
      "untuk", "dalam", "hari", "besok", "tomorrow", "lusa", "minggu", "depan",
      "jatuh", "tempo", "due", "date", "tanggal", "yang", "dengan", "dari",
      "ke", "kepada", "to", "for", "of", "$",
    ]);
    let rest = text
      .replace(/0x[0-9a-fA-F]{40}/g, " ")
      .replace(/(?:in|dalam)\s+\d+\s*(?:days?|hari)/gi, " ")
      .replace(/\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{0,4}/gi, " ")
      .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ")
      .replace(/\b\d[\d.,]*\s*(k|m|ribu|juta|rb|jt)?\s*(tusd8|usdt|usd|\$)?/gi, " ")
      .replace(/\b(?:buatkan|buat|create|tolong|please|invoice|tagihan|sebesar|senilai|bayar|pay|tagih)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const words = rest.split(" ").filter((w) => w && !JUNK.has(w.toLowerCase()));
    memo = words.join(" ").replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "").trim();
  }
  return memo ? memo.slice(0, 120) : null;
}

function detectIntent(text) {
  const lower = text.toLowerCase();
  if (/\b(pay|bayar|lunasi)\b/.test(lower) && /invoice|tagihan|#\d+/.test(lower)) return "pay_invoice";
  if (/\b(confirm|konfirmasi|terima|diterima|release|cairkan)\b/.test(lower)) return "confirm_invoice";
  if (/\b(status|cek|check|lihat|list|daftar)\b/.test(lower) && /invoice|tagihan/.test(lower)) return "check_status";
  if (/\b(dispute|komplain|sengketa|refund)\b/.test(lower)) return "dispute_invoice";
  if (/\b(cancel|batal)\b/.test(lower) && /invoice|tagihan/.test(lower)) return "cancel_invoice";
  return "create_invoice";
}

/** Rule-based parse. Always available, no network needed. */
function ruleParse(text) {
  const intent = detectIntent(text);
  const amountInfo = intent === "create_invoice" ? extractAmount(text) : null;
  const payer = extractPayer(text);
  const dueDate = intent === "create_invoice" ? extractDueDate(text) : null;
  const invoiceId = intent === "create_invoice" ? null : extractInvoiceId(text);
  const memo = intent === "create_invoice" ? extractMemo(text, {}) : null;

  const missing = [];
  if (intent === "create_invoice") {
    if (!amountInfo) missing.push("amount");
    if (!payer) missing.push("payer");
    if (!dueDate) missing.push("dueDate");
  } else if (intent !== "check_status" && invoiceId === null) {
    missing.push("invoiceId");
  }

  const found = ["amount", "payer", "dueDate"].filter((k) => {
    if (k === "amount") return !!amountInfo;
    if (k === "payer") return !!payer;
    return !!dueDate;
  }).length;
  const confidence = intent === "create_invoice" ? found / 3 : invoiceId !== null ? 1 : 0.3;

  return {
    intent,
    amount: amountInfo ? amountInfo.amount : null,
    currency: amountInfo ? amountInfo.currency : null,
    payer,
    dueDate,
    dueDateISO: dueDate ? new Date(dueDate * 1000).toISOString() : null,
    memo,
    invoiceId,
    confidence,
    missing,
    source: "rules",
  };
}

const SYSTEM_PROMPT = `You extract structured invoice instructions from a user message (English or Bahasa Indonesia).
Reply with ONLY a JSON object, no other text:
{"intent":"create_invoice|pay_invoice|confirm_invoice|check_status|dispute_invoice|cancel_invoice","amount":number|null,"currency":"tUSD8","payer":"0x...|null","dueDateISO":"YYYY-MM-DD|null","memo":"string|null","invoiceId":number|null}
- amount is in tUSD8 (human units). "1.5k" = 1500, "2 juta" = 2000000.
- dueDateISO: resolve relative dates ("in 7 days", "besok", "5 Des") against today.
- If a field is absent, use null.`;

async function llmParse(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Today is ${new Date().toISOString().slice(0, 10)}. Message: ${text}` },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(raw);
  const dueDate = parsed.dueDateISO ? Math.floor(new Date(parsed.dueDateISO).getTime() / 1000) : null;
  const missing = [];
  if (parsed.intent === "create_invoice") {
    if (!parsed.amount) missing.push("amount");
    if (!parsed.payer) missing.push("payer");
    if (!dueDate) missing.push("dueDate");
  }
  return {
    intent: parsed.intent || "unknown",
    amount: parsed.amount ?? null,
    currency: parsed.currency || "tUSD8",
    payer: parsed.payer || null,
    dueDate,
    dueDateISO: parsed.dueDateISO || null,
    memo: parsed.memo || null,
    invoiceId: parsed.invoiceId ?? null,
    confidence: missing.length === 0 ? 0.95 : 0.7,
    missing,
    source: "llm",
  };
}

/** Parse with the LLM when configured, otherwise (or on failure) rules. */
async function parseInvoiceRequest(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    return { intent: "unknown", amount: null, currency: null, payer: null, dueDate: null, dueDateISO: null, memo: null, invoiceId: null, confidence: 0, missing: ["text"], source: "rules" };
  }
  try {
    const llm = await llmParse(trimmed);
    if (llm) return llm;
  } catch {
    // fall through to the rule parser
  }
  return ruleParse(trimmed);
}

module.exports = { parseInvoiceRequest, ruleParse, normalizeNumber };
