(() => {
  const $ = (selector) => document.querySelector(selector);
  const fileInput = $("#dataFiles");
  const importOverlay = $("#importOverlay");
  const importProgress = $("#importProgress");
  const importError = $("#importError");
  const filterIds = ["competitionFilter", "formatFilter", "seasonFilter", "teamFilter", "playerFilter", "venueFilter", "stageFilter", "inningsFilter", "pressureFilter", "sampleFilter"];
  const filterElements = Object.fromEntries(filterIds.map((id) => [id, document.getElementById(id)]));
  const names = {
    all: "All pressure signals",
    chase: "Chase under strain",
    late: "Final five overs",
    wickets: "Four or fewer wickets left",
    knockout: "Knockout matches",
    close: "Close finishes"
  };
  const pressureKinds = ["all", "chase", "late", "wickets", "knockout", "close"];
  const signalKinds = ["chase", "late", "wickets", "knockout", "close"];
  const state = { data: null, kind: "batting", toastTimer: 0 };

  function showImport() {
    importError.hidden = true;
    importOverlay.hidden = false;
  }

  function closeImport() {
    importOverlay.hidden = true;
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3400);
  }

  function parseLine(line) {
    const fields = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = !quoted;
        }
      } else if (char === "," && !quoted) {
        fields.push(field);
        field = "";
      } else {
        field += char;
      }
    }
    fields.push(field);
    return fields;
  }

  function csvRows(text) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    const headers = parseLine(lines.shift() || "").map((value) => value.trim());
    return lines.filter((line) => line.length > 0).map((line) => {
      const cells = parseLine(line);
      const row = {};
      headers.forEach((header, index) => { row[header] = cells[index] ?? ""; });
      return row;
    });
  }

  function asNumber(value) {
    const result = Number(value);
    return Number.isFinite(result) ? result : 0;
  }

  function yes(value) {
    return value === true || String(value).toLowerCase() === "true" || value === "1";
  }

  function baseName(file) {
    return (file.name.split(/[\\/]/).pop() || "").toLowerCase();
  }

  function progress(label, percent) {
    $("#progressLabel").textContent = label;
    $("#progressPercent").textContent = `${Math.round(percent)}%`;
    $("#progressBar").style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }

  async function readRows(file, callback, report) {
    const reader = file.stream().getReader();
    const decoder = new TextDecoder();
    let remainder = "";
    let header = null;
    let rowCount = 0;
    let bytesRead = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytesRead += result.value.byteLength;
      const chunk = remainder + decoder.decode(result.value, { stream: true });
      const lines = chunk.split(/\r?\n/);
      remainder = lines.pop() || "";
      for (const line of lines) {
        if (!line) continue;
        const cells = parseLine(line);
        if (!header) {
          header = cells;
          continue;
        }
        callback(cells, header);
        rowCount += 1;
      }
      if (report && (rowCount % 25000 === 0 || bytesRead === file.size)) {
        report(bytesRead / Math.max(1, file.size), rowCount);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }
    const last = remainder + decoder.decode();
    if (last.trim()) {
      const cells = parseLine(last);
      if (!header) header = cells;
      else {
        callback(cells, header);
        rowCount += 1;
      }
    }
    return rowCount;
  }

  function rowObject(cells, header) {
    const row = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = cells[i] ?? "";
    return row;
  }

  function put(map, key, initial) {
    if (!map.has(key)) map.set(key, initial());
    return map.get(key);
  }

  function newMeasure() {
    return { balls: 0, runs: 0, wickets: 0 };
  }

  function addDelivery(measure, balls, runs, wickets) {
    measure.balls += balls;
    measure.runs += runs;
    measure.wickets += wickets;
  }

  function makeInnings() {
    return { runs: 0, wickets: 0, legalBalls: 0 };
  }

  function buildMatches(rows, competitions, teamNames) {
    const result = new Map();
    for (const row of rows) {
      const compId = String(row.comp_id || "");
      const homeId = String(row.home_team_id || "");
      const awayId = String(row.away_team_id || "");
      const competition = competitions.get(compId);
      if (homeId) teamNames.set(`${compId}|${homeId}`, row.home_team || teamNames.get(`${compId}|${homeId}`) || "");
      if (awayId) teamNames.set(`${compId}|${awayId}`, row.away_team || teamNames.get(`${compId}|${awayId}`) || "");
      result.set(String(row.match_id), {
        id: String(row.match_id),
        compId,
        competition: competition?.name || "Unknown competition",
        format: competition?.format || "T20",
        season: competition?.season || "",
        date: row.match_date || "",
        stage: row.stage || "",
        venue: row.venue_country || "Unknown",
        homeId,
        awayId,
        knockOut: yes(row.knock_out) || /semi.?final|final|eliminator|qualifier/i.test(row.stage || ""),
        result: row.result || "",
        revised1: asNumber(row.first_inn_revised_overs),
        revised2: asNumber(row.second_inn_revised_overs)
      });
    }
    return result;
  }

  function formatBalls(match, innings) {
    const revised = innings === 1 ? match.revised1 : match.revised2;
    if (revised > 0) return revised;
    const format = match.format.toLowerCase();
    const overs = format.match(/(?:t|odi)?\s*(\d{1,3})\s*(?:i)?$/);
    if (/hundred/.test(format)) return 100;
    if (overs) return asNumber(overs[1]) * 6;
    if (/odi|one.?day/.test(format)) return 300;
    return 120;
  }

  function isLegalBall(row) {
    return !/wide|no.?ball/i.test(row.extras_type || "");
  }

  function chargedRuns(row) {
    const byes = /bye|leg.?bye/i.test(row.extras_type || "");
    return asNumber(row.runs) + (byes ? 0 : asNumber(row.extras1_runs) + asNumber(row.extras_2_runs));
  }

  function creditedWicket(row) {
    if (!yes(row.is_wicket)) return 0;
    return /run.?out|retired|obstructing|handled the ball/i.test(row.dismissal_type || "") ? 0 : 1;
  }

  function closeFinish(result) {
    const text = String(result || "").toLowerCase();
    const runs = text.match(/won by\s+(\d+)\s+runs?/);
    const wickets = text.match(/won by\s+(\d+)\s+wickets?/);
    return Boolean((runs && asNumber(runs[1]) <= 10) || (wickets && asNumber(wickets[1]) <= 2) || /tied|super over/.test(text));
  }

  function makePlayerGroup(match, innings, player, role) {
    return {
      matchId: match.id,
      compId: match.compId,
      competition: match.competition,
      format: match.format,
      season: match.season,
      date: match.date,
      stage: match.stage,
      venue: match.venue,
      homeId: match.homeId,
      awayId: match.awayId,
      innings,
      teamId: String(role === "batting" ? player.batting_team_id : player.bowling_team_id),
      playerId: String(role === "batting" ? player.striker_id : player.bowler_id),
      player: role === "batting" ? player.striker_name : player.bowler_name,
      role,
      total: newMeasure(),
      pressure: Object.fromEntries(pressureKinds.map((key) => [key, newMeasure()]))
    };
  }

  async function loadData(files) {
    const fileMap = new Map(Array.from(files).map((file) => [baseName(file), file]));
    const deliveryFile = fileMap.get("ball_by_ball.csv");
    const matchFile = fileMap.get("matches.csv");
    const competitionFile = fileMap.get("competitions.csv");
    if (!deliveryFile || !matchFile || !competitionFile) {
      throw new Error("Please choose the complete Data Pack folder. It must include ball_by_ball.csv, matches.csv and competitions.csv.");
    }
    progress("Reading competitions and match details…", 5);
    const [competitionRows, matchRows, teamRows] = await Promise.all([
      competitionFile.text().then(csvRows),
      matchFile.text().then(csvRows),
      fileMap.has("teams.csv") ? fileMap.get("teams.csv").text().then(csvRows) : Promise.resolve([])
    ]);
    const competitions = new Map(competitionRows.map((row) => [String(row.comp_id), {
      name: row.comp_name || "Unknown competition",
      format: row.match_format || "T20",
      season: String(row.season || "")
    }]));
    const teamNames = new Map(teamRows.map((row) => [`${row.comp_id}|${row.team_id}`, row.team_name || ""]));
    const matches = buildMatches(matchRows, competitions, teamNames);
    const inningsTotals = new Map();
    progress("Finding innings totals and targets…", 10);
    const firstRows = await readRows(deliveryFile, (cells, headers) => {
      const row = rowObject(cells, headers);
      const key = `${row.match_id}|${row.innings}`;
      const total = put(inningsTotals, key, makeInnings);
      total.runs += asNumber(row.runs) + asNumber(row.extras1_runs) + asNumber(row.extras_2_runs);
      total.wickets += yes(row.is_wicket) ? 1 : 0;
      total.legalBalls += isLegalBall(row) ? 1 : 0;
    }, (fraction) => progress("Finding innings totals and targets…", 10 + fraction * 36));
    if (!firstRows) throw new Error("The ball-by-ball file contains a header but no delivery rows.");

    const groups = new Map();
    const signalCounts = new Map();
    const playerNames = new Map();
    const inningsStates = new Map();
    let pressureDeliveries = 0;
    progress("Scoring pressure deliveries…", 48);
    await readRows(deliveryFile, (cells, headers) => {
      const row = rowObject(cells, headers);
      const match = matches.get(String(row.match_id));
      if (!match) return;
      const innings = asNumber(row.innings);
      const inningsKey = `${match.id}|${innings}`;
      const inningState = put(inningsStates, inningsKey, makeInnings);
      const total = inningsTotals.get(inningsKey) || makeInnings();
      const legal = isLegalBall(row);
      const ballNumber = inningState.legalBalls;
      const totalBalls = formatBalls(match, innings);
      const ballsRemaining = Math.max(0, totalBalls - ballNumber);
      const wicketsRemaining = Math.max(0, 10 - inningState.wickets);
      const target = innings === 2 ? (inningsTotals.get(`${match.id}|1`)?.runs || 0) + 1 : 0;
      const runsNeeded = Math.max(0, target - inningState.runs);
      const requiredRate = ballsRemaining > 0 ? (runsNeeded * 6) / ballsRemaining : 0;
      const baseRate = /odi|one.?day/.test(match.format.toLowerCase()) ? 7 : 9;
      const flags = {
        chase: innings === 2 && target > 1 && requiredRate >= baseRate,
        late: ballsRemaining > 0 && ballsRemaining <= Math.max(12, Math.ceil(totalBalls * 0.25)),
        wickets: wicketsRemaining <= 4,
        knockout: match.knockOut,
        close: closeFinish(match.result)
      };
      flags.all = signalKinds.some((key) => flags[key]);
      const signalKey = `${match.id}|${innings}`;
      const deliverySignals = put(signalCounts, signalKey, () => Object.fromEntries(signalKinds.map((key) => [key, 0])));
      for (const signal of signalKinds) if (flags[signal]) deliverySignals[signal] += 1;
      if (flags.all) pressureDeliveries += 1;

      const batter = {
        striker_id: row.striker_id,
        striker_name: row.striker_name,
        batting_team_id: row.batting_team_id,
        bowling_team_id: row.bowling_team_id
      };
      const bowler = {
        bowler_id: row.bowler_id,
        bowler_name: row.bowler_name,
        batting_team_id: row.batting_team_id,
        bowling_team_id: row.bowling_team_id
      };
      const batterId = String(row.striker_id || "");
      const bowlerId = String(row.bowler_id || "");
      if (batterId && row.striker_name) playerNames.set(batterId, row.striker_name);
      if (bowlerId && row.bowler_name) playerNames.set(bowlerId, row.bowler_name);

      const batterKey = `${match.id}|${innings}|batting|${batterId}`;
      if (batterId) {
        const batting = put(groups, batterKey, () => makePlayerGroup(match, innings, batter, "batting"));
        const batBalls = /wide/i.test(row.extras_type || "") ? 0 : 1;
        const batRuns = asNumber(row.runs);
        addDelivery(batting.total, batBalls, batRuns, yes(row.is_wicket) && String(row.dismissed_player_id) === batterId ? 1 : 0);
        for (const type of pressureKinds) if (flags[type]) addDelivery(batting.pressure[type], batBalls, batRuns, yes(row.is_wicket) && String(row.dismissed_player_id) === batterId ? 1 : 0);
      }

      if (bowlerId) {
        const bowlingKey = `${match.id}|${innings}|bowling|${bowlerId}`;
        const bowling = put(groups, bowlingKey, () => makePlayerGroup(match, innings, bowler, "bowling"));
        const bowlBalls = legal ? 1 : 0;
        const bowlRuns = chargedRuns(row);
        const bowlWickets = creditedWicket(row);
        addDelivery(bowling.total, bowlBalls, bowlRuns, bowlWickets);
        for (const type of pressureKinds) if (flags[type]) addDelivery(bowling.pressure[type], bowlBalls, bowlRuns, bowlWickets);
      }
      inningState.runs += asNumber(row.runs) + asNumber(row.extras1_runs) + asNumber(row.extras_2_runs);
      inningState.wickets += yes(row.is_wicket) ? 1 : 0;
      if (legal) inningState.legalBalls += 1;
    }, (fraction) => progress("Scoring pressure deliveries…", 48 + fraction * 49));

    if (!groups.size) throw new Error("No matching deliveries were found. Check that the selected CSV files belong to the supplied Data Pack.");
    return {
      matches, competitions, teamNames, groups: Array.from(groups.values()), playerNames, signalCounts,
      pressureDeliveries, deliveryRows: firstRows, loadedAt: new Date()
    };
  }

  function optionsFor(select, options, placeholder, currentValue) {
    const previous = currentValue ?? select.value;
    select.replaceChildren(new Option(placeholder, ""));
    for (const option of options) select.add(new Option(option.label, option.value));
    select.disabled = false;
    if (Array.from(select.options).some((option) => option.value === previous)) select.value = previous;
  }

  function selectedFilters() {
    return Object.fromEntries(filterIds.map((id) => [id, filterElements[id].value]));
  }

  function filteredGroups(filters) {
    const data = state.data;
    return data.groups.filter((group) => {
      if (filters.competitionFilter && group.compId !== filters.competitionFilter) return false;
      if (filters.formatFilter && group.format !== filters.formatFilter) return false;
      if (filters.seasonFilter && group.season !== filters.seasonFilter) return false;
      if (filters.venueFilter && group.venue !== filters.venueFilter) return false;
      if (filters.stageFilter && group.stage !== filters.stageFilter) return false;
      if (filters.inningsFilter && String(group.innings) !== filters.inningsFilter) return false;
      const match = data.matches.get(group.matchId);
      if (filters.teamFilter && match && match.homeId !== filters.teamFilter && match.awayId !== filters.teamFilter) return false;
      if (filters.playerFilter && group.playerId !== filters.playerFilter) return false;
      return true;
    });
  }

  function populateFilters() {
    const data = state.data;
    const current = selectedFilters();
    const competitionOptions = Array.from(data.competitions, ([value, item]) => ({ value, label: item.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
    optionsFor(filterElements.competitionFilter, competitionOptions, "All competitions", current.competitionFilter);

    const groups = filteredGroups({ ...current, seasonFilter: "", playerFilter: "" });
    const contextGroups = current.competitionFilter
      ? data.groups.filter((g) => g.compId === current.competitionFilter)
      : data.groups;
    const formats = [...new Set(contextGroups.map((group) => group.format).filter(Boolean))].sort();
    optionsFor(filterElements.formatFilter, formats.map((value) => ({ value, label: value })), "All formats", current.formatFilter);
    const seasonOptions = [...new Set(contextGroups.map((g) => g.season).filter(Boolean))]
      .sort((a, b) => Number(b) - Number(a)).map((value) => ({ value, label: value }));
    optionsFor(filterElements.seasonFilter, seasonOptions, "All seasons", current.seasonFilter);

    const matchIds = new Set(groups.map((group) => group.matchId));
    const matchOptions = [...matchIds].map((id) => data.matches.get(id)).filter(Boolean);
    const teamOptions = new Map();
    const venueOptions = new Set();
    const stageOptions = new Set();
    for (const match of matchOptions) {
      venueOptions.add(match.venue);
      if (match.stage) stageOptions.add(match.stage);
      if (match.homeId) teamOptions.set(match.homeId, data.teamNames.get(`${match.compId}|${match.homeId}`) || match.homeId);
      if (match.awayId) teamOptions.set(match.awayId, data.teamNames.get(`${match.compId}|${match.awayId}`) || match.awayId);
    }
    optionsFor(filterElements.teamFilter, [...teamOptions].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)), "All teams", current.teamFilter);
    optionsFor(filterElements.venueFilter, [...venueOptions].sort().map((value) => ({ value, label: value })), "All venues", current.venueFilter);
    optionsFor(filterElements.stageFilter, [...stageOptions].sort().map((value) => ({ value, label: value })), "All stages", current.stageFilter);
    const playerOptions = new Map();
    for (const group of groups) playerOptions.set(group.playerId, group.player);
    optionsFor(filterElements.playerFilter, [...playerOptions].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)), "All players", current.playerFilter);
    for (const id of ["inningsFilter", "pressureFilter", "sampleFilter", "sortFilter"]) filterElements[id] && (filterElements[id].disabled = false);
    filterElements.inningsFilter.value = current.inningsFilter;
    filterElements.pressureFilter.value = current.pressureFilter || "all";
    filterElements.sampleFilter.value = current.sampleFilter || "12";
    $("#sortFilter").value = $("#sortFilter").value || "rating";
  }

  function getMetrics(groups, kind, pressureType) {
    const players = new Map();
    for (const group of groups) {
      if (group.role !== kind) continue;
      const aggregate = put(players, group.playerId, () => ({
        id: group.playerId, name: group.player, teams: new Map(), matches: new Set(),
        pressureBalls: 0, pressureRuns: 0, pressureWickets: 0,
        totalBalls: 0, totalRuns: 0, totalWickets: 0,
        pressureMatches: new Set()
      }));
      const team = state.data.teamNames.get(`${group.compId}|${group.teamId}`) || group.teamId || "—";
      if (team) aggregate.teams.set(team, (aggregate.teams.get(team) || 0) + group.total.balls);
      aggregate.matches.add(group.matchId);
      const pressure = group.pressure[pressureType];
      const allPressure = group.pressure.all;
      const baseBalls = Math.max(0, group.total.balls - allPressure.balls);
      const baseRuns = Math.max(0, group.total.runs - allPressure.runs);
      const baseWickets = Math.max(0, group.total.wickets - allPressure.wickets);
      aggregate.pressureBalls += pressure.balls;
      aggregate.pressureRuns += pressure.runs;
      aggregate.pressureWickets += pressure.wickets;
      aggregate.totalBalls += baseBalls;
      aggregate.totalRuns += baseRuns;
      aggregate.totalWickets += baseWickets;
      if (pressure.balls > 0) aggregate.pressureMatches.add(group.matchId);
    }
    return Array.from(players.values())
      .filter((player) => player.pressureBalls >= asNumber(filterElements.sampleFilter.value) && player.totalBalls >= 30)
      .map((player) => {
      const impact = kind === "batting"
        ? (player.pressureRuns / player.pressureBalls * 100) - (player.totalRuns / player.totalBalls * 100)
        : ((player.totalRuns / player.totalBalls * 6) > 0 ? (player.totalRuns / player.totalBalls * 6) - (player.pressureRuns / player.pressureBalls * 6) : 0)
          + ((player.pressureWickets / player.pressureBalls * 6) - (player.totalWickets / player.totalBalls * 6)) * 2;
      const confidence = Math.sqrt(
        Math.min(1, player.pressureBalls / (kind === "batting" ? 60 : 48))
        * Math.min(1, player.totalBalls / (kind === "batting" ? 120 : 90))
      );
      const impactScale = kind === "batting" ? 50 : 3.5;
      const normalizedImpact = impact / (Math.abs(impact) + impactScale);
      const rating = 50 + 50 * normalizedImpact * confidence;
      const teams = [...player.teams.entries()].sort((a, b) => b[1] - a[1]).map(([team]) => team);
      return {
        ...player,
        pressureRate: kind === "batting" ? player.pressureRuns / player.pressureBalls * 100 : player.pressureRuns / player.pressureBalls * 6,
        baselineRate: kind === "batting" ? player.totalRuns / player.totalBalls * 100 : player.totalRuns / player.totalBalls * 6,
        impact,
        rating,
        team: teams[0] || "—"
      };
      });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function initials(name) {
    return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  }

  function fmt(value, digits = 1) {
    return Number.isFinite(value) ? value.toFixed(digits) : "0.0";
  }

  function renderTable(metrics) {
    const sort = $("#sortFilter").value;
    metrics.sort((a, b) => {
      if (sort === "player") return a.name.localeCompare(b.name);
      if (sort === "pressureSample") return b.pressureBalls - a.pressureBalls;
      if (sort === "pressureImpact") return b.impact - a.impact;
      return b.rating - a.rating;
    });
    const head = $("#rankingHead");
    const tableHead = state.kind === "batting"
      ? ["RANK", "PLAYER", "TEAM", "PRESSURE INDEX", "PRESSURE SR", "BASELINE SR", "CHANGE", "PRESSURE BALLS"]
      : ["RANK", "PLAYER", "TEAM", "PRESSURE INDEX", "PRESSURE ECON", "BASELINE ECON", "CHANGE", "PRESSURE BALLS"];
    head.innerHTML = `<tr>${tableHead.map((title) => `<th>${title}</th>`).join("")}</tr>`;
    const body = $("#rankingBody");
    if (!metrics.length) {
      body.innerHTML = `<tr class="empty-row"><td colspan="8"><span class="empty-table-icon">↗</span><strong>No players meet these filters</strong><span>Try a smaller minimum sample or broaden your match selection.</span></td></tr>`;
      $("#tableSummary").textContent = "No players match the current filters";
      return metrics;
    }
    body.innerHTML = metrics.slice(0, 10).map((player, index) => {
      const sign = player.impact > 0 ? "+" : "";
      const changeClass = player.impact >= 0 ? "change-positive" : "change-negative";
      const metricLabel = state.kind === "batting" ? "strike rate" : "economy rate";
      const pressureCell = state.kind === "batting" ? fmt(player.pressureRate) : fmt(player.pressureRate);
      const baselineCell = state.kind === "batting" ? fmt(player.baselineRate) : fmt(player.baselineRate);
      return `<tr>
        <td class="rank-cell">${String(index + 1).padStart(2, "0")}</td>
        <td><span class="player-cell"><span class="player-avatar">${escapeHtml(initials(player.name))}</span><span class="player-name">${escapeHtml(player.name)}<span class="player-detail">${metricLabel} · ${player.pressureMatches.size} pressure matches</span></span></span></td>
        <td class="team-cell">${escapeHtml(player.team)}</td>
        <td><span class="index-cell"><span class="index-number">${Math.round(player.rating)}</span><span class="index-track"><span style="width:${Math.max(0, Math.min(100, player.rating))}%"></span></span></span></td>
        <td>${pressureCell}</td><td>${baselineCell}</td>
        <td><span class="${changeClass}">${sign}${fmt(player.impact)}</span></td>
        <td class="sample-cell">${player.pressureBalls.toLocaleString()}</td>
      </tr>`;
    }).join("");
    $("#tableSummary").textContent = `Showing top ${Math.min(metrics.length, 10)} of ${metrics.length} qualified ${state.kind === "batting" ? "batters" : "bowlers"}`;
    return metrics;
  }

  function renderChart(groups) {
    const seasons = new Map();
    for (const group of groups) {
      if (group.role !== state.kind || !group.season) continue;
      const season = put(seasons, group.season, () => ({ pressureBalls: 0, pressureRuns: 0, baseBalls: 0, baseRuns: 0 }));
      const pressure = group.pressure[filterElements.pressureFilter.value || "all"];
      season.pressureBalls += pressure.balls;
      season.pressureRuns += pressure.runs;
      season.baseBalls += Math.max(0, group.total.balls - group.pressure.all.balls);
      season.baseRuns += Math.max(0, group.total.runs - group.pressure.all.runs);
    }
    const chart = $("#trendChart");
    const data = [...seasons.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).slice(-7);
    if (!data.length) {
      chart.innerHTML = `<div class="chart-empty"><span class="empty-chart-icon">⌁</span><strong>No seasonal data for this view</strong><span>Adjust your filters to compare pressure vs. baseline performance.</span></div>`;
      return;
    }
    const measures = data.map(([season, item]) => ({
      season,
      pressure: state.kind === "batting" ? (item.pressureBalls ? item.pressureRuns / item.pressureBalls * 100 : 0) : (item.pressureBalls ? item.pressureRuns / item.pressureBalls * 6 : 0),
      baseline: state.kind === "batting" ? (item.baseBalls ? item.baseRuns / item.baseBalls * 100 : 0) : (item.baseBalls ? item.baseRuns / item.baseBalls * 6 : 0)
    }));
    const max = Math.max(1, ...measures.flatMap((item) => [item.pressure, item.baseline])) * 1.18;
    const left = 34, right = 10, top = 7, bottom = 25, width = 660, height = 147;
    const plotHeight = height - top - bottom;
    const groupWidth = (width - left - right) / measures.length;
    const barWidth = Math.min(17, groupWidth * 0.22);
    const lines = [0, .5, 1].map((ratio) => {
      const y = top + plotHeight * ratio;
      return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" stroke="#edf0f4" stroke-dasharray="${ratio ? "3 4" : "0"}"/><text x="${left - 7}" y="${y + 3}" fill="#a2acb9" font-size="8" text-anchor="end">${fmt(max * (1 - ratio), 0)}</text>`;
    }).join("");
    const bars = measures.map((item, index) => {
      const center = left + groupWidth * (index + .5);
      const ph = item.pressure / max * plotHeight;
      const bh = item.baseline / max * plotHeight;
      return `<rect x="${center - barWidth - 2}" y="${top + plotHeight - ph}" width="${barWidth}" height="${ph}" rx="2" fill="#e73f81"><title>${item.season} pressure: ${fmt(item.pressure)}</title></rect><rect x="${center + 2}" y="${top + plotHeight - bh}" width="${barWidth}" height="${bh}" rx="2" fill="#d5dbe4"><title>${item.season} baseline: ${fmt(item.baseline)}</title></rect><text x="${center}" y="${height - 5}" fill="#909bac" font-size="8" text-anchor="middle">${escapeHtml(item.season)}</text>`;
    }).join("");
    const unit = state.kind === "batting" ? "Strike rate" : "Economy / 6 balls";
    chart.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${unit} under pressure compared with baseline by season">${lines}${bars}</svg>`;
  }

  function renderSignals(groups) {
    const selectedMatchIds = new Set(groups.map((group) => group.matchId));
    const inningsFilter = filterElements.inningsFilter.value;
    const matchCounts = new Map();
    for (const [key, counts] of state.data.signalCounts) {
      const [matchId, innings] = key.split("|");
      if (!selectedMatchIds.has(matchId) || (inningsFilter && innings !== inningsFilter)) continue;
      for (const signal of signalKinds) matchCounts.set(signal, (matchCounts.get(signal) || 0) + counts[signal]);
    }
    const filters = selectedFilters();
    const labels = [
      ["chase", "Chase under strain", "pink"], ["late", "Final five overs", "blue"],
      ["wickets", "Four or fewer wickets", "gold"], ["knockout", "Knockout matches", "green"],
      ["close", "Close finishes", "pink"]
    ];
    $("#pressureMix").innerHTML = labels.map(([key, label, color]) => `<div class="signal-row"><span class="signal-dot signal-${color}"></span><span class="signal-label">${label}</span><span class="signal-value">${(matchCounts.get(key) || 0).toLocaleString()}</span></div>`).join("");
    const active = [filters.competitionFilter, filters.formatFilter, filters.seasonFilter, filters.teamFilter, filters.playerFilter, filters.venueFilter, filters.stageFilter, filters.inningsFilter, filters.pressureFilter !== "all" ? filters.pressureFilter : ""].filter(Boolean).length;
    $(".filter-count").textContent = String(active);
    $("#filterDescription").textContent = active === 0
      ? "Pressure is measured against each player's non-pressure baseline"
      : "Rankings and insights update instantly";
  }

  function render() {
    if (!state.data) return;
    const filters = selectedFilters();
    const groups = filteredGroups(filters);
    const type = filters.pressureFilter || "all";
    const metrics = getMetrics(groups, state.kind, type);
    const sortedMetrics = renderTable(metrics);
    renderChart(groups);
    renderSignals(groups);
    const selectedMatches = new Set(groups.map((group) => group.matchId));
    let pressureBalls = 0;
    for (const group of groups) if (group.role === state.kind) pressureBalls += group.pressure[type].balls;
    $("#pressureBallsStat").textContent = pressureBalls.toLocaleString();
    $("#pressureBallsNote").textContent = `${names[type]} · ${state.kind === "batting" ? "batter" : "bowler"} balls`;
    $("#playersStat").textContent = String(metrics.length);
    $("#playersNote").textContent = `Qualified ${state.kind === "batting" ? "batters" : "bowlers"}`;
    $("#matchesStat").textContent = selectedMatches.size.toLocaleString();
    $("#topRatingStat").innerHTML = `${sortedMetrics.length ? Math.round(sortedMetrics[0].rating) : "—"}<small>/100</small>`;
    $("#topRatingNote").textContent = sortedMetrics.length ? sortedMetrics[0].name : "Confidence-weighted";
    const dates = [...selectedMatches].map((id) => state.data.matches.get(id)?.date).filter(Boolean).sort();
    $("#dateRangeNote").textContent = dates.length ? `${dates[0].slice(0, 4)} — ${dates[dates.length - 1].slice(0, 4)}` : "From your selected filters";
  }

  async function onFilesChosen() {
    const files = fileInput.files;
    if (!files || !files.length) return;
    importError.hidden = true;
    importProgress.hidden = false;
    $("#progressBar").style.width = "0%";
    $("#dataStatus").textContent = "Reading files…";
    try {
      const data = await loadData(files);
      state.data = data;
      populateFilters();
      $("#sortFilter").disabled = false;
      render();
      closeImport();
      $("#dataStatus").textContent = `${data.deliveryRows.toLocaleString()} deliveries loaded`;
      $("#dataStatus").classList.add("ready");
      $("#updatedLabel").textContent = `${data.competitions.size} competitions · ${data.matches.size} matches`;
      showToast(`Analysis ready — ${data.pressureDeliveries.toLocaleString()} pressure deliveries identified.`);
    } catch (error) {
      importError.textContent = error instanceof Error ? error.message : "The selected files could not be read.";
      importError.hidden = false;
      importOverlay.hidden = false;
      $("#dataStatus").textContent = "Import needs attention";
    } finally {
      importProgress.hidden = true;
      fileInput.value = "";
    }
  }

  $("#importButton").addEventListener("click", showImport);
  $("#sidebarImport").addEventListener("click", showImport);
  $("#closeImport").addEventListener("click", closeImport);
  $("#cancelImport").addEventListener("click", closeImport);
  importOverlay.addEventListener("click", (event) => { if (event.target === importOverlay) closeImport(); });
  fileInput.addEventListener("change", onFilesChosen);
  $("#resetFilters").addEventListener("click", () => {
    for (const id of filterIds) if (filterElements[id]) filterElements[id].value = "";
    if (state.data) {
      filterElements.pressureFilter.value = "all";
      filterElements.sampleFilter.value = "12";
      $("#sortFilter").value = "rating";
      render();
    }
  });
  for (const id of filterIds) filterElements[id].addEventListener("change", () => {
    if (state.data) {
      if (id === "competitionFilter") {
        filterElements.formatFilter.value = "";
        filterElements.seasonFilter.value = "";
        filterElements.teamFilter.value = "";
        filterElements.venueFilter.value = "";
        filterElements.stageFilter.value = "";
      }
      render();
    }
  });
  $("#sortFilter").addEventListener("change", render);
  document.querySelectorAll(".segment").forEach((button) => button.addEventListener("click", () => {
    state.kind = button.dataset.kind;
    document.querySelectorAll(".segment").forEach((item) => {
      item.classList.toggle("active", item === button);
      item.setAttribute("aria-selected", String(item === button));
    });
    if (state.data) render();
  }));
  $("#methodLink").addEventListener("click", (event) => {
    event.preventDefault();
    const details = $("#methodologyDetails");
    details.hidden = !details.hidden;
    $("#methodLink").innerHTML = details.hidden ? "Explore methodology <span>→</span>" : "Hide methodology <span>↑</span>";
    if (!details.hidden) details.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  async function loadBundledData() {
    const bundledFiles = window.SUPERR_DEFAULT_FILES_GZIP;
    if (!Array.isArray(bundledFiles)) {
      importError.textContent = "The bundled Data Pack could not be loaded. Use Import data to choose a Data Pack folder.";
      importError.hidden = false;
      importOverlay.hidden = false;
      $("#dataStatus").textContent = "Bundled data unavailable";
      return;
    }
    try {
      if (typeof DecompressionStream !== "function") {
        throw new Error("This browser cannot decompress the bundled Data Pack. Use a current browser or import the folder manually.");
      }
      const transfer = new DataTransfer();
      for (const entry of bundledFiles) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
          throw new Error("The bundled Data Pack is malformed.");
        }
        const binary = atob(entry[1]);
        const compressed = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) compressed[index] = binary.charCodeAt(index);
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
        const contents = await new Response(stream).blob();
        transfer.items.add(new File([contents], entry[0], { type: "text/csv" }));
      }
      fileInput.files = transfer.files;
    } catch (error) {
      importError.textContent = error instanceof Error ? error.message : "The bundled Data Pack could not be prepared.";
      importError.hidden = false;
      importOverlay.hidden = false;
      $("#dataStatus").textContent = "Bundled data needs attention";
      return;
    } finally {
      window.SUPERR_DEFAULT_FILES_GZIP = null;
    }
    await onFilesChosen();
  }
  void loadBundledData();
})();
