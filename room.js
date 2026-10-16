import * as THREE from "/vendor/three.module.js";
const $ = (s) => document.querySelector(s);
const ui = Object.fromEntries(
  [
    "auth-screen",
    "waiting-screen",
    "room-layout",
    "auth-form",
    "auth-message",
    "auth-submit",
    "username",
    "password",
    "room-list",
    "room-title",
    "room-kicker",
    "chat-title",
    "room-subtitle",
    "room-description",
    "room-count",
    "people-count",
    "account-name",
    "account-role",
    "account-avatar",
    "event-label",
    "event-card-title",
    "event-card-copy",
    "event-button",
    "chat-stream",
    "chat-form",
    "chat-input",
    "members-strip",
    "record-button",
    "voice-button",
    "world-canvas",
    "world-wrap",
    "world-toast",
    "position-display",
    "admin-panel",
    "admin-content",
    "moderator-tools",
    "profile-dialog",
    "profile-color",
    "profile-style",
    "signup-avatar",
    "network-dot",
    "network-label",
    "event-pip",
  ].map((id) => [
    id.replaceAll("-", "_"),
    id === "event-pip" ? $(".event-pip") : $(`#${id}`),
  ]),
);
const state = {
  mode: "login",
  token: localStorage.getItem("teens-renewed-token"),
  me: null,
  roomId: "lounge",
  rooms: [],
  users: [],
  messages: [],
  event: { active: false },
  members: [],
  peers: new Map(),
  voice: false,
  stream: null,
  tab: "participants",
  reconnect: true,
  recording: false,
};
let socket,
  renderer,
  scene,
  camera,
  world,
  raf,
  lastFrame = 0,
  lastMove = 0,
  minimap = false;
const avatars = new Map(),
  targets = new Map(),
  keys = new Set();
