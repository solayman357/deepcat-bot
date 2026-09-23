const https = require("https");
const fs = require("fs");

// ============ CONFIG ============
const TG_BOT_TOKEN = "8327609038:AAGb7hWpN2P99uMt2mIXdJcfZEPf81vRbqg";
const DEEPCAT_API = "https://api.aicat-anthropic.com";
const DATA_FILE = __dirname + "/data.json";
const CHECK_INTERVAL = 5 * 60 * 1000;
const ADMIN_ID = 7176002628;

// ============ DATA ============
let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
function saveDb() { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }

// ============ HTTP HELPERS ============
function httpsReq(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

async function deepcatApi(token, method, path, body) {
  const url = new URL(DEEPCAT_API + path);
  const opts = {
    hostname: url.hostname,
    path: url.pathname,
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (token) opts.headers.token = token;
  return httpsReq(url, opts, body ? JSON.stringify(body) : null);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ BD TIME ============
function bdNow() {
  return new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" });
}
function bdHour() {
  return parseInt(new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka", hour: "numeric", hour12: false }));
}
function bdToday() {
  return new Date().toLocaleString("en-CA", { timeZone: "Asia/Dhaka" });
}

// ============ TELEGRAM ============
async function tgSend(chatId, text, extra) {
  const body = { chat_id: chatId, text, parse_mode: "HTML" };
  if (extra) Object.assign(body, extra);
  const url = new URL(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`);
  return httpsReq(url, {
    hostname: url.hostname,
    path: url.pathname,
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }, JSON.stringify(body));
}

async function tgReply(msg, text) {
  return tgSend(msg.chat.id, text);
}

// ============ DEEPCAT AUTH ============
async function login(user) {
  const r = await deepcatApi(null, "POST", "/api/user/login", {
    account: user.phone,
    password: user.password,
  });
  if (r.code === 1 && r.data?.userinfo?.token) {
    user.token = r.data.userinfo.token;
    user.tokenExpiry = Date.now() + (r.data.userinfo.expires_in - 120) * 1000;
    user.userNo = r.data.userinfo.user_no;
    saveDb();
    return true;
  }
  return false;
}

async function ensureLogin(user) {
  if (user.token && Date.now() < (user.tokenExpiry || 0)) return true;
  return login(user);
}

// ============ DEEPCAT API CALLS ============
async function getBalance(user) {
  const r = await deepcatApi(user.token, "GET", "/api/user/index");
  return r.code === 1 ? parseFloat(r.data.money) : -1;
}

async function doCheckIn(user) {
  const r = await deepcatApi(user.token, "GET", "/api/Checkin/checkin");
  return r;
}

async function getCheckInInfo(user) {
  const r = await deepcatApi(user.token, "GET", "/api/checkin/info");
  return r;
}

async function getActiveOrders(user) {
  const r = await deepcatApi(user.token, "POST", "/api/order/getQuantOrder", { page: 1, limit: 10, status: 0 });
  return r.code === 1 ? (r.data?.data || []) : [];
}

async function createOrder(user, amount) {
  const r = await deepcatApi(user.token, "POST", "/api/order/set_Order", {
    money: amount.toFixed(4),
    order_duration: 24,
  });
  return r;
}

// ============ AUTO WORKER ============
async function autoWork(user, chatId) {
  if (!(await ensureLogin(user))) {
    await tgSend(chatId, "❌ Login failed! /login se use kore abar login koren.");
    return;
  }

  const today = bdToday();
  const hour = bdHour();

  try {
    const activeOrders = await getActiveOrders(user);

    if (activeOrders.length === 0) {
      // No active order — invest
      const balance = await getBalance(user);
      if (balance > 0.1) {
        await tgSend(chatId, `💰 No active order. Balance: $${balance.toFixed(4)}\n⏳ 30s por new order...`);
        await sleep(30000);
        const r = await createOrder(user, balance);
        if (r.code === 1) {
          await tgSend(chatId, `✅ New order created: $${balance.toFixed(4)} (24h)`);
          user.lastCheckIn = "";
          saveDb();
          // Check-in after order
          await sleep(30000);
          if (hour >= 12 && user.lastCheckIn !== today) {
            const cr = await doCheckIn(user);
            if (cr.code === 1) {
              await tgSend(chatId, `✅ Check-in done! +0.30 USDT`);
              user.lastCheckIn = today;
              saveDb();
            }
          }
        } else {
          await tgSend(chatId, `❌ Order failed: ${r.msg}`);
        }
      }
    } else {
      const o = activeOrders[0];
      const remaining = o.endtime - Math.floor(Date.now() / 1000);

      if (remaining <= 0) {
        // Order completed
        await tgSend(chatId, `🎉 Order #${o.id} completed! ($${o.order_amount})\n⏳ 30s por new order...`);
        await sleep(30000);
        const balance = await getBalance(user);
        if (balance > 0.1) {
          const r = await createOrder(user, balance);
          if (r.code === 1) {
            await tgSend(chatId, `✅ New order: $${balance.toFixed(4)} (24h)`);
            user.lastCheckIn = "";
            saveDb();
            await sleep(30000);
            if (hour >= 12 && user.lastCheckIn !== today) {
              const cr = await doCheckIn(user);
              if (cr.code === 1) {
                await tgSend(chatId, `✅ Check-in done! +0.30 USDT`);
                user.lastCheckIn = today;
                saveDb();
              }
            }
          }
        }
      } else {
        // Report status
        const mins = Math.floor(remaining / 60);
        console.log(`[${bdNow()}] ${user.phone}: Order $${o.order_amount} | ${o.progress}% | ${mins}m left`);
      }

      // Daily check-in (after 12 PM only)
      if (hour >= 12 && user.lastCheckIn !== today) {
        const cr = await doCheckIn(user);
        if (cr.code === 1) {
          await tgSend(chatId, `✅ Check-in done! +0.30 USDT`);
          user.lastCheckIn = today;
          saveDb();
        }
      }
    }
  } catch (e) {
    console.error(`[${bdNow()}] Auto error for ${user.phone}:`, e.message);
  }
}

// ============ TELEGRAM HANDLERS ============
const pendingLogin = {};

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = (msg.text || "").trim();

  if (!text) return;

  // /start
  if (text === "/start") {
    await tgReply(msg,
      `🤖 <b>DeepCat Auto Bot</b>\n\n` +
      `Commands:\n` +
      `/login &lt;phone&gt; &lt;password&gt; — Login\n` +
      `/status — Balance + order info\n` +
      `/checkin — Manual check-in\n` +
      `/orders — List active orders\n` +
      `/auto on|off — Auto invest toggle\n` +
      `/help — Show this\n\n` +
      `Auto: Order complete → new order + check-in (12PM+ BD)`
    );
    return;
  }

  // /help
  if (text === "/help") {
    await tgReply(msg,
      `📋 <b>How it works:</b>\n\n` +
      `1. /login phone password\n` +
      `2. Bot auto checks every 5 min\n` +
      `3. Order complete → 30s → new order (full balance)\n` +
      `4. Check-in: only after 12:00 PM BD\n` +
      `5. Notifications sent here`
    );
    return;
  }

  // /login
  if (text.startsWith("/login")) {
    const parts = text.split(/\s+/);
    if (parts.length < 3) {
      await tgReply(msg, `Usage: /login &lt;phone&gt; &lt;password&gt;\nExample: /login 01902214912 solayman`);
      return;
    }
    const phone = parts[1];
    const password = parts[2];

    await tgReply(msg, `⏳ Logging in as ${phone}...`);

    const tempUser = { phone, password };
    const ok = await login(tempUser);

    if (ok) {
      // Save user
      if (!db.users) db.users = {};
      db.users[userId] = {
        phone,
        password,
        token: tempUser.token,
        tokenExpiry: tempUser.tokenExpiry,
        userNo: tempUser.userNo,
        chatId,
        autoEnabled: true,
        lastCheckIn: "",
      };
      saveDb();

      const balance = await getBalance(db.users[userId]);
      await tgReply(msg,
        `✅ Login successful!\n\n` +
        `📱 Account: ${phone}\n` +
        `💰 Balance: $${balance.toFixed(4)}\n` +
        `🤖 Auto: ON`
      );
    } else {
      await tgReply(msg, `❌ Login failed! Phone/password check koren.`);
    }
    return;
  }

  // Check if user is logged in
  const user = db.users?.[userId];
  if (!user) {
    await tgReply(msg, `⚠️ Pothome /login koren.`);
    return;
  }

  // Re-login if needed
  await ensureLogin(user);

  // /status
  if (text === "/status") {
    const balance = await getBalance(user);
    const orders = await getActiveOrders(user);
    const checkInfo = await getCheckInInfo(user);

    let orderText = "";
    if (orders.length === 0) {
      orderText = `No active orders`;
    } else {
      for (const o of orders) {
        const remaining = o.endtime - Math.floor(Date.now() / 1000);
        const hrs = Math.floor(remaining / 3600);
        const mins = Math.floor((remaining % 3600) / 60);
        orderText += `#${o.id}: $${o.order_amount} | ${o.progress}% | ${remaining > 0 ? `${hrs}h ${mins}m left` : 'DONE'}\n`;
      }
    }

    const checkedToday = checkInfo.data?.status === "false";
    const autoStatus = user.autoEnabled ? "ON" : "OFF";

    await tgReply(msg,
      `📊 <b>Status</b>\n\n` +
      `📱 Account: ${user.phone}\n` +
      `💰 Balance: $${balance.toFixed(4)}\n` +
      `📋 Orders:\n${orderText}\n` +
      `✅ Check-in today: ${checkedToday ? 'Done' : 'Pending'}\n` +
      `🤖 Auto: ${autoStatus}`
    );
    return;
  }

  // /checkin
  if (text === "/checkin") {
    const hour = bdHour();
    if (hour < 12) {
      await tgReply(msg, `⏰ Check-in only after 12:00 PM BD time. Ekhon ${hour}:xx.`);
      return;
    }
    const r = await doCheckIn(user);
    if (r.code === 1) {
      await tgReply(msg, `✅ Check-in done! +0.30 USDT`);
      user.lastCheckIn = bdToday();
      saveDb();
    } else {
      await tgReply(msg, `ℹ️ ${r.msg}`);
    }
    return;
  }

  // /orders
  if (text === "/orders") {
    const orders = await getActiveOrders(user);
    if (orders.length === 0) {
      await tgReply(msg, `📋 No active orders.`);
      return;
    }
    let txt = `📋 <b>Active Orders:</b>\n\n`;
    for (const o of orders) {
      const remaining = o.endtime - Math.floor(Date.now() / 1000);
      const hrs = Math.floor(remaining / 3600);
      const mins = Math.floor((remaining % 3600) / 60);
      txt += `#${o.id}: $${o.order_amount}\n`;
      txt += `  Progress: ${o.progress}%\n`;
      txt += `  ${remaining > 0 ? `${hrs}h ${mins}m left` : '✅ DONE'}\n\n`;
    }
    await tgReply(msg, txt);
    return;
  }

  // /auto on|off
  if (text.startsWith("/auto")) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await tgReply(msg, `Usage: /auto on OR /auto off`);
      return;
    }
    const setting = parts[1].toLowerCase();
    if (setting === "on") {
      user.autoEnabled = true;
      saveDb();
      await tgReply(msg, `🤖 Auto invest: ON`);
    } else if (setting === "off") {
      user.autoEnabled = false;
      saveDb();
      await tgReply(msg, `🤖 Auto invest: OFF`);
    } else {
      await tgReply(msg, `Usage: /auto on OR /auto off`);
    }
    return;
  }
}

