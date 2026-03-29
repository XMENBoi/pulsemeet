import "dotenv/config";

import { createServer } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import compression from "compression";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { Server } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  : [];

const maxMessageLength = Number.parseInt(process.env.MAX_MESSAGE_LENGTH ?? "320", 10);
const reportLogPath = process.env.REPORTS_LOG_PATH?.trim() || "";
const trustProxy = Number.parseInt(process.env.TRUST_PROXY ?? "0", 10);
const turnProvider = (process.env.TURN_PROVIDER || "").trim().toLowerCase();
const twilioTtlSeconds = Math.min(
  86_400,
  Math.max(300, Number.parseInt(process.env.TWILIO_TTL_SECONDS ?? "3600", 10))
);
const meteredRegion = (process.env.METERED_REGION || "").trim();

const defaultIceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];
let iceServers = defaultIceServers;

try {
  const parsedIceServers = JSON.parse(process.env.ICE_SERVERS ?? "[]");
  if (Array.isArray(parsedIceServers) && parsedIceServers.length > 0) {
    iceServers = parsedIceServers;
  }
} catch {
  iceServers = defaultIceServers;
}

function getResolvedTurnProvider() {
  if (turnProvider) {
    return turnProvider;
  }

  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    return "twilio";
  }

  if (process.env.METERED_APP_NAME && process.env.METERED_API_KEY) {
    return "metered";
  }

  return "static";
}

async function fetchTwilioIceServers() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();

  if (!accountSid || !authToken) {
    throw new Error("Twilio credentials are missing.");
  }

  const body = new URLSearchParams({
    Ttl: String(twilioTtlSeconds)
  });

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Tokens.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body,
    signal: AbortSignal.timeout(10_000)
  });

  if (!response.ok) {
    throw new Error(`Twilio token request failed with status ${response.status}.`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload.ice_servers) || payload.ice_servers.length === 0) {
    throw new Error("Twilio returned no ICE servers.");
  }

  return payload.ice_servers;
}

async function fetchMeteredIceServers() {
  const appName = process.env.METERED_APP_NAME?.trim();
  const apiKey = process.env.METERED_API_KEY?.trim();

  if (!appName || !apiKey) {
    throw new Error("Metered credentials are missing.");
  }

  const endpoint = new URL(`https://${appName}.metered.live/api/v1/turn/credentials`);
  endpoint.searchParams.set("apiKey", apiKey);
  if (meteredRegion) {
    endpoint.searchParams.set("region", meteredRegion);
  }

  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(10_000)
  });

  if (!response.ok) {
    throw new Error(`Metered credential request failed with status ${response.status}.`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("Metered returned no ICE servers.");
  }

  return payload;
}

async function resolveRtcConfig() {
  const provider = getResolvedTurnProvider();

  switch (provider) {
    case "twilio":
      return {
        provider,
        iceServers: await fetchTwilioIceServers()
      };
    case "metered":
      return {
        provider,
        iceServers: await fetchMeteredIceServers()
      };
    case "static":
    default:
      return {
        provider: "static",
        iceServers
      };
  }
}

if (trustProxy > 0) {
  app.set("trust proxy", trustProxy);
}

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  })
);
app.use(compression());
app.use(express.json({ limit: "32kb" }));
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: true,
    legacyHeaders: false
  })
);
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    app: process.env.APP_NAME || "PulseMeet",
    turnProvider: getResolvedTurnProvider(),
    online: sessions.size,
    waiting: waitingQueue.length,
    liveRooms: activeRooms.size
  });
});

app.get("/api/rtc-config", async (_request, response) => {
  response.set("Cache-Control", "no-store");

  try {
    const rtcConfig = await resolveRtcConfig();
    response.json(rtcConfig);
  } catch (error) {
    response.status(503).json({
      message: "TURN configuration is unavailable right now.",
      detail: error instanceof Error ? error.message : "Unknown TURN provider error."
    });
  }
});

const io = new Server(httpServer, {
  cors: {
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin not allowed by CORS"));
    },
    methods: ["GET", "POST"]
  }
});

const sessions = new Map();
const waitingQueue = [];
const activeRooms = new Map();

const PROFANITY = [
  /\bfuck\b/gi,
  /\bshit\b/gi,
  /\bbitch\b/gi,
  /\basshole\b/gi,
  /\bslut\b/gi,
  /\bnigg(?:a|er)\b/gi
];

function createSession(socket) {
  return {
    socket,
    joinedAt: Date.now(),
    roomId: null,
    partnerId: null,
    interests: [],
    rateWindows: new Map()
  };
}

function sanitizeText(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }

  return value.replace(/\s+/g, " ").trim();
}

function sanitizeInterests(rawInterests) {
  if (!Array.isArray(rawInterests)) {
    return [];
  }

  const normalized = rawInterests
    .map((item) => sanitizeText(item))
    .filter(Boolean)
    .map((item) => item.toLowerCase().slice(0, 24))
    .slice(0, 6);

  return [...new Set(normalized)].slice(0, 6);
}

