// index.js — Express API + Telegraf bot (webhook)
import express from "express";
import crypto from "crypto";
import cors from "cors";
import { Telegraf } from "telegraf";

// ===== ENV =====
const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;              // токен бота
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);     // 12345,-100...
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "")
  .split(",").map(s => s.trim()).filter(Boolean);     // домены фронта
const SERVER_URL = process.env.SERVER_URL;            // https://tma-den-serv.onrender.com
const SECRET_TOKEN = process.env.SECRET_TOKEN || "";  // любой секрет для вебхука
const WEBHOOK_PATH = "/tg-webhook";                   // путь вебхука

// ===== Express =====
const app = express();
app.use(express.json());

app.use(cors({
  origin: (origin, cb) => {
    if (!ALLOWED_ORIGINS.length || !origin) return cb(null, true);
    return ALLOWED_ORIGINS.includes(origin) ? cb(null, true) : cb(new Error("CORS"));
  }
}));

app.get("/", (_, res) => res.send("TMA backend is running"));

// Приём «ручных» POST из фронта (опционально)
app.post("/web-data", async (req, res) => {
  const p = req.body || {};
  const text = formatLead(p);
  try {
    await notifyAdmins(text);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/report-error", async (req, res) => {
  try {
    const initData = req.get("X-Telegram-Init-Data") || "";
    if (!verifyInitData(initData, BOT_TOKEN)) {
      return res.status(403).json({ ok:false, error:"bad initData" });
    }

    const { debug } = req.body || {};
    const u = debug?.user;
    const who = u?.id
      ? `<a href="tg://user?id=${u.id}">${esc(u.username ? "@"+u.username : (u.first_name || u.id))}</a>`
      : "неизвестно";

    const txt = [
      "🐞 <b>Отчёт об ошибке</b>",
      `<b>От:</b> ${who}`,
      debug?.url ? `<b>URL:</b> ${esc(debug.url)}` : null,
      (debug?.platform || debug?.colorScheme) ? `<b>Платформа:</b> ${esc(debug.platform||"-")} • Тема: ${esc(debug.colorScheme||"-")}` : null,
      debug?.appStep ? `<b>Шаг:</b> ${esc(debug.appStep)}` : null,
      debug?.selection ? `<b>Выбор:</b> ${esc(JSON.stringify(debug.selection))}` : null,
      debug?.lastError?.message ? `\n<b>Ошибка:</b> ${esc(debug.lastError.message)}` : null,
      debug?.lastError?.stack ? `<b>Стек:</b>\n<pre>${esc(String(debug.lastError.stack)).slice(0,1800)}</pre>` : null,
      `Время: ${new Date(debug?.ts || Date.now()).toLocaleString("ru-RU")}`
    ].filter(Boolean).join("\n");

    if (!ADMIN_CHAT_IDS.length) {
      return res.status(500).json({ ok:false, error:"ADMIN_CHAT_IDS is empty" });
    }

    await notifyAdmins(txt); // уже есть в index.js
    res.json({ ok:true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false });
  }
});


// ===== Telegraf bot (вебхук) =====
if (!BOT_TOKEN) {
  console.warn("BOT_TOKEN is not set — бот отключён");
} else {
  const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 9000 });

  bot.command("id", (ctx) => ctx.reply(`chat_id: ${ctx.chat.id}`));

  // данные из WebApp
  bot.on("message", async (ctx) => {
    const raw = ctx.message?.web_app_data?.data;
    if (!raw) return;
    let p; try { p = JSON.parse(raw); } catch { return; }

    const text = formatLead(p, ctx.from);
    if (ADMIN_CHAT_IDS.length) {
      await Promise.all(ADMIN_CHAT_IDS.map(id =>
        ctx.telegram.sendMessage(id, text, { parse_mode: "HTML", disable_web_page_preview: true })
      ));
    }
    await ctx.reply("✅ Заявка принята, скоро свяжемся!");
  });

  // защищаем вебхук секретом
  app.use(WEBHOOK_PATH, (req, res, next) => {
    const got = req.get("x-telegram-bot-api-secret-token") || "";
    if (SECRET_TOKEN && got !== SECRET_TOKEN) return res.sendStatus(403);
    return bot.webhookCallback(WEBHOOK_PATH)(req, res);
  });

  // ставим вебхук на старте (если указан SERVER_URL)
  (async () => {
    try {
      if (SERVER_URL) {
        await bot.telegram.setWebhook(`${SERVER_URL}${WEBHOOK_PATH}`, { secret_token: SECRET_TOKEN });
        console.log("Webhook set:", `${SERVER_URL}${WEBHOOK_PATH}`);
      } else {
        const info = await bot.telegram.getWebhookInfo();
        console.log("Webhook info:", info);
      }
    } catch (e) {
      console.error("setWebhook error:", e.response?.description || e.message);
    }
  })();
}

app.listen(PORT, () => console.log(`Server running on ${PORT}`));

// ===== helpers =====
function esc(s = "") { return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function formatLead(p, from) {
  return [
    `<b>Новая заявка</b>`,
    p.category ? `Категория: <b>${esc(p.category)}</b>` : null,
    (p.brand || p.model) ? `Марка/модель: <b>${esc(p.brand||"")} ${esc(p.model||"")}</b>` : null,
    p.service ? `Услуга: <b>${esc(p.service)}</b>` : null,
    p.price_from ? `От: <b>${p.price_from} ₽</b>` : null,
    p.name ? `Имя: <b>${esc(p.name)}</b>` : null,
    p.phone ? `Телефон: <b>${esc(p.phone)}</b>` : null,
    p.city ? `Город: <b>${esc(p.city)}</b>` : null,
    p.comment ? `Комментарий: ${esc(p.comment)}` : null,
    from ? `\nОт: <a href="tg://user?id=${from.id}">${esc(from.username ? "@"+from.username : from.first_name || "user")}</a>` : null,
    `Время: ${new Date(p.ts || Date.now()).toLocaleString("ru-RU")}`
  ].filter(Boolean).join("\n");
}

function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return false;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return false;

  const data = [];
  params.forEach((v, k) => { if (k !== "hash") data.push(`${k}=${v}`); });
  data.sort();
  const dataCheckString = data.join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  const authDate = Number(params.get("auth_date") || "0");
  const fresh = !authDate || (Date.now()/1000 - authDate) < 24*60*60; // не старше суток

  return calc === hash && fresh;
}


async function notifyAdmins(text, tg) {
  // отправка через Telegram HTTP API (без зависимости от контекста Telegraf)
  await Promise.all(ADMIN_CHAT_IDS.map(id =>
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: id, text, parse_mode: "HTML", disable_web_page_preview: true })
    })
  ));
}
