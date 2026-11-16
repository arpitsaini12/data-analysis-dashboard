# SupeRR Selector — Pressure Index

A browser-based cricket analytics dashboard for comparing batter and bowler performance under pressure with each player's non-pressure baseline. It reads the supplied CSV files locally; no data is uploaded.

## Open the dashboard

Open `index.html` in a current desktop browser. The supplied Data Pack is bundled and loads automatically. To analyze a different dataset, select **Import data** and choose its folder. The bundled core files are `ball_by_ball.csv`, `matches.csv`, `competitions.csv`, and `teams.csv`. The large ball-by-ball file is scanned twice in a streaming read so innings targets and pressure situations can be calculated without uploading the data.

The dashboard includes competition, format, season, team, player, venue country, match stage, innings, pressure-signal, sample-size, and ranking-sort filters. Switch between batter and bowler rankings with the tabs above the table.

## Share your analysis

The challenge asks for a reel, post, or short video showing your player-analysis process. You can share how you analyzed the data, a player pick, or a behind-the-scenes “war room” moment. Tag `@rajasthanroyals` and `@unstop.world` when posting.

Suggested caption:

> I used the SupeRR Selector to compare player performance under pressure with each player's usual baseline. Here's the analysis behind my pick: [player name] — [link to your video or post]. @rajasthanroyals @unstop.world

## Pressure model

- **Chase under strain:** second-innings required run rate of at least 9 runs per over for T20/T20I (7 for ODI).
- **Final overs:** the last 25% of scheduled balls in an innings (the last five overs in a 20-over match).
- **Wickets in hand:** four or fewer wickets remain.
- **Knockout:** the match is marked as a knockout or its stage is a qualifier, eliminator, semi-final, or final.
- **Close finish:** the result is a tie/super over, a win by 10 or fewer runs, or a win by two or fewer wickets.

Signals can overlap. **All pressure signals** uses the union, counting a delivery once. A selected single-signal lens compares those deliveries with deliveries outside the union, keeping the baseline consistent.

The batter impact is the strike-rate difference (pressure minus baseline). The bowler impact rewards lower pressure economy and a higher pressure wicket rate relative to baseline. Impact is normalized onto a 0–100 index centered at 50, then shrunk toward 50 for smaller pressure or baseline samples. Rankings require at least 30 non-pressure balls as well as the selected pressure-ball minimum. These are transparent descriptive rankings, not predictions.
