const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

let io;

/**
 * Rooms:
 *   admin:{id} / bidder:{id} - personal notifications
 *   admins / bidders         - list pages (new tender, stats)
 *   tender:{id}:admins       - full live board of one tender
 *   tender:{id}:bidders      - same board, anonymized per bidder (prices only)
 */
function initSocket(httpServer, origins) {
  io = new Server(httpServer, { cors: { origin: origins } });

  io.use(async (socket, next) => {
    try {
      const payload = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET);
      const account = await require("./middleware/auth").loadAccount(payload);
      if (!account) throw new Error("inactive");
      socket.data.user = account;
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const { id, type } = socket.data.user;
    socket.join(`${type}:${id}`);
    socket.join(type === "admin" ? "admins" : "bidders");

    // only join a board the user is allowed to see (lazy require avoids a circular import)
    socket.on("tender:join", async (tenderId) => {
      try {
        await require("./services/tenderService").getVisibleTender(socket.data.user, Number(tenderId));
        // admins and bidders watch separate rooms: bidders only ever get the anonymized board
        socket.join(`tender:${Number(tenderId)}:${type === "admin" ? "admins" : "bidders"}`);
      } catch {
        socket.emit("tender:join:error", { tender_id: tenderId });
      }
    });
    socket.on("tender:leave", (tenderId) => socket.leave(`tender:${Number(tenderId)}:${type === "admin" ? "admins" : "bidders"}`));
  });

  return io;
}

function getIO() {
  if (!io) throw new Error("Socket.IO is not initialised");
  return io;
}

module.exports = { initSocket, getIO };
