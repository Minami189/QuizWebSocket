const { WebSocketServer } = require("ws");

// Store rooms and participants
// rooms = {
//   "<roomCode>": {
//     owner: { ws, email },
//     clients: [{ ws, email }, ...],
//     quiz: {...},
//     state: "waiting" | "started" | "ended",
//     timer: {
//       timeRemaining: Number,
//       interval: TimeoutObject
//     } | null
//   }
// }
const rooms = {};
const PORT = process.env.PORT || 4000;
const wss = new WebSocketServer({ port: PORT });

/**
 * Safe send wrapper
 */
function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch (err) {
    console.warn("Failed to send to socket:", err.message);
  }
}

/**
 * Broadcast to clients
 */
function broadcast(clients, obj) {
  clients.forEach(client => safeSend(client.ws, obj));
}

/**
 * Clean delete room
 */
function deleteRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.timer && room.timer.interval) {
    clearInterval(room.timer.interval);
    room.timer = null;
  }

  delete rooms[roomCode];
  console.log(`Deleted room ${roomCode}`);
}

/**
 * Remove ws from room (disconnect/leave)
 */
function leaveRoom(ws) {
  if (!ws.room) return;

  const roomCode = ws.room;
  const room = rooms[roomCode];
  if (!room) {
    ws.room = null;
    return;
  }

  // owner leaving disconnects → delete room
  if (room.owner && room.owner.ws === ws) {
    const clients = room.clients || [];
    clients.forEach(client => {
      safeSend(client.ws, { action: "roomClosed", body: "Owner left, room closed" });
      client.ws.room = null;
    });

    if (room.timer && room.timer.interval) {
      clearInterval(room.timer.interval);
      room.timer = null;
    }

    delete rooms[roomCode];
    console.log(`Room ${roomCode} deleted because owner left`);
  } else {
    room.clients = room.clients.filter(c => c.ws !== ws);
    console.log(`User left room ${roomCode}`);
  }

  ws.room = null;
  ws.userEmail = null;
}

