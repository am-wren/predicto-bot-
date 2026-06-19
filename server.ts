import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import {
  connectDB,
  getMatches,
  getMatch,
  createMatch,
  updateMatch,
  getPredictions,
  createOrUpdatePrediction,
  getLeaderboard,
  resolvePredictionMatch,
  getUser,
  isUsingMongoDB
} from "./src/database";
import { startDiscordBot } from "./src/bot/client";
import { dynamicBotName } from "./src/bot/embeds";

// Initialize environment variables
dotenv.config();

console.log("MONGODB_URI =", process.env.MONGODB_URI);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middlewares
  app.use(express.json());

  // Establish Database Connection
  const isMongo = await connectDB();

  // Try to start Discord Bot in the background
  try {
    if (process.env.DISCORD_TOKEN) {
      await startDiscordBot();
    } else {
      console.log("ℹ️ No DISCORD_TOKEN found in environment secrets. Bot client listener starting in Web Simulator Mode.");
    }
  } catch (err) {
    console.error("🔴 Failed to initialize Discord Bot thread:", err);
  }

  // --- API ROUTE ENDPOINTS for both Real Bot status monitoring and Web Simulator ---

  // Health and connection status info
  app.get("/api/status", async (req, res) => {
    try {
      const dbConnected = isUsingMongoDB();
      const dbType = dbConnected ? "MongoDB Atlas" : "Local Database (JSON Fallback)";
      const botActive = !!process.env.DISCORD_TOKEN;

      res.json({
        status: "ok",
        database: {
          connected: true,
          type: dbType,
          mongo: dbConnected
        },
        bot: {
          active: botActive,
          status: botActive ? "Ready & Listening" : "Web Mock Active",
          name: dynamicBotName,
          clientId: process.env.DISCORD_CLIENT_ID || "not_configured"
        }
      });
    } catch (err: any) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // Get Matches
  app.get("/api/matches", async (req, res) => {
    try {
      const matches = await getMatches();
      const predictions = await getPredictions();

      // Return matches with prediction counts injected
      const matchesWithVotes = matches.map((m) => {
        const preds = predictions.filter((p) => p.matchId === m.id);
        const home = preds.filter((p) => p.selection === "home").length;
        const draw = preds.filter((p) => p.selection === "draw").length;
        const away = preds.filter((p) => p.selection === "away").length;

        // Auto expire if expired in memory/db
        const now = new Date();
        let currentStatus = m.status;
        if ((m.status === "upcoming" || m.status === "closing_soon") && now >= m.expiresAt) {
          currentStatus = "closed";
        }

        return {
          ...m,
          status: currentStatus,
          votes: { home, draw, away, total: preds.length }
        };
      });

      res.json(matchesWithVotes);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get active leaderboard
  app.get("/api/leaderboard", async (req, res) => {
    try {
      const users = await getLeaderboard();
      res.json(users);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create match (Webhook or Simulator)
  app.post("/api/commands/create", async (req, res) => {
    try {
      const { home_team, away_team, kickoff_time, prediction_duration, winner_reward, description } = req.body;

      if (!home_team || !away_team || !kickoff_time || !prediction_duration || !winner_reward) {
        return res.status(400).json({ error: "Missing required parameters for match creation." });
      }

      // Calculate next ID
      const matches = await getMatches();
      const nextIdNum = matches.length + 1;
      const matchId = `WC-2026-${String(nextIdNum).padStart(4, "0")}`;

      // Parse duration
      let durationMs = 30 * 60 * 1000; // 30 mins default
      const matchMin = prediction_duration.match(/^(\d+)m$/);
      const matchHr = prediction_duration.match(/^(\d+)h$/);
      if (matchMin) {
        durationMs = parseInt(matchMin[1]) * 60 * 1000;
      } else if (matchHr) {
        durationMs = parseInt(matchHr[1]) * 60 * 60 * 1000;
      }

      const expiresAt = new Date(Date.now() + durationMs);

      const created = await createMatch({
        id: matchId,
        homeTeam: home_team,
        awayTeam: away_team,
        kickoffTime: kickoff_time,
        predictionDuration: prediction_duration,
        winnerReward: winner_reward,
        description: description || "Match Prediction Arena",
        status: "upcoming",
        winner: null,
        expiresAt,
        messageId: "web_mock_" + Date.now(),
        channelId: "web_channel",
      });

      res.status(201).json({ message: "Prediction created!", match: created });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Vote (Simulator)
  app.post("/api/commands/vote", async (req, res) => {
    try {
      const { match_id, user_id, username, selection } = req.body;

      if (!match_id || !user_id || !username || !selection) {
        return res.status(400).json({ error: "Missing match_id, user_id, username, or selection." });
      }

      const parsedSelection = selection.toLowerCase();
      if (!["home", "draw", "away"].includes(parsedSelection)) {
        return res.status(400).json({ error: "Selection must be: home, draw, or away" });
      }

      const prediction = await createOrUpdatePrediction(
        match_id,
        user_id,
        username,
        parsedSelection as "home" | "draw" | "away"
      );

      res.json({ message: "Prediction Registered!", prediction });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Close Predictions (Simulator)
  app.post("/api/commands/close", async (req, res) => {
    try {
      const { match_id } = req.body;
      const match = await getMatch(match_id);

      if (!match) {
        return res.status(404).json({ error: "Match not found." });
      }

      const updated = await updateMatch(match_id, { status: "closed" });
      res.json({ message: `Predictions locked for ${match_id}`, match: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Resolve/Result match and reward distribution (Simulator)
  app.post("/api/commands/resolve", async (req, res) => {
    try {
      const { match_id, winner } = req.body;

      if (!match_id || !winner) {
        return res.status(400).json({ error: "Missing match_id or winner outcome." });
      }

      if (!["home", "draw", "away"].includes(winner)) {
        return res.status(400).json({ error: "Winner outcome must be 'home', 'draw', or 'away'." });
      }

      const results = await resolvePredictionMatch(match_id, winner);
      res.json({ message: `Successfully resolved match ${match_id}`, winner, results });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // User details / Add simulated user for playground helper
  app.get("/api/user/:id", async (req, res) => {
    try {
      const user = await getUser(req.params.id);
      res.json(user);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Load Vite Middleware for single-page React frontend in dev, or serve client dist in production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server initialized perfectly on Port http://0.0.0.0:${PORT}`);
  });
}

startServer();
