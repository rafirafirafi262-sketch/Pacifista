const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const puppeteer = require("puppeteer-core");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const pino = require("pino");

// --- PENGATURAN ---
const STATUS_PAGES = [
  { name: "CCTV Publik", slug: "bot-cctvpublic" },
  // { name: "JSS", slug: "bot-jss" },
];

// === ANTI-SPAM SETTINGS ===
const ANTI_SPAM_CONFIG = {
  MIN_DELAY_BETWEEN_MESSAGES: 3000,
  MAX_MESSAGES_PER_HOUR: 20,
  BATCH_SEND_DELAY: 2000,
  COOLDOWN_BETWEEN_BATCHES: 5000,
};

// Global control flags
let monitoringStarted = false;
let escalationStarted = false;
let firstRun = true;
let lastRegenerateTime = 0;

const CHROME_PATH = "/usr/bin/chromium";
const KUMA_BASE_URL = "http://172.16.100.10";
let sock;

// --- PEMANTAU STATUS OTOMATIS ---
const monitorDownCount = {};
const lastStatuses = {};
const escalationQueue = {};
const monitorDownTime = {};
const sentOffline = {};

// === MESSAGE THROTTLING ===
const messageCountPerHour = {};
const lastMessageTime = {};

const HIERARCHY = {
  admin: "6285934964784@s.whatsapp.net",
  atasan: "6282283595329@s.whatsapp.net",
  pimpinan: "628995897629@s.whatsapp.net",
};

let isChecking = false;

