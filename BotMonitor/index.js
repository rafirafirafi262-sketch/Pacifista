const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const puppeteer = require("puppeteer-core");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const pino = require("pino");

const HIERARCHY_FILE = path.join(__dirname, "hierarchy.json");
const SESSION_START_FILE = path.join(__dirname, "monitor-sessions.json"); // TAMBAH INI

// TAMBAH fungsi ini
function loadMonitorSessions() {
  if (fs.existsSync(SESSION_START_FILE)) {
    const data = fs.readFileSync(SESSION_START_FILE, "utf-8");
    return JSON.parse(data);
  }
  return {};
}

// TAMBAH fungsi ini
function saveMonitorSessions() {
  fs.writeFileSync(SESSION_START_FILE, JSON.stringify(monitorSessionStart, null, 2));
}
function loadHierarchy() {
  if (fs.existsSync(HIERARCHY_FILE)) {
    const data = fs.readFileSync(HIERARCHY_FILE, "utf-8");
    return JSON.parse(data);
  }
  return {
    admin: "6285934964784@s.whatsapp.net",
    atasan: "6282283595329@s.whatsapp.net",
    pimpinan: "628995897629@s.whatsapp.net",
  };
}

function saveHierarchy(data) {
  fs.writeFileSync(HIERARCHY_FILE, JSON.stringify(data, null, 2));
}

// KONFIGURASI
const STATUS_PAGES = [
   { 
    name: "CCTV Publik",     
    slug: "bot-cctvpublic" 
  },
  { 
    name: "Hotel",         
    slug: "bot-hotel" 
  },
];

const ANTI_SPAM_CONFIG = {
  MIN_DELAY_BETWEEN_MESSAGES: 3000,
  MAX_MESSAGES_PER_HOUR: 10,
  BATCH_SEND_DELAY: 2000,
  COOLDOWN_BETWEEN_BATCHES: 5000,
};

let monitoringStarted = false;
let escalationStarted = false;
// let firstRun = true;
let lastReportTime = 0;

const CHROME_PATH = "/usr/bin/chromium";
const KUMA_BASE_URL = "http://172.16.100.10";
let sock;
let isConnecting = false;
let monitoringInterval = null;
let escalationInterval = null;
let weeklyReportInterval = null;
const monitorSessionStart = loadMonitorSessions();
// STATE VARIABLES
const monitorDownCount = {};
const lastStatuses = {};
const escalationQueue = {};
const monitorDownTime = {};
const sentOffline = {};
const messageCountPerHour = {};
const lastMessageTime = {};
const maintenanceMode = {};

// ===== HISTORY TRACKING =====
const monitorHistory = {}; // Format: { "monitor-key": [{ timestamp, status, duration }] }
const categoryStats = {};


function saveHierarchy(data) {
  fs.writeFileSync(HIERARCHY_FILE, JSON.stringify(data, null, 2));
}

let HIERARCHY = loadHierarchy();

let isChecking = false;

function formatPhoneNumber(number) {
  number = number.replace(/[^0-9]/g, "");
  if (!number.startsWith("62")) {
    number = "62" + number;
  }
  return number + "@s.whatsapp.net";
}

// ===== FUNGSI HISTORY =====
function initializeMonitorHistory(monitorKey) {
  if (!monitorHistory[monitorKey]) {
    monitorHistory[monitorKey] = [];
  }
}

function recordMonitorEvent(monitorKey, status, duration = null) {
  initializeMonitorHistory(monitorKey);

  const event = {
    timestamp: Date.now(),
    status: status,
    duration: duration,
  };

  monitorHistory[monitorKey].push(event);

  // Simpan hanya 7 hari terakhir
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  monitorHistory[monitorKey] = monitorHistory[monitorKey].filter(
    (event) => event.timestamp > sevenDaysAgo
  );
}

function getTodayStats(monitorKey) {
  initializeMonitorHistory(monitorKey);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();

  const events = monitorHistory[monitorKey].filter(
    (e) => e.timestamp >= todayStart
  );

  const downEvents = events.filter((e) => e.status === "offline");

  // Hitung durasi akumulatif
  let totalDowntime = 0;
  downEvents.forEach((e) => {
    if (e.duration) totalDowntime += e.duration;
  });

  // Tambahkan downtime yang sedang berjalan
  if (sentOffline[monitorKey] && monitorDownTime[monitorKey]) {
    totalDowntime += (Date.now() - monitorDownTime[monitorKey].getTime());
  }

  const hasBeenOnline = monitorSessionStart[monitorKey] !== undefined;

  return {
    downCount: downEvents.length,
    totalDowntime: totalDowntime,
    events: events.length,
    hasBeenOnline: hasBeenOnline,
  };
}
function getWeeklyStats(monitorKey) {
  initializeMonitorHistory(monitorKey);

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const events = monitorHistory[monitorKey].filter(
    (e) => e.timestamp >= sevenDaysAgo
  );

  let downEvents = events.filter((e) => e.status === "offline");
  let totalDowntime = 0;

  downEvents.forEach((e) => {
    if (e.duration) totalDowntime += e.duration;
  });

  // Add current downtime if still offline
  if (sentOffline[monitorKey] && monitorDownTime[monitorKey]) {
    totalDowntime += (Date.now() - monitorDownTime[monitorKey].getTime());
  }

  const hasBeenOnline = monitorSessionStart[monitorKey] !== undefined;
  
  // ===== FIX UTAMA DI SINI =====
  let monitoringPeriod = 0;
  let uptime = 0;
  let uptimePercent = "N/A";

  if (hasBeenOnline) {
    const sessionStart = monitorSessionStart[monitorKey];
    const periodStart = Math.max(sessionStart, sevenDaysAgo);
    
    // Hitung periode AKTUAL sejak monitor pertama kali online
    monitoringPeriod = Date.now() - periodStart;
    
    // Uptime = periode monitoring - total downtime
    uptime = Math.max(0, monitoringPeriod - totalDowntime);
    
    // Hitung persentase uptime
    if (monitoringPeriod > 0) {
      uptimePercent = ((uptime / monitoringPeriod) * 100).toFixed(2);
    } else {
      uptimePercent = "0.00";
    }
  }
  // ===== AKHIR FIX =====

  return {
    downCount: downEvents.length,
    totalDowntime: totalDowntime,
    uptime: uptime,
    uptimePercent: uptimePercent,
    monitoringPeriod: monitoringPeriod,
    events: events.length,
    hasBeenOnline: hasBeenOnline,
  };
}
// ===== FUNGSI PARSE MONITOR KEY =====
const parseMonitorKey = (key) => {
  const parts = key.split(" - ");
  return {
    category: parts[0],
    name: parts.slice(1).join(" - ")
  };
};
// ===== FUNGSI UTILITY =====
function formatDuration(ms) {
  if (ms <= 0) return "0 detik";

  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  let result = [];
  if (days > 0) result.push(`${days}h`);
  if (hours > 0) result.push(`${hours}j`);
  if (minutes > 0) result.push(`${minutes}m`);
  if (seconds > 0 && result.length === 0) result.push(`${seconds}d`);

  return result.slice(0, 2).join(" ");
}

