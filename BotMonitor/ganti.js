const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const puppeteer = require("puppeteer-core");
const cheerio = require("cheerio");

// --- PENGATURAN ---
const STATUS_PAGES = [
  { name: "CCTV Publik", slug: "bot-cctvpublic" },
  // { name: "JSS", slug: "bot-jss" },
];

const CHROME_PATH =
  "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe";

const KUMA_BASE_URL = "http://172.16.100.10";
let sock;

// --- PEMANTAU STATUS OTOMATIS ---
const monitorDownCount = {};
const lastStatuses = {};
const escalationQueue = {};
const monitorDownTime = {};
const sentOffline = {}; // ✅ DIPINDAHKAN KE SCOPE GLOBAL agar persisten

const HIERARCHY = {
  admin: "628995897629@s.whatsapp.net",
  atasan: "6282283595329@s.whatsapp.net",
  pimpinan: "6285934964784@s.whatsapp.net",
};

async function cekStatusMonitor() {
  console.log("🔍 Mengecek perubahan status monitor...", new Date().toLocaleTimeString());

  let browser = null;
  const messageToSend = [];

  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    for (const pageInfo of STATUS_PAGES) {
      const url = `${KUMA_BASE_URL}/status/${pageInfo.slug}`;
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
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


          // ✅ Set waktu down hanya sekali (saat pertama kali down)
          if (monitorDownCount[key] === 1) {
            monitorDownTime[key] = Date.now();
          }

          // ✅ HANYA SATU PENGECEKAN untuk notifikasi DOWN 10 menit
          if (monitorDownCount[key] === 10) {
            const now = new Date().toLocaleString("id-ID");
            const message = `🔴 ${key}`;
            console.log("📤 Kirim notifikasi DOWN 10 menit:", message);
            messageToSend.push(message);

            // ✅ Tandai bahwa status offline sudah dikirim
            sentOffline[key] = true;

            // ✅ Masukkan ke escalation queue HANYA SEKALI
            if (!escalationQueue[key]) {
              escalationQueue[key] = { level: "admin", lastSent: Date.now() };
            }
          }
        } else {
          // ✅ Monitor kembali ONLINE
          if (sentOffline[key]) {
            const now = new Date().toLocaleString("id-ID");
            const message = `🟢 *${key}* telah kembali ONLINE pada ${now}`;
            console.log("📤 Kirim notifikasi ONLINE:", message);
            messageToSend.push(message);

            // ✅ Reset semua state terkait monitor ini
            delete sentOffline[key];
          }

          monitorDownCount[key] = 0;
          delete escalationQueue[key];
          delete monitorDownTime[key];
        }
      }
    }

    // ✅ Kirim pesan gabungan jika ada
    if (messageToSend.length > 0) {
      const activeDownTimes = Object.values(monitorDownTime);

      const earliestDownTimes = activeDownTimes.length > 0
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
  }
}

function runEscalationChecks() {
  const now = Date.now();
  const shouldEscalateToAtasan = [];
  const shouldEscalateToPimpinan = [];

  // Batas waktu tunggu (dalam milidetik)
  const ATASAN_WAIT_MS = 20 * 60 * 1000; // Contoh: 10 menit (Bisa disesuaikan)
  const PIMPINAN_WAIT_MS = 40 * 60 * 1000; // 30 menit

  for (const [key, esc] of Object.entries(escalationQueue)) {
    const elapsed = now - esc.lastSent;

    if (esc.level === "admin" && elapsed >= ATASAN_WAIT_MS) {
      // Admin tidak merespons setelah ATASAN_WAIT_MS
      shouldEscalateToAtasan.push(key);
    } else if (esc.level === "atasan" && elapsed >= PIMPINAN_WAIT_MS) {
      // Atasan tidak merespons setelah PIMPINAN_WAIT_MS
      shouldEscalateToPimpinan.push(key);
    }
  }

  // Kirim Batch Eskalasi (jika ada)
  if (shouldEscalateToAtasan.length > 0) {
    sendBatchEscalation("atasan", shouldEscalateToAtasan);
  }

  if (shouldEscalateToPimpinan.length > 0) {
    sendBatchEscalation("pimpinan", shouldEscalateToPimpinan);
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
    await sock.sendMessage(targetHierarchy, { text: finalMessage });
    console.log(`✅ Pesan eskalasi berhasil dikirim ke ${targetLevel}`);
  } catch (error) {
    console.error(
      `❌ Gagal mengirim pesan eskalasi ke ${targetLevel}:`,
      error.message
    );
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

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("Session_baileys");
  sock = makeWASocket({ auth: state, printQRInTerminal: true });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("Pindai QR code ini:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log("Koneksi terputus, menyambungkan kembali...");
        connectToWhatsApp();
      }
    } else if (connection === "open") {
      console.log("Berhasil terhubung ke WhatsApp!");
      console.log(
        "Penjadwalan aktif. Bot akan mengirim laporan 10 menit sekali"
      );
      cekStatusMonitor();
      setInterval(cekStatusMonitor, 60 * 1000);
      setInterval(runEscalationChecks, 30 * 1000);
      // ------------------------
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
        await sock.sendMessage(from, {
          text: "✅ Konfirmasi diterima. Status eskalasi telah dihentikan.",
        });
        console.log()
        handleAcknowledgement(from);
      }else{
        console.log('✅ ini bukan konfirmasi')
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
