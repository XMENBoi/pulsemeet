const socket = io();

const state = {
  brand: "PulseMeet",
  isQueued: false,
  isMatched: false,
  isStarting: false,
  role: null,
  roomId: null,
  queuePosition: null,
  localStream: null,
  remoteStream: null,
  peerConnection: null,
  pendingCandidates: [],
  rtcConfig: { iceServers: [] }
};

const refs = {
  brandName: document.getElementById("brandName"),
  onlineCount: document.getElementById("onlineCount"),
  waitingCount: document.getElementById("waitingCount"),
  roomCount: document.getElementById("roomCount"),
  sessionBadge: document.getElementById("sessionBadge"),
  statusTitle: document.getElementById("statusTitle"),
  statusText: document.getElementById("statusText"),
  queuePosition: document.getElementById("queuePosition"),
  roomStatus: document.getElementById("roomStatus"),
  localVideo: document.getElementById("localVideo"),
  remoteVideo: document.getElementById("remoteVideo"),
  localPlaceholder: document.getElementById("localPlaceholder"),
  remotePlaceholder: document.getElementById("remotePlaceholder"),
  sharedInterestPills: document.getElementById("sharedInterestPills"),
  interestsInput: document.getElementById("interestsInput"),
  consentCheckbox: document.getElementById("consentCheckbox"),
  startButton: document.getElementById("startButton"),
  nextButton: document.getElementById("nextButton"),
  leaveButton: document.getElementById("leaveButton"),
  micButton: document.getElementById("micButton"),
  cameraButton: document.getElementById("cameraButton"),
  reportButton: document.getElementById("reportButton"),
  reportReason: document.getElementById("reportReason"),
  chatState: document.getElementById("chatState"),
  messageList: document.getElementById("messageList"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  sendButton: document.getElementById("sendButton"),
  toastStack: document.getElementById("toastStack")
};

function parseInterests() {
  return refs.interestsInput.value
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function showToast(message, type = "") {
  const node = document.createElement("div");
  node.className = `toast ${type ? `toast--${type}` : ""}`.trim();
  node.textContent = message;
  refs.toastStack.append(node);

  window.setTimeout(() => {
    node.remove();
  }, 4200);
}

function updateStatus(badge, title, text) {
  refs.sessionBadge.textContent = badge;
  refs.statusTitle.textContent = title;
  refs.statusText.textContent = text;
}

function updateControls() {
  const hasMedia = Boolean(state.localStream);
  const canChat = state.isMatched;
  const consented = refs.consentCheckbox.checked;

  refs.startButton.disabled = state.isStarting || state.isQueued || !consented;
  refs.nextButton.disabled = !(state.isMatched || state.isQueued);
  refs.leaveButton.disabled = !(state.isMatched || state.isQueued || hasMedia);
  refs.micButton.disabled = !hasMedia;
  refs.cameraButton.disabled = !hasMedia;
  refs.reportButton.disabled = !state.isMatched;
  refs.chatInput.disabled = !canChat;
  refs.sendButton.disabled = !canChat;
  refs.chatState.textContent = canChat ? "Open" : "Locked";
  refs.roomStatus.textContent = state.isMatched ? "Live" : state.isQueued ? "Searching" : "Idle";
  refs.queuePosition.textContent = state.queuePosition ? `#${state.queuePosition}` : "-";
}

async function loadRtcConfig() {
  const response = await fetch("/api/rtc-config", {
    cache: "no-store",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error("RTC config request failed.");
  }

  const payload = await response.json();
  if (!Array.isArray(payload.iceServers) || payload.iceServers.length === 0) {
    throw new Error("RTC config was empty.");
  }

  state.rtcConfig = {
    iceServers: payload.iceServers
  };
}

function renderSharedInterests(interests = []) {
  refs.sharedInterestPills.replaceChildren();

  interests.slice(0, 4).forEach((interest) => {
    const node = document.createElement("span");
    node.className = "pill";
    node.textContent = `shared: ${interest}`;
    refs.sharedInterestPills.append(node);
  });
}

function addMessage(text, type) {
  const node = document.createElement("li");
  node.className = `message message--${type}`;
  node.textContent = text;
  refs.messageList.append(node);
  refs.messageList.scrollTop = refs.messageList.scrollHeight;
}

function clearMessages(systemMessage = "Chat unlocks when you are paired with someone.") {
  refs.messageList.replaceChildren();
  addMessage(systemMessage, "system");
}

function syncMediaButtons() {
  const audioTrack = state.localStream?.getAudioTracks()?.[0];
  const videoTrack = state.localStream?.getVideoTracks()?.[0];

  refs.micButton.textContent = audioTrack?.enabled === false ? "Unmute mic" : "Mute mic";
  refs.cameraButton.textContent = videoTrack?.enabled === false ? "Camera on" : "Camera off";
}

function resetRemoteStage(message = "Next conversation appears here.") {
  if (state.remoteStream) {
    state.remoteStream.getTracks().forEach((track) => track.stop());
  }

  state.remoteStream = null;
  refs.remoteVideo.srcObject = null;
  refs.remotePlaceholder.hidden = false;
  refs.remotePlaceholder.innerHTML = `<strong>${message}</strong><span>Go live to enter the lounge and start matching.</span>`;
  renderSharedInterests([]);
}

function closePeerConnection() {
  if (state.peerConnection) {
    state.peerConnection.onicecandidate = null;
    state.peerConnection.ontrack = null;
    state.peerConnection.onconnectionstatechange = null;
    state.peerConnection.close();
    state.peerConnection = null;
  }

  state.pendingCandidates = [];
  resetRemoteStage("Connection cleared.");
}

async function ensureLocalMedia() {
  if (state.localStream) {
    return state.localStream;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user"
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    state.localStream = stream;
    refs.localVideo.srcObject = stream;
    refs.localPlaceholder.hidden = true;
    syncMediaButtons();
    updateControls();
    return stream;
  } catch (error) {
    updateStatus(
      "Permission needed",
      "Camera or microphone blocked",
      "Allow camera and microphone access in your browser, then try going live again."
    );
    showToast("Camera or microphone permission was denied.", "error");
    throw error;
  }
}

async function createPeerConnection() {
  closePeerConnection();

  state.remoteStream = new MediaStream();
  refs.remoteVideo.srcObject = state.remoteStream;

  const peerConnection = new RTCPeerConnection(state.rtcConfig);

  peerConnection.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => {
      if (!state.remoteStream.getTracks().find((existing) => existing.id === track.id)) {
        state.remoteStream.addTrack(track);
      }
    });

    refs.remotePlaceholder.hidden = true;
    updateStatus("Live", "Conversation is open", "You are connected. Say hi, type in chat, or tap next anytime.");
  };

  peerConnection.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }

    socket.emit("webrtc:signal", {
      roomId: state.roomId,
      type: "ice-candidate",
      candidate: event.candidate
    });
  };

  peerConnection.onconnectionstatechange = () => {
    switch (peerConnection.connectionState) {
      case "connecting":
        updateStatus("Connecting", "Joining the room", "Partner found. Finalizing the WebRTC connection.");
        break;
      case "connected":
        updateStatus("Live", "Conversation is open", "You are connected. Say hi, type in chat, or tap next anytime.");
        break;
      case "disconnected":
        updateStatus("Weak signal", "Connection dipped", "The call looks unstable. It may recover in a moment.");
        break;
      case "failed":
        updateStatus("Connection failed", "The video link could not be completed", "Tap next to try a fresh partner, or add a TURN server for stricter networks.");
        showToast("Peer connection failed. A TURN server usually helps here.", "error");
        break;
      default:
        break;
    }
  };

  const localStream = await ensureLocalMedia();
  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  state.peerConnection = peerConnection;
  return peerConnection;
}

