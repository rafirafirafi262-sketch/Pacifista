//call package
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
const { timeout } = require("puppeteer-core");

//object status
const STATUS_PAGE = [
  {name: "CCTV public", slug: "bot-cctvpublic"},
  // {name: "JSS", slug: "bot-jss"},
];

//path browser
const PATH =
  "C:/Users/Bento/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe";

//url base
const BASE_URL = "http://172.16.100.10";
let sock;

//pemantau status
const monitorDownCount = {};
const lastStatuses = {};
const escalationQueue = {};
const monitorDownTime = {};

//set nomer untuk eskalasi
const HIERARCHY = {
  admin: "6285763156062@s.whatsapp.net",
  atasan: "6282283595329@s.whatsapp.net",
  pimpinan: "628995897629@s.whatsapp.net",
};

// async function cekStatusMonitor() {
//   console.log("🔎 Mengecek perubahan status monitor...");

  let browser = null;
  const messageToSend = [];
  const sentOffline = {};

  try {
    browser = await puppeteer.launch({
      executablePath: PATH,
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    for (const pageInfo of STATUS_PAGE) {
      const url = `${BASE_URL}/status/${pageInfo.slug}`;
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await page.waitForSelector(".item-name");
      await page.waitForSelector(".badge.bg-primary, .badge.bg-danger");
      const html = await page.content();
      await page.close();
      //Fungsi untuk mengambil status monitor dari halama
      const $ = cheerio.load(html);
      const monitors = [];
      $(".monitor-list .item").each((_, el) => {
        const name = $(el).find(".item-name").text().trim();
        const isOffline = $(el).find(".badge.bg-danger").length > 0;
        if (name) monitors.push({ name, isOffline });
      });
      //Fungsi untuk memeriksa perubahan status
      for (const monitor of monitors) {
        const key = `${pageInfo.name} - ${monitor.name}`;
        const currentStatus = monitor.isOffline ? "offline" : "online";
        const prevStatus = lastStatuses[key];
        lastStatuses[key] = currentStatus;

        if (!monitorDownCount[key]) monitorDownCount[key] = 0;
        //ini baru coba
        if (currentStatus === "offline") {
          monitorDownCount[key]++;
          if (monitorDownTime[key] === 1)
            return (monitorDownTime[key] = Date.now());

          if (monitorDownCount[key] === 10) {
            const now = new Date().toLocaleDateString("id-ID");
            const message = `🚫${key}`;
            console.log("📩 Kirim notifikasi DOWN 10 menit...");
            messageToSend.push(message);

            sentOffline[key] = true;

            if (!escalationQueue[key]) {
              escalationQueue[key] = {
                level: "admin",
                lastSent: Date.now(),
              };
            }
          }
        } else {
          if (sentOffline[key]) {
            const now = new Date().toLocaleDateString("id-ID");
            const message = `🟢${key} kembali ONLINE ${now}`;
            console.log("📤 kirim notifikasi online", message);
            messageToSend.push(message);

            delete sentOffline[key];
          }

          monitorDownCount[key] = 0;
          delete escalationQueue[key];
          delete monitorDownTime[key];
        }
      }
    }
    //Kirim pesan gabungan jika ada yang sudah down selama waktu yang ditentukan
    if (messageToSend.length > 0) {
      const now = new Date().toLocaleDateString("id-ID");
      const title = `LAPORAN MONITORING SYSTEM\n ${now} \n\n `;
      const bodyMessage = messageToSend.join("\n");
      const finalMessage = title + bodyMessage;
      console.log(
        `\n📩 mengirim pesan gabungan (${messageToSend.length} notifikasi)`
      );
      await sock.sendMessage(HIERARCHY.admin, { text: finalMessage });
    }
  } catch (err) {
    console.log("❌ Gagal memantau status...", err.message);
  } finally {
    console.log("✅ Pemeriksaan selesai. menutup browser");
    if (browser) await browser.close();
  }
}

function runEscalationChecks() {
  const now = Date.now();
  const shouldEscalateToAtasan = [];
  const shouldEscalateToPimpinan = [];

  //Set waktu tunggu untuk eskalasi dalam milidetik
  const ATASAN_WAIT_MS = 20 * 60 * 1000; //20 menit
  const PIMPINAN_WAIT_MS = 40 * 60 * 1000; //40 menit

  for (const [key, esc] of Object.entries(escalationQueue)) {
    const elapsed = now - esc.lastSent;
    //kondisi untuk eskalasi jika admin tidak merespon selama 20 menit
    if (esc.level === "admin" && elapsed >= ATASAN_WAIT_MS) {
      shouldEscalateToAtasan.push(key);
    }
    //kondisi untuk eskalasi jika atasan tidak merespon selama 40 menit
    else if (esc.level === "atasan" && elapsed >= PIMPINAN_WAIT_MS) {
      shouldEscalateToPimpinan.push(key);
    }
  }
  //Kirim pesan yang akan dieskalasi
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

  //Konfigurasi pesan berdasarkan level target
  if (targetLevel === "atasan") {
    targetHierarchy = HIERARCHY.atasan;
    nextLevel = "atasan";
    waitTime = "20 menit"; //Disesuaikan dengan waktu tunggu (ATASAN_WAIT_MS/PiMPINAN_WAIT_MS)
    title = `⚠️ESKALASI LEVEL 1 : KE ATASAN⚠️\n\n`;
  } else {
    targetHierarchy = HIERARCHY.pimpinan;
    nextLevel = "pimpinan";
    waitTime = "40 menit";
    title = `🚨 ESKALASI LEVEL 2 : KE PIMPINAN (${keysToEscalate.length} monitor)`;
  }
  let body = [];

  for (const key of keysToEscalate) {
    const esc = escalationQueue[key];
    if (!esc) continue;

    const initialDownTime = monitorDownTime[key]
      ? new Date(monitorDownTime[key]).toLocaleDateString("id-ID")
      : "N/A";

    body.push(`🚫${key} Down sejak${initialDownTime}`);

    escalationQueue[key].level = nextLevel;
    escalationQueue[key].lastSent = Date.now();

    if (targetLevel === "pimpinan") {
      console.log(`Reset total DOWN untuk monitor: ${key}`);

      delete escalationQueue[key];
      monitorDownCount[key] = 0;
      delete monitorDownTime[key];
    }
  }

  const finalMessage = `**${title}**\n
  Status: ${waitTime} telah berlalu tanpa konfirmasi dari ${
    targetLevel === "atasan" ? "Admin" : "Atasan"
  }.*DAFTAR MONITOR:*\n
      ${body.join("\n")}`;

  console.log(
    `\n 📤 Mengirim batch eskalasi ke ${targetLevel} : ${keysToEscalate.length} item`
  );
  await sock.sendMessage(targetHierarchy, { text: finalMessage });
}

function handleAcknowledgment(from) {
  for (const [key, esc] of Object.entries(escalationQueue)) {
    if (
      (esc.level === "admin" && from === HIERARCHY.admin) ||
      (esc.level === "pimpinan" && from === HIERARCHY.atasan)
    ) {
      console.log(`✅ ${key} telah di konfirmasi oleh ${esc.level}`);
      delete escalationQueue[key];
      monitorDownCount[key] = 0;
      delete monitorDownCount[key];
    }
  }
}

async function regenerateSession() {
  console.log(
    "⚠️ Sesi terlogout. Menghapus session lama dan menyiapkan QR baru..."
  );
  const sessionPath = path.join(__dirname, "Session_baileys");

  try {
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log("🧹 Folder Session_baileys telah dihapus.");
    }
  } catch (err) {
    console.log("❌ Gagal menghapus folder session:", err.message);
  }
  console.log("🔄 Membuat sesi baru dan menampilkan QR Code baru...");
  await connectToWhatsApp();
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("Session_baileys");
  sock = makeWASocket({ auth: state, printQRInTerminal: true });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("Pindai QR kode ini...");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log("Koneksi terputus, sambungkan Kembali....");
        connectToWhatsApp();
      }else {
        console.log("🚫 Logout terdeteksi. QR baru akan dibuat...");
        regenerateSession();
      }
    } else if (connection === "open") {
      console.log("Berhasil Terhubung Ke WhatsApp!");
      console.log(
        "Penjadwalan Aktif. Bot Akan Mengirimkan Laporan 10 Menit Sekali"
      );

      cekStatusMonitor();
      setInterval(cekStatusMonitor, 60 * 1000);
      setInterval(runEscalationChecks, 30 * 1000);
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
        await sock.sendMessage(from, {
          text: "✅ Konfirmasi diterima. Status eskalasi telah dihentikan.",
        });
        handleAcknowledgment(from);
      } else {
        console.log(
          `📩 Pesan Diterima Dari ${from}, Bukan Konfirmasi: ${textMsg}\n\n`
        );
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

connectToWhatsApp();