// ===== FUNGSI MAINTENANCE MODE =====
function addToMaintenance(monitorKey, durationMs = 60 * 60 * 1000) {
  const endTime = Date.now() + durationMs;
  maintenanceMode[monitorKey] = endTime;

  console.log(
    `🔧 ${monitorKey} masuk MODE MAINTENANCE sampai ${new Date(
      endTime
    ).toLocaleString("id-ID")}`
  );

  return endTime;
}

function isInMaintenance(monitorKey) {
  if (!maintenanceMode[monitorKey]) return false;

  const now = Date.now();
  if (now >= maintenanceMode[monitorKey]) {
    console.log(`✅ ${monitorKey} keluar dari MODE MAINTENANCE`);
    delete maintenanceMode[monitorKey];
    return false;
  }

  return true;
}

function getMaintenanceTimeLeft(monitorKey) {
  if (!maintenanceMode[monitorKey]) return 0;

  const now = Date.now();
  const timeLeft = maintenanceMode[monitorKey] - now;

  return timeLeft > 0 ? timeLeft : 0;
}
function parseMaintenanceDuration(durationStr) {
  const match = durationStr.match(/^(\d+)(h|m|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 'h': return value * 60 * 60 * 1000;
    case 'm': return value * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

// ===== FUNGSI HELP =====
async function sendHelpMessage(from) {
  let helpMsg = `*📚 PANDUAN PERINTAH BOT MONITORING*\n`;
  helpMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  helpMsg += `*PERINTAH DASAR:*\n\n`;

  helpMsg += `1. *ok*\n`;
  helpMsg += `   Konfirmasi monitor down & masuk mode maintenance 1 jam\n`;
  helpMsg += `   Contoh: \`ok\`\n\n`;

  helpMsg += `2. *status*\n`;
  helpMsg += `   Lihat monitor yang sedang dalam mode maintenance\n`;
  helpMsg += `   Contoh: \`status\`\n\n`;

  helpMsg += `3. *stats*\n`;
  helpMsg += `   Lihat statistik uptime & downtime hari ini\n`;
  helpMsg += `   Contoh: \`stats\`\n\n`;

  helpMsg += `4. *weekly*\n`;
  helpMsg += `   Lihat statistik uptime & downtime 7 hari terakhir\n`;
  helpMsg += `   Contoh: \`weekly\`\n\n`;

  helpMsg += `5. *check*\n`;
  helpMsg += `   Cek status monitor sekarang \n`;
  helpMsg += `   Contoh: \`check\`\n\n`;
  
  helpMsg += `6. *maintenance <durasi>*\n`;  // ← TAMBAH BARU
  helpMsg += `   Set durasi maintenance custom (contoh: 2h, 30m, 1d)\n`;
  helpMsg += `   Contoh: \`maintenance 2h\`\n\n`;

  helpMsg += `\n*PERINTAH ADMIN:*\n\n`;
  helpMsg += `6. *set admin/atasan/pimpinan <nomor>*\n`;
  helpMsg += `   Ubah nomor admin (hanya admin saat ini)\n`;
  helpMsg += `   Contoh: \`set admin 628xxxxxxxxxx\`\n\n`;

  helpMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  helpMsg += `_Perintah case-insensitive (ok, OK, Ok semua berlaku)_`;

  if (await canSendMessage(from)) {
    await new Promise((r) => setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY));
    await sock.sendMessage(from, { text: helpMsg });
    await recordMessageSent(from);
  }
}

async function sendStatsMessage(from, isWeekly = false) {
  let statsMsg = `*📊 STATISTIK MONITORING ${
    isWeekly ? "(7 HARI)" : "(HARI INI)"
  }*\n`;
  statsMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Group stats by category
  const categoryGroups = {};
  
  for (const key of Object.keys(lastStatuses)) {
    const { category, name } = parseMonitorKey(key);
    if (!categoryGroups[category]) {
      categoryGroups[category] = [];
    }
    
    const stats = isWeekly ? getWeeklyStats(key) : getTodayStats(key);
    categoryGroups[category].push({
      name: name,
      fullKey: key,
      ...stats,
    });
  }

  if (Object.keys(categoryGroups).length === 0) {
    statsMsg += `✅ Belum ada data monitoring.\n`;
  } else {
    let totalDowntime = 0;
    let totalDownCount = 0;

    // Display per category
    for (const [category, monitors] of Object.entries(categoryGroups)) {
      statsMsg += `*━━━ ${category} ━━━*\n\n`;
      
      monitors.forEach((stat, idx) => {
        totalDowntime += stat.totalDowntime;
        totalDownCount += stat.downCount;

        statsMsg += `*${idx + 1}. ${stat.name}*\n`;
        statsMsg += `   Status: ${
          lastStatuses[stat.fullKey] === "online" ? "🟢 Online" : "🔴 Offline"
        }\n`;
        statsMsg += `   Down ${isWeekly ? "minggu ini" : "hari ini"}: ${
          stat.downCount
        }x\n`;
        statsMsg += `   Total downtime: ${formatDuration(stat.totalDowntime)}\n`;

       if (isWeekly) {
  const allMonitors = Object.values(categoryGroups).flat();
  const onlineMonitors = allMonitors.filter(m => m.hasBeenOnline);
  
  if (onlineMonitors.length > 0) {
    const totalUptimePercent = onlineMonitors.reduce((sum, s) => {
      const uptimeNum = parseFloat(s.uptimePercent);
      return sum + (isNaN(uptimeNum) ? 0 : uptimeNum);
    }, 0);
    const avgUptime = (totalUptimePercent / onlineMonitors.length).toFixed(2);
    statsMsg += `Rata-rata uptime: ${avgUptime}%\n`;
  }
}


        statsMsg += `\n`;
      });
    }

    statsMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    statsMsg += `*TOTAL ${isWeekly ? "MINGGU" : "HARI"}:*\n`;
    statsMsg += `Total down: ${totalDownCount}x\n`;
    statsMsg += `Total downtime: ${formatDuration(totalDowntime)}\n`;

    if (isWeekly) {
      const allMonitors = Object.values(categoryGroups).flat();
      const onlineMonitors = allMonitors.filter(m => m.hasBeenOnline);
      
      if (onlineMonitors.length > 0) {
        const totalUptime = onlineMonitors.reduce((sum, s) => sum + s.uptime, 0) / onlineMonitors.length;
        const avgUptime = ((totalUptime / (7 * 24 * 60 * 60 * 1000)) * 100).toFixed(2);
        statsMsg += `Rata-rata uptime: ${avgUptime}%\n`;
      }
    }
  }

  if (await canSendMessage(from)) {
    await new Promise((r) => setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY));
    await sock.sendMessage(from, { text: statsMsg });
    await recordMessageSent(from);
  }
}
async function forceCheckMonitors(from) {
  let msg = `⏳ Sedang melakukan pengecekan status monitor...\n\n`;

  if (await canSendMessage(from)) {
    await new Promise((r) => setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY));
    await sock.sendMessage(from, { text: msg });
    await recordMessageSent(from);
  }

  // Jalankan pengecekan
  await cekStatusMonitor();

  // Group by category
  const categoryGroups = {};
  
  for (const [key, status] of Object.entries(lastStatuses)) {
    const { category, name } = parseMonitorKey(key);
    if (!categoryGroups[category]) {
      categoryGroups[category] = {
        online: [],
        offline: []
      };
    }
    
    if (status === "online") {
      categoryGroups[category].online.push(name);
    } else {
      categoryGroups[category].offline.push(name);
    }
  }

  // Build result message
  let resultMsg = `✅ *Pengecekan selesai!*\n\n`;

  for (const [category, monitors] of Object.entries(categoryGroups)) {
    const totalOnline = monitors.online.length;
    const totalOffline = monitors.offline.length;
    const total = totalOnline + totalOffline;

    resultMsg += `*${category}:*\n`;
    resultMsg += `🟢 Online: ${totalOnline}/${total}\n`;
    resultMsg += `🔴 Offline: ${totalOffline}/${total}\n`;

    if (totalOffline > 0) {
      resultMsg += `\n_Monitor offline:_\n`;
      monitors.offline.forEach((monitor) => {
        resultMsg += `  • ${monitor}\n`;
      });
    }
    resultMsg += `\n`;
  }

  if (await canSendMessage(from)) {
    await new Promise((r) => setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY));
    await sock.sendMessage(from, { text: resultMsg });
    await recordMessageSent(from);
  }
}
async function sendWeeklyReport() {
  console.log("📅 Mengirim laporan mingguan...");

  let reportMsg = `*📋 LAPORAN MINGGUAN MONITORING CCTV*\n`;
  reportMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 7);

  reportMsg += `📅 Periode: ${weekStart.toLocaleDateString(
    "id-ID"
  )} - ${now.toLocaleDateString("id-ID")}\n\n`;

  // Group by category
  const categoryGroups = {};
  let totalDowntime = 0;
  let totalDownCount = 0;

  for (const key of Object.keys(lastStatuses)) {
    const { category, name } = parseMonitorKey(key);
    if (!categoryGroups[category]) {
      categoryGroups[category] = [];
    }
    
    const stats = getWeeklyStats(key);
    categoryGroups[category].push({
      name: name,
      fullKey: key,
      ...stats,
    });

    totalDowntime += stats.totalDowntime;
    totalDownCount += stats.downCount;
  }

  if (Object.keys(categoryGroups).length === 0) {
    reportMsg += `✅ Tidak ada data monitoring minggu ini.\n`;
  } else {
    reportMsg += `*DETAIL PER KATEGORI:*\n`;
    reportMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const [category, monitors] of Object.entries(categoryGroups)) {
      reportMsg += `*【 ${category} 】*\n\n`;
      
      monitors.forEach((stat, idx) => {
        reportMsg += `${idx + 1}. *${stat.name}*\n`;
        reportMsg += `   Status: ${
          lastStatuses[stat.fullKey] === "online" ? "🟢 Online" : "🔴 Offline"
        }\n`;
        reportMsg += `   Down: ${stat.downCount}x\n`;
        reportMsg += `   Downtime: ${formatDuration(stat.totalDowntime)}\n`;
        
        if (stat.hasBeenOnline) {
          reportMsg += `   Uptime: ${stat.uptimePercent}%\n`;
        } else {
          reportMsg += `   Uptime: N/A (belum pernah online)\n`;
        }
        reportMsg += `\n`;
      });
    }

    reportMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    reportMsg += `*RINGKASAN MINGGUAN:*\n`;
    
    const totalMonitors = Object.values(categoryGroups).flat().length;
    reportMsg += `Total Monitor: ${totalMonitors}\n`;
    reportMsg += `Total Down: ${totalDownCount}x\n`;
    reportMsg += `Total Downtime: ${formatDuration(totalDowntime)}\n`;

    const allMonitors = Object.values(categoryGroups).flat();
    const onlineMonitors = allMonitors.filter(m => m.hasBeenOnline);
    
    if (onlineMonitors.length > 0) {
      const totalUptime = onlineMonitors.reduce((sum, s) => sum + s.uptime, 0) / onlineMonitors.length;
      const avgUptime = ((totalUptime / (7 * 24 * 60 * 60 * 1000)) * 100).toFixed(2);
      reportMsg += `Rata-rata Uptime: ${avgUptime}%\n`;
    }
  }

  reportMsg += `\n_Laporan ini dikirim setiap hari Senin pukul 08:00_`;

  // Kirim ke admin
  if (await canSendMessage(HIERARCHY.admin)) {
    await new Promise((r) => setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY));
    await sock.sendMessage(HIERARCHY.admin, { text: reportMsg });
    await recordMessageSent(HIERARCHY.admin);
    console.log("✅ Laporan mingguan terkirim");
  } else {
    console.log("⛔ SKIP laporan mingguan - rate limit");
  }
}

