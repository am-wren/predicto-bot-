import fs from "fs";
import path from "path";
import mongoose from "mongoose";

// Interface Definitions
export interface Match {
  id: string; // e.g. WC-2026-0001
  homeTeam: string;
  awayTeam: string;
  kickoffTime: string;
  predictionDuration: string;
  winnerReward: string;
  description: string;
  status: "upcoming" | "closing_soon" | "closed" | "resolved";
  winner: "home" | "draw" | "away" | null;
  createdAt: Date;
  expiresAt: Date;
  messageId: string | null;
  channelId: string | null;
}

export interface Prediction {
  id: string;
  matchId: string;
  userId: string;
  username: string;
  selection: "home" | "draw" | "away";
  timestamp: Date;
}

export interface UserStats {
  userId: string;
  username: string;
  coins: number;
  xp: number;
  tournamentPoints: number;
  wins: number;
  losses: number;
}

// Check MongoDB URI


// 1. Mongoose Schemas (if MONGODB_URI is provided)
const MatchSchema = new mongoose.Schema<Match>({
  id: { type: String, required: true, unique: true },
  homeTeam: { type: String, required: true },
  awayTeam: { type: String, required: true },
  kickoffTime: { type: String, required: true },
  predictionDuration: { type: String, required: true },
  winnerReward: { type: String, required: true },
  description: { type: String },
  status: { type: String, enum: ["upcoming", "closing_soon", "closed", "resolved"], default: "upcoming" },
  winner: { type: String, enum: ["home", "draw", "away", null], default: null },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  messageId: { type: String, default: null },
  channelId: { type: String, default: null },
});

const PredictionSchema = new mongoose.Schema<Prediction>({
  id: { type: String, required: true, unique: true },
  matchId: { type: String, required: true },
  userId: { type: String, required: true },
  username: { type: String, required: true },
  selection: { type: String, enum: ["home", "draw", "away"], required: true },
  timestamp: { type: Date, default: Date.now },
});

// Compound index to ensure unique vote per user per match
PredictionSchema.index({ matchId: 1, userId: 1 }, { unique: true });

const UserStatsSchema = new mongoose.Schema<UserStats>({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  coins: { type: Number, default: 0 },
  xp: { type: Number, default: 0 },
  tournamentPoints: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
});

let MongoMatch: mongoose.Model<Match>;
let MongoPrediction: mongoose.Model<Prediction>;
let MongoUserStats: mongoose.Model<UserStats>;

const isMongoConnected = !!process.env.MONGODB_URI;
if (mongoose.connection.readyState === 1) {
  MongoMatch = mongoose.models.Match || mongoose.model<Match>("Match", MatchSchema);
  MongoPrediction = mongoose.models.Prediction || mongoose.model<Prediction>("Prediction", PredictionSchema);
  MongoUserStats = mongoose.models.UserStats || mongoose.model<UserStats>("UserStats", UserStatsSchema);
}

// 2. File-based Database Fallback
const DATA_FILE = path.join(process.cwd(), "db-fallback.json");

interface LocalData {
  matches: Match[];
  predictions: Prediction[];
  users: UserStats[];
}

const DEFAULT_DATA: LocalData = {
  matches: [
    {
      id: "WC-2026-0001",
      homeTeam: "Saudi Arabia",
      awayTeam: "Uruguay",
      kickoffTime: "22:00 UTC",
      predictionDuration: "30m",
      winnerReward: "500 Coins",
      description: "Group Stage Match",
      status: "upcoming",
      winner: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 mins
      messageId: "mock_msg_001",
      channelId: "mock_chan_001",
    }
  ],
  predictions: [],
  users: [],
};

function readLocalData(): LocalData {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(data);
      // parse dates
      parsed.matches = parsed.matches.map((m: any) => ({
        ...m,
        createdAt: new Date(m.createdAt),
        expiresAt: new Date(m.expiresAt),
      }));
      parsed.predictions = parsed.predictions.map((p: any) => ({
        ...p,
        timestamp: new Date(p.timestamp),
      }));
      return parsed;
    }
  } catch (error) {
    console.error("Failed to read local database fallback:", error);
  }
  // Initialize file
  writeLocalData(DEFAULT_DATA);
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function writeLocalData(data: LocalData) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.error("Failed to write local database fallback:", error);
  }
}

