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

// === ANTI-SPAM SETTINGS (TAMBAHAN BARU) ===
const ANTI_SPAM_CONFIG = {
  MIN_DELAY_BETWEEN_MESSAGES: 3000,    // 3 detik antara tiap pesan
  MAX_MESSAGES_PER_HOUR: 20,            // Max 20 pesan per jam ke satu contact
  BATCH_SEND_DELAY: 2000,               // 2 detik delay sebelum batch send
  COOLDOWN_BETWEEN_BATCHES: 5000,       // 5 detik antara batch kirim
};

// Global control flags
let monitoringStarted = false;      // mencegah double interval saat reconnect
let escalationStarted = false;      // sama untuk eskalasi
let firstRun = true;                // treat first check as baseline (jangan kirim notifikasi DOWN)
let lastRegenerateTime = 0;         // cooldown untuk regenerate session (ms)
let monitoringInterval = null;      // simpan reference interval monitoring
let escalationInterval = null;      // simpan reference interval eskalasi


const CHROME_PATH = "/usr/bin/chromium";

const KUMA_BASE_URL = "http://172.16.100.10";
let sock;

// --- PEMANTAU STATUS OTOMATIS ---
const monitorDownCount = {};
const lastStatuses = {};
const escalationQueue = {};
const monitorDownTime = {};
const sentOffline = {}; // ✅ DIPINDAHKAN KE SCOPE GLOBAL agar persisten

// === MESSAGE THROTTLING (TAMBAHAN BARU) ===
const messageCountPerHour = {};  // { "contact": { count: N, resetTime: timestamp } }
const lastMessageTime = {};      // { "contact": timestamp }

const HIERARCHY = {
  admin: "6285934964784@s.whatsapp.net",
  atasan: "6282283595329@s.whatsapp.net",
  pimpinan: "628995897629@s.whatsapp.net",
};

let isChecking = false;

// ✅ FUNGSI BARU: Cek apakah bisa kirim pesan (anti-throttle)
async function canSendMessage(contact) {
  const now = Date.now();
  
  // 1. Cek delay minimum antar pesan
  if (lastMessageTime[contact]) {
    const timeSinceLastMsg = now - lastMessageTime[contact];
    if (timeSinceLastMsg < ANTI_SPAM_CONFIG.MIN_DELAY_BETWEEN_MESSAGES) {
      const waitTime = ANTI_SPAM_CONFIG.MIN_DELAY_BETWEEN_MESSAGES - timeSinceLastMsg;
      console.log(`⏳ Tunggu ${waitTime}ms sebelum kirim ke ${contact}`);
      await new Promise(r => setTimeout(r, waitTime));
    }
  }

  // 2. Cek limit per jam
  if (!messageCountPerHour[contact]) {
    messageCountPerHour[contact] = { count: 0, resetTime: now + 3600000 };
  }

  const hourData = messageCountPerHour[contact];
  
  // Reset counter setiap jam
  if (now >= hourData.resetTime) {
    hourData.count = 0;
    hourData.resetTime = now + 3600000;
  }

  // Cek apakah sudah mencapai limit
  if (hourData.count >= ANTI_SPAM_CONFIG.MAX_MESSAGES_PER_HOUR) {
    console.log(`⛔ Sudah mencapai limit ${ANTI_SPAM_CONFIG.MAX_MESSAGES_PER_HOUR} pesan/jam untuk ${contact}`);
    return false;
  }

  return true;
}

