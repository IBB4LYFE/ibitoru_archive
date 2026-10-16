import { createServer } from "node:http";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const root = fileURLToPath(new URL(".", import.meta.url));
const dataPath = process.env.TEENS_RENEWED_DATA || join(root, "data", "teens-renewed.json");
const roomsSeed = [
  { id: "lounge", name: "The Lounge", kind: "lounge", ownerId: null },
  { id: "debate-hall", name: "Debate Hall", kind: "debate", ownerId: null },
  { id: "voice-room", name: "Voice Room", kind: "voice", ownerId: null }
];
const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
const maxMessageLength = 800;

function cleanName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 24) : "";
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function passwordMatches(password, salt, expected) {
  const actual = scryptSync(password, salt, 64);
  const saved = Buffer.from(expected, "hex");
  return saved.length === actual.length && timingSafeEqual(actual, saved);
}

function makePassword(password) {
  const salt = randomBytes(16).toString("hex");
  return { salt, passwordHash: scryptSync(password, salt, 64).toString("hex") };
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    approved: user.approved,
    muted: user.muted,
    canSpeak: user.canSpeak,
    avatarColor: user.avatarColor,
    avatarStyle: user.avatarStyle
  };
}

export function createRoomService({ port = Number(process.env.PORT || 4173), host = process.env.HOST || "0.0.0.0", dataFile = dataPath, adminUsername = process.env.TEENS_RENEWED_ADMIN, adminPassword = process.env.TEENS_RENEWED_ADMIN_PASSWORD } = {}) {
  mkdirSync(join(dataFile, ".."), { recursive: true });
  let state;
  if (existsSync(dataFile)) {
    state = JSON.parse(readFileSync(dataFile, "utf8"));
  } else {
    state = { users: {}, rooms: roomsSeed, messages: {}, event: { active: false, startedAt: null, startedBy: null } };
  }
  state.rooms ||= roomsSeed;
  state.users ||= {};
  state.messages ||= {};
  state.event ||= { active: false, startedAt: null, startedBy: null };
  const sockets = new Map();
  const lastAction = new WeakMap();
  const lastMoved = new WeakMap();

  if (adminUsername || adminPassword) {
    const username = cleanName(adminUsername);
    if (!username || typeof adminPassword !== "string" || adminPassword.length < 12) {
      throw new Error("Set both TEENS_RENEWED_ADMIN and TEENS_RENEWED_ADMIN_PASSWORD; the password must be at least 12 characters.");
    }
    const existing = Object.values(state.users).find((user) => user.username.toLowerCase() === username.toLowerCase());
    if (existing) {
      existing.role = "admin";
      existing.approved = true;
    } else {
      const credentials = makePassword(adminPassword);
      const user = {
        id: randomBytes(12).toString("hex"), username, ...credentials,
        role: "admin", approved: true, muted: false, canSpeak: true,
        avatarColor: "#f07857", avatarStyle: "sun", lastRoomId: "lounge", sessionHash: null, x: 0, z: 1
      };
      state.users[user.id] = user;
    }
  }

  function save() {
    const tempPath = `${dataFile}.tmp`;
    writeFileSync(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tempPath, dataFile);
  }

  function send(socket, type, payload = {}) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...payload }));
  }

  function roomMembers(roomId) {
    const members = new Map();
    for (const [socket, connection] of sockets) {
      const user = connection.user;
      if (user?.lastRoomId !== roomId || !user.approved) continue;
      const previous = members.get(user.id);
      members.set(user.id, {
        user: publicUser(user), x: user.x || 0, z: user.z || 0,
        voice: Boolean(connection.voice || previous?.voice), socket
      });
    }
    return [...members.values()];
  }

  function spawnPosition(roomId, excludeUserId) {
    const occupied = roomMembers(roomId)
      .filter((member) => member.user.id !== excludeUserId)
      .map((member) => [member.x, member.z]);
    const room = state.rooms.find((item) => item.id === roomId);
    const options = room?.kind === "debate"
      ? [[-8, 6], [8, 6], [-8, 8], [8, 8], [-6, 8], [6, 8], [0, 8]]
      : room?.kind === "voice"
        ? [[-7, 0], [7, 0], [0, 7], [-7, 6], [7, 6], [0, -7], [8, 4]]
        : [[-6, 1], [6, 3], [0, 5], [-7, -4], [7, 5], [4, 6], [-4, 6], [0, 8]];
    return options.find(([x, z]) => occupied.every(([otherX, otherZ]) => Math.hypot(x - otherX, z - otherZ) > 1.5)) || [0, 8];
  }

  function snapshot(socket) {
    const connection = sockets.get(socket);
    if (!connection?.user) return;
    const user = connection.user;
    const roomId = user.lastRoomId;
    send(socket, "world:snapshot", {
      me: publicUser(user), roomId, rooms: state.rooms,
      users: roomMembers(roomId).map(({ user: member, x, z, voice }) => ({ ...member, x, z, voice })),
      messages: (state.messages[roomId] || []).slice(-100), event: state.event,
      members: user.role === "admin" ? Object.values(state.users).map(publicUser) : undefined
    });
  }

  function broadcastRoom(roomId, type, payload, except) {
    for (const [socket, connection] of sockets) {
      if (socket !== except && connection.user?.approved && connection.user.lastRoomId === roomId) send(socket, type, payload);
    }
  }

  function broadcastUsers(roomId) {
    broadcastRoom(roomId, "world:users", { users: roomMembers(roomId).map(({ user, x, z, voice }) => ({ ...user, x, z, voice })) });
  }

  function broadcastMembers() {
    const members = Object.values(state.users).map(publicUser);
    for (const [socket, connection] of sockets) {
      if (connection.user?.role === "admin") send(socket, "admin:members", { members });
      else if (connection.user) send(socket, "account:status", { me: publicUser(connection.user) });
    }
  }

  function fail(socket, message) {
    send(socket, "error", { message });
  }

  function handleAuth(socket, packet) {
    const username = cleanName(packet.username);
    if (packet.type === "auth:signup") {
      if (username.length < 2 || !/^[\p{L}\p{N}_ .-]+$/u.test(username)) return fail(socket, "Use 2–24 letters, numbers, spaces, dots, underscores or hyphens.");
      if (typeof packet.password !== "string" || packet.password.length < 10 || packet.password.length > 128) return fail(socket, "Choose a password between 10 and 128 characters.");
      if (Object.values(state.users).some((user) => user.username.toLowerCase() === username.toLowerCase())) return fail(socket, "That username is already registered.");
      const credentials = makePassword(packet.password);
      const token = randomBytes(32).toString("base64url");
      const user = {
        id: randomBytes(12).toString("hex"), username, ...credentials,
        role: "member", approved: false, muted: false, canSpeak: true,
        avatarColor: /^#[\da-f]{6}$/i.test(packet.avatarColor) ? packet.avatarColor : "#f07857",
        avatarStyle: ["sun", "leaf", "wave"].includes(packet.avatarStyle) ? packet.avatarStyle : "sun",
        lastRoomId: "lounge", sessionHash: hash(token), x: 0, z: 1
      };
      state.users[user.id] = user;
      save();
      sockets.set(socket, { user, voice: false });
      send(socket, "auth:success", { token, me: publicUser(user) });
      broadcastMembers();
      return;
    }

    let user;
    if (typeof packet.token === "string") {
      const tokenHash = hash(packet.token);
      user = Object.values(state.users).find((candidate) => candidate.sessionHash && candidate.sessionHash === tokenHash);
    } else {
      user = Object.values(state.users).find((candidate) => candidate.username.toLowerCase() === username.toLowerCase());
      if (user && typeof packet.password === "string" && !passwordMatches(packet.password, user.salt, user.passwordHash)) user = null;
    }
    if (!user) return fail(socket, "Username or password is incorrect.");
    if (packet.type === "auth:admin-login" && user.role !== "admin") {
      return fail(socket, "That account is not an admin. Use participant sign-in instead.");
    }
    const token = typeof packet.token === "string" ? packet.token : randomBytes(32).toString("base64url");
    if (!packet.token) {
      user.sessionHash = hash(token);
      save();
    }
    sockets.set(socket, { user, voice: false });
    send(socket, "auth:success", { token, me: publicUser(user) });
    if (user.approved) snapshot(socket);
  }

  function handle(socket, packet) {
    if (!packet || typeof packet !== "object" || Array.isArray(packet) || typeof packet.type !== "string") return;
    const connection = sockets.get(socket);
    if (!connection?.user) return handleAuth(socket, packet);
    const user = connection.user;
    if (!user.approved) {
      if (packet.type === "auth:logout") send(socket, "auth:logged-out");
      return fail(socket, "Your account is waiting for an admin to approve access.");
    }
    const now = Date.now();
    const previous = lastAction.get(socket) || 0;
    if (["chat:send", "voice:note"].includes(packet.type) && now - previous < 700) return fail(socket, "Slow down a moment before sending another message.");
    if (["chat:send", "voice:note", "room:create", "voice:join", "voice:leave"].includes(packet.type)) lastAction.set(socket, now);

    if (packet.type === "room:join") {
      const room = state.rooms.find((item) => item.id === packet.roomId);
      if (!room) return fail(socket, "That room no longer exists.");
      const previousRoom = user.lastRoomId;
      connection.voice = false;
      user.lastRoomId = room.id;
      user.x = 0;
      user.z = 1;
        [user.x, user.z] = spawnPosition(room.id, user.id);
      save();
      send(socket, "world:snapshot", {
        me: publicUser(user), roomId: room.id, rooms: state.rooms,
        users: roomMembers(room.id).map(({ user: member, x, z, voice }) => ({ ...member, x, z, voice })),
        messages: (state.messages[room.id] || []).slice(-100), event: state.event,
        members: user.role === "admin" ? Object.values(state.users).map(publicUser) : undefined
      });
      broadcastUsers(previousRoom);
      broadcastUsers(room.id);
      return;
    }

    if (packet.type === "chat:send" || packet.type === "voice:note") {
      if (packet.type === "voice:note" && (user.muted || !user.canSpeak)) return fail(socket, "You do not have permission to send voice notes.");
      const body = typeof packet.body === "string" ? packet.body.trim().slice(0, maxMessageLength) : "";
      const audioData = typeof packet.audioData === "string" ? packet.audioData : "";
      if (packet.type === "chat:send" && !body) return;
      if (packet.type === "voice:note" && (!/^data:audio\/(webm|ogg|mp4)(?:;codecs=[a-z0-9.,-]+)?;base64,[A-Za-z0-9+/]+=*$/i.test(audioData) || audioData.length > 35000 || Buffer.from(audioData.split(",")[1], "base64").length > 26000)) return fail(socket, "Voice notes must be WebM, Ogg, or MP4 audio under 8 seconds.");
      const message = {
        id: randomBytes(10).toString("hex"), userId: user.id, username: user.username,
        body: packet.type === "voice:note" ? "Voice note" : body, createdAt: new Date().toISOString(),
        ...(packet.type === "voice:note" ? { kind: "voice", audioData } : {})
      };
      const history = state.messages[user.lastRoomId] ||= [];
      history.push(message);
      if (history.length > 100) history.splice(0, history.length - 100);
      save();
      broadcastRoom(user.lastRoomId, "chat:message", { message });
      return;
    }

    if (packet.type === "profile:update") {
      if (/^#[\da-f]{6}$/i.test(packet.avatarColor)) user.avatarColor = packet.avatarColor;
      if (["sun", "leaf", "wave"].includes(packet.avatarStyle)) user.avatarStyle = packet.avatarStyle;
      save();
      broadcastMembers();
      broadcastUsers(user.lastRoomId);
      return;
    }

    if (packet.type === "player:move") {
      const x = Number(packet.x);
      const z = Number(packet.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      const elapsed = Math.max(0, now - (lastMoved.get(socket) || now));
      const distance = Math.hypot(x - (user.x || 0), z - (user.z || 0));
      if (distance > Math.max(0.55, elapsed * 0.006 + 0.16)) return fail(socket, "Movement update was too fast.");
      user.x = Math.max(-9, Math.min(9, x));
      user.z = Math.max(-9, Math.min(9, z));
      lastMoved.set(socket, now);
      broadcastRoom(user.lastRoomId, "player:moved", { userId: user.id, x: user.x, z: user.z }, socket);
      return;
    }

    if (packet.type === "event:start" || packet.type === "event:stop") {
      if (user.role !== "admin") return fail(socket, "Only an admin can manage the official event.");
      state.event = packet.type === "event:start"
        ? { active: true, startedAt: new Date().toISOString(), startedBy: user.username }
        : { active: false, startedAt: null, startedBy: null };
      save();
      for (const [target] of sockets) if (sockets.get(target)?.user?.approved) send(target, "event:state", { event: state.event });
      return;
    }

    if (packet.type === "admin:grant" || packet.type === "admin:revoke" || packet.type === "admin:role") {
      if (user.role !== "admin") return fail(socket, "Only an admin can manage participants and roles.");
      const target = Object.values(state.users).find((candidate) => candidate.username.toLowerCase() === cleanName(packet.username).toLowerCase());
      if (!target) return fail(socket, "No registered account has that username.");
      if (packet.type === "admin:grant") target.approved = true;
            if (packet.type === "admin:grant") {
              target.approved = true;
              [target.x, target.z] = spawnPosition(target.lastRoomId, target.id);
            }
      if (packet.type === "admin:revoke") {
        if (target.role === "admin") return fail(socket, "Admin accounts cannot be removed as participants.");
        target.approved = false;
        for (const [targetSocket, targetConnection] of sockets) {
          if (targetConnection.user?.id === target.id) {
            send(targetSocket, "account:revoked", {});
            targetSocket.close(4003, "Access removed by an admin");
          }
        }
        broadcastUsers(target.lastRoomId);
      }
      if (packet.type === "admin:role") {
        if (!target.approved || !["member", "moderator"].includes(packet.role) || target.role === "admin") return fail(socket, "That role change is not allowed.");
        target.role = packet.role;
      }
      save();
      broadcastMembers();
      if (packet.type === "admin:grant") {
        for (const [targetSocket, targetConnection] of sockets) if (targetConnection.user?.id === target.id) {
          send(targetSocket, "account:status", { me: publicUser(target) });
          snapshot(targetSocket);
        }
        broadcastUsers(target.lastRoomId);
      }
      return;
    }

    if (packet.type === "moderation:mute" || packet.type === "moderation:speaking") {
      if (!["admin", "moderator"].includes(user.role)) return fail(socket, "Moderator permission required.");
      const target = Object.values(state.users).find((candidate) => candidate.username.toLowerCase() === cleanName(packet.username).toLowerCase());
      if (!target || !target.approved || target.role === "admin" || target.id === user.id) return fail(socket, "That participant cannot be moderated by this account.");
      if (packet.type === "moderation:mute") target.muted = Boolean(packet.muted);
      if (packet.type === "moderation:speaking") target.canSpeak = Boolean(packet.canSpeak);
      if (target.muted || !target.canSpeak) {
        for (const [targetSocket, targetConnection] of sockets) {
          if (targetConnection.user?.id === target.id && targetConnection.voice) {
            targetConnection.voice = false;
            send(targetSocket, "voice:forced-leave", {});
          }
        }
      }
      save();
      broadcastMembers();
      broadcastUsers(user.lastRoomId);
      if (target.lastRoomId !== user.lastRoomId) broadcastUsers(target.lastRoomId);
      return;
    }

    if (packet.type === "room:create") {
      const name = cleanName(packet.name);
      if (name.length < 3 || state.rooms.length >= 24) return fail(socket, "Room names need 3–24 characters; the world can hold 24 rooms.");
      if (state.rooms.some((room) => room.name.toLowerCase() === name.toLowerCase())) return fail(socket, "A room already uses that name.");
      const room = { id: `space-${randomBytes(7).toString("hex")}`, name, kind: "discussion", ownerId: user.id };
      state.rooms.push(room);
      save();
      for (const [target, targetConnection] of sockets) if (targetConnection.user?.approved) send(target, "rooms:updated", { rooms: state.rooms });
      send(socket, "room:created", { roomId: room.id });
      return;
    }

    if (packet.type === "voice:join" || packet.type === "voice:leave") {
      if (packet.type === "voice:join" && (user.muted || !user.canSpeak)) return fail(socket, user.muted ? "Your microphone is muted by a moderator." : "A moderator has paused your speaking permission.");
      connection.voice = packet.type === "voice:join";
      send(socket, "voice:state", { joined: connection.voice });
      broadcastUsers(user.lastRoomId);
      return;
    }

    if (packet.type === "voice:signal") {
      if (!connection.voice || user.muted || !user.canSpeak) return fail(socket, "Join voice and have speaking permission before sending voice signals.");
      const targetSocket = [...sockets].find(([, targetConnection]) => targetConnection.user?.id === packet.targetUserId && targetConnection.user.lastRoomId === user.lastRoomId && targetConnection.voice)?.[0];
      if (!targetSocket || !packet.description && !packet.candidate) return;
      send(targetSocket, "voice:signal", { fromUserId: user.id, description: packet.description, candidate: packet.candidate });
      return;
    }

    if (packet.type === "auth:logout") {
      user.sessionHash = null;
      save();
      send(socket, "auth:logged-out");
      socket.close(1000, "Logged out");
    }
  }

  const server = createServer((request, response) => {
    const pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
    if (pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok", service: "teens-renewed" }));
      return;
    }
    const routeMap = {
      "/": "index2.html", "/index2.html": "index2.html", "/room.css": "room.css", "/room.js": "room.js", "/guide.html": "guide.html",
      "/vendor/three.module.js": "node_modules/three/build/three.module.js",
      "/vendor/three.core.js": "node_modules/three/build/three.core.js"
    };
    const relative = routeMap[pathname];
    if (!relative) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const filePath = normalize(join(root, relative));
    try {
      const content = readFileSync(filePath);
      response.writeHead(200, {
        "content-type": mimeTypes[extname(filePath)] || "application/javascript; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ws: wss:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
      });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 48 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== request.headers.host) return socket.destroy();
      } catch { return socket.destroy(); }
    }
    if (new URL(request.url, "http://localhost").pathname !== "/ws") return socket.destroy();
    webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit("connection", client, request));
  });
  webSockets.on("connection", (socket) => {
    sockets.set(socket, { user: null, voice: false });
    socket.on("message", (raw) => {
      try { handle(socket, JSON.parse(raw.toString())); }
      catch { fail(socket, "That message could not be processed."); }
    });
    socket.on("close", () => {
      const connection = sockets.get(socket);
      sockets.delete(socket);
      if (connection?.user?.approved) broadcastUsers(connection.user.lastRoomId);
    });
  });
  server.listen(port, host);
  server.on("error", (error) => console.error("TEENS RENEWED server error:", error.message));
  const address = () => server.address();
  const close = () => new Promise((resolve) => {
    for (const socket of webSockets.clients) socket.close();
    webSockets.close(() => server.close(() => resolve()));
  });
  return { server, address, close, getState: () => state };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const service = createRoomService();
  service.server.on("listening", () => {
    const address = service.address();
    console.log(`TEENS RENEWED is listening at http://localhost:${address.port}`);
    if (!process.env.TEENS_RENEWED_ADMIN || !process.env.TEENS_RENEWED_ADMIN_PASSWORD) console.warn("No admin configured. Set TEENS_RENEWED_ADMIN and TEENS_RENEWED_ADMIN_PASSWORD before starting the server.");
  });
}