// ===== SCHEDULE WEEKLY REPORT (Senin pukul 08:00) =====
function scheduleWeeklyReport() {
  const checkReport = () => {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Minggu, 1 = Senin, dst
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Senin (1) pukul 08:00
    if (dayOfWeek === 1 && hour === 8 && minute === 0) {
      if (Date.now() - lastReportTime > 60 * 60 * 1000) {
        // Cegah double send
        sendWeeklyReport();
        lastReportTime = Date.now();
      }
    }
  };

  if (weeklyReportInterval) {
    clearInterval(weeklyReportInterval);
  }

  weeklyReportInterval = setInterval(checkReport, 60 * 1000); // Check setiap 1 menit
  console.log("✅ Weekly report scheduler aktif (Senin 08:00)");
}

// ===== ANTI SPAM =====
async function canSendMessage(contact) {
  const now = Date.now();

  if (lastMessageTime[contact]) {
    const timeSinceLastMsg = now - lastMessageTime[contact];
    if (timeSinceLastMsg < ANTI_SPAM_CONFIG.MIN_DELAY_BETWEEN_MESSAGES) {
      const waitTime =
        ANTI_SPAM_CONFIG.MIN_DELAY_BETWEEN_MESSAGES - timeSinceLastMsg;
      await new Promise((r) => setTimeout(r, waitTime));
    }
  }

  if (!messageCountPerHour[contact]) {
    messageCountPerHour[contact] = { count: 0, resetTime: now + 3600000 };
  }

  const hourData = messageCountPerHour[contact];

  if (now >= hourData.resetTime) {
    hourData.count = 0;
    hourData.resetTime = now + 3600000;
  }

  if (hourData.count >= ANTI_SPAM_CONFIG.MAX_MESSAGES_PER_HOUR) {
    console.log(
      `⛔ Sudah mencapai limit ${ANTI_SPAM_CONFIG.MAX_MESSAGES_PER_HOUR} pesan/jam`
    );
    return false;
  }

  return true;
}

