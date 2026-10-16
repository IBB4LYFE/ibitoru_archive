import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createRoomService } from "../server.js";

function waitFor(socket, type, match = () => true, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const queuedIndex = socket.packets.findIndex((packet) => packet.type === type && match(packet));
    if (queuedIndex >= 0) return resolve(socket.packets.splice(queuedIndex, 1)[0]);
    const timer = setTimeout(() => { socket.off("message", onMessage); reject(new Error(`Timed out waiting for ${type}; received ${socket.packets.map((packet) => packet.type).join(", ")}`)); }, timeout);
    function onMessage(raw) {
      const packet = JSON.parse(raw.toString());
      if (packet.type !== type || !match(packet)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(packet);
    }
    socket.on("message", onMessage);
  });
}

async function connect(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  socket.packets = [];
  socket.on("message", (raw) => socket.packets.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return socket;
}

function sendFor(socket, packet, replyType) {
  const response = waitFor(socket, replyType);
  socket.send(JSON.stringify(packet));
  return response;
}

test("real participants share chat and server-enforced roles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "teens-renewed-"));
  const service = createRoomService({ port: 0, host: "127.0.0.1", dataFile: join(directory, "state.json"), adminUsername: "HouseAdmin", adminPassword: "a-long-admin-password" });
  await new Promise((resolve) => service.server.once("listening", resolve));
  const port = service.address().port;
  const sockets = [];
  try {
    const admin = await connect(port);
    sockets.push(admin);
    await sendFor(admin, { type: "auth:admin-login", username: "HouseAdmin", password: "a-long-admin-password" }, "auth:success");
    await waitFor(admin, "world:snapshot");

    const member = await connect(port);
    sockets.push(member);
    const registered = await sendFor(member, { type: "auth:signup", username: "River", password: "a-strong-member-password" }, "auth:success");
    assert.equal(registered.me.approved, false);
    assert.equal(service.getState().event.active, false);

    const memberAdminAttempt = await connect(port);
    sockets.push(memberAdminAttempt);
    const adminDenied = await sendFor(memberAdminAttempt, { type: "auth:admin-login", username: "River", password: "a-strong-member-password" }, "error");
    assert.match(adminDenied.message, /not an admin/i);

    const memberList = waitFor(admin, "admin:members");
    await memberList;
    const approved = waitFor(member, "account:status", (packet) => packet.me.approved);
    const adminPresence = waitFor(admin, "world:users", (packet) => packet.users.some((user) => user.username === "River"));
    admin.send(JSON.stringify({ type: "admin:grant", username: "River" }));
    assert.equal((await approved).me.approved, true);
    await adminPresence;
    await waitFor(member, "world:snapshot");

    const sharedMessage = waitFor(admin, "chat:message");
    member.send(JSON.stringify({ type: "chat:send", body: "We are both here." }));
    assert.equal((await sharedMessage).message.body, "We are both here.");
    assert.equal(service.getState().messages.lounge.length, 1);

    const rejectedEvent = sendFor(member, { type: "event:start" }, "error");
    assert.match((await rejectedEvent).message, /Only an admin/);
    assert.equal(service.getState().event.active, false);
    const started = waitFor(member, "event:state");
    admin.send(JSON.stringify({ type: "event:start" }));
    assert.equal((await started).event.active, true);

    const createdRoom = waitFor(member, "room:created");
    const roomListUpdate = waitFor(admin, "rooms:updated", (packet) => packet.rooms.some((room) => room.name === "River's Study"));
    member.send(JSON.stringify({ type: "room:create", name: "River's Study" }));
    const newRoom = await createdRoom;
    await roomListUpdate;
    const newRoomSnapshot = waitFor(member, "world:snapshot", (packet) => packet.roomId === newRoom.roomId);
    member.send(JSON.stringify({ type: "room:join", roomId: newRoom.roomId }));
    await newRoomSnapshot;
    assert.equal(service.getState().users[registered.me.id].lastRoomId, newRoom.roomId);

    const returningMember = await connect(port);
    sockets.push(returningMember);
    await sendFor(returningMember, { type: "auth:login", token: registered.token }, "auth:success");
    const restoredRoom = await waitFor(returningMember, "world:snapshot");
    assert.equal(restoredRoom.roomId, newRoom.roomId);
    assert.equal(restoredRoom.users.filter((user) => user.id === registered.me.id).length, 1);
    const voiceNote = await sendFor(returningMember, {
      type: "voice:note",
      audioData: "data:audio/webm;codecs=opus;base64,YQ==",
    }, "chat:message");
    assert.equal(voiceNote.message.kind, "voice");

    const moderator = await connect(port);
    sockets.push(moderator);
    await sendFor(moderator, { type: "auth:signup", username: "Sky", password: "a-strong-moderator-password" }, "auth:success");
    await waitFor(admin, "admin:members");
    const skyApproved = waitFor(moderator, "account:status");
    admin.send(JSON.stringify({ type: "admin:grant", username: "Sky" }));
    await skyApproved;
    const moderatorSnapshot = await waitFor(moderator, "world:snapshot");
    const moderatorAccount = service.getState().users[moderatorSnapshot.me.id];
    const adminAccount = Object.values(service.getState().users).find((user) => user.role === "admin");
    assert.notDeepEqual([moderatorAccount.x, moderatorAccount.z], [adminAccount.x, adminAccount.z]);
    await waitFor(admin, "admin:members");
    const roleUpdated = waitFor(moderator, "account:status", (packet) => packet.me.role === "moderator");
    admin.send(JSON.stringify({ type: "admin:role", username: "Sky", role: "moderator" }));
    assert.equal((await roleUpdated).me.role, "moderator");
    const targetUpdate = waitFor(member, "world:users", (packet) => packet.users.find((user) => user.username === "River")?.canSpeak === false);
    moderator.send(JSON.stringify({ type: "moderation:speaking", username: "River", canSpeak: false }));
    assert.equal((await targetUpdate).users.find((user) => user.username === "River").canSpeak, false);

    const moderatorRoom = waitFor(moderator, "world:snapshot", (packet) => packet.roomId === newRoom.roomId);
    moderator.send(JSON.stringify({ type: "room:join", roomId: newRoom.roomId }));
    await moderatorRoom;
    await new Promise((resolve) => setTimeout(resolve, 750));
    const riverSeesSky = waitFor(member, "chat:message", (packet) => packet.message.body === "Sky types at the same time.");
    const skySeesRiver = waitFor(moderator, "chat:message", (packet) => packet.message.body === "River types at the same time.");
    member.send(JSON.stringify({ type: "chat:send", body: "River types at the same time." }));
    moderator.send(JSON.stringify({ type: "chat:send", body: "Sky types at the same time." }));
    const [riverReceived, skyReceived] = await Promise.all([riverSeesSky, skySeesRiver]);
    assert.equal(riverReceived.message.username, "Sky");
    assert.equal(skyReceived.message.username, "River");

    await sendFor(admin, { type: "auth:logout" }, "auth:logged-out");
  } finally {
    sockets.forEach((socket) => socket.terminate());
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