const cameraTarget = new THREE.Vector3();
const cameraLook = new THREE.Vector3();
const cameraOffset = new THREE.Vector3(3, 10, 13);
function send(type, data = {}) {
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ type, ...data }));
}
function connect() {
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
  );
  ui.network_dot.classList.remove("is-online");
  ui.network_label.textContent = "Connecting";
  socket.onopen = () => {
    ui.network_dot.classList.add("is-online");
    ui.network_label.textContent = "Connected";
    if (state.token) send("auth:login", { token: state.token });
  };
  socket.onmessage = ({ data }) => {
    try {
      receive(JSON.parse(data));
    } catch {
      toast("Unable to read a room update.");
    }
  };
  socket.onerror = () => {
    ui.network_dot.classList.remove("is-online");
    ui.network_label.textContent = "Offline";
  };
  socket.onclose = (event) => {
    ui.network_dot.classList.remove("is-online");
    ui.network_label.textContent = "Offline";
    leaveVoice(false);
    if (event.code === 4003) {
      state.token = null;
      state.me = null;
      localStorage.removeItem("teens-renewed-token");
      showAuth("An admin removed your access.");
    }
    if (state.reconnect) setTimeout(connect, 1500);
  };
}
function receive(p) {
  try {
    switch (p.type) {
      case "auth:success":
        state.me = p.me;
        state.token = p.token || state.token;
        if (state.token)
          localStorage.setItem("teens-renewed-token", state.token);
        account();
        if (!state.me.approved) waiting();
        break;
      case "auth:logged-out":
        showAuth();
        break;
      case "error":
        if (ui.room_layout.hidden) ui.auth_message.textContent = p.message;
        else toast(p.message);
        break;
      case "world:snapshot":
        state.me = p.me;
        state.roomId = p.roomId;
        state.rooms = p.rooms || [];
        state.users = p.users || [];
        state.messages = p.messages || [];
        state.event = p.event || { active: false };
        if (p.members) state.members = p.members;
        showWorld();
        render();
        chat();
        break;
      case "world:users":
        state.users = p.users || [];
        users();
        members();
        rooms();
        moderation();
        syncPeers();
        break;
      case "player:moved":
        if (targets.has(p.userId))
          Object.assign(targets.get(p.userId), { x: p.x, z: p.z });
        break;
      case "chat:message":
        state.messages.push(p.message);
        if (state.messages.length > 100) state.messages.shift();
        appendMessage(p.message);
        break;
      case "rooms:updated":
        state.rooms = p.rooms || [];
        rooms();
        break;
      case "room:created":
        send("room:join", { roomId: p.roomId });
        break;
      case "event:state":
        state.event = p.event;
        event();
        break;
      case "admin:members":
        state.members = p.members || [];
        adminRender();
        break;
      case "account:status": {
        state.me = p.me;
        account();
        if (state.me.muted || !state.me.canSpeak) leaveVoice();
        moderation();
        break;
      }
      case "account:revoked":
        showAuth("An admin removed your access.");
        break;
      case "voice:state":
        state.voice = !!p.joined;
        voiceButton();
        break;
      case "voice:forced-leave":
        leaveVoice(false);
        toast("A moderator paused your microphone.");
        break;
      case "voice:signal":
        signal(p);
        break;
    }
  } catch (error) {
    console.error("TEENS RENEWED update failed:", error);
    toast(`Room update failed: ${error.message}`);
  }
}
function showAuth(message = "") {
  ui.auth_screen.hidden = false;
  ui.waiting_screen.hidden = true;
  ui.room_layout.hidden = true;
  ui.auth_message.textContent = message;
  ui.password.value = "";
  mode("login");
}
function waiting() {
  ui.auth_screen.hidden = true;
  ui.waiting_screen.hidden = false;
  ui.room_layout.hidden = true;
}
function showWorld() {
  ui.auth_screen.hidden = true;
  ui.waiting_screen.hidden = true;
  ui.room_layout.hidden = false;
  if (!raf) startWorld();
}
function mode(name) {
  state.mode = name;
  document
    .querySelectorAll("[data-mode]")
    .forEach((b) => b.classList.toggle("is-active", b.dataset.mode === name || (name === "admin" && b.dataset.mode === "login")));
  ui.signup_avatar.hidden = name !== "signup";
  ui.password.autocomplete =
    name === "signup" ? "new-password" : "current-password";
  $("#welcome-title").innerHTML = name === "admin" ? "Admin<br>sign in." : name === "signup" ? "Join the<br>room." : "Pull up<br>a chair.";
  $(".auth-intro").textContent = name === "admin"
    ? "Use the administrator username and password configured for this server."
    : name === "signup"
      ? "Create your participant account. An admin will approve it before you enter."
      : "A shared room for people who want to think out loud, listen closely, and meet each other halfway.";
  $("#admin-entry").innerHTML = name === "admin"
    ? "Not an admin? <span>Participant sign-in ↗</span>"
    : "Are you an admin? <span>Admin sign-in ↗</span>";
  $(".auth-footnote").textContent = name === "signup"
    ? "Your account will wait for admin approval after you sign up."
    : name === "admin"
      ? "Admin access is limited to the account configured by the server owner."
      : "New participant accounts wait for admin approval.";
  ui.auth_submit.innerHTML = name === "signup"
    ? 'Request access <span aria-hidden="true">↗</span>'
    : name === "admin"
      ? 'Enter admin tools <span aria-hidden="true">↗</span>'
      : 'Enter the room <span aria-hidden="true">↗</span>';
  ui.auth_message.textContent = "";
}
function account() {
  if (!state.me) return;
  ui.account_name.textContent = state.me.username;
  ui.account_role.textContent = state.me.role.toUpperCase();
  ui.account_avatar.textContent = state.me.username[0].toUpperCase();
  ui.account_avatar.style.background = state.me.avatarColor;
  ui.profile_color.value = state.me.avatarColor;
  ui.profile_style.value = state.me.avatarStyle;
  ui.event_button.hidden = state.me.role !== "admin";
  $("#manage-button").hidden = state.me.role !== "admin";
  ui.record_button.hidden =
    !window.MediaRecorder || state.me.muted || !state.me.canSpeak;
  moderation();
}
function render() {
  rooms();
  event();
  users();
  members();
  account();
}
function rooms() {
  const icons = { lounge: "◒", debate: "◇", voice: "◖", discussion: "○" };
  ui.room_list.replaceChildren();
  state.rooms.forEach((r, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `room-link${r.id === state.roomId ? " is-active" : ""}`;
    b.title = r.name;
    b.setAttribute("aria-current", r.id === state.roomId ? "page" : "false");
    const symbol = document.createElement("span");
    symbol.className = "room-symbol";
    symbol.textContent = icons[r.kind] || "○";
    const name = document.createElement("span");
    name.className = "room-name";
    name.textContent = r.name;
    b.append(symbol, name);
    b.onclick = () => {
      if (r.id !== state.roomId) send("room:join", { roomId: r.id });
    };
    ui.room_list.append(b);
    if (r.id === state.roomId)
      ui.room_count.textContent = `${String(i + 1).padStart(2, "0")} / ${String(state.rooms.length).padStart(2, "0")}`;
  });
  const r = state.rooms.find((x) => x.id === state.roomId);
  if (!r) return;
  ui.room_title.textContent = ui.chat_title.textContent = r.name;
  ui.room_kicker.textContent = `ROOM / ${r.name.toUpperCase()}`;
  const copy =
    r.kind === "debate"
      ? [
          "Bring a position. Leave room for another.",
          "An open floor for unscripted live debate.",
        ]
      : r.kind === "voice"
        ? [
            "A quieter corner for voices, not echoes.",
            "Join live voice chat with people in this room.",
          ]
        : r.kind === "discussion"
          ? [
              "A space shaped by the people in it.",
              "A community-created room for open discussion.",
            ]
          : [
              "A good place to begin.",
              "A shared lounge for open conversation.",
            ];
  ui.room_subtitle.textContent = copy[0];
  ui.room_description.textContent = copy[1];
  if (scene) buildRoom();
}
function event() {
  const active = !!state.event.active;
  ui.event_label.textContent = `OFFICIAL EVENT · ${active ? "LIVE" : "INACTIVE"}`;
  document.querySelector(".status-lamp").classList.toggle("is-active", active);
  ui.event_pip.classList.toggle("is-active", active);
  ui.event_card_title.textContent = active
    ? "The room is in session."
    : "The floor is yours.";
  ui.event_card_copy.textContent = active
    ? `Started by ${state.event.startedBy || "an admin"}. The conversation is live.`
    : "The official event has not started yet.";
  ui.event_button.textContent = active
    ? "End the official event ↗"
    : "Start the official event ↗";
}
function users() {
  if (!scene || !state.me) return;
  const here = new Set();
  for (const user of state.users) {
    here.add(user.id);
    let a = avatars.get(user.id);
    if (!a) {
      a = avatar(user);
      avatars.set(user.id, a);
      world.add(a.group);
    }
    if (a.color !== user.avatarColor) {
      const color = new THREE.Color(user.avatarColor);
      a.body.material.color.copy(color);
      a.base.material.color.copy(color).multiplyScalar(0.6);
      a.arms.forEach((arm) => arm.children[0].material.color.copy(color).multiplyScalar(0.8));
      a.group.remove(a.accessory);
      a.accessory.traverse((part) => {
        if (part.isMesh) { part.geometry.dispose(); part.material.dispose(); }
      });
      a.accessory = avatarAccessory(user.avatarStyle, user.avatarColor);
      a.group.add(a.accessory);
      a.color = user.avatarColor;
    }
    if (a.style !== user.avatarStyle) {
      a.hair.material.color.set(
        user.avatarStyle === "leaf"
          ? "#43a875"
          : user.avatarStyle === "wave"
            ? "#4862bc"
            : "#432e3a",
      );
      a.group.remove(a.accessory);
      a.accessory.traverse((part) => {
        if (part.isMesh) { part.geometry.dispose(); part.material.dispose(); }
      });
      a.accessory = avatarAccessory(user.avatarStyle, user.avatarColor);
      a.group.add(a.accessory);
      a.style = user.avatarStyle;
    }
    a.group.userData.self = user.id === state.me.id;
    let t = targets.get(user.id) || { x: user.x || 0, z: user.z || 0 };
    if (a.group.userData.self)
      a.group.position.set(user.x || 0, 0, user.z || 0);
    else {
      t.x = user.x || 0;
      t.z = user.z || 0;
    }
    targets.set(user.id, t);
  }
  for (const [id, a] of avatars) {
    if (here.has(id)) continue;
    world.remove(a.group);
    a.group.traverse((o) => {
      if (o.isMesh || o.isSprite) {
        o.geometry?.dispose();
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
    avatars.delete(id);
    targets.delete(id);
  }
  ui.people_count.textContent = state.users.length;
  const me = state.users.find((u) => u.id === state.me.id);
  if (me)
    ui.position_display.textContent = `${String(Math.round(me.x || 0)).padStart(2, "0")} · ${String(Math.round(me.z || 0)).padStart(2, "0")}`;
  voiceButton();
}
function members() {
  ui.members_strip.replaceChildren();
  state.users.slice(0, 9).forEach((u) => {
    const c = document.createElement("span");
    c.className = "member-chip";
    const dot = document.createElement("i");
    dot.className = "member-dot";
    dot.style.background = u.avatarColor;
    const n = document.createElement("span");
    n.textContent = `${u.username}${u.voice ? " · voice" : ""}${u.muted ? " · muted" : ""}`;
    c.append(dot, n);
    ui.members_strip.append(c);
  });
}
function chat() {
  ui.chat_stream.replaceChildren();
  if (!state.messages.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.innerHTML =
      '<span aria-hidden="true">“</span><p>No messages yet.<br>Start the conversation.</p>';
    ui.chat_stream.append(empty);
  } else state.messages.forEach(appendMessage);
}
function appendMessage(m) {
  if (ui.chat_stream.querySelector(".chat-empty"))
    ui.chat_stream.replaceChildren();
  const article = document.createElement("article");
  article.className = "message";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const user = document.createElement("strong");
  user.textContent = m.username;
  const time = document.createElement("time");
  time.dateTime = m.createdAt;
  time.textContent = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(m.createdAt));
  meta.append(user, time);
  article.append(meta);
  if (m.kind === "voice" && m.audioData) {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    const [info, data] = m.audioData.split(",");
    audio.src = URL.createObjectURL(
      new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], {
        type: info.match(/data:([^;]+)/)?.[1] || "audio/webm",
      }),
    );
    audio.setAttribute("aria-label", `Voice note from ${m.username}`);
    article.append(audio);
  } else {
    const body = document.createElement("p");
    body.className = "message-body";
    body.textContent = m.body;
    article.append(body);
  }
  ui.chat_stream.append(article);
  ui.chat_stream.scrollTop = ui.chat_stream.scrollHeight;
}
function toast(text) {
  ui.world_toast.textContent = text;
  ui.world_toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => (ui.world_toast.hidden = true), 3000);
}
function moderation() {
  const allowed = ["admin", "moderator"].includes(state.me?.role);
  ui.moderator_tools.hidden = !allowed;
  if (!allowed) return;
  ui.moderator_tools.replaceChildren();
  const header = document.createElement("div");
  header.className = "moderator-heading";
  header.innerHTML =
    '<span>ROOM MODERATION</span><button class="tiny-icon" aria-label="Close moderation tools">×</button>';
  header.querySelector("button").onclick = () =>
    (ui.moderator_tools.hidden = true);
  ui.moderator_tools.append(header);
  state.users
    .filter((u) => u.id !== state.me.id && u.role !== "admin")
    .forEach((u) => {
      const row = document.createElement("div");
      row.className = "moderator-row";
      const label = document.createElement("span");
      label.textContent = u.username;
      for (const [labelText, type, payload] of [
        [
          u.muted ? "Unmute" : "Mute",
          "moderation:mute",
          { username: u.username, muted: !u.muted },
        ],
        [
          u.canSpeak ? "Pause speaking" : "Allow speaking",
          "moderation:speaking",
          { username: u.username, canSpeak: !u.canSpeak },
        ],
      ]) {
        const b = document.createElement("button");
        b.textContent = labelText;
        b.onclick = () => send(type, payload);
        row.append(b);
      }
      row.prepend(label);
      ui.moderator_tools.append(row);
    });
}
const renderModeration = moderation;
moderation = function () {
  const wasOpen = !ui.moderator_tools.hidden;
  renderModeration();
  ui.moderator_tools.hidden = !wasOpen;
};
function adminRender() {
  if (ui.admin_panel.hidden) return;
  ui.admin_content.replaceChildren();
  document
    .querySelectorAll("[data-admin-tab]")
    .forEach((b) =>
      b.classList.toggle("is-active", b.dataset.adminTab === state.tab),
    );
  if (state.tab === "event") {
    const p = document.createElement("p");
    p.className = "admin-event-copy";
    p.textContent = state.event.active
      ? `The official event began ${new Date(state.event.startedAt).toLocaleString()} and is live.`
      : "The official event is inactive. Starting it notifies all participants.";
    const b = document.createElement("button");
    b.className = "primary-button";
    b.textContent = state.event.active
      ? "End official event"
      : "Start official event";
    b.onclick = () => send(state.event.active ? "event:stop" : "event:start");
    ui.admin_content.append(p, b);
    return;
  }
  state.members.forEach((m) => {
    const row = document.createElement("div");
    row.className = "admin-row";
    const label = document.createElement("div");
    label.className = "admin-user";
    const n = document.createElement("strong");
    n.textContent = m.username;
    const d = document.createElement("small");
    d.textContent = m.approved ? m.role.toUpperCase() : "AWAITING APPROVAL";
    label.append(n, d);
    const actions = document.createElement("div");
    actions.className = "admin-actions";
    if (m.role !== "admin") {
      if (!m.approved) {
        const b = document.createElement("button");
        b.textContent = "Approve";
        b.onclick = () => send("admin:grant", { username: m.username });
        actions.append(b);
      } else {
        const role = document.createElement("select");
        role.setAttribute("aria-label", `Role for ${m.username}`);
        role.innerHTML =
          '<option value="member">Member</option><option value="moderator">Moderator</option>';
        role.value = m.role === "moderator" ? "moderator" : "member";
        role.onchange = () =>
          send("admin:role", { username: m.username, role: role.value });
        const remove = document.createElement("button");
        remove.textContent = "Remove";
        remove.onclick = () => send("admin:revoke", { username: m.username });
        actions.append(role, remove);
      }
    }
    row.append(label, actions);
    ui.admin_content.append(row);
  });
  if (!state.members.length)
    ui.admin_content.textContent = "No registered participants yet.";
}
function initWorld() {
  renderer = new THREE.WebGLRenderer({
    canvas: ui.world_canvas,
    antialias: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 0.1, 70);
  scene.add(new THREE.HemisphereLight("#fff2d2", "#26372c", 2));
  const sun = new THREE.DirectionalLight("#fff0cb", 3);
  sun.position.set(-7, 13, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun);
  const pinkLight = new THREE.PointLight("#ff5cad", 24, 18, 2);
  pinkLight.position.set(-5, 5, 1);
  scene.add(pinkLight);
  const cyanLight = new THREE.PointLight("#5bdcff", 22, 18, 2);
  cyanLight.position.set(6, 4, -3);
  scene.add(cyanLight);
  buildRoom();
  new ResizeObserver(() => {
    const r = ui.world_wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
  }).observe(ui.world_wrap);
  addEventListener("keydown", keyDown);
  addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  addEventListener("blur", () => keys.clear());
  ui.world_canvas.addEventListener("pointerdown", moveClick);
}
function startWorld() {
  initWorld();
  const frame = (t) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((t - lastFrame) / 1000 || 0, 0.05);
    lastFrame = t;
    move(dt, t);
    for (const [id, a] of avatars) {
      const target = targets.get(id);
      if (target && !a.group.userData.self) {
        a.group.position.x = THREE.MathUtils.damp(
          a.group.position.x,
          target.x,
          9,
          dt,
        );
        a.group.position.z = THREE.MathUtils.damp(
          a.group.position.z,
          target.z,
          9,
          dt,
        );
      }
      const walking = Boolean(a.group.userData.moving);
      const bounce = Math.sin(t * 0.004 + a.phase) * (walking ? 0.045 : 0.018);
      const swing = Math.sin(t * (walking ? 0.012 : 0.002) + a.phase) * (walking ? 0.62 : 0.09);
      a.body.position.y = 0.67 + bounce;
      a.head.position.y = 1.28 + bounce * 0.6;
      a.label.position.y = 2.16 + bounce * 0.6;
      a.arms[0].rotation.x = swing;
      a.arms[1].rotation.x = -swing;
      a.legs[0].rotation.x = -swing * 0.65;
      a.legs[1].rotation.x = swing * 0.65;
      a.label.lookAt(camera.position);
    }
    const player = avatars.get(state.me?.id);
    if (player && !minimap) {
      cameraTarget.copy(player.group.position).add(cameraOffset);
      camera.position.lerp(cameraTarget, 1 - Math.exp(-3.5 * dt));
      cameraLook.copy(player.group.position);
      cameraLook.y = 0.9;
      camera.lookAt(cameraLook);
    }
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);
}
function box(parent, size, pos, color) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(...size),
    new THREE.MeshStandardMaterial({ color, roughness: 0.82 }),
  );
  m.position.set(...pos);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}