async function recordMessageSent(contact) {
  lastMessageTime[contact] = Date.now();

  if (!messageCountPerHour[contact]) {
    messageCountPerHour[contact] = {
      count: 0,
      resetTime: Date.now() + 3600000,
    };
  }
  messageCountPerHour[contact].count++;

  console.log(
    `📊 Pesan: ${messageCountPerHour[contact].count}/${ANTI_SPAM_CONFIG.MAX_MESSAGES_PER_HOUR}`
  );
}

// ===== CEK STATUS MONITOR =====
async function cekStatusMonitor() {
  if (isChecking) {
    console.log("⏳ Pengecekan sebelumnya belum selesai, skip...");
    return;
  }

  isChecking = true;
  console.log("🔍 Mengecek status monitor...", new Date().toLocaleTimeString());

  let browser = null;
  const messageToSend = [];

  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
      ],
    });

    for (const pageInfo of STATUS_PAGES) {
      const url = `${KUMA_BASE_URL}/status/${pageInfo.slug}`;
      let page = null;

      try {
        page = await browser.newPage();
        await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
        await page.waitForSelector(".item-name", { timeout: 10000 });
        await page.waitForSelector(".badge.bg-primary, .badge.bg-danger", {
          timeout: 10000,
        });
        const html = await page.content();
        await page.close();
        page = null;

        const $ = cheerio.load(html);
        const monitors = [];

        $(".monitor-list .item").each((_, el) => {
          const name = $(el).find(".item-name").text().trim();
          const isOffline = $(el).find(".badge.bg-danger").length > 0;
          if (name) {
            monitors.push({ name, isOffline });
          }
        });

        const onlineMonitors = [];

        for (const monitor of monitors) {
          const key = `${pageInfo.name} - ${monitor.name}`;
          const currentStatus = monitor.isOffline ? "offline" : "online";

          if (isInMaintenance(key)) {
            const timeLeft = getMaintenanceTimeLeft(key);
            const minutesLeft = Math.ceil(timeLeft / 60000);
            console.log(
              `🔧 SKIP ${key} - Sedang maintenance (${minutesLeft} menit lagi)`
            );
            continue;
          }

          lastStatuses[key] = currentStatus;

          if (!monitorDownCount[key]) {
            monitorDownCount[key] = 0;
          }

          if (currentStatus === "offline") {
            monitorDownCount[key]++;

            if (!monitorDownTime[key]) {
              monitorDownTime[key] = new Date();
            }

            if (monitorDownCount[key] === 1) {
              messageToSend.push(key);
              sentOffline[key] = true;
              recordMonitorEvent(key, "offline");

              if (!escalationQueue[key]) {
                escalationQueue[key] = { level: "admin", lastSent: Date.now() };
              } else {
                escalationQueue[key].lastSent = Date.now();
              }
            }
          } else {
            if (!monitorSessionStart[key]) {
                monitorSessionStart[key] = Date.now();
               saveMonitorSessions(); // TAMBAH INI
               //console.log(`🟢 ${key} pertama kali terdeteksi online`);
          }
            if (sentOffline[key]) {
              const downTime = monitorDownTime[key];
              const duration = Date.now() - downTime.getTime();
              recordMonitorEvent(key, "online", duration);

              onlineMonitors.push(key);

              delete sentOffline[key];
              delete escalationQueue[key];
              delete monitorDownCount[key];
              delete monitorDownTime[key];
            }
          }
        }

        if (onlineMonitors.length > 0) {
          const now = new Date().toLocaleString("id-ID", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });

          let message = `LAPORAN MONITORING SYSTEM\n🟢 ONLINE KEMBALI SEJAK ${now}\n\n`;
          message += `DAFTAR MONITOR ONLINE:\n`;

          onlineMonitors.forEach((monitor) => {
            message += `🟢 ${monitor}\n`;
          });

          console.log("📤 Kirim notifikasi ONLINE gabungan:", message);
          messageToSend.push(message);
        }
      } catch (pageErr) {
        console.warn(`⚠️ Error di halaman ${pageInfo.slug}:`, pageErr.message);
        if (page) {
          try {
            await page.close();
          } catch (e) {
            // Ignore close error
          }
        }
        continue;
      }
    }

    if (messageToSend.length > 0) {
      const offlineMessages = messageToSend.filter(
        (m) => !m.includes("ONLINE")
      );

      if (offlineMessages.length > 0) {
        const activeDownTimes = Object.values(monitorDownTime);
        const earliestDownTimes =
          activeDownTimes.length > 0
            ? new Date(Math.min(...activeDownTimes)).toLocaleString("id-ID")
            : "N/A";

        const title = `LAPORAN MONITORING SYSTEM\n🛑 DOWN SEJAK ${earliestDownTimes}\n\n*DAFTAR MONITOR DOWN:*\n`;
        const bodyMessages = offlineMessages.map((m) => `🛑 ${m}`).join("\n");
        const finalMessages = title + bodyMessages;

        console.log(
          `\n📬 Mengirim pesan gabungan (${offlineMessages.length} monitor)...`
        );

        if (await canSendMessage(HIERARCHY.admin)) {
          await new Promise((r) =>
            setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY)
          );
          await sock.sendMessage(HIERARCHY.admin, { text: finalMessages });
          await recordMessageSent(HIERARCHY.admin);
          console.log("✅ Pesan berhasil dikirim");
        } else {
          console.log("⛔ SKIP pengiriman - rate limit");
        }
      }

      for (const msg of messageToSend) {
        if (msg.includes("ONLINE")) {
          if (await canSendMessage(HIERARCHY.admin)) {
            await new Promise((r) =>
              setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY)
            );
            await sock.sendMessage(HIERARCHY.admin, { text: msg });
            await recordMessageSent(HIERARCHY.admin);
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ Gagal memantau status:", err.message);
    console.error("Stack trace:", err.stack);
  } finally {
    console.log("✅ Pemeriksaan selesai. Menutup browser..");
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.warn("⚠️ Error saat menutup browser:", e.message);
      }
    }
    isChecking = false;
  }
}

