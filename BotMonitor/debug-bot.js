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

// KONFIGURASI
const STATUS_PAGES = [{ name: "CCTV Publik", slug: "bot-cctvpublic" }];

const ANTI_SPAM_CONFIG = {
  MIN_DELAY_BETWEEN_MESSAGES: 3000,
  MAX_MESSAGES_PER_HOUR: 10,
  BATCH_SEND_DELAY: 2000,
  COOLDOWN_BETWEEN_BATCHES: 5000,
};

let monitoringStarted = false;
let escalationStarted = false;
let firstRun = true;
let lastReportTime = 0;

const CHROME_PATH = "/usr/bin/chromium";
const KUMA_BASE_URL = "http://172.16.100.10";
let sock;
let isConnecting = false;
let monitoringInterval = null;
let escalationInterval = null;

// STATE VARIABLES
const monitorDownCount = {};
const lastStatuses = {};
const escalationQueue = {};
const monitorDownTime = {};
const sentOffline = {};
const messageCountPerHour = {};
const lastMessageTime = {};
const maintenanceMode = {}; // Format: { "monitor-key": endTime }

const HIERARCHY = {
  admin: "6285934964784@s.whatsapp.net",
  atasan: "6282283595329@s.whatsapp.net",
  pimpinan: "628995897629@s.whatsapp.net",
};

let isChecking = false;

// ===== FUNGSI MAINTENANCE MODE =====
function addToMaintenance(monitorKey, durationMs = 60 * 60 * 1000) {
  const endTime = Date.now() + durationMs;
  maintenanceMode[monitorKey] = endTime;
  
  console.log(`🔧 ${monitorKey} masuk MODE MAINTENANCE sampai ${new Date(endTime).toLocaleString('id-ID')}`);
  
  return endTime;
}

function isInMaintenance(monitorKey) {
  if (!maintenanceMode[monitorKey]) return false;
  
  const now = Date.now();
  if (now >= maintenanceMode[monitorKey]) {
    // Maintenance selesai
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
// ===== END FUNGSI MAINTENANCE MODE =====

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
        await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
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

        // Kumpulkan monitor yang kembali online
        const onlineMonitors = [];

        for (const monitor of monitors) {
          const key = `${pageInfo.name} - ${monitor.name}`;
          const currentStatus = monitor.isOffline ? "offline" : "online";
          
          // ===== CEK MAINTENANCE MODE =====
          if (isInMaintenance(key)) {
            const timeLeft = getMaintenanceTimeLeft(key);
            const minutesLeft = Math.ceil(timeLeft / 60000);
            
            console.log(`🔧 SKIP ${key} - Sedang maintenance (${minutesLeft} menit lagi)`);
            continue; // Skip monitor ini, tidak dipantau
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

              if (!escalationQueue[key]) {
                escalationQueue[key] = { level: "admin", lastSent: Date.now() };
              } else {
                escalationQueue[key].lastSent = Date.now();
              }
            }
          } else {
            // Monitor online - cek apakah sebelumnya offline
            if (sentOffline[key]) {
              onlineMonitors.push(key);
              
              // Bersihkan state
              delete sentOffline[key];
              delete escalationQueue[key];
              delete monitorDownCount[key];
              delete monitorDownTime[key];
            }
          }
        }

        // Kirim notifikasi gabungan untuk monitor yang kembali online
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
            message += `🔴 ${monitor}\n`;
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
        const now = new Date().toLocaleString("id-ID");

        const title = `LAPORAN MONITORING SYSTEM\n🛑 DOWN SEJAK ${earliestDownTimes}\n\n*DAFTAR MONITOR DOWN:*\n`;
        const bodyMessages = offlineMessages.map((m) => `• ${m}`).join("\n");
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
      // Skip jika monitor sedang maintenance
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
  
  // Jika tidak ada monitor keys spesifik, ambil semua yang relevan dengan pengirim
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
  
  // Proses setiap monitor yang dikonfirmasi
  for (const key of confirmedMonitors) {
    console.log(`✅ ${key} dikonfirmasi - Masuk MODE MAINTENANCE 1 jam`);
    
    // Tambahkan ke maintenance mode (1 jam)
    addToMaintenance(key, 60 * 60 * 1000);
    
    // Bersihkan state monitoring
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

        if (!monitoringStarted) {
          console.log("⏳ Menunggu 10 menit sebelum monitoring pertama...");
          await new Promise((resolve) => setTimeout(resolve, 10 * 60 * 1000));

          console.log("🚀 Memulai pemantauan CCTV...");
          console.log("Cek setiap 10 menit, escalate setiap 1 jam");

          monitoringStarted = true;

          cekStatusMonitor();

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

        console.log("✅ Monitoring dan escalation aktif.");
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

      if (from === HIERARCHY.admin || from === HIERARCHY.atasan) {
        // ===== COMMAND: OK (Konfirmasi) =====
        if (textMsg.startsWith("ok")) {
          console.log(`✅ Konfirmasi diterima dari ${from}`);

          // Handle konfirmasi
          const confirmedMonitors = handleAcknowledgement(from);
          
          if (confirmedMonitors.length > 0) {
            const maintenanceEndTime = new Date(Date.now() + 60 * 60 * 1000).toLocaleString('id-ID', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
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
            // Tidak ada monitor untuk dikonfirmasi
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
        
        // ===== COMMAND: STATUS / MAINTENANCE =====
        if (textMsg === "status" || textMsg === "maintenance") {
          let statusMsg = `📊 *STATUS MAINTENANCE*\n`;
          statusMsg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
          
          const activeMaintenances = Object.entries(maintenanceMode);
          
          if (activeMaintenances.length === 0) {
            statusMsg += `✅ Tidak ada monitor dalam mode maintenance.`;
          } else {
            statusMsg += `🔧 Monitor dalam maintenance:\n\n`;
            
            activeMaintenances.forEach(([key, endTime], idx) => {
              const timeLeft = endTime - Date.now();
              const minutesLeft = Math.ceil(timeLeft / 60000);
              const endTimeStr = new Date(endTime).toLocaleString('id-ID', {
                hour: '2-digit',
                minute: '2-digit'
              });
              
              statusMsg += `${idx + 1}. *${key}*\n`;
              statusMsg += `   ⏰ Selesai: ${endTimeStr} (${minutesLeft} menit lagi)\n\n`;
            });
          }
          
          if (await canSendMessage(from)) {
            await new Promise((r) =>
              setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY)
            );
            await sock.sendMessage(from, { text: statusMsg });
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

console.log("╔═══════════════════════════════════════════════╗");
console.log("║     BOT MONITORING CCTV - PRODUCTION          ║");
console.log("║  Cek: 10 menit | Eskalasi: 1 jam              ║");
console.log("║  Fitur: Maintenance Mode (1 jam)              ║");
console.log("╚═══════════════════════════════════════════════╝\n");

connectToWhatsApp();
