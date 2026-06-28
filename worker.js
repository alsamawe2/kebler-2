/* ============================================================
   Kepler Optics — Order Backend (Cloudflare Worker)
   يخفي توكن تيليجرام + أكواد الخصم + يتحقق من الأسعار (منع التلاعب)
   ------------------------------------------------------------
   الأسرار تُضبط كـ Variables/Secrets في Cloudflare (مو هنا):
     TG_TOKEN      = توكن البوت الجديد
     TG_CHAT       = 209943943
     PROMO_CODES   = {"yourcode":{"discount":15,"active":true}}   (أكوادك السرية — تُضبط في Cloudflare فقط)
     ZAIN_NUMBER   = رقم محفظة زين كاش (يظهر للزبون فقط بعد تأكيد الطلب)
   ============================================================ */

// السماح بالوصول من موقعك فقط
const ALLOWED_ORIGINS = [
  "https://kepler-iq.com",
  "https://www.kepler-iq.com",
  "https://alsamawe2.github.io",
];

// كتالوج الأسعار (المصدر الموثوق — لا يثق بسعر العميل)
const PRICES = {
  1:28000, 2:52000, 3:6000, 4:48000, 5:34000, 6:19000, 7:28000, 8:28000,
  10:34000, 11:48000, 12:34000, 13:34000, 14:42000, 15:38000, 16:36000,
  17:34000, 18:22000, 19:32000,
};
const VARIANTS = {
  3: { "60 ml": 6000, "130 ml": 10500 },
};

function getPromos(env) {
  try { return JSON.parse(env.PROMO_CODES || "{}"); } catch { return {}; }
}
function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function json(data, origin, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}
const fmt = (n) => Number(n).toLocaleString("en-US");

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    const url = new URL(request.url);

    // فحص بسيط عند الجذر
    if (request.method === "GET") return new Response("Kepler order API ✓", { headers: { "Content-Type": "text/plain" } });
    if (request.method !== "POST") return json({ ok: false, error: "method" }, origin, 405);

    let body;
    try { body = await request.json(); } catch { return json({ ok:false, error:"bad json" }, origin, 400); }
    const PROMO_CODES = getPromos(env);

    // التحقق من كود خصم (للعرض اللحظي)
    if (url.pathname.endsWith("/promo")) {
      const code = String(body.code || "").trim().toLowerCase();
      const p = PROMO_CODES[code];
      if (!p || !p.active) return json({ ok:false }, origin);
      return json({ ok:true, discount: p.discount }, origin);
    }

    // استلام طلب
    if (url.pathname.endsWith("/order")) {
      const items = Array.isArray(body.items) ? body.items : [];
      const name  = String(body.name  || "").trim().slice(0,80);
      const phone = String(body.phone || "").trim().slice(0,30);
      const addr  = String(body.addr  || "").trim().slice(0,200);
      const promoCode = String(body.promo || "").trim().toLowerCase();
      if (!items.length || !name || !phone) return json({ ok:false, error:"missing" }, origin, 400);

      let total = 0, anyUnverified = false;
      const lineTexts = items.map((it, i) => {
        const id = parseInt(it.id, 10);
        const qty = Math.max(1, Math.min(99, parseInt(it.qty, 10) || 1));
        const variant = it.variant ? String(it.variant) : "";
        let unit;
        if (VARIANTS[id] && variant && VARIANTS[id][variant] != null) unit = VARIANTS[id][variant];
        else if (PRICES[id] != null) unit = PRICES[id];
        else { unit = parseInt(it.price,10) || 0; anyUnverified = true; }
        const sum = unit * qty;
        total += sum;
        const nm = String(it.name || ("#"+id)).slice(0,60);
        return (i+1)+". "+nm+(variant?" - "+variant:"")+" × "+qty+"  ➜  "+fmt(sum)+" د.ع";
      });

      let discountLine = "💰 المجموع: "+fmt(total)+" د.ع";
      const p = PROMO_CODES[promoCode];
      if (p && p.active) {
        const disc = Math.round(total * p.discount / 100);
        discountLine = "💰 المجموع الأصلي: "+fmt(total)+" د.ع\n"
          + "🏷️ كود الخصم: "+promoCode+" (-"+p.discount+"%)\n"
          + "✅ الإجمالي بعد الخصم: "+fmt(total-disc)+" د.ع";
        total = total - disc;
      }

      const orderNum = Date.now().toString().slice(-6);
      const PAY_LABELS = { cash: "الدفع عند الاستلام", zain: "زين كاش (تحويل مسبق — بانتظار الإيصال)" };
      const payLabel = PAY_LABELS[body.payMethod] || body.payMethod || "—";
      let msg = "🛍 طلب جديد #"+orderNum+" — كيبلر للبصريات\n━━━━━━━━━━━━━━━\n"
        + lineTexts.join("\n") + "\n━━━━━━━━━━━━━━━\n"
        + discountLine + "\n"
        + "💳 الدفع: "+payLabel+"\n━━━━━━━━━━━━━━━\n"
        + "👤 الاسم: "+name+"\n📞 الهاتف: "+phone
        + (addr ? "\n📍 العنوان: "+addr : "")
        + "\n━━━━━━━━━━━━━━━\n⏰ "+new Date().toLocaleString("ar-IQ");
      if (anyUnverified) msg += "\n⚠️ يحتوي منتجاً غير مُتحقَّق من سعره (حدّث PRICES في الـ Worker).";

      if (!env.TG_TOKEN || !env.TG_CHAT) return json({ ok:false, error:"config", detail:"TG_TOKEN/TG_CHAT غير مضبوطة" }, origin, 500);
      const tgUrl = "https://api.telegram.org/bot" + env.TG_TOKEN + "/sendMessage";
      const r = await fetch(tgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TG_CHAT, text: msg }),  // نص عادي — أكثر أماناً (بدون Markdown)
      });
      const d = await r.json().catch(() => ({}));
      if (!d.ok) { console.log("Telegram error:", JSON.stringify(d)); return json({ ok:false, error:"telegram", detail: d.description || "" }, origin, 502); }
      const resp = { ok:true, orderNum, total };
      if (body.payMethod === "zain") resp.zain = env.ZAIN_NUMBER || "";  // يُعاد للزبون فقط بعد الطلب
      return json(resp, origin);
    }

    return json({ ok:false, error:"not found" }, origin, 404);
  },
};
