import express from "express";
import fetch from "node-fetch";
import { Telegraf } from "telegraf";

const BOT_TOKEN     = (process.env.BOT_TOKEN || "").trim();
const SERVER_URL    = (process.env.SERVER_URL || "").trim();        // https://tma-den-serv.onrender.com
const WEBHOOK_PATH  = "/tg-webhook";
const SECRET_TOKEN  = (process.env.SECRET_TOKEN || "").trim();      // твой секрет БЕЗ пробелов
const CHANNEL_ID    = (process.env.CHANNEL_ID || "").trim();        // @den_customs
const FRONT_URL     = (process.env.FRONT_URL || "").trim();
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");
if (!SERVER_URL.startsWith("https://")) throw new Error("SERVER_URL must be https");

const app = express();
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 9000 });

// --- Команды ---
bot.start(ctx => ctx.replyWithHTML(
  "👋 <b>Добро пожаловать!</b>\nОткройте мини-приложение из меню Telegram. Админы могут прислать /publish."
));
bot.command("id", ctx => ctx.reply(String(ctx.chat.id)));

bot.command("publish", async (ctx) => {
  if (!ADMIN_CHAT_IDS.includes(String(ctx.from.id))) {
    return ctx.reply("Недостаточно прав.");
  }
  if (!CHANNEL_ID || !FRONT_URL) return ctx.reply("CHANNEL_ID или FRONT_URL не заданы");

  const postText = `🔥 <b>Автосервис онлайн — всё в один клик!</b>

🚗 Чип-тюнинг и дооснащение
⚙️ Программирование блоков
🛠 Ремонт и диагностика
📲 Онлайн-заявка прямо в Telegram

Открой каталог и оформи заявку за 1 минуту 👇`;

  try {
    await ctx.telegram.sendMessage(CHANNEL_ID, postText, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "Каталог", web_app: { url: FRONT_URL } }]] }
    });
    return ctx.reply("Пост с кнопкой отправлен в канал.");
  } catch (e) {
    return ctx.reply("Не удалось отправить пост: " + (e.description || e.message));
  }
});

// --- Установка вебхука (секрет уже .trim()) ---
const setWebhook = async () => {
  const url = `${SERVER_URL}${WEBHOOK_PATH}`;
  await bot.telegram.setWebhook(url, { secret_token: SECRET_TOKEN });
  console.log("Webhook set:", url);
};

// --- ЕДИНСТВЕННЫЙ обработчик вебхука ---
app.use(WEBHOOK_PATH, (req, res) => {
  const got = (req.get("x-telegram-bot-api-secret-token") || "").trim();
  console.log("[webhook] got=", JSON.stringify(got), " expected=", JSON.stringify(SECRET_TOKEN));
  if (SECRET_TOKEN && got !== SECRET_TOKEN) return res.sendStatus(403);
  return bot.webhookCallback(WEBHOOK_PATH)(req, res);
});

// --- health/diag ---
app.get("/diag", async (req, res) => {
  try {
    const me  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`).then(r=>r.json());
    const wh  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`).then(r=>r.json());
    res.json({ ok:true, me, wh });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// --- старт сервера ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log("Server running on", PORT);
  await setWebhook();
});



