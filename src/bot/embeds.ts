import { Match, Prediction, UserStats } from "../database";

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbedData {
  title: string;
  description: string;
  color: string; // hex
  fields: EmbedField[];
  footer: { text: string };
  thumbnailUrl: string;
}

export let dynamicBotName = "World Cup Predictor";

export function setDynamicBotName(name: string) {
  dynamicBotName = name;
}

// Custom simple progress bar helper
export function makeProgressBar(percentage: number, length = 10): string {
  const filledCount = Math.min(length, Math.round((percentage / 100) * length));
  const emptyCount = Math.max(0, length - filledCount);
  return `${"█".repeat(filledCount)}${"░".repeat(emptyCount)}`;
}

export function buildMatchEmbed(match: Match, predictions: Prediction[]): DiscordEmbedData {
  const homeVotes = predictions.filter((p) => p.selection === "home").length;
  const drawVotes = predictions.filter((p) => p.selection === "draw").length;
  const awayVotes = predictions.filter((p) => p.selection === "away").length;
  const totalVotes = homeVotes + drawVotes + awayVotes;

  // Percentages
  const homePct = totalVotes > 0 ? Math.round((homeVotes / totalVotes) * 100) : 0;
  const drawPct = totalVotes > 0 ? Math.round((drawVotes / totalVotes) * 100) : 0;
  const awayPct = totalVotes > 0 ? Math.round((awayVotes / totalVotes) * 100) : 0;

  // Color dynamic logic
  let color = "#2ecc71"; // Upcoming (Green)
  let statusText = "Match closes automatically before kickoff.";

  if (match.status === "closing_soon") {
    color = "#f1c40f"; // Closing Soon (Yellow)
    statusText = "⚠️ 💥 Predictions Closing Soon! Act fast!";
  } else if (match.status === "closed" || match.status === "resolved") {
    color = "#e74c3c"; // Closed/Resolved (Red)
    statusText = "🔒 Predictions Closed";
  }

  // If predictions is closed, append that
  let description = `Predict the outcome before kickoff.\n\nChoose who will win and earn rewards if your prediction is correct.\n\n${statusText}`;
  if (match.status === "resolved") {
    description = `🏆 **Match Resolved!**\nWinner Selection: **${match.winner === "home" ? match.homeTeam : match.winner === "draw" ? "🤝 Draw" : match.awayTeam}**\n\nPredictions are closed. Rewards have been distributed.`;
  }

  // Stats text
  const homeBar = makeProgressBar(homePct);
  const drawBar = makeProgressBar(drawPct);
  const awayBar = makeProgressBar(awayPct);

  const statsValue = `📊 **Prediction Statistics**\n` +
    `🏠 **${match.homeTeam}**: ${homePct}% [${homeBar}]\n` +
    `🤝 **Draw**: ${drawPct}% [${drawBar}]\n` +
    `✈️ **${match.awayTeam}**: ${awayPct}% [${awayBar}]`;

  const fields: EmbedField[] = [
    {
      name: "🏠 Home Team",
      value: `**${match.homeTeam}**`,
      inline: true,
    },
    {
      name: "⚔️ Matchup",
      value: "⚡ **VS** ⚡",
      inline: true,
    },
    {
      name: "✈️ Away Team",
      value: `**${match.awayTeam}**`,
      inline: true,
    },
    {
      name: "⏰ Kickoff",
      value: `📆 ${match.kickoffTime}`,
      inline: true,
    },
    {
      name: "🎁 Victory Reward",
      value: `💰 **${match.winnerReward}**\n+100 XP & 3 Points`,
      inline: true,
    },
    {
      name: "🆔 Match ID",
      value: `\`${match.id}\``,
      inline: true,
    },
    {
      name: "📊 Current Votes",
      value: `🏠 Home: **${homeVotes}**\n🤝 Draw: **${drawVotes}**\n✈️ Away: **${awayVotes}**\n*(Total Votes: ${totalVotes})*`,
      inline: false,
    },
    {
      name: "📈 Live Crowd Sentiment",
      value: statsValue,
      inline: false,
    }
  ];

  if (match.description) {
    fields.unshift({
      name: "📝 Match Info",
      value: match.description,
      inline: false,
    });
  }

  return {
    title: `🏆 WORLD CUP PREDICTION ARENA`,
    description,
    color,
    fields,
    footer: { text: `${dynamicBotName} • Match ${match.id} • Prediction Bot Created by @am_wrenn` },
    thumbnailUrl: "https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=120&auto=format&fit=crop&q=60&ixlib=rb-4.0.3" // high quality soccer ball thumbnail
  };
}

export function buildLeaderboardEmbed(users: UserStats[]): DiscordEmbedData {
  let rankingsText = "";
  if (users.length === 0) {
    rankingsText = "No participants yet. Be the first to predict!";
  } else {
    rankingsText = users.slice(0, 10).map((user, idx) => {
      let medal = "🔹";
      if (idx === 0) medal = "🥇";
      else if (idx === 1) medal = "🥈";
      else if (idx === 2) medal = "🥉";
      
      return `${medal} **#${idx + 1}** ${user.username} — **${user.tournamentPoints} pts** (${user.wins}W/${user.losses}L) • \`${user.coins} Coins\` • \`Lvl ${Math.floor(user.xp / 500) + 1}\``;
    }).join("\n");
  }

  return {
    title: `🏆 ${dynamicBotName.toUpperCase()} RANKINGS`,
    description: "The official top predictor rankings. Updated in real-time.",
    color: "#f1c40f", // Gold
    fields: [
      {
        name: "Leaderboard Standings (Top 10 players)",
        value: rankingsText,
        inline: false
      }
    ],
    footer: { text: `${dynamicBotName} • Prediction Bot Created by @am_wrenn` },
    thumbnailUrl: "https://images.unsplash.com/photo-1518063319789-7217e6706b04?w=120&auto=format&fit=crop&q=60" // Golden cup thumbnail
  };
}