// ✅ FUNGSI BARU: Catat pesan yang dikirim
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
    return; // ❗ skip eksekusi kalau masih jalan sebelumnya
  }
  isChecking = true; // 🔒 lock mulai

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
      } catch (pageErr) {
        console.warn(`⚠️ Error di halaman ${pageInfo.slug}:`, pageErr.message);
        if (page) await page.close();
        continue;
      }

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

          // ✅ Set waktu down hanya sekali
          if (!monitorDownTime[key]) {
            monitorDownTime[key] = new Date();
          }

          // ✅ Kirim notifikasi hanya sekali per jam (setiap 6x loop 10 menit)
          // contoh: 10 menit * 6 = 60 menit
          if (monitorDownCount[key] === 1 || monitorDownCount[key] % 6 === 0) {
            const now = new Date().toLocaleString("id-ID");
            const message = `🔴 *${key}* terdeteksi OFFLINE sejak ${new Date(
              monitorDownTime[key]
            ).toLocaleString("id-ID")} (cek: ${now})`;
            console.log("📤 Kirim notifikasi DOWN:", message);
            messageToSend.push(message);

            sentOffline[key] = true;

            // ✅ Tambahkan ke escalation queue hanya sekali
            if (!escalationQueue[key]) {
              escalationQueue[key] = { level: "admin", lastSent: Date.now() };
            } else {
              escalationQueue[key].lastSent = Date.now(); // update waktu terakhir kirim
            }
          }
        } else {
          // ✅ Jika kembali ONLINE
          if (sentOffline[key]) {
            const now = new Date().toLocaleString("id-ID");
            const message = `🟢 *${key}* telah kembali ONLINE pada ${now}`;
            console.log("📤 Kirim notifikasi ONLINE:", message);
            messageToSend.push(message);

            // Reset semua state terkait monitor ini
            delete sentOffline[key];
            delete escalationQueue[key];
            delete monitorDownCount[key];
            delete monitorDownTime[key];
          }
        }
      }
    }

    // ✅ Kirim pesan gabungan jika ada (DENGAN ANTI-SPAM)
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
      
      // ✅ TAMBAHAN BARU: Cek anti-spam sebelum kirim
      if (await canSendMessage(HIERARCHY.admin)) {
        // ✅ TAMBAHAN BARU: Delay sebelum send
        await new Promise(r => setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY));
        
        await sock.sendMessage(HIERARCHY.admin, { text: finalMessages });
        
        // ✅ TAMBAHAN BARU: Catat pesan yang dikirim
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

  isEscalating = true; // 🔒 lock aktif
  console.log("🚀 Menjalankan pengecekan eskalasi...");

  try {
    const now = Date.now();
    const shouldEscalateToAtasan = [];
    const shouldEscalateToPimpinan = [];

    // Batas waktu tunggu (dalam milidetik)
    const ATASAN_WAIT_MS = 20 * 60 * 1000; // 20 menit
    const PIMPINAN_WAIT_MS = 40 * 60 * 1000; // 40 menit

    for (const [key, esc] of Object.entries(escalationQueue)) {
      const elapsed = now - esc.lastSent;

      if (esc.level === "admin" && elapsed >= ATASAN_WAIT_MS) {
        shouldEscalateToAtasan.push(key);
      } else if (esc.level === "atasan" && elapsed >= PIMPINAN_WAIT_MS) {
        shouldEscalateToPimpinan.push(key);
      }
    }

    // Kirim Batch Eskalasi jika ada
    if (shouldEscalateToAtasan.length > 0) {
      await sendBatchEscalation("atasan", shouldEscalateToAtasan);
      // ✅ TAMBAHAN BARU: Cooldown antar batch
      await new Promise(r => setTimeout(r, ANTI_SPAM_CONFIG.COOLDOWN_BETWEEN_BATCHES));
    }

    if (shouldEscalateToPimpinan.length > 0) {
      await sendBatchEscalation("pimpinan", shouldEscalateToPimpinan);
    }

  } catch (err) {
    console.error("❌ Error saat menjalankan eskalasi:", err.message);
  } finally {
    isEscalating = false; // 🔓 unlock agar bisa jalan lagi nanti
    console.log("✅ Pengecekan eskalasi selesai.\n");
  }
}

async function sendBatchEscalation(targetLevel, keysToEscalate) {
  if (keysToEscalate.length === 0) return;

  let targetHierarchy;
  let title;
  let nextLevel;
  let waitTime;

  // Catatan: Pastikan variabel global monitorDownCount dan monitorDownTime
  // telah dideklarasikan di scope yang sama atau global.

  // Konfigurasi pesan berdasarkan level target
  if (targetLevel === "atasan") {
    targetHierarchy = HIERARCHY.atasan;
    nextLevel = "atasan";
    waitTime = "20 menit"; // Sesuaikan dengan ATASAN_WAIT_MS di runEscalationChecks
    title = `⚠️ ESKALASI LEVEL 1: KE ATASAN (${keysToEscalate.length} Monitor)`;
  } else {
    // targetLevel === "pimpinan"
    targetHierarchy = HIERARCHY.pimpinan;
    nextLevel = "pimpinan";
    waitTime = "40 menit"; // Sesuaikan dengan PIMPINAN_WAIT_MS di runEscalationChecks
    title = `🚨 ESKALASI LEVEL 2: KE PIMPINAN (${keysToEscalate.length} Monitor)`;
  }

  let body = [];

  for (const key of keysToEscalate) {
    const esc = escalationQueue[key];
    if (!esc) continue;

    const initialDownTime = monitorDownTime[key]
      ? new Date(monitorDownTime[key]).toLocaleString("id-ID")
      : "N/A";

    // Format laporan untuk setiap monitor
    body.push(`- *${key}* (Down Sejak: ${initialDownTime})`);

    // Perbarui status monitor ke level berikutnya dan reset lastSent timer
    escalationQueue[key].level = nextLevel;
    escalationQueue[key].lastSent = Date.now();

    // JIKA SUDAH LEVEL PIMPINAN (ESKALASI SELESAI), RESET TOTAL STATE
    if (targetLevel === "pimpinan") {
      console.log(`🧹 Reset total state DOWN untuk monitor: ${key}`);

      // 1. Hapus dari antrian eskalasi (Wajib)
      delete escalationQueue[key];

      // 2. Reset hitungan down (WAJIB agar bisa trigger notifikasi awal lagi)
      monitorDownCount[key] = 0;

      // 3. Hapus waktu down pertama (Wajib)
      delete monitorDownTime[key];
    }
  }

  // ✅ FIX: Gunakan *bold* untuk WhatsApp, bukan **bold**
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
    // ✅ TAMBAHAN BARU: Cek anti-spam sebelum kirim
    if (await canSendMessage(targetHierarchy)) {
      // ✅ TAMBAHAN BARU: Delay sebelum send
      await new Promise(r => setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY));
      
      await sock.sendMessage(targetHierarchy, { text: finalMessage });
      
      // ✅ TAMBAHAN BARU: Catat pesan yang dikirim
      await recordMessageSent(targetHierarchy);
      
      console.log(`✅ Pesan eskalasi berhasil dikirim ke ${targetLevel}`);
    } else {
      console.log(`⛔ SKIP eskalasi ke ${targetLevel} - sudah mencapai rate limit`);
    }
  } catch (error) {
    console.error(`❌ Gagal mengirim pesan eskalasi ke ${targetLevel}:`, error.message);
  }
}