async function canSendMessage(contact) {
  const now = Date.now();
  
  if (lastMessageTime[contact]) {
    const timeSinceLastMsg = now - lastMessageTime[contact];
    if (timeSinceLastMsg < ANTI_SPAM_CONFIG.MIN_DELAY_BETWEEN_MESSAGES) {
      const waitTime = ANTI_SPAM_CONFIG.MIN_DELAY_BETWEEN_MESSAGES - timeSinceLastMsg;
      console.log(`⏳ Tunggu ${waitTime}ms sebelum kirim ke ${contact}`);
      await new Promise(r => setTimeout(r, waitTime));
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
    console.log(`⛔ Sudah mencapai limit ${ANTI_SPAM_CONFIG.MAX_MESSAGES_PER_HOUR} pesan/jam untuk ${contact}`);
    return false;
  }

  return true;
}

async function recordMessageSent(contact) {
  lastMessageTime[contact] = Date.now();
  
  if (!messageCountPerHour[contact]) {
    messageCountPerHour[contact] = { count: 0, resetTime: Date.now() + 3600000 };
  }
  messageCountPerHour[contact].count++;
  
  console.log(`📊 Pesan ke ${contact}: ${messageCountPerHour[contact].count}/${ANTI_SPAM_CONFIG.MAX_MESSAGES_PER_HOUR} per jam`);
}

async function cekStatusMonitor() {
  if (isChecking) {
    console.log("⏳ Pengecekan sebelumnya belum selesai, skip...");
    return;
  }
  isChecking = true;

  console.log(
    "🔍 Mengecek perubahan status monitor...",
    new Date().toLocaleTimeString()
  );

  let browser = null;
  const messageToSend = [];

  try {
    browser = await puppeteer.launch({
      executablePath: "/usr/bin/chromium",
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
        await page.waitForSelector(".badge.bg-primary, .badge.bg-danger", { timeout: 10000 });
        const html = await page.content();
        await page.close();
        page = null;

        const $ = cheerio.load(html);
        const monitors = [];
        $(".monitor-list .item").each((_, el) => {
          const name = $(el).find(".item-name").text().trim();
          const isOffline = $(el).find(".badge.bg-danger").length > 0;
          if (name) monitors.push({ name, isOffline });
        });

        for (const monitor of monitors) {
          const key = `${pageInfo.name} - ${monitor.name}`;
          const currentStatus = monitor.isOffline ? "offline" : "online";
          const prevStatus = lastStatuses[key];
          lastStatuses[key] = currentStatus;
          if (!monitorDownCount[key]) monitorDownCount[key] = 0;

          if (currentStatus === "offline") {
            monitorDownCount[key]++;

            if (!monitorDownTime[key]) {
              monitorDownTime[key] = new Date();
            }

            if (monitorDownCount[key] === 1 || monitorDownCount[key] % 6 === 0) {
              const now = new Date().toLocaleString("id-ID");
              const message = `🔴 *${key}* terdeteksi OFFLINE sejak ${new Date(
                monitorDownTime[key]
              ).toLocaleString("id-ID")} (cek: ${now})`;
              console.log("📤 Kirim notifikasi DOWN:", message);
              messageToSend.push(message);

              sentOffline[key] = true;

              if (!escalationQueue[key]) {
                escalationQueue[key] = { level: "admin", lastSent: Date.now() };
              } else {
                escalationQueue[key].lastSent = Date.now();
              }
            }
          } else {
            if (sentOffline[key]) {
              const now = new Date().toLocaleString("id-ID");
              const message = `🟢 *${key}* telah kembali ONLINE pada ${now}`;
              console.log("📤 Kirim notifikasi ONLINE:", message);
              messageToSend.push(message);

              delete sentOffline[key];
              delete escalationQueue[key];
              delete monitorDownCount[key];
              delete monitorDownTime[key];
            }
          }
        }
      } catch (pageErr) {
        console.warn(`⚠️ Error di halaman ${pageInfo.slug}:`, pageErr.message);
        if (page) await page.close();
        continue;
      }
    }

    if (messageToSend.length > 0) {
      const activeDownTimes = Object.values(monitorDownTime);
      const earliestDownTimes =
        activeDownTimes.length > 0
          ? new Date(Math.min(...activeDownTimes)).toLocaleString("id-ID")
          : "N/A";
      const now = new Date().toLocaleString("id-ID");
      const title = `LAPORAN MONITORING SYSTEM\n${now} \n\n DOWN SEJAK ${earliestDownTimes}\n\n`;
      const bodyMessages = messageToSend.join("\n");
      const finalMessages = title + bodyMessages;
      console.log(
        `\n📬 Mengirim pesan gabungan (${messageToSend.length} notifikasi)...`
      );
      
      if (await canSendMessage(HIERARCHY.admin)) {
        await new Promise(r => setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY));
        await sock.sendMessage(HIERARCHY.admin, { text: finalMessages });
        await recordMessageSent(HIERARCHY.admin);
        console.log("✅ Pesan berhasil dikirim");
      } else {
        console.log("⛔ SKIP pengiriman - sudah mencapai rate limit");
      }
    }
  } catch (err) {
    console.error("❌ Gagal memantau status:", err.message);
  } finally {
    console.log("✅ Pemeriksaan selesai. Menutup browser..");
    if (browser) await browser.close();
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

    const ATASAN_WAIT_MS = 20 * 60 * 1000;
    const PIMPINAN_WAIT_MS = 40 * 60 * 1000;

    for (const [key, esc] of Object.entries(escalationQueue)) {
      const elapsed = now - esc.lastSent;

      if (esc.level === "admin" && elapsed >= ATASAN_WAIT_MS) {
        shouldEscalateToAtasan.push(key);
      } else if (esc.level === "atasan" && elapsed >= PIMPINAN_WAIT_MS) {
        shouldEscalateToPimpinan.push(key);
      }
    }

    if (shouldEscalateToAtasan.length > 0) {
      await sendBatchEscalation("atasan", shouldEscalateToAtasan);
      await new Promise(r => setTimeout(r, ANTI_SPAM_CONFIG.COOLDOWN_BETWEEN_BATCHES));
    }

    if (shouldEscalateToPimpinan.length > 0) {
      await sendBatchEscalation("pimpinan", shouldEscalateToPimpinan);
    }

  } catch (err) {
    console.error("❌ Error saat menjalankan eskalasi:", err.message);
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
    waitTime = "20 menit";
    title = `⚠️ ESKALASI LEVEL 1: KE ATASAN (${keysToEscalate.length} Monitor)`;
  } else {
    targetHierarchy = HIERARCHY.pimpinan;
    nextLevel = "pimpinan";
    waitTime = "40 menit";
    title = `🚨 ESKALASI LEVEL 2: KE PIMPINAN (${keysToEscalate.length} Monitor)`;
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
      console.log(`🧹 Reset total state DOWN untuk monitor: ${key}`);

      delete escalationQueue[key];
      monitorDownCount[key] = 0;
      delete monitorDownTime[key];
    }
  }

  const finalMessage =
    `*${title}*\n` +
    `____________________________\n` +
    `Status: ${waitTime} telah berlalu tanpa konfirmasi dari ${
      targetLevel === "atasan" ? "Admin" : "Atasan"
    }.\n\n` +
    `*DAFTAR MONITOR:*\n` +
    body.join("\n");

  console.log(
    `\n📤 Mengirim batch eskalasi ke ${targetLevel}: ${keysToEscalate.length} item.`
  );

  try {
    if (await canSendMessage(targetHierarchy)) {
      await new Promise(r => setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY));
      await sock.sendMessage(targetHierarchy, { text: finalMessage });
      await recordMessageSent(targetHierarchy);
      console.log(`✅ Pesan eskalasi berhasil dikirim ke ${targetLevel}`);
    } else {
      console.log(`⛔ SKIP eskalasi ke ${targetLevel} - sudah mencapai rate limit`);
    }
  } catch (error) {
    console.error(`❌ Gagal mengirim pesan eskalasi ke ${targetLevel}:`, error.message);
  }
}

