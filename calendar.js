// ================================================================
// CALENDAR ENGINE  —  calendar.js
// Reads real task data from loadTasks(). Never duplicates state.
// All helper functions (loadTasks, getTodayKey, detectTaskType,
// getDomainIconHtml, escapeHtml, resumeTaskById) live in script.js.
// ================================================================

const calState = {
  year: new Date().getFullYear(),
  month: new Date().getMonth(), // 0-indexed
  selectedDateKey: null,        // "YYYY-MM-DD"
};

/* ── Navigation ─────────────────────────────────────────────────── */

function calNavigate(delta) {
  calState.month += delta;
  if (calState.month > 11) { calState.month = 0; calState.year++; }
  if (calState.month < 0)  { calState.month = 11; calState.year--; }
  renderCalendar();
}

function calGoToday() {
  const now = new Date();
  calState.year  = now.getFullYear();
  calState.month = now.getMonth();
  calState.selectedDateKey = getTodayKey();
  renderCalendar();
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function _calDateKey(d) {
  const y   = d.getFullYear();
  const mo  = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + mo + "-" + day;
}

/**
 * Build dateKey → task[] map from the planner data (loadTasks).
 * Tasks with a scheduleDate appear on that date.
 * Active/pending/snoozed tasks without a scheduleDate appear on today.
 */
function _calBuildTaskMap() {
  const tasks    = loadTasks();
  const map      = {};
  const todayKey = getTodayKey();

  tasks.forEach(function(task) {
    if (task.scheduleDate) {
      if (!map[task.scheduleDate]) map[task.scheduleDate] = [];
      map[task.scheduleDate].push(task);
    }
    if (!task.scheduleDate && task.state !== "completed") {
      if (!map[todayKey]) map[todayKey] = [];
      if (!map[todayKey].find(function(t) { return t.id === task.id; })) {
        map[todayKey].push(task);
      }
    }
  });
  return map;
}

/* ── Main render ─────────────────────────────────────────────────── */

function renderCalendar() {
  var year     = calState.year;
  var month    = calState.month;
  var todayKey = getTodayKey();
  var taskMap  = _calBuildTaskMap();

  // Month title
  var titleEl = document.getElementById("cal-month-title");
  if (titleEl) {
    titleEl.textContent = new Date(year, month, 1)
      .toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  // "This month" badge
  var now = new Date();
  var badgeEl = document.getElementById("cal-today-badge");
  if (badgeEl) {
    var isCurMonth = year === now.getFullYear() && month === now.getMonth();
    badgeEl.textContent = isCurMonth ? "This month" : "";
  }

  // Reset panel slide state on each render
  var panelEl = document.getElementById("cal-panel");
  if (panelEl) panelEl.classList.remove("cal-panel-open");

  // Build grid
  var grid = document.getElementById("cal-grid");
  if (!grid) return;
  grid.innerHTML = "";

  var firstDayRaw = new Date(year, month, 1).getDay(); // 0=Sun
  var startOffset = firstDayRaw === 0 ? 6 : firstDayRaw - 1; // Mon-based
  var daysInMonth = new Date(year, month + 1, 0).getDate();

  // Leading empty cells
  for (var i = 0; i < startOffset; i++) {
    var empty = document.createElement("div");
    empty.className = "cal-cell cal-cell-empty";
    grid.appendChild(empty);
  }

  // Day cells
  for (var d = 1; d <= daysInMonth; d++) {
    (function(dayNum) {
      var dateObj  = new Date(year, month, dayNum);
      var dateKey  = _calDateKey(dateObj);
      var isToday  = dateKey === todayKey;
      var isSel    = dateKey === calState.selectedDateKey;
      var dayTasks = taskMap[dateKey] || [];
      var hasTasks = dayTasks.length > 0;

      var cell = document.createElement("div");
      var cellCls = "cal-cell";
      if (isToday)  cellCls += " cal-cell-today";
      if (isSel)    cellCls += " cal-cell-selected";
      if (hasTasks) cellCls += " cal-cell-has-tasks";
      cell.className = cellCls;
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("tabindex", "0");
      cell.setAttribute("aria-label",
        dateObj.toLocaleDateString("en-US", {
          weekday: "long", month: "long", day: "numeric"
        }));

      // Day number
      var numEl = document.createElement("div");
      numEl.className = "cal-day-num";
      numEl.textContent = dayNum;
      cell.appendChild(numEl);

      // Task indicators
      if (hasTasks) {
        var indicator = document.createElement("div");
        indicator.className = "cal-indicators";
        var count = dayTasks.length;
        if (count <= 3) {
          dayTasks.forEach(function(t) {
            var dot = document.createElement("span");
            var dotCls = "cal-dot";
            if (t.state === "completed") dotCls += " cal-dot-done";
            else if (t.state === "active")  dotCls += " cal-dot-active";
            else if (t.state === "snoozed") dotCls += " cal-dot-snoozed";
            dot.className = dotCls;
            indicator.appendChild(dot);
          });
        } else {
          var badge = document.createElement("span");
          badge.className = "cal-count-badge";
          badge.textContent = count + " tasks";
          indicator.appendChild(badge);
        }
        cell.appendChild(indicator);
      }

      cell.addEventListener("click", function() { calSelectDay(dateKey); });
      cell.addEventListener("keydown", function(e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          calSelectDay(dateKey);
        }
      });
      grid.appendChild(cell);
    })(d);
  }

  // Render panel
  if (calState.selectedDateKey) {
    renderCalPanel(calState.selectedDateKey);
  } else if (year === now.getFullYear() && month === now.getMonth()) {
    calSelectDay(todayKey);
  } else {
    renderCalPanelEmpty();
  }
}

/* ── Day selection ───────────────────────────────────────────────── */

function calSelectDay(dateKey) {
  calState.selectedDateKey = dateKey;

  // Update selected cell visual
  document.querySelectorAll(".cal-cell").forEach(function(c) {
    c.classList.remove("cal-cell-selected");
  });
  var parts = dateKey.split("-");
  var y = parseInt(parts[0], 10);
  var mo = parseInt(parts[1], 10);
  var d  = parseInt(parts[2], 10);
  if (y === calState.year && mo === calState.month + 1) {
    var cells = document.querySelectorAll(".cal-cell:not(.cal-cell-empty)");
    if (cells[d - 1]) cells[d - 1].classList.add("cal-cell-selected");
  }

  renderCalPanel(dateKey);
}

/* ── Panel render ────────────────────────────────────────────────── */

function renderCalPanel(dateKey) {
  var panel = document.getElementById("cal-panel-inner");
  if (!panel) return;

  var taskMap  = _calBuildTaskMap();
  var dayTasks = taskMap[dateKey] || [];
  var todayKey = getTodayKey();
  var isToday  = dateKey === todayKey;

  var parts   = dateKey.split("-");
  var dateObj = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  var dayName  = dateObj.toLocaleDateString("en-US", { weekday: "long" });
  var fullDate = dateObj.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric"
  });

  var html = '<div class="cal-panel-date">'
    + '<div class="cal-panel-day-name">' + dayName + '</div>'
    + '<div class="cal-panel-full-date">' + fullDate + '</div>'
    + (isToday ? '<span class="cal-panel-today-pill">Today</span>' : '')
    + '</div>';

  if (dayTasks.length === 0) {
    html += '<div class="cal-panel-empty">'
      + '<div class="cal-empty-icon">&#10022;</div>'
      + '<div class="cal-empty-title">No tasks planned</div>'
      + '<div class="cal-empty-sub">A clear day. Use it wisely.</div>'
      + '</div>';
  } else {
    // "Open today's plan" CTA
    var actionable = dayTasks.filter(function(t) { return t.state !== "completed"; });
    if (isToday && actionable.length > 0) {
      var launchTask = actionable.filter(function(t) { return t.state === "active"; })[0] || actionable[0];
      html += '<button class="cal-open-plan-btn" type="button" onclick="resumeTaskById(\''
        + launchTask.id + '\')">'
        + '<span>&#9654;</span> Open Today\'s Plan'
        + '</button>';
    }

    // Summary strip
    var totalMins = dayTasks.reduce(function(s, t) { return s + (t.focusTime || 25); }, 0);
    var doneCount = dayTasks.filter(function(t) { return t.state === "completed"; }).length;
    var durLbl = totalMins >= 60
      ? Math.floor(totalMins / 60) + "h" + (totalMins % 60 ? " " + totalMins % 60 + "m" : "")
      : totalMins + "m";

    html += '<div class="cal-panel-summary">'
      + '<div class="cal-summary-pill"><span class="csp-icon">&#128203;</span>'
      + '<span>' + dayTasks.length + ' task' + (dayTasks.length > 1 ? "s" : "") + '</span></div>'
      + '<div class="cal-summary-pill"><span class="csp-icon">&#9201;</span>'
      + '<span>~' + durLbl + '</span></div>'
      + (doneCount > 0
          ? '<div class="cal-summary-pill cal-pill-done"><span class="csp-icon">&#10003;</span>'
            + '<span>' + doneCount + ' done</span></div>'
          : "")
      + '</div>';

    // Task list
    html += '<div class="cal-panel-tasks">';
    dayTasks.forEach(function(task) {
      html += _renderCalTaskCard(task);
    });
    html += '</div>';
  }

  panel.innerHTML = html;

  // Ensure panel slides in
  var panelEl = document.getElementById("cal-panel");
  if (panelEl) panelEl.classList.add("cal-panel-open");
}