async function flushPendingCandidates() {
  if (!state.peerConnection?.remoteDescription) {
    return;
  }

  while (state.pendingCandidates.length > 0) {
    const candidate = state.pendingCandidates.shift();
    try {
      await state.peerConnection.addIceCandidate(candidate);
    } catch {
      showToast("A network candidate could not be applied.", "error");
    }
  }
}

async function handleSignal(payload) {
  if (!payload.roomId || payload.roomId !== state.roomId) {
    return;
  }

  if (!state.peerConnection) {
    await createPeerConnection();
  }

  if (payload.type === "offer") {
    await state.peerConnection.setRemoteDescription(payload.sdp);
    const answer = await state.peerConnection.createAnswer();
    await state.peerConnection.setLocalDescription(answer);
    await flushPendingCandidates();

    socket.emit("webrtc:signal", {
      roomId: state.roomId,
      type: "answer",
      sdp: state.peerConnection.localDescription
    });
    return;
  }

  if (payload.type === "answer") {
    await state.peerConnection.setRemoteDescription(payload.sdp);
    await flushPendingCandidates();
    return;
  }

  if (payload.type === "ice-candidate") {
    if (state.peerConnection.remoteDescription) {
      await state.peerConnection.addIceCandidate(payload.candidate);
    } else {
      state.pendingCandidates.push(payload.candidate);
    }
  }
}

