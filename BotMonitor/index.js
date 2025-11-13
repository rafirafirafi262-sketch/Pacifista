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
// Global control flags
let monitoringStarted = false;      // mencegah double interval saat reconnect
let escalationStarted = false;      // sama untuk eskalasi
let firstRun = true;                // treat first check as baseline (jangan kirim notifikasi DOWN)
let lastRegenerateTime = 0;         // cooldown untuk regenerate session (ms)


const CHROME_PATH = "/usr/bin/chromium";

const KUMA_BASE_URL = "http://172.16.100.10";
let sock;

// --- PEMANTAU STATUS OTOMATIS ---
const monitorDownCount = {};
const lastStatuses = {};
const escalationQueue = {};
const monitorDownTime = {};
const sentOffline = {}; // ✅ DIPINDAHKAN KE SCOPE GLOBAL agar persisten

const HIERARCHY = {
  admin: "6285934964784@s.whatsapp.net",
  atasan: "6282283595329@s.whatsapp.net",
  pimpinan: "628995897629@s.whatsapp.net",
};
let isChecking = false;
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
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await page.waitForSelector(".item-name");
      await page.waitForSelector(".badge.bg-primary, .badge.bg-danger");
      const html = await page.content();
      await page.close();

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

    // =========================================
// ✅ Pengecekan status CCTV & pengiriman notifikasi
// =========================================
// for (const key of Object.keys(statusMonitor)) {
  // const isDown = statusMonitor[key] === "DOWN";

  // if (isDown) {
  //   // Tambah hitungan down time
  //   monitorDownCount[key] = (monitorDownCount[key] || 0) + 1;

  //   // Simpan waktu pertama kali down
  //   if (!monitorDownTime[key]) {
  //     monitorDownTime[key] = Date.now();
  //   // }

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

  //let lastReportTime = 0;
    
    // ✅ Kirim pesan gabungan jika ada
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
      await sock.sendMessage(HIERARCHY.admin, { text: finalMessages });
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

// Ganti fungsi lama dengan ini
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
    // small delay to avoid burst
    await new Promise(r => setTimeout(r, 1500));
    await sock.sendMessage(targetHierarchy, { text: finalMessage });
    console.log(`✅ Pesan eskalasi berhasil dikirim ke ${targetLevel}`);
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
  }
    else {
      console.log("🚫 Logout terdeteksi. QR baru akan dibuat...");
      regenerateSession();
    }

  } else if (connection === "open") {
  console.log("✅ Berhasil terhubung ke WhatsApp!");
  console.log("⏳ Menunggu 10 menit sebelum memulai pemantauan pertama...");

  // 🔸 Tunggu 10 menit (600.000 ms) sebelum menjalankan pemantauan pertama
  await new Promise((resolve) => setTimeout(resolve, 10 * 60 * 1000));

  console.log("🚀 Memulai pemantauan CCTV...");
  console.log("Bot akan mengecek CCTV setiap 10 menit dan mengirim laporan setiap 1 jam");

  // Gunakan flag supaya interval tidak dobel ketika reconnect
  if (!global.monitoringStarted) {
    global.monitoringStarted = true;
    cekStatusMonitor();
    setInterval(cekStatusMonitor, 10 * 60 * 1000); // ✅ Cek setiap 10 menit
  }

  if (!global.escalationStarted) {
    global.escalationStarted = true;
    setInterval(runEscalationChecks, 60 * 60 * 1000); // ✅ Kirim laporan setiap 1 jam
  }

  console.log("✅ Interval pemantauan dan eskalasi aktif.");
}

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
        await sock.sendMessage(from, {
          text: "✅ Konfirmasi diterima. Status eskalasi telah dihentikan.",
        });
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