function cyl(parent, r, h, pos, color) {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, h, 20),
    new THREE.MeshStandardMaterial({ color, roughness: 0.8 }),
  );
  m.position.set(...pos);
  m.castShadow = true;
  parent.add(m);
  return m;
}
function buildRoom() {
  if (!scene) return;
  if (world) {
    scene.remove(world);
    world.traverse((o) => {
      if (o.isMesh || o.isSprite) {
        o.geometry?.dispose();
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
  }
  world = new THREE.Group();
  scene.add(world);
  const r = state.rooms.find((x) => x.id === state.roomId) || {
    kind: "lounge",
  };
  const t =
    r.kind === "debate"
      ? {
          floor: "#ff8058",
          wall: "#421b5d",
          accent: "#f4ed67",
          seat: "#ff5cad",
          grid: "#ffb078",
        }
      : r.kind === "voice"
        ? {
            floor: "#24b9d5",
            wall: "#132c65",
            accent: "#b5e83b",
            seat: "#7657ef",
            grid: "#5bdcff",
          }
        : r.kind === "discussion"
          ? {
              floor: "#aa79ed",
              wall: "#29295f",
              accent: "#ff5cad",
              seat: "#36d9c0",
              grid: "#cba6ff",
            }
          : {
              floor: "#347ae7",
              wall: "#17234f",
              accent: "#f4ed67",
              seat: "#ff5cad",
              grid: "#5bdcff",
            };
  scene.background = new THREE.Color(t.wall);
  scene.fog = new THREE.Fog(t.wall, 20, 38);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(22, 21),
    new THREE.MeshStandardMaterial({ color: t.floor, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.1;
  floor.receiveShadow = true;
  world.add(floor);
  for (let line = -10; line <= 10; line += 2) {
    box(world, [0.035, 0.018, 20], [line, -0.083, 0], t.grid);
    box(world, [20, 0.018, 0.035], [0, -0.083, line], t.grid);
  }
  box(world, [22, 4, 0.2], [0, 1.8, -10.5], t.wall);
  box(world, [0.2, 4, 20], [-11, 1.8, 0], t.wall);
  box(world, [0.2, 4, 20], [11, 1.8, 0], t.wall);
  for (let i = 0; i < 9; i++)
    box(
      world,
      [1.1, 0.14, 0.12],
      [-5.2 + i * 1.3, 2.7 + (i % 3) * 0.16, -10.35],
      i % 2 ? t.accent : "#59b9ff",
    );
  if (r.kind === "debate") {
    box(world, [8, 0.4, 3], [0, 0.1, -6.4], "#784154");
    box(world, [4, 0.15, 0.5], [0, 0.6, -7], t.accent);
    for (let row = 0; row < 2; row++)
      for (let col = 0; col < 5; col++) {
        const x = (col - 2) * 2.15,
          z = row * 2.1;
        box(world, [1.2, 0.3, 0.7], [x, 0.4, z], t.seat);
        box(world, [1.2, 0.7, 0.15], [x, 0.8, z + 0.3], t.seat);
      }
  } else if (r.kind === "voice") {
    cyl(world, 3.1, 0.12, [0, 0.04, 0], "#57c7ae");
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4,
        x = Math.cos(a) * 3.2,
        z = Math.sin(a) * 3.2;
      cyl(world, 0.8, 0.4, [x, 0.3, z], i % 2 ? t.seat : "#d89d48");
    }
  } else {
    cyl(world, 1.5, 0.3, [0, 0.15, 0], "#f3b347");
    box(world, [2.3, 0.55, 0.85], [-3.5, 0.45, 0], t.seat);
    box(world, [2.3, 0.48, 0.2], [-3.5, 0.85, 0.43], t.seat);
    box(world, [2.3, 0.55, 0.85], [3.5, 0.45, -2.6], "#547ae2");
    box(world, [2.3, 0.48, 0.2], [3.5, 0.85, -3.03], "#547ae2");
    for (const [x, z] of [
      [-8, -7],
      [8, -7],
      [-8, 7],
      [8, 7],
    ]) {
      cyl(world, 0.33, 0.4, [x, 0.2, z], "#ffad54");
      for (let i = 0; i < 4; i++) {
        const leaf = new THREE.Mesh(
          new THREE.SphereGeometry(0.25, 10, 8),
          new THREE.MeshStandardMaterial({
            color: i % 2 ? "#43e2b2" : "#b5e83b",
          }),
        );
        leaf.scale.set(0.6, 1.5, 0.4);
        leaf.position.set(
          x + Math.cos((i * Math.PI) / 2) * 0.25,
          0.8,
          z + Math.sin((i * Math.PI) / 2) * 0.25,
        );
        world.add(leaf);
      }
    }
  }
  camera.position.set(0, minimap ? 22 : 17, minimap ? 0.01 : 17);
  camera.lookAt(0, 0, 0);
  avatars.clear();
  targets.clear();
  users();
}
function nameplate(name) {
  const c = document.createElement("canvas");
  c.width = 480;
  c.height = 104;
  const x = c.getContext("2d");
  x.fillStyle = "#101426f2";
  x.beginPath();
  x.roundRect(4, 4, 472, 96, 14);
  x.fill();
  x.fillStyle = "#fff7f1";
  x.font = "700 40px sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(name.slice(0, 24), 240, 53, 440);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    }),
  );
  s.scale.set(2.35, 0.54, 1);
  return s;
}
function avatarAccessory(style, color) {
  const accessory = new THREE.Group();
  const accent = new THREE.Color(color || "#ff5cad");
  if (style === "sun") {
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.34, 0.045, 8, 24),
      new THREE.MeshStandardMaterial({ color: "#f4ed67", metalness: 0.25, roughness: 0.55 }),
    );
    halo.position.y = 1.78;
    halo.rotation.x = 0.15;
    accessory.add(halo);
    const star = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.11, 0),
      new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.18 }),
    );
    star.position.set(0, 1.81, 0.02);
    accessory.add(star);
  } else if (style === "leaf") {
    for (const side of [-1, 1]) {
      const leaf = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 0.34, 0.12),
        new THREE.MeshStandardMaterial({ color: side < 0 ? "#4fe6c2" : "#b5e83b", roughness: 0.72 }),
      );
      leaf.position.set(side * 0.14, 1.76, 0.02);
      leaf.rotation.z = side * -0.25;
      leaf.rotation.z = side * -0.55;
      accessory.add(leaf);
    }
  } else {
    const band = new THREE.Mesh(
      new THREE.TorusGeometry(0.31, 0.055, 8, 24, Math.PI),
      new THREE.MeshStandardMaterial({ color: "#5bdcff", roughness: 0.6 }),
    );
    band.position.set(0, 1.36, 0);
    accessory.add(band);
    for (const side of [-1, 1]) {
      const cup = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.18, 0.12),
        new THREE.MeshStandardMaterial({ color: accent, roughness: 0.62 }),
      );
      cup.position.set(side * 0.31, 1.31, 0.015);
      accessory.add(cup);
    }
  }
  return accessory;
}
function avatar(user) {
  const group = new THREE.Group(),
    color = new THREE.Color(user.avatarColor || "#ff617d");
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.54, 0.63, 0.37),
    new THREE.MeshStandardMaterial({ color, roughness: 0.8 }),
  );
  body.position.y = 0.67;
  body.castShadow = true;
  group.add(body);
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.56, 0.56, 0.52),
    new THREE.MeshStandardMaterial({ color: "#efc29d" }),
  );
  head.position.y = 1.28;
  group.add(head);
  const hair = new THREE.Mesh(
    new THREE.BoxGeometry(0.61, 0.16, 0.58),
    new THREE.MeshStandardMaterial({
      color:
        user.avatarStyle === "leaf"
          ? "#43a875"
          : user.avatarStyle === "wave"
            ? "#4862bc"
            : "#432e3a",
    }),
  );
  hair.position.set(0, 1.62, -0.015);
  group.add(hair);
  const eyes = [];
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.064, 12, 10),
      new THREE.MeshStandardMaterial({ color: "#fffaf4", roughness: 0.5 }),
    );
    eye.position.set(side * 0.12, 1.31, 0.275);
    group.add(eye);
    const pupil = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 10, 8),
      new THREE.MeshStandardMaterial({ color: "#28213a", roughness: 0.4 }),
    );
    pupil.position.set(side * 0.12, 1.3, 0.321);
    group.add(pupil);
    eyes.push(eye);
  }
  const smile = new THREE.Mesh(
    new THREE.TorusGeometry(0.064, 0.013, 6, 16, Math.PI),
    new THREE.MeshStandardMaterial({ color: "#7d3f54", roughness: 0.6 }),
  );
  smile.position.set(0, 1.17, 0.27);
  group.add(smile);
  const arms = [];
  const legs = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(side * 0.31, 0.87, 0);
    const sleeve = new THREE.Mesh(
      new THREE.BoxGeometry(0.19, 0.4, 0.23),
      new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.8), roughness: 0.84 }),
    );
    sleeve.position.y = -0.2;
    arm.add(sleeve);
    group.add(arm);
    arms.push(arm);
    const leg = new THREE.Group();
    leg.position.set(side * 0.14, 0.36, 0);
    const trouser = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.36, 0.24),
      new THREE.MeshStandardMaterial({ color: "#303550", roughness: 0.9 }),
    );
    trouser.position.y = -0.16;
    leg.add(trouser);
    const shoe = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.12, 0.33),
      new THREE.MeshStandardMaterial({ color: side < 0 ? "#f4ed67" : "#5bdcff", roughness: 0.65 }),
    );
    shoe.position.set(0, -0.33, 0.05);
    leg.add(shoe);
    group.add(leg);
    legs.push(leg);
  }
  const accessory = avatarAccessory(user.avatarStyle, user.avatarColor);
  group.add(accessory);
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.36, 0.39, 0.1, 20),
    new THREE.MeshStandardMaterial({
      color: color.clone().multiplyScalar(0.6),
    }),
  );
  base.position.y = 0.06;
  group.add(base);
  const label = nameplate(user.username);
  label.position.y = 2.16;
  group.add(label);
  group.scale.setScalar(1.45);
  return { group, body, head, base, hair, label, eyes, arms, legs, accessory, color: user.avatarColor, style: user.avatarStyle, phase: Math.random() * Math.PI * 2 };
}
function keyDown(e) {
  if (
    e.target instanceof HTMLElement &&
    (e.target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(e.target.tagName))
  )
    return;
  const k = e.key.toLowerCase();
  if (
    [
      "w",
      "a",
      "s",
      "d",
      "arrowup",
      "arrowleft",
      "arrowdown",
      "arrowright",
    ].includes(k)
  ) {
    e.preventDefault();
    keys.add(k);
  }
}
function moveClick(e) {
  const r = ui.world_canvas.getBoundingClientRect(),
    p = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      (-(e.clientY - r.top) / r.height) * 2 + 1,
    ),
    ray = new THREE.Raycaster();
  ray.setFromCamera(p, camera);
  const point = ray.ray.intersectPlane(
    new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
    new THREE.Vector3(),
  );
  if (point)
    window.moveTarget = {
      x: THREE.MathUtils.clamp(point.x, -9, 9),
      z: THREE.MathUtils.clamp(point.z, -9, 9),
    };
}
function move(dt, time) {
  if (!state.me || !avatars.has(state.me.id)) return;
  const a = avatars.get(state.me.id);
  let x =
      Number(keys.has("d") || keys.has("arrowright")) -
      Number(keys.has("a") || keys.has("arrowleft")),
    z =
      Number(keys.has("s") || keys.has("arrowdown")) -
      Number(keys.has("w") || keys.has("arrowup"));
  if (window.moveTarget && !x && !z) {
    x = window.moveTarget.x - a.group.position.x;
    z = window.moveTarget.z - a.group.position.z;
    if (Math.hypot(x, z) < 0.12) {
      window.moveTarget = null;
      x = 0;
      z = 0;
    }
  }
  a.group.userData.moving = Boolean(x || z);
  if (!x && !z) return;
  const len = Math.hypot(x, z);
  x /= len;
  z /= len;
  a.group.position.x = THREE.MathUtils.clamp(
    a.group.position.x + x * dt * 3.3,
    -9,
    9,
  );
  a.group.position.z = THREE.MathUtils.clamp(
    a.group.position.z + z * dt * 3.3,
    -9,
    9,
  );
  a.group.rotation.y = Math.atan2(x, z);
  ui.position_display.textContent = `${String(Math.round(a.group.position.x)).padStart(2, "0")} · ${String(Math.round(a.group.position.z)).padStart(2, "0")}`;
  if (time - lastMove > 90) {
    lastMove = time;
    send("player:move", { x: a.group.position.x, z: a.group.position.z });
  }
}
function voiceButton() {
  ui.voice_button.classList.toggle("is-joined", state.voice);
  ui.voice_button.textContent = state.voice ? "◖ Leave voice" : "◖ Join voice";
}
async function toggleVoice() {
  if (state.voice) {
    send("voice:leave");
    leaveVoice(false);
    return;
  }
  if (state.me.muted || !state.me.canSpeak)
    return toast("A moderator has paused your microphone.");
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
    return toast("Live voice needs a supported browser and microphone access.");
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    send("voice:join");
    state.voice = true;
    voiceButton();
    syncPeers();
  } catch (e) {
    toast(
      e.name === "NotAllowedError"
        ? "Allow microphone access to join voice."
        : "Microphone access is unavailable.",
    );
  }
}
function leaveVoice(notify = true) {
  if (notify && state.voice) send("voice:leave");
  state.voice = false;
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  for (const id of [...state.peers.keys()]) removePeer(id);
  voiceButton();
}
function peerFor(id) {
  const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    }),
    audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  document.body.append(audio);
  const peer = { pc, audio, candidates: [] };
  state.peers.set(id, peer);
  state.stream?.getTracks().forEach((t) => pc.addTrack(t, state.stream));
  pc.ontrack = (e) => {
    audio.srcObject = e.streams[0];
    audio.play().catch(() => {});
  };
  pc.onicecandidate = (e) => {
    if (e.candidate)
      send("voice:signal", {
        targetUserId: id,
        candidate: e.candidate.toJSON(),
      });
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) removePeer(id);
  };
  return peer;
}
async function syncPeers() {
  if (!state.voice || !state.stream) return;
  const people = state.users.filter(
      (u) => u.id !== state.me.id && u.voice && u.canSpeak && !u.muted,
    ),
    ids = new Set(people.map((u) => u.id));
  for (const id of state.peers.keys()) if (!ids.has(id)) removePeer(id);
  for (const user of people) {
    if (state.peers.has(user.id)) continue;
    const p = peerFor(user.id);
    if (state.me.id.localeCompare(user.id) < 0)
      try {
        const offer = await p.pc.createOffer();
        await p.pc.setLocalDescription(offer);
        send("voice:signal", {
          targetUserId: user.id,
          description: p.pc.localDescription.toJSON(),
        });
      } catch {
        removePeer(user.id);
      }
  }
}
function removePeer(id) {
  const p = state.peers.get(id);
  if (!p) return;
  p.pc.close();
  p.audio.remove();
  state.peers.delete(id);
}
async function signal(m) {
  if (!state.voice || !state.stream) return;
  let p = state.peers.get(m.fromUserId) || peerFor(m.fromUserId);
  try {
    if (m.description) {
      await p.pc.setRemoteDescription(m.description);
      for (const c of p.candidates.splice(0)) await p.pc.addIceCandidate(c);
      if (m.description.type === "offer") {
        const answer = await p.pc.createAnswer();
        await p.pc.setLocalDescription(answer);
        send("voice:signal", {
          targetUserId: m.fromUserId,
          description: p.pc.localDescription.toJSON(),
        });
      }
    }
    if (m.candidate) {
      if (p.pc.remoteDescription) await p.pc.addIceCandidate(m.candidate);
      else p.candidates.push(m.candidate);
    }
  } catch {
    removePeer(m.fromUserId);
  }
}
async function recordNote() {
  if (state.recording) return;
  if (state.me.muted || !state.me.canSpeak)
    return toast("A moderator has paused voice notes.");
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
    return toast("Voice notes are not supported here.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = [
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ].find((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) throw Error();
    const rec = new MediaRecorder(stream, {
        mimeType: mime,
        audioBitsPerSecond: 24000,
      }),
      parts = [];
    state.recording = true;
    ui.record_button.classList.add("is-recording");
    toast("Recording a short voice note…");
    rec.ondataavailable = (e) => {
      if (e.data.size) parts.push(e.data);
    };
    rec.onstop = () => {
      state.recording = false;
      ui.record_button.classList.remove("is-recording");
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(parts, { type: mime });
      if (blob.size > 25000)
        return toast("That note is too large. Try a shorter one.");
      const reader = new FileReader();
      reader.onload = () => send("voice:note", { audioData: reader.result });
      reader.readAsDataURL(blob);
    };
    rec.start();
    setTimeout(() => {
      if (rec.state === "recording") rec.stop();
    }, 6000);
  } catch {
    stream?.getTracks().forEach((t) => t.stop());
    toast("Allow microphone access to record a voice note.");
  }
}
function adminOpen() {
  ui.admin_panel.hidden = false;
  adminRender();
}
function logout() {
  state.reconnect = false;
  send("auth:logout");
  state.token = null;
  state.me = null;
  localStorage.removeItem("teens-renewed-token");
  leaveVoice(false);
  showAuth();
  setTimeout(() => {
    state.reconnect = true;
    socket?.close();
  }, 100);
}
document
  .querySelectorAll("[data-mode]")
  .forEach((b) => (b.onclick = () => mode(b.dataset.mode)));