// 3. Unified Database Methods
export async function connectDB(): Promise<boolean> {
  const MONGODB_URI = process.env.MONGODB_URI || "";

  if (!MONGODB_URI) {
    console.log("ℹ️ No MONGODB_URI configured. Using file-based JSON database (db-fallback.json) instead.");

    if (!fs.existsSync(DATA_FILE)) {
      writeLocalData(DEFAULT_DATA);
    }

    return false;
  }

  try {
    await mongoose.connect(MONGODB_URI);
    console.log("🟢 Successfully connected to MongoDB Database.");
    return true;
  } catch (err) {
    console.error("🔴 MongoDB connection failed:", err);
    return false;
  }
}

export function isUsingMongoDB(): boolean {
  return mongoose.connection.readyState === 1;
}

// MATCH OPERATIONS
export async function getMatches(): Promise<Match[]> {
  if (isUsingMongoDB()) {
    return await MongoMatch.find().sort({ createdAt: -1 });
  } else {
    const data = readLocalData();
    return data.matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}

export async function getMatch(id: string): Promise<Match | null> {
  if (isUsingMongoDB()) {
    return await MongoMatch.findOne({ id });
  } else {
    const data = readLocalData();
    return data.matches.find((m) => m.id === id) || null;
  }
}

export async function createMatch(matchData: Omit<Match, "createdAt">): Promise<Match> {
  if (isUsingMongoDB()) {
    const match = new MongoMatch({ ...matchData, createdAt: new Date() });
    await match.save();
    return match.toObject() as Match;
  } else {
    const data = readLocalData();
    const newMatch: Match = {
      ...matchData,
      createdAt: new Date(),
    };
    data.matches.push(newMatch);
    writeLocalData(data);
    return newMatch;
  }
}

export async function updateMatch(id: string, update: Partial<Match>): Promise<Match | null> {
  if (isUsingMongoDB()) {
    const match = await MongoMatch.findOneAndUpdate({ id }, { $set: update }, { new: true });
    return match ? (match.toObject() as Match) : null;
  } else {
    const data = readLocalData();
    const index = data.matches.findIndex((m) => m.id === id);
    if (index === -1) return null;
    data.matches[index] = { ...data.matches[index], ...update };
    writeLocalData(data);
    return data.matches[index];
  }
}

// PREDICTION OPERATIONS
export async function getPredictions(matchId?: string): Promise<Prediction[]> {
  if (isUsingMongoDB()) {
    const filter = matchId ? { matchId } : {};
    return await MongoPrediction.find(filter);
  } else {
    const data = readLocalData();
    if (matchId) {
      return data.predictions.filter((p) => p.matchId === matchId);
    }
    return data.predictions;
  }
}

export async function getUserPrediction(matchId: string, userId: string): Promise<Prediction | null> {
  if (isUsingMongoDB()) {
    return await MongoPrediction.findOne({ matchId, userId });
  } else {
    const data = readLocalData();
    return data.predictions.find((p) => p.matchId === matchId && p.userId === userId) || null;
  }
}

export async function createOrUpdatePrediction(
  matchId: string,
  userId: string,
  username: string,
  selection: "home" | "draw" | "away"
): Promise<Prediction> {
  const predictionId = `PRED-${matchId}-${userId}`;
  const now = new Date();

  // Validate match is not closed
  const match = await getMatch(matchId);
  if (!match) throw new Error("Match not found");
  if (match.status === "closed" || match.status === "resolved" || now > match.expiresAt) {
    throw new Error("Predictions are already closed for this match!");
  }

  if (isUsingMongoDB()) {
    const prediction = await MongoPrediction.findOneAndUpdate(
      { matchId, userId },
      { id: predictionId, username, selection, timestamp: now },
      { upsert: true, new: true }
    );
    return prediction.toObject() as Prediction;
  } else {
    const data = readLocalData();
    const index = data.predictions.findIndex((p) => p.matchId === matchId && p.userId === userId);
    const pred: Prediction = {
      id: predictionId,
      matchId,
      userId,
      username,
      selection,
      timestamp: now,
    };
    if (index !== -1) {
      data.predictions[index] = pred;
    } else {
      data.predictions.push(pred);
    }
    writeLocalData(data);
    return pred;
  }
}

// USER AND REWARDS OPERATIONS
export async function getUsers(): Promise<UserStats[]> {
  if (isUsingMongoDB()) {
    const users = await MongoUserStats.find();
    return users.map(u => ({
      ...u.toObject(),
      coins: parseInt(u.coins as any) || 0
    })) as any;
  } else {
    const data = readLocalData();
    return data.users;
  }
}

export async function getUser(userId: string, usernameFallback = "User"): Promise<UserStats> {
  if (isUsingMongoDB()) {
    let u = await MongoUserStats.findOne({ userId });
    if (!u) {
      u = new MongoUserStats({
        userId,
        username: usernameFallback,
        coins: 0,
        xp: 0,
        tournamentPoints: 0,
        wins: 0,
        losses: 0,
      });
      await u.save();
    }
    const obj = u.toObject();
    return {
      ...obj,
      coins: parseInt(obj.coins as any) || 0
    } as any;
  } else {
    const data = readLocalData();
    let u = data.users.find((x) => x.userId === userId);
    if (!u) {
      u = {
        userId,
        username: usernameFallback,
        coins: 0,
        xp: 0,
        tournamentPoints: 0,
        wins: 0,
        losses: 0,
      };
      data.users.push(u);
      writeLocalData(data);
    }
    return u;
  }
}

export async function updateUserStats(
  userId: string,
  username: string,
  update: Partial<Omit<UserStats, "userId" | "username">>
): Promise<UserStats> {
  const current = await getUser(userId, username);
  const newCoins = Math.max(0, (current.coins || 0) + (update.coins || 0));
  const newXP = Math.max(0, (current.xp || 0) + (update.xp || 0));
  const newTP = Math.max(0, (current.tournamentPoints || 0) + (update.tournamentPoints || 0));
  const newWins = (current.wins || 0) + (update.wins || 0);
  const newLosses = (current.losses || 0) + (update.losses || 0);

  if (isUsingMongoDB()) {
    const u = await MongoUserStats.findOneAndUpdate(
      { userId },
      {
        username,
        coins: String(newCoins),
        xp: newXP,
        tournamentPoints: newTP,
        wins: newWins,
        losses: newLosses,
      },
      { upsert: true, new: true }
    );
    const obj = u.toObject();
    return {
      ...obj,
      coins: parseInt(obj.coins as any) || 0
    } as any;
  } else {
    const data = readLocalData();
    const index = data.users.findIndex((x) => x.userId === userId);
    const updatedUser: UserStats = {
      userId,
      username,
      coins: newCoins,
      xp: newXP,
      tournamentPoints: newTP,
      wins: newWins,
      losses: newLosses,
    };
    if (index !== -1) {
      data.users[index] = updatedUser;
    } else {
      data.users.push(updatedUser);
    }
    writeLocalData(data);
    return updatedUser;
  }
}

// GET LEADERBOARD
export async function getLeaderboard(): Promise<UserStats[]> {
  const allUsers = await getUsers();
  // Sort by tournament points descending, then XP, then Coins
  return allUsers.sort((a, b) => {
    if (b.tournamentPoints !== a.tournamentPoints) {
      return b.tournamentPoints - a.tournamentPoints;
    }
    if (b.xp !== a.xp) {
      return b.xp - a.xp;
    }
    return b.coins - a.coins;
  });
}

// RESOLVE MATCH PREDICTIONS AND REWARD PARTICIPANTS
export async function resolvePredictionMatch(matchId: string, winner: "home" | "draw" | "away") {
  // 1. Get Match
  const match = await getMatch(matchId);
  if (!match) throw new Error("Match not found");
  if (match.status === "resolved") throw new Error("Match already resolved");

  // 2. Parse reward coins
  let coinReward = 500;
  const matchNum = match.winnerReward.match(/\d+/);
  if (matchNum) {
    coinReward = parseInt(matchNum[0]);
  }

  // 3. Mark match as resolved
  await updateMatch(matchId, { status: "resolved", winner });

  // 4. Find all predictions for this match
  const predictions = await getPredictions(matchId);

  const resultsSummary = {
    winnersCount: 0,
    losersCount: 0,
    list: [] as Array<{ userId: string; username: string; correct: boolean; rewardCoins: number; rewardXP: number; rewardTP: number }>
  };

  // 5. Update user rewards
  for (const p of predictions) {
    const isCorrect = p.selection === winner;
    let coinsGained = 0;
    let xpGained = 10; // participation
    let tpGained = 0;

    if (isCorrect) {
      coinsGained = coinReward;
      xpGained = 100;
      tpGained = 3;
      resultsSummary.winnersCount++;
    } else {
      resultsSummary.losersCount++;
    }

    // Update DB stats for user
    await updateUserStats(p.userId, p.username, {
      coins: coinsGained,
      xp: xpGained,
      tournamentPoints: tpGained,
      wins: isCorrect ? 1 : 0,
      losses: isCorrect ? 0 : 1,
    });

    resultsSummary.list.push({
      userId: p.userId,
      username: p.username,
      correct: isCorrect,
      rewardCoins: coinsGained,
      rewardXP: xpGained,
      rewardTP: tpGained,
    });
  }

  return resultsSummary;
}