async function startQueue() {
  if (state.isStarting) {
    return;
  }

  if (!refs.consentCheckbox.checked) {
    showToast("Confirm the 18+ and policy checkbox before going live.", "error");
    return;
  }

  state.isStarting = true;
  updateControls();

  try {
    await ensureLocalMedia();
    clearMessages("Searching for someone new...");
    socket.emit("queue:join", {
      interests: parseInterests()
    });
    state.isQueued = true;
    state.isMatched = false;
    state.queuePosition = 1;
    updateStatus("Searching", "Scanning the lounge", "You are in the queue now. We will pair you as soon as a compatible partner appears.");
  } catch {
    return;
  } finally {
    state.isStarting = false;
    updateControls();
  }
}

function leaveOrPause() {
  if (state.isMatched) {
    socket.emit("session:leave");
  } else if (state.isQueued) {
    socket.emit("queue:leave");
    state.isQueued = false;
    state.queuePosition = null;
    updateStatus("Paused", "You stepped out of the queue", "Your camera preview stays on, but you are no longer being matched.");
    clearMessages();
    updateControls();
  } else {
    closePeerConnection();
    updateStatus("Ready", "Ready when you are", "Turn on your camera and microphone, add a few interests if you want better matches, then go live.");
  }
}

function goNext() {
  if (state.isMatched) {
    socket.emit("session:next");
    return;
  }

  if (state.isQueued) {
    socket.emit("queue:leave");
    state.isQueued = false;
    state.queuePosition = null;
    updateStatus("Paused", "Search paused", "Tap go live again whenever you want a new conversation.");
    updateControls();
    return;
  }

  void startQueue();
}

refs.startButton.addEventListener("click", () => {
  void startQueue();
});

refs.consentCheckbox.addEventListener("change", () => {
  updateControls();
});

refs.nextButton.addEventListener("click", () => {
  goNext();
});

refs.leaveButton.addEventListener("click", () => {
  leaveOrPause();
});

refs.micButton.addEventListener("click", () => {
  const audioTrack = state.localStream?.getAudioTracks()?.[0];
  if (!audioTrack) {
    return;
  }

  audioTrack.enabled = !audioTrack.enabled;
  syncMediaButtons();
});

refs.cameraButton.addEventListener("click", () => {
  const videoTrack = state.localStream?.getVideoTracks()?.[0];
  if (!videoTrack) {
    return;
  }

  videoTrack.enabled = !videoTrack.enabled;
  syncMediaButtons();
});

