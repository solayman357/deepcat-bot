const https = require("https");
const fs = require("fs");

const API = "https://api.aicat-anthropic.com";
const ACCOUNT = "01902214912";
const PASSWORD = "solayman";
const CHECK_INTERVAL = 5 * 60 * 1000;
const DATA_FILE = __dirname + "/data.json";

let token = null;
let tokenExpiry = 0;

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(API + path);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (token) options.headers.token = token;
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ code: 0, msg: "parse error" }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function bdNow() {
  return new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" });
}

function bdHour() {
  return parseInt(new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka", hour: "numeric", hour12: false }));
}

function bdToday() {
  return new Date().toLocaleString("en-CA", { timeZone: "Asia/Dhaka" });
}

async function login() {
  if (token && Date.now() < tokenExpiry) return true;
  const r = await api("POST", "/api/user/login", { account: ACCOUNT, password: PASSWORD });
  if (r.code === 1 && r.data?.userinfo?.token) {
    token = r.data.userinfo.token;
    tokenExpiry = Date.now() + (r.data.userinfo.expires_in - 60) * 1000;
    console.log(`[${bdNow()}] Login OK`);
    return true;
  }
  console.error("Login failed:", r.msg);
  return false;
}

async function getBalance() {
  const r = await api("GET", "/api/user/index");
  return r.code === 1 ? parseFloat(r.data.money) : 0;
}

async function checkIn() {
  const r = await api("GET", "/api/Checkin/checkin");
  if (r.code === 1) {
    console.log(`[${bdNow()}] Check-in done! +0.30 USDT`);
    return true;
  }
  console.log(`[${bdNow()}] Check-in: ${r.msg}`);
  return false;
}

async function getActiveOrders() {
  const r = await api("POST", "/api/order/getQuantOrder", { page: 1, limit: 10, status: 0 });
  return r.code === 1 ? (r.data?.data || []) : [];
}

async function createOrder(amount) {
  const r = await api("POST", "/api/order/set_Order", {
    money: amount.toFixed(4),
    order_duration: 24,
  });
  if (r.code === 1) {
    console.log(`[${bdNow()}] New order: $${amount.toFixed(4)} (24h)`);
    return true;
  }
  console.error(`[${bdNow()}] Order failed: ${r.msg}`);
  return false;
}

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return { lastCheckIn: "" }; }
}

function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

async function main() {
  console.log("=== DeepCat Bot Started ===");

  if (!(await login())) {
    console.error("Cannot login, retrying in 1 min...");
    await sleep(60000);
    return main();
  }

  while (true) {
    try {
      await login();
      const data = loadData();
      const today = bdToday();
      const hour = bdHour();

      const activeOrders = await getActiveOrders();

      if (activeOrders.length === 0) {
        const balance = await getBalance();
        if (balance > 0.1) {
          console.log(`[${bdNow()}] No active orders. Balance: $${balance.toFixed(4)}`);
          await sleep(30000);
          const ok = await createOrder(balance);
          if (ok) {
            data.lastCheckIn = "";
            saveData(data);
            await sleep(30000);
            if (hour >= 12 && data.lastCheckIn !== today) {
              if (await checkIn()) {
                data.lastCheckIn = today;
                saveData(data);
              }
            }
          }
        } else {
          console.log(`[${bdNow()}] No orders, balance low: $${balance.toFixed(4)}`);
        }
      } else {
        const o = activeOrders[0];
        const remaining = o.endtime - Math.floor(Date.now() / 1000);

        if (remaining <= 0) {
          console.log(`[${bdNow()}] Order #${o.id} done! Waiting 30s...`);
          await sleep(30000);
          const balance = await getBalance();
          if (balance > 0.1) {
            if (await createOrder(balance)) {
              data.lastCheckIn = "";
              saveData(data);
              await sleep(30000);
              if (hour >= 12 && data.lastCheckIn !== today) {
                if (await checkIn()) {
                  data.lastCheckIn = today;
                  saveData(data);
                }
              }
            }
          }
        } else {
          console.log(`[${bdNow()}] Order #${o.id}: $${o.order_amount} | ${o.progress}% | ${Math.floor(remaining/60)}m left`);
        }

        if (hour >= 12 && data.lastCheckIn !== today) {
          if (await checkIn()) {
            data.lastCheckIn = today;
            saveData(data);
          }
        }
      }
    } catch (e) {
      console.error(`[${bdNow()}] Error:`, e.message);
    }

    await sleep(CHECK_INTERVAL);
  }
}

main();