function maskProfanity(message) {
  return PROFANITY.reduce((current, pattern) => current.replace(pattern, (match) => "*".repeat(match.length)), message);
}

function touchRateWindow(session, key, limit, windowMs) {
  const now = Date.now();
  const previous = session.rateWindows.get(key) ?? [];
  const active = previous.filter((timestamp) => now - timestamp < windowMs);
  active.push(now);
  session.rateWindows.set(key, active);
  return active.length <= limit;
}

function isSessionAvailable(session) {
  return Boolean(session && !session.roomId && session.socket.connected);
}

function removeFromQueue(socketId) {
  const index = waitingQueue.indexOf(socketId);
  if (index >= 0) {
    waitingQueue.splice(index, 1);
  }
}

function queueSession(session) {
  if (!session || !session.socket.connected || session.roomId) {
    return;
  }

  removeFromQueue(session.socket.id);
  waitingQueue.push(session.socket.id);
  session.socket.emit("queue:joined", {
    waitingCount: waitingQueue.length,
    interests: session.interests
  });
  broadcastQueueState();
  emitStats();
}

function broadcastQueueState() {
  waitingQueue.forEach((socketId, index) => {
    const session = sessions.get(socketId);
    if (!session || !session.socket.connected || session.roomId) {
      return;
    }

    session.socket.emit("queue:update", {
      position: index + 1,
      waitingCount: waitingQueue.length
    });
  });
}

function emitStats() {
  io.emit("stats:update", {
    online: sessions.size,
    waiting: waitingQueue.length,
    liveRooms: activeRooms.size
  });
}