// ===== ESCALATION =====
let isEscalating = false;

async function runEscalationChecks() {
  if (isEscalating) {
    console.log("⏳ Proses eskalasi sebelumnya belum selesai, skip...");
    return;
  }

  isEscalating = true;
  console.log("🚀 Menjalankan pengecekan eskalasi...");

  try {
    const now = Date.now();
    const shouldEscalateToAtasan = [];
    const shouldEscalateToPimpinan = [];

    const ATASAN_WAIT_MS = 60 * 60 * 1000;
    const PIMPINAN_WAIT_MS = 2 * 60 * 60 * 1000;

    for (const [key, esc] of Object.entries(escalationQueue)) {
      if (isInMaintenance(key)) {
        console.log(`🔧 SKIP eskalasi ${key} - Sedang maintenance`);
        continue;
      }

      const elapsed = now - esc.lastSent;

      if (esc.level === "admin" && elapsed >= ATASAN_WAIT_MS) {
        shouldEscalateToAtasan.push(key);
      } else if (esc.level === "atasan" && elapsed >= PIMPINAN_WAIT_MS) {
        shouldEscalateToPimpinan.push(key);
      }
    }

    if (shouldEscalateToAtasan.length > 0) {
      await sendBatchEscalation("atasan", shouldEscalateToAtasan);
      await new Promise((r) =>
        setTimeout(r, ANTI_SPAM_CONFIG.COOLDOWN_BETWEEN_BATCHES)
      );
    }

    if (shouldEscalateToPimpinan.length > 0) {
      await sendBatchEscalation("pimpinan", shouldEscalateToPimpinan);
    }
  } catch (err) {
    console.error("❌ Error saat eskalasi:", err.message);
  } finally {
    isEscalating = false;
    console.log("✅ Pengecekan eskalasi selesai.\n");
  }
}

