/**
 * WhatsApp Authentication Script
 *
 * Run this during setup to authenticate with WhatsApp.
 * Displays QR code, waits for scan, saves credentials, then exits.
 *
 * Usage: npx tsx src/whatsapp-auth.ts
 */
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import readline from 'readline';
import { HttpsProxyAgent } from 'https-proxy-agent';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

const AUTH_DIR = './store/auth';
const QR_FILE = './store/qr-data.txt';
const QR_PNG = './store/qr.png';
const STATUS_FILE = './store/auth-status.txt';

const logger = pino({
  level: 'debug', // Verbose logging for debugging
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

// Check for --pairing-code flag and phone number
const usePairingCode = process.argv.includes('--pairing-code');
const phoneArg = process.argv.find((_, i, arr) => arr[i - 1] === '--phone');

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function connectSocket(
  phoneNumber?: string,
  isReconnect = false,
): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (state.creds.registered && !isReconnect) {
    fs.writeFileSync(STATUS_FILE, 'already_authenticated');
    console.log('✓ Already authenticated with WhatsApp');
    console.log(
      '  To re-authenticate, delete the store/auth folder and run again.',
    );
    process.exit(0);
  }

  // Configure proxy agent if HTTP_PROXY or HTTPS_PROXY is set
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  const { version } = await fetchLatestBaileysVersion().catch(async () => {
    return fetchLatestWaWebVersion(agent ? ({ agent } as any) : {}).catch(
      (err) => {
        logger.warn(
          { err },
          'Failed to fetch latest WA Web version, using default',
        );
        return { version: undefined };
      },
    );
  });

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    agent,
    fetchAgent: agent,
  } as any);

  if (usePairingCode && phoneNumber && !state.creds.me) {
    // Request pairing code after a short delay for connection to initialize
    // Only on first connect (not reconnect after 515)
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber!);
        console.log(`\n🔗 Your pairing code: ${code}\n`);
        console.log('  1. Open WhatsApp on your phone');
        console.log('  2. Tap Settings → Linked Devices → Link a Device');
        console.log('  3. Tap "Link with phone number instead"');
        console.log(`  4. Enter this code: ${code}\n`);
        fs.writeFileSync(STATUS_FILE, `pairing_code:${code}`);
      } catch (err: any) {
        console.error('Failed to request pairing code:', err.message);
        process.exit(1);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Write raw QR data to file so the setup skill can render it
      fs.writeFileSync(QR_FILE, qr);
      // Also save as PNG for easier scanning
      QRCode.toFile(QR_PNG, qr, { width: 400 })
        .then(() => {
          console.log(`\n📷 QR code saved as image: ${QR_PNG}`);
          console.log('   Open it with: open store/qr.png\n');
        })
        .catch(() => {});
      console.log('Scan this QR code with WhatsApp:\n');
      console.log('  1. Open WhatsApp on your phone');
      console.log('  2. Tap Settings → Linked Devices → Link a Device');
      console.log('  3. Point your camera at the QR code below\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        fs.writeFileSync(STATUS_FILE, 'failed:logged_out');
        console.log('\n✗ Logged out. Delete store/auth and try again.');
        process.exit(1);
      } else if (reason === DisconnectReason.timedOut) {
        fs.writeFileSync(STATUS_FILE, 'failed:qr_timeout');
        console.log('\n✗ QR code timed out. Please try again.');
        process.exit(1);
      } else if (reason === 515) {
        // 515 = stream error, often happens after pairing succeeds but before
        // registration completes. Reconnect to finish the handshake.
        console.log('\n⟳ Stream error (515) after pairing — reconnecting...');
        connectSocket(phoneNumber, true);
      } else {
        fs.writeFileSync(STATUS_FILE, `failed:${reason || 'unknown'}`);
        console.log('\n✗ Connection failed. Please try again.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      fs.writeFileSync(STATUS_FILE, 'authenticated');
      // Clean up QR file now that we're connected
      try {
        fs.unlinkSync(QR_FILE);
      } catch {}
      console.log('\n✓ Successfully authenticated with WhatsApp!');
      console.log('  Credentials saved to store/auth/');
      console.log('  You can now start the NanoClaw service.\n');

      // Cleanly close the WebSocket so WhatsApp server releases the session
      // before the nanoclaw service connects. Without this, process.exit()
      // kills the TCP connection abruptly and the server keeps it "active",
      // causing the service to get 405 Connection Failure.
      setTimeout(async () => {
        try {
          await sock.end(undefined);
        } catch {}
        setTimeout(() => process.exit(0), 2000);
      }, 1000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

async function authenticate(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  // Clean up any stale QR/status files from previous runs
  try {
    fs.unlinkSync(QR_FILE);
  } catch {}
  try {
    fs.unlinkSync(QR_PNG);
  } catch {}
  try {
    fs.unlinkSync(STATUS_FILE);
  } catch {}

  let phoneNumber = phoneArg;
  if (usePairingCode && !phoneNumber) {
    phoneNumber = await askQuestion(
      'Enter your phone number (with country code, no + or spaces, e.g. 14155551234): ',
    );
  }

  console.log('Starting WhatsApp authentication...\n');

  await connectSocket(phoneNumber);
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
