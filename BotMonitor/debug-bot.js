
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");

// ========== DEBUG MODE - VERBOSE LOGGING ==========
const DEBUG = true; // Set true untuk enable verbose debug

const logger = pino({
  level: DEBUG ? "debug" : "error",
});

const HIERARCHY = {
  admin: "6285934964784@s.whatsapp.net",
};

let sock;
let connectionAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

async function connectToWhatsApp() {
  connectionAttempt++;
  console.log(`\n🔄 CONNECTION ATTEMPT #${connectionAttempt}`);
  console.log(`⏰ Timestamp: ${new Date().toLocaleString()}`);
  console.log("════════════════════════════════════════════\n");

  try {
    const { state, saveCreds } = await useMultiFileAuthState("Session_baileys");
    
    console.log("📂 Session state loaded");
    console.log(`   - Auth state exists: ${!!state.auth}`);
    console.log(`   - Creds exists: ${!!state.creds}`);
    console.log(`   - Session keys: ${Object.keys(state).join(", ")}\n`);

    sock = makeWASocket({
      auth: state,
      logger: logger,
      browser: ["CCTV Monitoring", "Windows", "Fajar"],
      syncFullHistory: false,
      retryRequestDelayMs: 100,
    });

    console.log("✅ Socket created successfully\n");

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr, isOnline, isConnected } = update;

      console.log("\n📡 CONNECTION UPDATE EVENT:");
      console.log(`   - connection: ${connection}`);
      console.log(`   - isOnline: ${isOnline}`);
      console.log(`   - isConnected: ${isConnected}`);
      
      if (qr) {
        console.log(`   - QR Code Available: YES`);
        console.log("📱 Pindai QR code ini untuk login:");
        qrcode.generate(qr, { small: true });
      } else {
        console.log(`   - QR Code Available: NO`);
      }

      if (lastDisconnect) {
        console.log(`   - Disconnect Error:`);
        console.log(`     * Status Code: ${lastDisconnect.error?.output?.statusCode}`);
        console.log(`     * Error: ${lastDisconnect.error?.message}`);
      }

      if (connection === "close") {
        console.log("\n🔴 CONNECTION CLOSED");

        const shouldReconnect =
          lastDisconnect.error?.output?.statusCode !==
          DisconnectReason.loggedOut;

        console.log(`   - Should Reconnect: ${shouldReconnect}`);

        if (shouldReconnect) {
          if (connectionAttempt < MAX_RECONNECT_ATTEMPTS) {
            console.log(
              `\n🔁 Reconnecting in 10 seconds... (Attempt ${connectionAttempt}/${MAX_RECONNECT_ATTEMPTS})`
            );
            await new Promise((resolve) => setTimeout(resolve, 10000));
            connectToWhatsApp();
          } else {
            console.log(`\n❌ MAX RECONNECT ATTEMPTS REACHED`);
            console.log("Kemungkinan penyebab:");
            console.log("   1. Nomor WhatsApp sudah di-ban");
            console.log("   2. Session credentials sudah expired");
            console.log("   3. Network connectivity issue");
            process.exit(1);
          }
        } else {
          console.log("\n🚫 LOGGED OUT");
          process.exit(1);
        }
      } else if (connection === "open") {
        console.log("\n🟢 CONNECTION OPEN - SUCCESS!");
        console.log(`✅ Bot berhasil connect ke WhatsApp`);
        console.log(`⏰ Connected at: ${new Date().toLocaleString()}`);
        
        connectionAttempt = 0;
        
        console.log("\n⏳ Waiting 5 seconds untuk stabilize connection...");
        await new Promise((resolve) => setTimeout(resolve, 5000));

        console.log("\n📤 TEST: Sending test message to admin...");
        try {
          const testMsg = `✅ Bot sudah online!\nTime: ${new Date().toLocaleString("id-ID")}`;
          await sock.sendMessage(HIERARCHY.admin, { text: testMsg });
          console.log("✅ Test message sent successfully!");
        } catch (err) {
          console.log(`❌ Failed to send test message: ${err.message}`);
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);
    console.log("✅ Event listeners registered\n");

  } catch (err) {
    console.error("\n❌ ERROR in connectToWhatsApp():");
    console.error(`   Message: ${err.message}`);
    
    if (connectionAttempt < MAX_RECONNECT_ATTEMPTS) {
      console.log(`\n🔁 Retrying in 5 seconds...`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      connectToWhatsApp();
    } else {
      console.log("\n❌ FATAL ERROR");
      process.exit(1);
    }
  }
}

console.log("╔════════════════════════════════════════════╗");
console.log("║   CCTV MONITORING BOT - DEBUG MODE         ║");
console.log("║   Starting connection...                   ║");
console.log("╚════════════════════════════════════════════╝");

connectToWhatsApp();