refs.reportButton.addEventListener("click", () => {
  if (!state.isMatched) {
    return;
  }

  socket.emit("session:report", {
    roomId: state.roomId,
    reason: refs.reportReason.value
  });
});

refs.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = refs.chatInput.value.trim();

  if (!text || !state.isMatched) {
    return;
  }

  socket.emit("chat:send", { roomId: state.roomId, text });
  addMessage(text, "self");
  refs.chatInput.value = "";
});

document.querySelectorAll("[data-suggested-tag]").forEach((button) => {
  button.addEventListener("click", () => {
    const value = button.getAttribute("data-suggested-tag");
    const current = parseInterests();
    if (!value || current.includes(value)) {
      return;
    }

    current.push(value);
    refs.interestsInput.value = current.join(", ");
  });
});

socket.on("connect", () => {
  updateStatus("Ready", "Ready when you are", "The server connection is up. Turn on your camera and go live when you want to start matching.");
});

socket.on("disconnect", () => {
  state.isQueued = false;
  state.isMatched = false;
  state.queuePosition = null;
  state.role = null;
  state.roomId = null;
  closePeerConnection();
  clearMessages();
  updateStatus("Offline", "Server connection lost", "Trying to reconnect. If the page stays offline, refresh it and try again.");
  updateControls();
});

socket.on("session:ready", (payload) => {
  state.brand = payload.brand;
  refs.brandName.textContent = payload.brand;
});

socket.on("stats:update", (payload) => {
  refs.onlineCount.textContent = payload.online;
  refs.waitingCount.textContent = payload.waiting;
  refs.roomCount.textContent = payload.liveRooms;
});

socket.on("queue:joined", (payload) => {
  state.isQueued = true;
  state.isMatched = false;
  state.queuePosition = payload.waitingCount ?? 1;
  updateStatus("Searching", "Scanning the lounge", "You are in the queue now. We will pair you as soon as a compatible partner appears.");
  updateControls();
});

socket.on("queue:update", (payload) => {
  state.queuePosition = payload.position;
  updateControls();
});

socket.on("match:found", async (payload) => {
  state.isQueued = false;
  state.isMatched = true;
  state.role = payload.role;
  state.roomId = payload.roomId;
  state.rtcConfig = payload.rtcConfig ?? { iceServers: [] };
  state.queuePosition = null;

  clearMessages("You are connected. Keep it friendly.");
  renderSharedInterests(payload.sharedInterests);
  updateStatus("Partner found", "Opening the connection", "A new person is here. Building the live video link now.");
  updateControls();

  try {
    await ensureLocalMedia();
    await loadRtcConfig();
    const peerConnection = await createPeerConnection();

    if (payload.role === "initiator") {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      socket.emit("webrtc:signal", {
        roomId: state.roomId,
        type: "offer",
        sdp: peerConnection.localDescription
      });
    }
  } catch {
    showToast("Could not start the peer connection. Check TURN setup and try again.", "error");
  }
});

socket.on("webrtc:signal", (payload) => {
  void handleSignal(payload).catch(() => {
    showToast("A connection signal could not be processed.", "error");
  });
});

socket.on("chat:message", (payload) => {
  if (payload.roomId && payload.roomId !== state.roomId) {
    return;
  }

  addMessage(payload.text, "partner");
});

socket.on("match:ended", (payload) => {
  state.isMatched = false;
  state.isQueued = payload.requeued;
  state.role = null;
  state.roomId = null;
  state.queuePosition = null;
  closePeerConnection();
  clearMessages(payload.requeued ? "Searching for someone new..." : "Chat unlocks when you are paired with someone.");
  updateStatus(payload.requeued ? "Searching" : "Paused", payload.requeued ? "Looking for the next person" : "Conversation ended", payload.reason);
  updateControls();
});

socket.on("report:logged", (payload) => {
  showToast(payload.message);
});

socket.on("server:error", (payload) => {
  showToast(payload.message, "error");
});

clearMessages();
updateControls();
