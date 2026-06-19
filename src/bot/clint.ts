import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  Message,
  TextChannel,
  ActivityType
} from "discord.js";
import {
  getMatches,
  getMatch,
  createMatch,
  updateMatch,
  getPredictions,
  createOrUpdatePrediction,
  getLeaderboard,
  resolvePredictionMatch,
  getUser,
  connectDB
} from "../database";
import { buildMatchEmbed, buildLeaderboardEmbed, setDynamicBotName, dynamicBotName } from "./embeds";

let client: Client | null = null;
let updateInterval: NodeJS.Timeout | null = null;

interface LeaderboardMessage {
  channelId: string;
  messageId: string;
}
const activeLeaderboardMessages: LeaderboardMessage[] = [];

// Helper to convert DiscordEmbedData to Discord.js EmbedBuilder
function toDiscordEmbed(embedData: any) {
  const embed = new EmbedBuilder()
    .setTitle(embedData.title)
    .setDescription(embedData.description)
    .setColor(embedData.color as any)
    .setFooter(embedData.footer);

  if (embedData.thumbnailUrl) {
    embed.setThumbnail(embedData.thumbnailUrl);
  }

  embedData.fields.forEach((f: any) => {
    embed.addFields({ name: f.name, value: f.value, inline: f.inline ?? false });
  });

  return embed;
}

// Create action buttons row for predictions
function buildActionRow(matchId: string, disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`prediction_home:${matchId}`)
      .setLabel("🏠 Home Win")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`prediction_draw:${matchId}`)
      .setLabel("🤝 Draw")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`prediction_away:${matchId}`)
      .setLabel("✈️ Away Win")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}