function handleAcknowledgement(from) {
  for (const [key, esc] of Object.entries(escalationQueue)) {
    if (
      (esc.level === "admin" && from === HIERARCHY.admin) ||
      (esc.level === "atasan" && from === HIERARCHY.atasan)
    ) {
      console.log(`✅ ${key} telah dikonfirmasi oleh ${esc.level}`);
      delete escalationQueue[key];
      monitorDownCount[key] = 0;
      delete monitorDownTime[key];
      delete sentOffline[key];
    }
  }
}

async function regenerateSession() {
  console.log("⚠️ Sesi terlogout. Menghapus session lama dan menyiapkan QR baru...");

  const sessionPath = path.join(__dirname, "Session_baileys");

  try {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log("🧹 Folder Session_baileys berhasil dihapus.");
    } else {
      console.log("ℹ️ Folder Session_baileys tidak ditemukan, lanjut membuat sesi baru.");
    }

    console.log("⏳ Menunggu 15 detik sebelum membuat QR baru...");
    await new Promise((resolve) => setTimeout(resolve, 15000));

    console.log("🔄 Membuat sesi baru dan menampilkan QR Code baru...");
    await connectToWhatsApp();
  } catch (err) {
    console.error("❌ Gagal regenerasi sesi:", err.message);
    console.log("🕒 Akan mencoba ulang dalam 10 detik...");
    await new Promise((resolve) => setTimeout(resolve, 10000));
    await connectToWhatsApp();
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("Session_baileys");
  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["CCTV Monitoring","Windows", "Fajar"],
  });
  
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📱 Pindai QR code ini untuk login:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log("🔁 Koneksi terputus, mencoba menyambungkan kembali dalam 10 detik...");
        await new Promise((resolve) => setTimeout(resolve, 10000));
        connectToWhatsApp();
      } else {
        console.log("🚫 Logout terdeteksi. QR baru akan dibuat...");
        regenerateSession();
      }

    } else if (connection === "open") {
      console.log("✅ Berhasil terhubung ke WhatsApp!");

      if (!monitoringStarted) {
        console.log("⏳ Menunggu 10 menit sebelum memulai pemantauan pertama...");
        await new Promise((resolve) => setTimeout(resolve, 10 * 60 * 1000));

        console.log("🚀 Memulai pemantauan CCTV...");
        console.log("Bot akan mengecek CCTV setiap 10 menit dan mengirim laporan setiap 1 jam");

        monitoringStarted = true;
        cekStatusMonitor();
        setInterval(cekStatusMonitor, 10 * 60 * 1000);
      }

      if (!escalationStarted) {
        escalationStarted = true;
        setInterval(runEscalationChecks, 60 * 60 * 1000);
      }

      console.log("✅ Interval pemantauan dan eskalasi aktif.");
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
      if (textMsg.startsWith("ok")) {
        console.log(`✅ Konfirmasi valid diterima dari ${from}: ${textMsg}`);
        
        if (await canSendMessage(from)) {
          await new Promise(r => setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY));
          await sock.sendMessage(from, {
            text: "✅ Konfirmasi diterima. Status eskalasi telah dihentikan.",
          });
          await recordMessageSent(from);
        }
        
        handleAcknowledgement(from);
      } else {
        console.log("✅ ini bukan konfirmasi");
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

connectToWhatsApp();