function renderCalPanelEmpty() {
  var panel = document.getElementById("cal-panel-inner");
  if (panel) {
    panel.innerHTML = '<div class="cal-panel-empty cal-panel-empty-hint">'
      + '<div class="cal-empty-icon">&#128197;</div>'
      + '<div class="cal-empty-title">Select a day</div>'
      + '<div class="cal-empty-sub">Click any date to see planned tasks.</div>'
      + '</div>';
  }
}

/* ── Calendar task card ──────────────────────────────────────────── */

function _renderCalTaskCard(task) {
  var stateLabels = { pending: "Pending", active: "Active", snoozed: "Snoozed", completed: "Done" };
  var steps   = task.aiSteps || [];
  var total   = steps.length;
  var done    = steps.filter(function(s) { return s.done; }).length;
  var pct     = total > 0 ? Math.round((done / total) * 100) : 0;
  var mins    = task.focusTime || 25;
  var durLbl  = mins >= 60
    ? Math.floor(mins / 60) + "h" + (mins % 60 ? " " + mins % 60 + "m" : "")
    : mins + " min";

  var categoryMap = {
    coding:"Code", assignment:"Study", exam:"Exam", learning:"Learn",
    fitness:"Fitness", writing:"Writing", design:"Design", meeting:"Meeting",
    email:"Email", finance:"Finance", shopping:"Errand", household:"Chore",
    admin:"Admin", travel:"Travel", work:"Work", research:"Research",
    business:"Business", interview:"Interview", reading:"Reading",
    language:"Language", video:"Video", math:"Math", cooking:"Cooking",
    packing:"Packing", general:"Task"
  };
  var domain   = detectTaskType(task.title || "");
  var category = categoryMap[domain] || "Task";
  var focusBadge = mins >= 60 ? "Deep Work" : (mins <= 20 ? "Quick" : "Focus");

  var cardCls = "cal-task-card";
  if (task.state === "active")    cardCls += " cal-tc-active";
  if (task.state === "snoozed")   cardCls += " cal-tc-snoozed";
  if (task.state === "completed") cardCls += " cal-tc-done";

  var iconHtml = getDomainIconHtml(task.title);
  var clickAttr = task.state !== "completed"
    ? " onclick=\"resumeTaskById('" + task.id + "')\" role=\"button\""
    : "";

  var progressHtml = "";
  if (total > 0) {
    progressHtml = '<div class="cal-tc-progress">'
      + '<div class="cal-tc-bar"><div class="cal-tc-fill" style="width:' + pct + '%"></div></div>'
      + '<span class="cal-tc-pct">' + pct + '%</span>'
      + '</div>';
  }

  return '<div class="' + cardCls + '"' + clickAttr + '>'
    + '<div class="cal-tc-top">'
    + '<div class="cal-tc-icon-wrap">' + iconHtml + '</div>'
    + '<div class="cal-tc-info">'
    + '<div class="cal-tc-badges">'
    + '<span class="tc-badge tc-badge-' + task.state + '">' + stateLabels[task.state] + '</span>'
    + '<span class="cal-tc-cat">' + escapeHtml(category) + '</span>'
    + '<span class="cal-tc-focus">' + focusBadge + '</span>'
    + '</div>'
    + '<div class="cal-tc-title">' + escapeHtml(task.title) + '</div>'
    + '<div class="cal-tc-meta">&#9201; ' + durLbl
    + (total > 0 ? ' &nbsp;&middot;&nbsp; ' + done + '/' + total + ' steps' : '')
    + '</div>'
    + '</div>'
    + '</div>'
    + progressHtml
    + '</div>';
}