function findBestPartnerIndex(baseSession) {
  let fallbackIndex = -1;
  let bestIndex = -1;
  let bestScore = -1;

  for (let index = 1; index < waitingQueue.length; index += 1) {
    const candidateId = waitingQueue[index];
    const candidate = sessions.get(candidateId);
    if (!isSessionAvailable(candidate)) {
      continue;
    }

    if (fallbackIndex === -1) {
      fallbackIndex = index;
    }

    const sharedInterests = candidate.interests.filter((interest) => baseSession.interests.includes(interest)).length;
    const waitBonus = Math.max(0, 20 - index);
    const score = sharedInterests * 100 + waitBonus;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex >= 0 ? bestIndex : fallbackIndex;
}

function pairSessions(firstSession, secondSession) {
  const roomId = crypto.randomUUID();

  removeFromQueue(firstSession.socket.id);
  removeFromQueue(secondSession.socket.id);

  firstSession.roomId = roomId;
  firstSession.partnerId = secondSession.socket.id;
  secondSession.roomId = roomId;
  secondSession.partnerId = firstSession.socket.id;

  activeRooms.set(roomId, {
    id: roomId,
    startedAt: Date.now(),
    participants: [firstSession.socket.id, secondSession.socket.id]
  });

  const sharedInterests = firstSession.interests.filter((interest) => secondSession.interests.includes(interest));
  const payload = {
    roomId,
    rtcConfig: {
      iceServers
    },
    sharedInterests
  };

  firstSession.socket.emit("match:found", {
    ...payload,
    role: "initiator"
  });

  secondSession.socket.emit("match:found", {
    ...payload,
    role: "receiver"
  });

  broadcastQueueState();
  emitStats();
}

function attemptMatchmaking() {
  while (waitingQueue.length >= 2) {
    const firstId = waitingQueue[0];
    const firstSession = sessions.get(firstId);

    if (!isSessionAvailable(firstSession)) {
      removeFromQueue(firstId);
      continue;
    }

    const partnerIndex = findBestPartnerIndex(firstSession);
    if (partnerIndex < 0) {
      break;
    }

    const secondId = waitingQueue[partnerIndex];
    const secondSession = sessions.get(secondId);
    if (!isSessionAvailable(secondSession)) {
      removeFromQueue(secondId);
      continue;
    }

    pairSessions(firstSession, secondSession);
  }
}

async function logReport(report) {
  if (!reportLogPath) {
    return;
  }

  const finalPath = path.join(__dirname, reportLogPath);
  const directory = path.dirname(finalPath);

  await fs.mkdir(directory, { recursive: true });
  await fs.appendFile(finalPath, `${JSON.stringify(report)}\n`, "utf8");
}

function teardownRoom(roomId) {
  if (!roomId) {
    return;
  }

  activeRooms.delete(roomId);
}

function clearSessionPairing(session) {
  if (!session) {
    return null;
  }

  const roomId = session.roomId;
  session.roomId = null;
  session.partnerId = null;
  return roomId;
}

function finishMatch(socket, options = {}) {
  const {
    requeueSelf = false,
    requeuePartner = false,
    reasonForSelf = "Session ended.",
    reasonForPartner = "Your partner left the chat."
  } = options;

  const session = sessions.get(socket.id);
  if (!session) {
    return;
  }

  removeFromQueue(socket.id);

  const partner = session.partnerId ? sessions.get(session.partnerId) : null;
  const ownRoomId = session.roomId;
  const partnerRoomId = partner?.roomId ?? null;

  clearSessionPairing(session);
  teardownRoom(ownRoomId);

  socket.emit("match:ended", {
    reason: reasonForSelf,
    requeued: requeueSelf
  });

  if (partner) {
    const partnerSocket = partner.socket;
    clearSessionPairing(partner);
    teardownRoom(partnerRoomId);
    partnerSocket.emit("match:ended", {
      reason: reasonForPartner,
      requeued: requeuePartner
    });
  }

  if (requeueSelf && session.socket.connected) {
    queueSession(session);
  }

  if (requeuePartner && partner?.socket.connected) {
    queueSession(partner);
  }

  attemptMatchmaking();
  broadcastQueueState();
  emitStats();
}

function relayToPartner(socket, eventName, payload) {
  const session = sessions.get(socket.id);
  if (!session?.partnerId) {
    return;
  }

  const partner = sessions.get(session.partnerId);
  if (!partner?.socket.connected) {
    return;
  }

  partner.socket.emit(eventName, payload);
}

io.on("connection", (socket) => {
  const session = createSession(socket);
  sessions.set(socket.id, session);
  socket.emit("session:ready", {
    socketId: socket.id,
    brand: process.env.APP_NAME || "PulseMeet"
  });
  emitStats();

  socket.on("queue:join", (payload = {}) => {
    const currentSession = sessions.get(socket.id);
    if (!currentSession) {
      return;
    }

    currentSession.interests = sanitizeInterests(payload.interests);
    removeFromQueue(socket.id);
    queueSession(currentSession);
    attemptMatchmaking();
  });

  socket.on("queue:leave", () => {
    removeFromQueue(socket.id);
    broadcastQueueState();
    emitStats();
  });

  socket.on("chat:send", (payload = {}) => {
    const currentSession = sessions.get(socket.id);
    if (!currentSession?.partnerId) {
      return;
    }

    if (!payload.roomId || payload.roomId !== currentSession.roomId) {
      return;
    }

    if (!touchRateWindow(currentSession, "chat", 10, 8_000)) {
      socket.emit("server:error", {
        message: "You are sending messages too quickly."
      });
      return;
    }

    const normalized = sanitizeText(payload.text);
    if (!normalized) {
      return;
    }

    const safeMessage = maskProfanity(normalized.slice(0, maxMessageLength));
    relayToPartner(socket, "chat:message", {
      roomId: currentSession.roomId,
      text: safeMessage,
      from: "partner",
      sentAt: Date.now()
    });
  });

  socket.on("session:report", async (payload = {}) => {
    const currentSession = sessions.get(socket.id);
    if (!currentSession?.partnerId) {
      return;
    }

    if (!payload.roomId || payload.roomId !== currentSession.roomId) {
      return;
    }

    if (!touchRateWindow(currentSession, "report", 3, 60_000)) {
      socket.emit("server:error", {
        message: "Report limit reached for now."
      });
      return;
    }

    const report = {
      id: crypto.randomUUID(),
      reportedAt: new Date().toISOString(),
      reporterSocketId: socket.id,
      reportedSocketId: currentSession.partnerId,
      roomId: currentSession.roomId,
      reason: sanitizeText(payload.reason, "No reason provided."),
      ip: socket.handshake.address
    };

    try {
      await logReport(report);
      socket.emit("report:logged", {
        message: "Report received. Thanks for helping keep the community safer."
      });
    } catch {
      socket.emit("server:error", {
        message: "Report logging failed on the server."
      });
    }
  });

  socket.on("webrtc:signal", (payload = {}) => {
    const currentSession = sessions.get(socket.id);
    if (!currentSession?.partnerId) {
      return;
    }

    if (!payload.roomId || payload.roomId !== currentSession.roomId) {
      return;
    }

    if (!touchRateWindow(currentSession, "signal", 120, 10_000)) {
      socket.emit("server:error", {
        message: "Connection signaling is happening too quickly."
      });
      return;
    }

    if (!["offer", "answer", "ice-candidate"].includes(payload.type)) {
      return;
    }

    relayToPartner(socket, "webrtc:signal", {
      ...payload,
      from: socket.id
    });
  });

  socket.on("session:next", () => {
    finishMatch(socket, {
      requeueSelf: true,
      requeuePartner: true,
      reasonForSelf: "Finding someone new...",
      reasonForPartner: "Your partner skipped. Finding someone new..."
    });
  });

  socket.on("session:leave", () => {
    finishMatch(socket, {
      requeueSelf: false,
      requeuePartner: true,
      reasonForSelf: "You left the conversation.",
      reasonForPartner: "Your partner left. Finding someone new..."
    });
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);

    finishMatch(socket, {
      requeueSelf: false,
      requeuePartner: true,
      reasonForSelf: "Disconnected.",
      reasonForPartner: "Your partner disconnected. Finding someone new..."
    });

    sessions.delete(socket.id);
    broadcastQueueState();
    emitStats();
  });
});

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST || "0.0.0.0";

httpServer.listen(port, host, () => {
  console.log(`${process.env.APP_NAME || "PulseMeet"} running on http://${host}:${port}`);
});