wss.on("connection", (ws) => {
  console.log("User connected");
  ws.room = null;
  ws.userEmail = null;

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (err) {
      console.log("Invalid JSON:", msg.toString());
      return;
    }

    const { action, body } = data;

    // -----------------------------
    // CREATE ROOM
    // -----------------------------
    if (action === "create") {
      leaveRoom(ws);

      const { userEmail, quizData } = body || {};
      if (!userEmail) {
        safeSend(ws, { action: "error", body: "userEmail required to create room" });
        return;
      }

      ws.userEmail = userEmail;

      let roomCode;
      do {
        roomCode = Math.floor(1000 + Math.random() * 9000).toString();
      } while (rooms[roomCode]);

      ws.room = roomCode;

      rooms[roomCode] = {
        owner: { ws, email: userEmail },
        clients: [],
        quiz: quizData || null,
        state: "waiting",
        timer: null
      };

      console.log(`Room ${roomCode} created by ${userEmail}`);

      safeSend(ws, {
        action: "created",
        body: { roomCode, message: `Room ${roomCode} created`, quiz: quizData || null }
      });

      return;
    }

    // -----------------------------
    // JOIN ROOM
    // -----------------------------
    if (action === "join") {
      leaveRoom(ws);

      const { roomCode, userEmail, username } = body || {};
      if (!roomCode || !userEmail) {
        safeSend(ws, { action: "error", body: "roomCode and userEmail required to join" });
        return;
      }

      const room = rooms[roomCode];
      if (!room) {
        safeSend(ws, { action: "error", body: "Room does not exist" });
        return;
      }

      if (room.state === "started") {
        safeSend(ws, { action: "error", body: "Session already started, cannot join" });
        return;
      }

      ws.userEmail = userEmail;
      ws.room = roomCode;

      const existing = room.clients.find(c => c.email === userEmail);
      if (existing) {
        existing.ws = ws;
      } else {
        room.clients.push({ ws, email: userEmail });
      }

      console.log(`User ${userEmail} joined room ${roomCode}`);

      safeSend(ws, {
        action: "joined",
        body: { message: `Joined room ${roomCode}`, quizData: room.quiz }
      });

      const allClients = [room.owner, ...room.clients];
      allClients.forEach(client => {
        if (client.ws !== ws) {
          safeSend(client.ws, { action: "userJoined", body: userEmail, username: username });
        }
      });

      return;
    }

    // -----------------------------
    // START SESSION
    // -----------------------------
    if (action === "startSession") {
      const { roomCode, timerSeconds } = body || {};
      const room = rooms[roomCode];

      if (!room) {
        safeSend(ws, { action: "error", body: "Room does not exist" });
        return;
      }

      if (!room.owner || room.owner.ws !== ws) {
        safeSend(ws, { action: "error", body: "Only the owner can start the session" });
        return;
      }

      const duration = (typeof timerSeconds === "number")
        ? Math.max(1, Math.floor(timerSeconds))
        : 60;

      room.state = "started";

      const allClients = [room.owner, ...room.clients];
      allClients.forEach(client => {
        safeSend(client.ws, {
          owner: client.email === room.owner.email,
          action: "sessionStarted",
          body: { quizData: room.quiz, timeRemaining: duration }
        });
      });

      console.log(`Session started in room ${roomCode}`);

      if (room.timer?.interval) clearInterval(room.timer.interval);

      room.timer = {
        timeRemaining: duration,
        interval: setInterval(() => {
          const r = rooms[roomCode];
          if (!r) return;

          r.timer.timeRemaining--;

          const everyone = [r.owner, ...r.clients];
          broadcast(everyone, {
            action: "timerTick",
            body: { timeRemaining: r.timer.timeRemaining }
          });

          if (r.timer.timeRemaining <= 0) {
            clearInterval(r.timer.interval);
            r.timer = null;
            r.state = "ended";

            broadcast(everyone, {
              action: "sessionEnded",
              body: "Time is up!"
            });
            console.log("sessionEnded");
          }
        }, 1000)
      };

      return;
    }

    // -----------------------------
    // RECONNECT
    // -----------------------------
    if (action === "reconnect") {
      const { roomCode, userEmail } = body || {};
      if (!roomCode || !userEmail) {
        safeSend(ws, { action: "error", body: "roomCode and userEmail required to reconnect" });
        return;
      }

      const room = rooms[roomCode];
      if (!room) {
        safeSend(ws, { action: "error", body: "Room does not exist" });
        return;
      }

      if (room.state === "ended") {
        safeSend(ws, { action: "error", body: "Room already ended" });
        return;
      }

      ws.userEmail = userEmail;
      ws.room = roomCode;

      if (room.owner.email === userEmail) {
        room.owner.ws = ws;

        safeSend(ws, {
          action: "reconnected",
          body: { quizData: room.quiz, role: "owner", state: room.state, timeRemaining: room.timer?.timeRemaining || null }
        });

        console.log(`Owner ${userEmail} reconnected to room ${roomCode}`);
        return;
      }

      const idx = room.clients.findIndex(c => c.email === userEmail);
      if (idx >= 0) {
        room.clients[idx].ws = ws;
      } else {
        room.clients.push({ ws, email: userEmail });
      }

      safeSend(ws, {
        action: "reconnected",
        body: { quizData: room.quiz, role: "client", state: room.state, timeRemaining: room.timer?.timeRemaining || null }
      });

      console.log(`Client ${userEmail} reconnected to room ${roomCode}`);
      return;
    }

    // -----------------------------
    // NEW: DELETE ROOM (owner only)
    // -----------------------------
    if (action === "deleteRoom") {
      const { roomCode } = body || {};
      console.log(body);
      if (!roomCode) {
        safeSend(ws, { action: "error", body: "roomCode required to delete room" });
        return;
      }

      const room = rooms[roomCode];
      if (!room) {
        safeSend(ws, { action: "error", body: "Room does not exist" });
        return;
      }

      if (room.owner.ws !== ws) {
        safeSend(ws, { action: "error", body: "Only the owner can delete the room" });
        return;
      }

      const everyone = [room.owner, ...room.clients];
      everyone.forEach(client => {
        safeSend(client.ws, {
          action: "roomDeleted",
          body: `Room ${roomCode} was deleted by the owner`,
          owner: client.ws === room.owner.ws  // true if this client is the owner
        });
      });

      deleteRoom(roomCode);
      return;
    }

    // -----------------------------
    // NEW: LEAVE ROOM (client only)
    // -----------------------------
    if (action === "leaveRoom") {
      if (!ws.room) {
        safeSend(ws, { action: "error", body: "You are not in a room" });
        return;
      }

      const roomCode = ws.room;
      const room = rooms[roomCode];

      if (!room) {
        ws.room = null;
        safeSend(ws, { action: "error", body: "Room no longer exists" });
        return;
      }

      if (room.owner.ws === ws) {
        safeSend(ws, { action: "error", body: "Owner cannot leave. Use deleteRoom instead." });
        return;
      }

      room.clients = room.clients.filter(c => c.ws !== ws);
      console.log(`User ${ws.userEmail} left room ${roomCode}`);

      if(!room.clients){
        room.clients = [];
      }

      const everyone = [room.owner, ...room.clients];
      broadcast(everyone, {
        action: "userLeft",
        body: room.clients
      });
      
      safeSend(ws, { action: "leftRoom", body: `You left room ${roomCode}` });

      ws.room = null;
      ws.userEmail = null;

      return;
    }

// -----------------------------
// FINISH QUIZ (client submits score)
// -----------------------------
  if (action === "finishQuiz") {
    const { roomCode, userEmail, score } = body || {};
    
    if (!roomCode || !userEmail || typeof score !== "number") {
      safeSend(ws, { action: "error", body: "roomCode, userEmail, and numeric score required" });
      return;
    }

    const room = rooms[roomCode];
    if (!room) {
      safeSend(ws, { action: "error", body: "Room does not exist" });
      return;
    }



    // Create store if not exists
    if (!room.finished) {
      room.finished = {}; // store by email
    }

    room.finished[userEmail] = score;

    console.log(`User ${userEmail} finished quiz in room ${roomCode} with score ${score}`);
    let timeRemaining = room?.timer?.timeRemaining;
    if(!timeRemaining) timeRemaining = 0;
    // Notify only the owner
    safeSend(room.owner.ws, {
      action: "userFinished",
      body: { userEmail, score, timeRemaining}
    });

    return;
  }


    // -----------------------------
    // SEND MESSAGE
    // -----------------------------
    if (action === "message") {
      if (!ws.room || !rooms[ws.room]) {
        safeSend(ws, { action: "error", body: "You are not in a room" });
        return;
      }

      const room = rooms[ws.room];
      const everyone = [room.owner, ...room.clients];

      broadcast(everyone, { action: "message", body });
      return;
    }

    // Unknown action
    safeSend(ws, { action: "error", body: `Unknown action: ${action}` });
  });

  ws.on("close", () => {
    leaveRoom(ws);
  });

  ws.on("error", () => {
    leaveRoom(ws);
  });
});


console.log("WebSocket server running on ws://0.0.0.0:" + PORT);
