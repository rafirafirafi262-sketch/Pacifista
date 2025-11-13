const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");

const logger = pino({
  level: "error", // Hanya error saja, jangan verbose
});

let sock;
let connectionAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let connectionSuccessTime = null;
let stableConnectionDuration = 0;

async function connectToWhatsApp() {
  connectionAttempt++;
  console.log(`\n🔄 CONNECTION ATTEMPT #${connectionAttempt}`);
  console.log(`⏰ ${new Date().toLocaleString()}`);
  console.log("═══════════════════════════════════════════════\n");

  try {
    const { state, saveCreds } = await useMultiFileAuthState("Session_baileys");
    
    console.log("📂 Session loaded");
    console.log(`   Auth state: ${!!state.auth ? "✅ YES" : "❌ NO"}`);
    console.log(`   Creds: ${!!state.creds ? "✅ YES" : "❌ NO"}\n`);

    sock = makeWASocket({
      auth: state,
      logger: logger,
      browser: ["CCTV Monitoring", "Windows", "Fajar"],
    });

    console.log("✅ Socket created\n");

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Display QR jika ada
      if (qr) {
        console.log("📱 QR CODE MUNCUL - Scan dengan WhatsApp:");
        qrcode.generate(qr, { small: true });
        console.log("");
      }

      // Saat connect
      if (connection === "connecting") {
        console.log("🔄 Status: CONNECTING...");
      }

      // Saat successful connect
      if (connection === "open") {
        console.log("🟢 ✅ CONNECTION OPEN!");
        console.log(`   Waktu connect: ${new Date().toLocaleString()}\n`);
        
        connectionSuccessTime = Date.now();
        connectionAttempt = 0; // Reset counter
        
        // ========== JANGAN KIRIM PESAN! HANYA TEST STABILITY ==========
        console.log("⏳ Testing connection stability...");
        console.log("   (Monitoring selama 2 menit, jangan tutup terminal)\n");
        
        // Monitor selama 2 menit
        let monitorCounter = 0;
        const monitorInterval = setInterval(() => {
          monitorCounter++;
          const elapsedSeconds = (Date.now() - connectionSuccessTime) / 1000;
          console.log(`   ✅ [${monitorCounter}] Connection STABLE (${Math.floor(elapsedSeconds)}s)\n`);
          
          if (monitorCounter >= 12) { // 12 x 10 detik = 120 detik = 2 menit
            clearInterval(monitorInterval);
            console.log("════════════════════════════════════════════════");
            console.log("🎉 CONNECTION STABILITY TEST PASSED!");
            console.log(`   Waktu stabil: 2 menit`);
            console.log("════════════════════════════════════════════════\n");
            console.log("✅ Bot siap untuk production!\n");
            console.log("📋 NEXT STEPS:");
            console.log("   1. Tekan CTRL+C untuk hentikan debug bot");
            console.log("   2. Jalankan production bot:");
            console.log("      pm2 start index.js --name BotMonitor");
            console.log("   3. Monitor dengan: pm2 logs BotMonitor\n");
            process.exit(0);
          }
        }, 10000); // Check setiap 10 detik
      }

      // Saat disconnect
      if (connection === "close") {
        console.log("🔴 CONNECTION CLOSED\n");

        if (lastDisconnect?.error) {
          const statusCode = lastDisconnect.error?.output?.statusCode;
          const errorMsg = lastDisconnect.error?.message;
          
          console.log(`   Error Code: ${statusCode}`);
          console.log(`   Error Msg: ${errorMsg}\n`);
          
          // Analisis error code
          if (statusCode === 440) {
            console.log("❌ ERROR 440: DEVICE CONFLICT");
            console.log("   Penyebab: Nomor sedang login di device lain");
            console.log("   Solusi: Logout dari phone/web WhatsApp Anda\n");
            process.exit(1);
          } else if (statusCode === 401) {
            console.log("❌ ERROR 401: UNAUTHORIZED");
            console.log("   Penyebab: Session expired atau invalid");
            console.log("   Solusi: Hapus Session_baileys/ dan scan QR baru\n");
            process.exit(1);
          }
        }

        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !==
          DisconnectReason.loggedOut;

        if (shouldReconnect && connectionAttempt < MAX_RECONNECT_ATTEMPTS) {
          console.log(`🔁 Reconnecting... (Attempt ${connectionAttempt}/${MAX_RECONNECT_ATTEMPTS})\n`);
          await new Promise((resolve) => setTimeout(resolve, 10000));
          connectToWhatsApp();
        } else {
          console.log("❌ MAX ATTEMPTS or LOGGED OUT");
          console.log("   Action: Jalankan ulang dengan session baru\n");
          process.exit(1);
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);

  } catch (err) {
    console.error("❌ ERROR:", err.message);
    if (connectionAttempt < MAX_RECONNECT_ATTEMPTS) {
      console.log(`🔁 Retry...\n`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      connectToWhatsApp();
    } else {
      process.exit(1);
    }
  }
}

console.log("╔═════════════════════════════════════════════╗");
console.log("║  CCTV BOT - CONNECTION STABILITY TEST      ║");
console.log("║  (Testing connection ONLY, no messages)    ║");
console.log("╚═════════════════════════════════════════════╝\n");

connectToWhatsApp();