async function sendBatchEscalation(targetLevel, keysToEscalate) {
  if (keysToEscalate.length === 0) return;

  let targetHierarchy;
  let title;
  let nextLevel;
  let waitTime;

  if (targetLevel === "atasan") {
    targetHierarchy = HIERARCHY.atasan;
    nextLevel = "atasan";
    waitTime = "1 Jam";
    title = `⚠️ ESKALASI LEVEL 1: ATASAN (${keysToEscalate.length} Monitor)`;
  } else {
    targetHierarchy = HIERARCHY.pimpinan;
    nextLevel = "pimpinan";
    waitTime = "2 Jam";
    title = `🚨 ESKALASI LEVEL 2: PIMPINAN (${keysToEscalate.length} Monitor)`;
  }

  let body = [];

  for (const key of keysToEscalate) {
    const esc = escalationQueue[key];
    if (!esc) continue;

    const initialDownTime = monitorDownTime[key]
      ? new Date(monitorDownTime[key]).toLocaleString("id-ID")
      : "N/A";

    body.push(`- *${key}* (Down Sejak: ${initialDownTime})`);

    escalationQueue[key].level = nextLevel;
    escalationQueue[key].lastSent = Date.now();

    if (targetLevel === "pimpinan") {
      console.log(`🧹 Reset state untuk monitor: ${key}`);
      delete escalationQueue[key];
      monitorDownCount[key] = 0;
      delete monitorDownTime[key];
    }
  }

  const finalMessage =
    `*${title}*\n` +
    `____________________________\n` +
    `Status: ${waitTime} telah berlalu tanpa konfirmasi.\n\n` +
    `*DAFTAR MONITOR:*\n` +
    body.join("\n");

  console.log(
    `\n📤 Mengirim eskalasi ke ${targetLevel}: ${keysToEscalate.length} item.`
  );

  try {
    if (await canSendMessage(targetHierarchy)) {
      await new Promise((r) =>
        setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY)
      );
      await sock.sendMessage(targetHierarchy, { text: finalMessage });
      await recordMessageSent(targetHierarchy);
      console.log(`✅ Pesan eskalasi dikirim ke ${targetLevel}`);
    } else {
      console.log(`⛔ SKIP eskalasi - rate limit`);
    }
  } catch (error) {
    console.error(`❌ Gagal kirim eskalasi ke ${targetLevel}:`, error.message);
  }
}

function handleAcknowledgement(from, monitorKeys = null) {
  const confirmedMonitors = [];

  if (!monitorKeys) {
    for (const [key, esc] of Object.entries(escalationQueue)) {
      if (
        (esc.level === "admin" && from === HIERARCHY.admin) ||
        (esc.level === "atasan" && from === HIERARCHY.atasan)
      ) {
        confirmedMonitors.push(key);
      }
    }
  } else {
    confirmedMonitors.push(...monitorKeys);
  }

  for (const key of confirmedMonitors) {
    console.log(`✅ ${key} dikonfirmasi - Masuk MODE MAINTENANCE 1 jam`);
    addToMaintenance(key, 60 * 60 * 1000);
    delete escalationQueue[key];
    delete monitorDownCount[key];
    delete monitorDownTime[key];
    delete sentOffline[key];
  }

  return confirmedMonitors;
}

async function regenerateSession() {
  console.log("⚠️ Sesi terlogout. Regenerate session...");

  const sessionPath = path.join(__dirname, "Session_baileys");

  try {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log("🧹 Folder Session_baileys dihapus.");
    }

    console.log("⏳ Menunggu 15 detik sebelum membuat QR baru...");
    await new Promise((resolve) => setTimeout(resolve, 15000));

    console.log("🔄 Membuat sesi baru...");
    await connectToWhatsApp();
  } catch (err) {
    console.error("❌ Gagal regenerasi:", err.message);
    console.log("🕒 Retry dalam 10 detik...");
    await new Promise((resolve) => setTimeout(resolve, 10000));
    await connectToWhatsApp();
  }
}