// ✅ Fungsi jika admin/atasan membalas
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
      delete sentOffline[key]; // ✅ Hapus juga dari sentOffline
    }
  }
}

async function regenerateSession() {
  console.log("⚠️ Sesi terlogout. Menghapus session lama dan menyiapkan QR baru...");

  const sessionPath = path.join(__dirname, "Session_baileys");

  try {
    // Tunggu 2 detik untuk memastikan koneksi WhatsApp benar-benar terputus
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (fs.existsSync(sessionPath)) {
      // Gunakan fs.rmSync agar bersih, tapi pastikan tidak crash jika sedang dipakai
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log("🧹 Folder Session_baileys berhasil dihapus.");
    } else {
      console.log("ℹ️ Folder Session_baileys tidak ditemukan, lanjut membuat sesi baru.");
    }

    // Tambah jeda sebelum reconnect (hindari spam login)
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
    // printQRInTerminal: true,
    logger: pino({ level: "silent" }), // nonaktifkan log awal
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
      
      // ✅ PERBAIKAN: Hentikan interval lama jika ada (saat reconnect)
      if (monitoringInterval) {
        clearInterval(monitoringInterval);
        console.log("🧹 Menghentikan interval monitoring lama...");
      }
      if (escalationInterval) {
        clearInterval(escalationInterval);
        console.log("🧹 Menghentikan interval eskalasi lama...");
      }

      // 🔸 Tunggu 10 menit HANYA di first run
      if (monitoringStarted === false) {
        console.log("⏳ Menunggu 10 menit sebelum memulai pemantauan pertama...");
        await new Promise((resolve) => setTimeout(resolve, 10 * 60 * 1000));
      } else {
        console.log("⏳ Reconnect terdeteksi, langsung mulai monitoring...");
      }

      console.log("🚀 Memulai pemantauan CCTV...");
      console.log("Bot akan mengecek CCTV setiap 10 menit dan mengirim laporan setiap 1 jam");

      // ✅ PERBAIKAN: Selalu set flag true dan buat interval baru
      if (!monitoringStarted) {
        monitoringStarted = true;
        cekStatusMonitor(); // Run sekali langsung
        monitoringInterval = setInterval(cekStatusMonitor, 10 * 60 * 1000); // ✅ Cek setiap 10 menit
        console.log("✅ Interval monitoring dimulai");
      }

      if (!escalationStarted) {
        escalationStarted = true;
        escalationInterval = setInterval(runEscalationChecks, 60 * 60 * 1000); // ✅ Kirim laporan setiap 1 jam
        console.log("✅ Interval eskalasi dimulai");
      }

      console.log("✅ Interval pemantauan dan eskalasi aktif.");
    }
  });

  //Fungsi Mengecek Balasan dari admin
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

    // Hanya respon dari admin atau atasan
    if (from === HIERARCHY.admin || from === HIERARCHY.atasan) {
      // Jika mengandung "oke" (misalnya "oke", "ok", "okey", "oke siap", dll)
      if (textMsg.startsWith("ok")) {
        console.log(`✅ Konfirmasi valid diterima dari ${from}: ${textMsg}`);
        
        // ✅ TAMBAHAN BARU: Cek anti-spam sebelum kirim balasan
        if (await canSendMessage(from)) {
          // ✅ TAMBAHAN BARU: Delay sebelum send
          await new Promise(r => setTimeout(r, ANTI_SPAM_CONFIG.BATCH_SEND_DELAY));
          
          await sock.sendMessage(from, {
            text: "✅ Konfirmasi diterima. Status eskalasi telah dihentikan.",
          });
          
          // ✅ TAMBAHAN BARU: Catat pesan yang dikirim
          await recordMessageSent(from);
        }
        
        console.log();
        handleAcknowledgement(from);
      } else {
        console.log("✅ ini bukan konfirmasi");
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// Jalankan bot
connectToWhatsApp();

// // AUTO RESTART
// const { spawn } = require("child_process");
// const { text } = require("stream/consumers");

// process.on("uncaughtException", (err) => {
//   console.error("❌ Uncaught Exception:", err);
//   restartProgram();
// });

// process.on("unhandledRejection", (reason, promise) => {
//   console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
//   restartProgram();
// });

// function restartProgram() {
//   console.log("🔁 Terjadi error fatal. Bot akan restart dalam 5 detik...");
//   setTimeout(() => {
//     spawn("node", [__filename], { stdio: "inherit" });
//     process.exit(1);
//   }, 5000);
// }