// Register Guild & Global Slash Commands
export async function deployCommands(token: string, clientId: string) {
  const commands = [
    new SlashCommandBuilder()
      .setName("prediction")
      .setDescription("Manage and enter World Cup predictions")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Create a new manual prediction match (Admins only)")
          .addStringOption((o) => o.setName("home_team").setDescription("Name of the Home Team").setRequired(true))
          .addStringOption((o) => o.setName("away_team").setDescription("Name of the Away Team").setRequired(true))
          .addStringOption((o) => o.setName("kickoff_time").setDescription("Time of kickoff (e.g. 22:00 UTC)").setRequired(true))
          .addStringOption((o) => o.setName("prediction_duration").setDescription("Length of predictions (e.g. 30m, 1h, 2h)").setRequired(true))
          .addStringOption((o) => o.setName("winner_reward").setDescription("Coins payout (e.g. 500 Coins)").setRequired(true))
          .addStringOption((o) => o.setName("description").setDescription("Brief match details").setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName("close")
          .setDescription("Lock predictions for a specific match (Admins only)")
          .addStringOption((o) => o.setName("match_id").setDescription("ID of the prediction match (e.g. WC-2026-0001)").setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName("result")
          .setDescription("Resolve prediction match winners and distribute rewards (Admins only)")
          .addStringOption((o) => o.setName("match_id").setDescription("ID of the prediction match").setRequired(true))
          .addStringOption((o) =>
            o
              .setName("winner")
              .setDescription("The outcome of the match")
              .setRequired(true)
              .addChoices(
                { name: "🏠 Home Win", value: "home" },
                { name: "🤝 Draw", value: "draw" },
                { name: "✈️ Away Win", value: "away" }
              )
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("leaderboard")
          .setDescription("Show the current World Cup prediction rankings")
      ),
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Get the full list of available commands and how to use them"),
  ].map((cmd) => cmd.toJSON());

  const rest = new REST({ version: "10" }).setToken(token);

  try {
    console.log("Started refreshing application (/) commands.");
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("Successfully reloaded application (/) commands globally.");
  } catch (error) {
    console.error("Error deploying slash commands:", error);
  }
}

// Periodically updates live embeds on active prediction messages and auto-closes expired ones
async function startAutoUpdates(clientInstance: Client) {
  if (updateInterval) clearInterval(updateInterval);

  updateInterval = setInterval(async () => {
    try {
      const matches = await getMatches();
      const now = new Date();

      for (const match of matches) {
        // 1. Check auto-close criteria (ExpiresAt passed but still upcoming/closing_soon)
        if ((match.status === "upcoming" || match.status === "closing_soon") && now >= match.expiresAt) {
          console.log(`Auto-closing match predictions: ${match.id}`);
          const updatedMatch = await updateMatch(match.id, { status: "closed" });
          if (updatedMatch && updatedMatch.messageId && updatedMatch.channelId) {
            try {
              const channel = (await clientInstance.channels.fetch(updatedMatch.channelId)) as TextChannel;
              if (channel) {
                const message = await channel.messages.fetch(updatedMatch.messageId);
                const predictions = await getPredictions(updatedMatch.id);
                const closedEmbed = toDiscordEmbed(buildMatchEmbed(updatedMatch, predictions));
                const closedRow = buildActionRow(updatedMatch.id, true); // disabled buttons

                await message.edit({
                  embeds: [closedEmbed],
                  components: [closedRow],
                });
              }
            } catch (err) {
              console.error(`Failed to update Closed Discord Message for ${match.id}:`, err);
            }
          }
          continue;
        }

        // 2. Check closing soon transition (within 5 minutes of closing)
        if (match.status === "upcoming" && match.expiresAt.getTime() - now.getTime() <= 5 * 60 * 1000) {
          await updateMatch(match.id, { status: "closing_soon" });
        }

        // 3. Regular active updates of embed text and stats
        if (match.status === "upcoming" || match.status === "closing_soon") {
          if (match.messageId && match.channelId) {
            try {
              const channel = (await clientInstance.channels.fetch(match.channelId)) as TextChannel;
              if (channel) {
                const message = await channel.messages.fetch(match.messageId);
                const predictions = await getPredictions(match.id);
                const updatedEmbed = toDiscordEmbed(buildMatchEmbed(match, predictions));
                const activeRow = buildActionRow(match.id, false);

                await message.edit({
                  embeds: [updatedEmbed],
                  components: [activeRow]
                });
              }
            } catch (err) {
              // Might be deleted or permission denied, ignore
            }
          }
        }
      }

      // 4. Update any active leaderboard messages
      if (activeLeaderboardMessages.length > 0) {
        const rankings = await getLeaderboard();
        const leaderboardEmbed = toDiscordEmbed(buildLeaderboardEmbed(rankings));
        for (const msg of [...activeLeaderboardMessages]) {
          try {
            const channel = (await clientInstance.channels.fetch(msg.channelId)) as TextChannel;
            if (channel) {
              const message = await channel.messages.fetch(msg.messageId);
              if (message) {
                await message.edit({
                  embeds: [leaderboardEmbed]
                });
              }
            }
          } catch (err) {
            // Remove from cache if deleted or error
            const idx = activeLeaderboardMessages.findIndex(m => m.messageId === msg.messageId);
            if (idx !== -1) {
              activeLeaderboardMessages.splice(idx, 1);
            }
          }
        }
      }
    } catch (error) {
      console.error("Error in background auto-updates cron:", error);
    }
  }, 30000); // 30 seconds
}

// Core Bot Handler Initialization
function startRotatingStatus(clientInstance: Client) {
  const statuses = [
    "🎯 Predict with /predict",
    "🏆 Tracking Leaderboards",
    "📊 Managing Predictions",
    "👑 By @am_wrenn"
  ];

  let currentIndex = 0;

  const updateStatus = () => {
    const statusText = statuses[currentIndex];
    try {
      clientInstance.user?.setPresence({
        activities: [
          {
            name: "customstatus",
            state: statusText,
            type: ActivityType.Custom
          }
        ],
        status: "online"
      });
      console.log(`[Status System] Discord bot status updated to: "${statusText}"`);
    } catch (error) {
      console.error(`[Status System] Failed to update status to "${statusText}":`, error);
    }
    currentIndex = (currentIndex + 1) % statuses.length;
  };

  // Set initial status right away
  updateStatus();

  // Rotate every 30 seconds
  setInterval(updateStatus, 30000);

  console.log("🟢 Rotating Discord bot status system started (rotating every 30s).");
}

export async function startDiscordBot() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!token) {
    console.log("⚠️ DISCORD_TOKEN is missing. Direct Live Discord Chat listener is disabled. Play in beautiful Web Simulator instead!");
    return;
  }

  // Auto connect database if not connected
  await connectDB();

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ],
  });

  client.on("ready", async () => {
    console.log(`🟢 Discord Bot logged in successfully as ${client?.user?.tag}!`);
    if (client?.user?.username) {
      setDynamicBotName(client.user.username);
    }
    if (clientId) {
      await deployCommands(token, clientId);
    }
    // Start background timer
    startAutoUpdates(client!);
    // Start status rotation
    startRotatingStatus(client!);
  });

  // Slash Command Handler
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options } = interaction as ChatInputCommandInteraction;

    if (commandName === "help") {
      const dbBotName = interaction.client.user?.username || dynamicBotName;
      const helpEmbed = new EmbedBuilder()
        .setTitle(`📖 ${dbBotName} Help Desk`)
        .setDescription(`Welcome to **${dbBotName}**! Predict match outcomes correctly to climb the leaderboard, earn points, and win rewards. Below is the list of all available commands:`)
        .setColor("#3498db")
        .addFields(
          {
            name: "👥 General Commands",
            value: "• `/prediction leaderboard` - View the live prediction leaderboard and top players."
          },
          {
            name: "👑 Admin Commands (Requires Manage Server permission)",
            value: 
              "• `/prediction create` - Initialize a new prediction arena with custom teams, durations, and rewards.\n" +
              "• `/prediction close` - Lock/close predictions manually for a match before kickoff.\n" +
              "• `/prediction result` - Resolve match results (Home, Draw, Away) and distribute coin prizes, XP, and Trophy Points."
          },
          {
            name: "❓ Assistance",
            value: "• `/help` - Show this command list."
          }
        )
        .setFooter({ text: `${dbBotName} • Help Desk • Prediction Bot Created by @am_wrenn` })
        .setTimestamp();

      await interaction.reply({ embeds: [helpEmbed] });
      return;
    }

    if (commandName === "prediction") {
      const subcommand = options.getSubcommand();
      const isManager = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

      // Create Prediction Command
      if (subcommand === "create") {
        if (!isManager) {
          await interaction.reply({
            content: "❌ **Access Denied:** You need `Manage Server` permissions to use this command.",
            ephemeral: true,
          });
          return;
        }

        const homeTeam = options.getString("home_team", true);
        const awayTeam = options.getString("away_team", true);
        const kickoffTime = options.getString("kickoff_time", true);
        const durationStr = options.getString("prediction_duration", true);
        const reward = options.getString("winner_reward", true);
        const description = options.getString("description", true);

        // Generate next ID
        const existing = await getMatches();
        const nextNum = existing.length + 1;
        const matchId = `WC-2026-${String(nextNum).padStart(4, "0")}`;

        // Parse duration
        let durationMs = 30 * 60 * 1000; // 30m default
        const matchMin = durationStr.match(/^(\d+)m$/);
        const matchHr = durationStr.match(/^(\d+)h$/);
        if (matchMin) {
          durationMs = parseInt(matchMin[1]) * 60 * 1000;
        } else if (matchHr) {
          durationMs = parseInt(matchHr[1]) * 60 * 60 * 1000;
        }

        const expiresAt = new Date(Date.now() + durationMs);

        await interaction.deferReply();

        try {
          // Store in DB
          const created = await createMatch({
            id: matchId,
            homeTeam,
            awayTeam,
            kickoffTime,
            predictionDuration: durationStr,
            winnerReward: reward,
            description,
            status: "upcoming",
            winner: null,
            expiresAt,
            messageId: null, // to be updated immediately after
            channelId: interaction.channelId,
          });

          const embedObj = buildMatchEmbed(created, []);
          const discordEmbed = toDiscordEmbed(embedObj);
          const interactiveRow = buildActionRow(matchId, false);

          const message = await interaction.editReply({
            embeds: [discordEmbed],
            components: [interactiveRow],
          });

          // update match with real Discord Message ID
          await updateMatch(matchId, {
            messageId: message.id,
          });
        } catch (err: any) {
          console.error("Failed to create prediction match:", err);
          await interaction.editReply({
            content: `❌ Error creating prediction: ${err.message}`,
          });
        }
      }

      // Close Prediction Command
      if (subcommand === "close") {
        if (!isManager) {
          await interaction.reply({
            content: "❌ **Access Denied:** You need `Manage Server` permissions.",
            ephemeral: true,
          });
          return;
        }

        const matchId = options.getString("match_id", true);
        const match = await getMatch(matchId);

        if (!match) {
          await interaction.reply({ content: "❌ Match ID not found.", ephemeral: true });
          return;
        }

        if (match.status === "closed" || match.status === "resolved") {
          await interaction.reply({ content: "⚠️ Predictions are already closed/resolved.", ephemeral: true });
          return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
          const updated = await updateMatch(matchId, { status: "closed" });
          const predictions = await getPredictions(matchId);

          if (updated && updated.messageId && updated.channelId) {
            try {
              const ch = (await client?.channels.fetch(updated.channelId)) as TextChannel;
              const msg = await ch.messages.fetch(updated.messageId);
              await msg.edit({
                embeds: [toDiscordEmbed(buildMatchEmbed(updated, predictions))],
                components: [buildActionRow(matchId, true)],
              });
            } catch (err) {
              console.log("Could not update discord message upon manual closure:", err);
            }
          }

          await interaction.editReply({
            content: `🔒 **Predictions locked successfully** for Match \`${matchId}\`.`,
          });
        } catch (err: any) {
          await interaction.editReply({ content: `❌ Error: ${err.message}` });
        }
      }

      // Result Resolution Command
      if (subcommand === "result") {
        if (!isManager) {
          await interaction.reply({
            content: "❌ **Access Denied:** You need `Manage Server` permissions.",
            ephemeral: true,
          });
          return;
        }

        const matchId = options.getString("match_id", true);
        const winner = options.getString("winner", true) as "home" | "draw" | "away";

        const match = await getMatch(matchId);
        if (!match) {
          await interaction.reply({ content: "❌ Match ID not found.", ephemeral: true });
          return;
        }

        if (match.status === "resolved") {
          await interaction.reply({ content: "⚠️ This match has already been resolved and rewards distributed.", ephemeral: true });
          return;
        }

        await interaction.deferReply();

        try {
          const results = await resolvePredictionMatch(matchId, winner);
          const resolvedMatch = await getMatch(matchId);
          const predictions = await getPredictions(matchId);

          if (resolvedMatch && resolvedMatch.messageId && resolvedMatch.channelId) {
            try {
              const ch = (await client?.channels.fetch(resolvedMatch.channelId)) as TextChannel;
              const msg = await ch.messages.fetch(resolvedMatch.messageId);
              await msg.edit({
                embeds: [toDiscordEmbed(buildMatchEmbed(resolvedMatch, predictions))],
                components: [buildActionRow(matchId, true)], // keep disabled buttons
              });
            } catch (err) {
              console.log("Could not edit message upon resolution:", err);
            }
          }

          // Format announcement embed of results
          const rewardOverview = `🏆 **Match Resolution: ${resolvedMatch?.homeTeam} vs ${resolvedMatch?.awayTeam}**\n` +
            `Winner Outcome: **${winner === "home" ? resolvedMatch?.homeTeam : winner === "draw" ? "Draw 🤝" : resolvedMatch?.awayTeam}**\n\n` +
            `💰 Reward pool claimed: **${match.winnerReward}** • **100 XP** • **3 TP**\n` +
            `🛡️ Correct Predictions: **${results.winnersCount} players**\n` +
            `🎖️ Wrong Predictions (Participation): **${results.losersCount} players** (+10 XP)`;

          const resEmbed = new EmbedBuilder()
            .setTitle("🏆 PREDICTION ARENA RESOLVED!")
            .setDescription(rewardOverview)
            .setColor("#00ff00")
            .setTimestamp();

          await interaction.editReply({
            embeds: [resEmbed],
          });
        } catch (err: any) {
          await interaction.editReply({ content: `❌ Resolution failed: ${err.message}` });
        }
      }

      // Leaderboard Command
      if (subcommand === "leaderboard") {
        await interaction.deferReply();
        try {
          const rankings = await getLeaderboard();
          const embed = toDiscordEmbed(buildLeaderboardEmbed(rankings));
          const message = await interaction.editReply({ embeds: [embed] });
          if (message && message.id && message.channelId) {
            if (!activeLeaderboardMessages.some((msg) => msg.messageId === message.id)) {
              activeLeaderboardMessages.push({
                channelId: message.channelId,
                messageId: message.id
              });
            }
          }
        } catch (err: any) {
          await interaction.editReply({ content: `❌ Error loading rankings: ${err.message}` });
        }
      }
    }
  });

  // Button Click Interaction Handles Voting
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;

    const btnInteraction = interaction as ButtonInteraction;
    const [action, matchId] = btnInteraction.customId.split(":");

    if (action.startsWith("prediction_")) {
      const selection = action.replace("prediction_", "") as "home" | "draw" | "away";

      try {
        const match = await getMatch(matchId);
        if (!match) {
          await btnInteraction.reply({ content: "❌ This prediction arena no longer exists.", ephemeral: true });
          return;
        }

        const now = new Date();
        if (match.status === "closed" || match.status === "resolved" || now >= match.expiresAt) {
          await btnInteraction.reply({ content: "🔒 Oops! Predictions are already closed for this matchup.", ephemeral: true });
          return;
        }

        // Save prediction
        await createOrUpdatePrediction(
          matchId,
          btnInteraction.user.id,
          btnInteraction.user.username,
          selection
        );

        const selectionName = selection === "home" ? match.homeTeam : selection === "draw" ? "🤝 Draw" : match.awayTeam;
        const selectionEmoji = selection === "home" ? "🏠" : selection === "draw" ? "🤝" : "✈️";

        // Send confirmation
        await btnInteraction.reply({
          content: `✅ **Prediction Registered!**\n\nYour Selection: **${selectionEmoji} ${selectionName}**\n\nGood luck! 🏆`,
          ephemeral: true,
        });

        // Instant visual update of message embed stats
        const activePredictions = await getPredictions(matchId);
        const updatedEmbed = toDiscordEmbed(buildMatchEmbed(match, activePredictions));
        const currentButtons = buildActionRow(matchId, false);

        await btnInteraction.message.edit({
          embeds: [updatedEmbed],
          components: [currentButtons],
        });
      } catch (err: any) {
        await btnInteraction.reply({ content: `❌ Error registering prediction: ${err.message}`, ephemeral: true });
      }
    }
  });
   // Login to Discord
  try {
    await client.login(token);
    console.log("🚀 Discord login started...");
  } catch (err) {
    console.error("❌ Discord login failed:", err);
  }

}