$("#admin-entry").onclick = () => mode(state.mode === "admin" ? "login" : "admin");
ui.auth_form.onsubmit = (e) => {
  e.preventDefault();
  if (socket?.readyState !== WebSocket.OPEN)
    return (ui.auth_message.textContent = "Connecting. Try again in a moment.");
  const type = state.mode === "signup"
    ? "auth:signup"
    : state.mode === "admin"
      ? "auth:admin-login"
      : "auth:login";
  send(type, {
    username: ui.username.value.trim(),
    password: ui.password.value,
    avatarColor: $("#avatar-color").value,
    avatarStyle: $("#avatar-style").value,
  });
};
ui.chat_form.onsubmit = (e) => {
  e.preventDefault();
  const body = ui.chat_input.value.trim();
  if (body) send("chat:send", { body });
  ui.chat_input.value = "";
};
ui.chat_input.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    ui.chat_form.requestSubmit();
  }
};
$("#create-room-button").onclick = () => $("#room-dialog").showModal();
$("#room-form").onsubmit = (e) => {
  e.preventDefault();
  send("room:create", { name: $("#room-name").value.trim() });
  $("#room-name").value = "";
  $("#room-dialog").close();
};
ui.event_button.onclick = () =>
  send(state.event.active ? "event:stop" : "event:start");
