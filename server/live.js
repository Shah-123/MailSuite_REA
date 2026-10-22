// Fans tracking events out to each user's open dashboards over Server-Sent Events.
export function createLiveHub() {
  const clients = new Map();

  return {
    subscribe(userId, res) {
      res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.flushHeaders();
      res.write(": connected\n\n");
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
      const set = clients.get(userId) ?? new Set();
      set.add(res);
      clients.set(userId, set);
      res.on("close", () => {
        clearInterval(keepAlive);
        set.delete(res);
        if (set.size === 0) clients.delete(userId);
      });
    },

    publish(userId, event) {
      for (const res of clients.get(userId) ?? []) {
        res.write(`event: tracking\ndata: ${JSON.stringify(event)}\n\n`);
      }
    },
  };
}