// ============ POLLING ============
let lastUpdateId = 0;

async function pollUpdates() {
  try {
    const url = new URL(`https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`);
    const data = await httpsReq(url, {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "GET",
    });

    if (data.ok && data.result) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        if (update.message) {
          handleMessage(update.message).catch(e => console.error("Handle error:", e.message));
        }
      }
    }
  } catch (e) {
    console.error("Poll error:", e.message);
  }
}

// ============ AUTO WORKER LOOP ============
async function autoLoop() {
  while (true) {
    try {
      const users = db.users || {};
      for (const [userId, user] of Object.entries(users)) {
        if (!user.autoEnabled) continue;
        if (!user.phone || !user.password) continue;
        try {
          await ensureLogin(user);
          await autoWork(user, user.chatId);
        } catch (e) {
          console.error(`Auto error ${user.phone}:`, e.message);
        }
      }
    } catch (e) {
      console.error("AutoLoop error:", e.message);
    }
    await sleep(CHECK_INTERVAL);
  }
}

// ============ MAIN ============
async function main() {
  console.log("=== DeepCat Telegram Bot Started ===");
  console.log(`BD Time: ${bdNow()}`);
  console.log(`Check interval: ${CHECK_INTERVAL / 1000}s`);

  // Start polling
  setInterval(pollUpdates, 1000);

  // Start auto worker
  autoLoop();
}

main();