ui.voice_button.onclick = toggleVoice;
ui.record_button.onclick = recordNote;
$("#profile-button").onclick = () => ui.profile_dialog.showModal();
$("#manage-button").onclick = adminOpen;
$("#save-profile").onclick = () => {
  send("profile:update", {
    avatarColor: ui.profile_color.value,
    avatarStyle: ui.profile_style.value,
  });
  ui.profile_dialog.close();
};
$("#logout-button").onclick = logout;
$("#waiting-signout").onclick = logout;
$("#account-menu").onclick = () =>
  state.me?.role === "admin"
    ? adminOpen()
    : state.me?.role === "moderator"
      ? (ui.moderator_tools.hidden = !ui.moderator_tools.hidden)
      : ui.profile_dialog.showModal();
$("#members-toggle").onclick = () =>
  state.me?.role === "admin"
    ? adminOpen()
    : state.me?.role === "moderator"
      ? (ui.moderator_tools.hidden = !ui.moderator_tools.hidden)
      : (ui.members_strip.hidden = !ui.members_strip.hidden);
$("#admin-toggle").onclick = () => (ui.admin_panel.hidden = true);
document.querySelectorAll("[data-admin-tab]").forEach(
  (b) =>
    (b.onclick = () => {
      state.tab = b.dataset.adminTab;
      adminRender();
    }),
);
$("#map-toggle").onclick = (e) => {
  minimap = !minimap;
  e.currentTarget.setAttribute("aria-pressed", String(minimap));
  buildRoom();
};
connect();
mode("login");
voiceButton();