async function connectToWhatsApp() {
  if (isConnecting) {
    console.log("⚠️ Connection sudah berjalan, skip...");
    return;
  }

  isConnecting = true;
  console.log("\n🔄 Memulai koneksi ke WhatsApp...");
  console.log(`⏰ ${new Date().toLocaleString()}\n`);

  try {
    if (sock) {
      console.log("🧹 Cleaning up old socket...");
      try {
        sock.ev.removeAllListeners();
        if (sock.ws) {
          sock.ws.close();
        }
        sock = null;
      } catch (e) {
        console.warn("⚠️ Error saat cleanup:", e.message);
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState("Session_baileys");
    const { version } = await fetchLatestBaileysVersion();

    console.log(`📂 Session loaded (Baileys v${version.join(".")})`);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      browser: ["CCTV Monitoring", "Chrome", "1.0.0"],
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      printQRInTerminal: false,
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("📱 Pindai QR code ini untuk login:");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "connecting") {
        console.log("🔄 Status: CONNECTING...");
      }

      if (connection === "close") {
        console.log("🔴 CONNECTION CLOSED");
        isConnecting = false;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMsg = lastDisconnect?.error?.message || "Unknown";

        console.log(`   Status Code: ${statusCode}`);
        console.log(`   Error: ${errorMsg}\n`);

        if (statusCode === DisconnectReason.badSession) {
          console.log("❌ BAD SESSION - Regenerating...");
          regenerateSession();
          return;
        }

        if (statusCode === DisconnectReason.connectionReplaced) {
          console.log("❌ CONNECTION REPLACED - Device lain login");
          process.exit(1);
        }

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("🚫 LOGGED OUT - Regenerating session...");
          regenerateSession();
          return;
        }

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          console.log("🔁 Reconnecting dalam 10 detik...");
          await new Promise((resolve) => setTimeout(resolve, 10000));
          connectToWhatsApp();
        }
      } else if (connection === "open") {
        console.log("✅ Berhasil terhubung ke WhatsApp!");
        isConnecting = false;

             // Inisialisasi session start untuk monitor yang sudah ada
        for (const key of Object.keys(lastStatuses)) {
          if (lastStatuses[key] === "online" && !monitorSessionStart[key]) {
            monitorSessionStart[key] = Date.now();
            console.log(`📝 Inisialisasi session untuk ${key}`);
          }
        }
        saveMonitorSessions(); // Simpan setelah inisialisasi

        if (!monitoringStarted) {
          console.log("⏳ Menunggu 10 menit sebelum monitoring pertama...");
          await new Promise((resolve) => setTimeout(resolve, 10 * 60 * 1000));

          console.log("🚀 Memulai pemantauan CCTV...");
          console.log("Cek setiap 10 menit, escalate setiap 1 jam");

          monitoringStarted = true;

          if (monitoringInterval) {
            clearInterval(monitoringInterval);
          }
          monitoringInterval = setInterval(cekStatusMonitor, 10 * 60 * 1000);
        }

        if (!escalationStarted) {
          escalationStarted = true;

          if (escalationInterval) {
            clearInterval(escalationInterval);
          }
          escalationInterval = setInterval(runEscalationChecks, 60 * 60 * 1000);
        }

        // Schedule weekly report
        scheduleWeeklyReport();

        console.log("✅ Monitoring, escalation, dan weekly report aktif.");
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      const msg = messages[0];
      if (!msg.message || !msg.key.remoteJid) return;

      const from = msg.key.remoteJid;
      const textMsg = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ""
      )
        .toLowerCase()
        .trim();

      if (
        from === HIERARCHY.admin ||
        from === HIERARCHY.atasan ||
        from === HIERARCHY.pimpinan
      ) {
        // ===== COMMAND: HELP =====
        if (textMsg === "help") {
          console.log(`❓ Help diminta dari ${from}`);
          await sendHelpMessage(from);
        }

        // ===== COMMAND: STATS =====
        if (textMsg === "stats") {
          console.log(`📊 Stats diminta dari ${from}`);
          await sendStatsMessage(from, false);
        }

        if (textMsg === "weekly") {
          console.log(`📊 Weekly stats diminta dari ${from}`);
          await sendStatsMessage(from, true);
        }

        // ===== COMMAND: FORCE-CHECK =====
        if (textMsg === "check") {
          console.log(`🔄 Force-check diminta dari ${from}`);
          await forceCheckMonitors(from);
        }

        // ===== COMMAND: OK (KONFIRMASI) =====
        if (textMsg.startsWith("ok")) {
          console.log(`✅ Konfirmasi diterima dari ${from}`);

          const confirmedMonitors = handleAcknowledgement(from);

          if (confirmedMonitors.length > 0) {
            const maintenanceEndTime = new Date(
              Date.now() + 60 * 60 * 1000
            ).toLocaleString("id-ID", {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });

            let responseMsg = `✅ *KONFIRMASI DITERIMA*\n`;
            responseMsg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
            responseMsg += `🔧 *STATUS: MODE MAINTENANCE*\n`;
            responseMsg += `⏰ Durasi: 1 Jam\n`;
            responseMsg += `📅 Sampai: ${maintenanceEndTime}\n\n`;
            responseMsg += `*Monitor yang masuk maintenance:*\n`;

            confirmedMonitors.forEach((monitor, idx) => {
              responseMsg += `${idx + 1}. ${monitor}\n`;
            });

            responseMsg += `\n_Monitor ini tidak akan dipantau selama 1 jam._`;
            responseMsg += `\n_Eskalasi otomatis dihentikan._`;

            if (await canSendMessage(from)) {
              await new Promise((r) =>
                setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY)
              );
              await sock.sendMessage(from, { text: responseMsg });
              await recordMessageSent(from);
            }
          } else {
            const noMonitorMsg = `ℹ️ Tidak ada monitor aktif yang perlu dikonfirmasi saat ini.`;

            if (await canSendMessage(from)) {
              await new Promise((r) =>
                setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY)
              );
              await sock.sendMessage(from, { text: noMonitorMsg });
              await recordMessageSent(from);
            }
          }
        }

 // ===== COMMAND: MAINTENANCE <DURATION> =====
        if (textMsg.startsWith("maintenance ")) {
          const args = textMsg.split(" ");
          if (args.length === 2) {
            const durationStr = args[1];
            const durationMs = parseMaintenanceDuration(durationStr);

            if (durationMs) {
              // Cari monitor yang paling baru down
              let latestDownMonitor = null;
              let latestDownTime = 0;

              for (const [key, downTime] of Object.entries(monitorDownTime)) {
                if (downTime.getTime() > latestDownTime) {
                  latestDownTime = downTime.getTime();
                  latestDownMonitor = key;
                }
              }

              if (latestDownMonitor) {
                const endTime = addToMaintenance(latestDownMonitor, durationMs);
                const durationStrFormatted = formatDuration(durationMs);
                const endTimeStr = new Date(endTime).toLocaleString("id-ID", {
                  day: "2-digit",
                  month: "2-digit",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                });

                let responseMsg = `✅ *MAINTENANCE DURATION DIUBAH*\n`;
                responseMsg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                responseMsg += `🔧 Monitor: ${latestDownMonitor}\n`;
                responseMsg += `⏰ Durasi Baru: ${durationStrFormatted}\n`;
                responseMsg += `📅 Sampai: ${endTimeStr}\n`;

                if (await canSendMessage(from)) {
                  await new Promise((r) =>
                    setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY)
                  );
                  await sock.sendMessage(from, { text: responseMsg });
                  await recordMessageSent(from);
                }
              } else {
                const noDownMsg = `ℹ️ Tidak ada monitor yang sedang down saat ini.`;
                if (await canSendMessage(from)) {
                  await new Promise((r) =>
                    setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY)
                  );
                  await sock.sendMessage(from, { text: noDownMsg });
                  await recordMessageSent(from);
                }
              }
            } else {
              const invalidMsg = `❌ Format tidak valid. Gunakan: maintenance 2h, maintenance 30m, atau maintenance 1d`;
              if (await canSendMessage(from)) {
                await new Promise((r) =>
                  setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY)
                );
                await sock.sendMessage(from, { text: invalidMsg });
                await recordMessageSent(from);
              }
            }
          }
        }
        // ===== COMMAND: SET ADMIN / ATASAN / PIMPINAN =====
        if (
          textMsg.startsWith("set admin") ||
          textMsg.startsWith("set atasan") ||
          textMsg.startsWith("set pimpinan")
        ) {
          if (from !== HIERARCHY.admin) {
            const notAllowedMsg = `❌ Hanya admin yang bisa mengubah nomor hierarki.`;
            if (await canSendMessage(from)) {
              await sock.sendMessage(from, { text: notAllowedMsg });
              await recordMessageSent(from);
            }
            return;
          }

          const parts = textMsg.split(" ");
          if (parts.length !== 3) {
            const usageMsg = `❌ Format salah. Gunakan:\nset admin 6285xxx\nset atasan 6281xxx\nset pimpinan 6289xxx`;
            if (await canSendMessage(from)) {
              await sock.sendMessage(from, { text: usageMsg });
              await recordMessageSent(from);
            }
            return;
          }

          const role = parts[1]; // admin, atasan, pimpinan
          const rawNumber = parts[2];
          const formattedNumber = formatPhoneNumber(rawNumber);

          if (!["admin", "atasan", "pimpinan"].includes(role)) {
            const invalidRoleMsg = `❌ Role tidak valid. Gunakan: admin, atasan, atau pimpinan.`;
            if (await canSendMessage(from)) {
              await sock.sendMessage(from, { text: invalidRoleMsg });
              await recordMessageSent(from);
            }
            return;
          }

          HIERARCHY[role] = formattedNumber;
          saveHierarchy(HIERARCHY);

          const successMsg = `✅ Nomor ${role} berhasil diubah menjadi: ${formattedNumber}`;
          if (await canSendMessage(from)) {
            await sock.sendMessage(from, { text: successMsg });
            await recordMessageSent(from);
          }
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);
  } catch (err) {
    console.error("❌ ERROR saat koneksi:", err.message);
    console.error("Stack trace:", err.stack);
    isConnecting = false;

    console.log("🔁 Retry dalam 10 detik...");
    await new Promise((resolve) => setTimeout(resolve, 10000));
    connectToWhatsApp();
  }
}

process.on("SIGINT", () => {
  console.log("\n\n🛑 Shutting down gracefully...");

  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    console.log("✅ Monitoring interval cleared");
  }

  if (escalationInterval) {
    clearInterval(escalationInterval);
    console.log("✅ Escalation interval cleared");
  }

  if (weeklyReportInterval) {
    clearInterval(weeklyReportInterval);
    console.log("✅ Weekly report interval cleared");
  }

  if (sock) {
    sock.ev.removeAllListeners();
    if (sock.ws) {
      sock.ws.close();
    }
    console.log("✅ Socket closed");
  }

  console.log("✅ Cleanup completed\n");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  console.error("❌ UNCAUGHT EXCEPTION:", err.message);
  console.error("Stack:", err.stack);
});

process.on("unhandledRejection", (err) => {
  console.error("❌ UNHANDLED REJECTION:", err);
});

console.log("╔════════════════════════════════════════════════════════╗");
console.log("║                 BOT MONITORING CCTV                    ║");
console.log("║     Cek: 10 menit | Eskalasi: 1 jam | Weekly Report    ║");
console.log("║           Fitur: Help, Stats, Force-Check              ║");
console.log("╚════════════════════════════════════════════════════════╝\n");

connectToWhatsApp();
