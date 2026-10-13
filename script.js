// Gemini requests are made by the backend; never put API keys in this file.
/* ============================================================
   NUDGE AI — script.js
   Core app logic: task store, task state machine, snooze/resume,
   AI breakdown, mood system, schedule, progress, stats dashboard.
   ============================================================ */

// ================================================================
// TASK STORE — persistent task management via localStorage
// ================================================================

const TASKS_KEY = "nudge_tasks";

// ── Versioned app-data initializer ──────────────────────────────────────
// Reset Nudge-owned data on version changes without clearing other apps'
// localStorage entries on the same origin.
(function _ensureCleanSlate() {
  const APP_VERSION = "1.1.0";
  const VERSION_KEY = "nudge_app_version";
  const storedVersion = localStorage.getItem(VERSION_KEY);
  if (storedVersion !== APP_VERSION) {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key && key.startsWith("nudge_")) localStorage.removeItem(key);
    }
    localStorage.setItem(VERSION_KEY, APP_VERSION);
  }
})();

/**
 * Load all tasks from localStorage.
 * @returns {Array} Array of task objects.
 */
function loadTasks() {
  try {
    return JSON.parse(localStorage.getItem(TASKS_KEY) || "[]");
  } catch (e) {
    return [];
  }
}

/**
 * Save all tasks to localStorage.
 * @param {Array} tasks
 */
function saveTasks(tasks) {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  // Keep Home sidebar in sync whenever task data changes
  syncHomeUI();
}

/**
 * Create a new task object with 'pending' state.
 * @param {string} title
 * @param {Array}  aiSteps  Array of step label strings
 * @param {number} focusTime Minutes per step
 * @returns {Object} task
 */
function createTask(title, aiSteps, focusTime, scheduleDate) {
  return {
    id: "task_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
    title: title,
    state: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    snoozeUntil: null,
    focusTime: focusTime || 25,
    scheduleDate: scheduleDate || null,
    aiSteps: aiSteps.map(label => ({ label, done: false, skipped: false })),
    completedStepsCount: 0,
  };
}

/**
 * Update a task's state (and optionally other fields) and save.
 * @param {string} id
 * @param {string} newState  "pending" | "active" | "snoozed" | "completed"
 * @param {Object} extra     Optional extra fields to merge
 */
function setTaskState(id, newState, extra = {}) {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return;
  tasks[idx] = { ...tasks[idx], state: newState, updatedAt: new Date().toISOString(), ...extra };
  saveTasks(tasks);
}

/**
 * Get a single task by id.
 * @param {string} id
 * @returns {Object|null}
 */
function getTaskById(id) {
  return loadTasks().find(t => t.id === id) || null;
}

/**
 * Update step progress on a task (syncs from in-memory state.steps).
 * @param {string} id
 * @param {Array}  steps  Current in-memory step array
 * @param {number} completedCount
 */
function syncTaskSteps(id, steps, completedCount) {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return;
  tasks[idx].aiSteps = steps;
  tasks[idx].completedStepsCount = completedCount;
  tasks[idx].updatedAt = new Date().toISOString();
  saveTasks(tasks);
}

/**
 * Check snoozed tasks — if snoozeUntil has passed, move them back to pending.
 * Call on page load and every 60s.
 */
function checkSnoozedTasks() {
  const tasks = loadTasks();
  const now = Date.now();
  let changed = false;

  tasks.forEach(t => {
    if (t.state === "snoozed" && t.snoozeUntil && new Date(t.snoozeUntil).getTime() <= now) {
      t.state = "pending";
      t.snoozeUntil = null;
      t.updatedAt = new Date().toISOString();
      changed = true;
    }
  });

  if (changed) {
    saveTasks(tasks);
    updateTasksBadge();
    // If tasks tab is open, re-render it
    if (state.currentScreen === "tasks") renderTasksTab();
  }
}

/**
 * Update the tasks tab badge with count of pending + active tasks.
 */
function updateTasksBadge() {
  const tasks = loadTasks();
  const count = tasks.filter(t => t.state === "pending" || t.state === "active").length;
  const badge = document.getElementById("tab-tasks-badge");
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 9 ? "9+" : count;
    badge.style.display = "flex";
  } else {
    badge.style.display = "none";
  }
}

// ================================================================
// STATE — single source of truth for the active task screen
// ================================================================
const state = {
  taskTitle: "",
  taskId: null,          // id of the task currently being worked on
  steps: [],            // Array of { label, done, skipped }
  activeIndex: 0,
  completedCount: 0,
  lastActionTime: null,
  moodTimer: null,
  isCompleted: false,
  currentScreen: "home",        // "home" | "task" | "tasks" | "stats"
  callerScreen: "home",         // which tab launched the task screen
  focusTime: 25,
  scheduleDate: "",
  scheduleStart: "",
  scheduleDuration: 25,
  scheduleSet: false,
  focusBarTimer: null,
  _reEngageNudge: null,
  lastCompletedToday: false,
  snoozingTaskId: null,          // task being snoozed via modal
  focusLockActive: false,        // whether focus lock overlay is showing
  sessionStartTime: null,        // when the active session started (for live timer)
  sessionTimerInterval: null,    // interval ID for session timer display

  // === DUAL TIMER ===
  stepStartTime: null,           // when the current step started
  stepTimerInterval: null,       // interval for step timer display
  taskStartTime: null,           // when the whole task session started
  taskTimerInterval: null,       // interval for task timer display
  overtimeNudgeShown: 0,         // which overtime level has been shown (0,1,2,3)
};

// Guard: prevents multiple API calls at once
let isGenerating = false;

// ================================================================
// TASK-TYPE DETECTION — extended domain classifier
// ================================================================
function detectTaskType(text) {
  const t = text.toLowerCase();
  // Programming & Tech
  if (/\bcode\b|\bbug\b|\bfeature\b|\bdeploy\b|\bapi\b|\bfunction\b|\bbuild app\b|\bdebug\b|\bgit\b|\bcommit\b|pull request|\bpr\b|\brepo\b|\bjavascript\b|\bpython\b|\breact\b|\bnode\b|\bhtml\b|\bcss\b|\bbackend\b|\bfrontend\b|\bprogram\b|\bscript\b/.test(t)) return "coding";
  // Assignment & Homework
  if (/\bassignment\b|\bhomework\b|\bdbms\b|\bsubmit\b.*\bassignment\b|\bcomplete\b.*\bassignment\b|\bdue\b|\bproject\b.*\bsubmit\b/.test(t)) return "assignment";
  // Exam & Study
  if (/\bexam\b|\btest\b|\bquiz\b|\bviva\b|\bmidterm\b|\bfinal\b.*\bexam\b|\bprep\b.*\bexam\b|\brevision\b|\bstudy\b|\bchapter\b|\bnotes\b/.test(t)) return "exam";
  // General reading/learning
  if (/\blearn\b|\blocture\b|\bread\b.*\bbook\b|\btextbook\b|\bcourse\b|\btutorial\b|\bwatch\b.*\bcourse\b/.test(t)) return "learning";
  // Travel & Packing
  if (/\bpack\b|\bsuitcase\b|\bluggage\b/.test(t)) return "packing";
  if (/\btravel\b|\btrip\b|\bflight\b|\bhotel\b|\bvisa\b|\bpassport\b|\bgo to\b.*\b(goa|mumbai|delhi|london|paris|dubai|airport)\b/.test(t)) return "travel";
  // Fitness & Health
  if (/\bgym\b|\bworkout\b|\bexercise\b|\brun\b|\byoga\b|\bstretching\b|\btraining\b|\blift\b|\bweights\b|\bcardio\b|\bpush.?up|\bpull.?up|\babs\b/.test(t)) return "fitness";
  // Writing & Content
  if (/\bwrite\b.*\b(essay|blog|article|report|story|email|letter|draft|thesis|proposal)\b|\bessay\b|\bblog\b|\barticle\b|\bdraft\b|\bthesis\b/.test(t)) return "writing";
  // Design & Creative
  if (/\bdesign\b|\bfigma\b|\bsketch\b|\bui\b|\bux\b|\bwireframe\b|\bartwork\b|\bdraw\b|\bphotoshop\b|\billustrat\b|\bcreative\b/.test(t)) return "design";
  // Video & Content creation
  if (/\bedit\b.*\bvideo\b|\bvideo edit\b|\byoutube\b|\breel\b|\bshort\b.*\bvideo\b|\bpremiere\b|\bdavinci\b/.test(t)) return "video";
  // Math
  if (/\bmath\b|\bmaths\b|\balgebra\b|\bcalculus\b|\bstatistics\b|\bgeometry\b|\bprobability\b|\bequation\b|\bsolve\b.*\bproblem\b/.test(t)) return "math";
  // Research
  if (/\bresearch\b|\bliterature review\b|\bsurvey\b.*\bpaper\b|\bfind papers\b|\bacademic\b/.test(t)) return "research";
  // Interview prep
  if (/\binterview\b|\bhr round\b|\btechnical interview\b|\bdsalgo\b|\bds algo\b|\bcracking\b/.test(t)) return "interview";
  // Business & Startup
  if (/\bstartup\b|\bpitch\b|\bbusiness plan\b|\bproduct\b.*\blaunch\b|\bmarket\b.*\bresearch\b|\bcompetitor\b/.test(t)) return "business";
  // Meetings & Office
  if (/\bmeeting\b|\bpresentation\b|\bdeck\b|\bslides\b|\bclient call\b|\bstandup\b/.test(t)) return "meeting";
  // Email & Communication
  if (/\bemail\b|\breply\b.*\bemail\b|\bdraft\b.*\bemail\b|\bfollow.?up\b/.test(t)) return "email";
  // Finance & Bills
  if (/\bpay\b|\bbill\b|\btax\b|\binvoice\b|\binsurance\b|\bbank\b|\brenew\b|\bapply\b.*\bcard\b|\bloan\b/.test(t)) return "finance";
  // Shopping
  if (/\bshop\b|\bbuy\b|\bpurchase\b|\border\b.*\bonline\b|\bamazon\b|\bgroceries\b/.test(t)) return "shopping";
  // Cooking & Food
  if (/\bcook\b|\brecipe\b|\bbake\b|\bmeal prep\b|\bfood\b.*\bprepare\b/.test(t)) return "cooking";
  // Household & Cleaning
  if (/\bclean\b|\blaundry\b|\bdishes\b|\brepair\b|\bfix\b.*\bhome\b|\borganize\b.*\broom\b|\bdeclutter\b|\bwash\b/.test(t)) return "household";
  // Admin & Paperwork
  if (/\bform\b|\bfile\b|\bapply\b|\brenew\b|\bdocument\b|\bpaperwork\b|\bgovernment\b|\baadhar\b|\bpassport apply\b/.test(t)) return "admin";
  // Language learning
  if (/\bjapanese\b|\bspanish\b|\bfrench\b|\bgerman\b|\bhindi\b|\blanguage\b|\bvocabulary\b|\bfluent\b|\bduolingo\b/.test(t)) return "language";
  // Reading
  if (/\bread\b.*\bbook\b|\bfinish book\b|\bnovel\b|\bchapters\b|\bnonfiction\b/.test(t)) return "reading";
  // Work / General project
  if (/\breport\b|\bproposal\b|\bdeadline\b|\bproject\b|\bwork\b/.test(t)) return "work";
  return "general";
}

// ================================================================
// AI STEP GENERATION — Intelligent Execution Coach
// ================================================================
// Expert-quality fallback steps per domain — used when API fails
const FALLBACK_STEPS_BY_TYPE = {
  // Programming
  coding: [
    "Read the requirement or error message word-by-word before touching code",
    "Write the expected output as a comment — define what 'working' means",
    "Implement the core logic in one clean function without over-engineering",
    "Test with one happy path and one edge case — log both outputs",
    "Commit: write a message describing what changed and why it was broken",
  ],
  // Assignment submission
  assignment: [
    "Read every question carefully — underline keywords and mark constraints",
    "Attempt the highest-marks questions first while your mind is fresh",
    "Show all working steps clearly — answer what is asked, nothing more",
    "Re-read your answers for missed points, calculation errors, or omissions",
    "Format and submit — screenshot the confirmation if submitting online",
  ],
  // Exam preparation
  exam: [
    "List every topic on the syllabus — mark each as Strong, Weak, or Unseen",
    "Start with Weak topics: re-read only the relevant section, not the chapter",
    "Write the 5 most important formulas or concepts from memory on blank paper",
    "Solve 5 past exam questions under timed conditions — no peeking",
    "Review wrong answers: write the exact reason each mistake happened",
    "Do a final 10-minute mental walkthrough of all key points before sleep",
  ],
  // Self-directed learning
  learning: [
    "Define one specific outcome: what will you be able to DO after this session?",
    "Watch or read only the section that addresses your stated outcome",
    "Pause and type or write your understanding of each major concept",
    "Build or attempt one hands-on example applying what you just learned",
    "Identify one thing that is still unclear and note it for next session",
  ],
  // Packing
  packing: [
    "Write a categorized list: clothes, toiletries, documents, electronics, misc",
    "Lay every item on the bed and cross-check it against the list",
    "Pack heaviest items at the bottom; fragile or frequently needed items on top",
    "Verify the critical four: ID/passport, boarding pass, charger, wallet",
    "Zip the bag, weigh it if flying, and photograph the open contents for reference",
  ],
  // Travel planning
  travel: [
    "Confirm booking details: transport, accommodation, and local SIM or WiFi",
    "List everything to pack by category — cross-reference with weather forecast",
    "Prepare documents folder: ID, tickets, insurance, hotel confirmation",
    "Pack and do the critical check: documents, charger, cash, medications",
    "Share your itinerary with one contact and set offline maps before departure",
  ],
  // Fitness
  fitness: [
    "Set up your space and timer before changing — remove the setup friction",
    "Warm up for 5 minutes: mobility drills and light movement for today's muscles",
    "Execute the main block at full effort — prioritize form over speed or weight",
    "Cool down: 5 minutes of static stretching targeting muscles you worked",
    "Log reps, weight, or duration immediately — memory degrades within minutes",
  ],
  // Writing
  writing: [
    "Write the single-sentence thesis: what is this piece arguing or explaining?",
    "Draft a 5-point bullet outline before writing any prose",
    "Write the full first draft without stopping to edit — quantity over quality",
    "Cut every sentence that does not directly support your thesis",
    "Read the final version aloud and fix anything that sounds awkward",
  ],
  // Design
  design: [
    "Define the design goal in one sentence: what problem does this solve for whom?",
    "Sketch 3 rough layout options on paper before opening any tool",
    "Build the chosen layout in low-fidelity — no colors or fonts yet",
    "Add typography, spacing, and color using your established style guide",
    "Review against the design goal — remove any element that doesn't serve it",
  ],
  // Video editing
  video: [
    "Watch the raw footage once through and mark usable takes with timestamps",
    "Assemble a rough cut in sequence — do not touch color or audio yet",
    "Trim every clip: cut 0.5s from the start and end of each if unsure",
    "Add music, voiceover, or sound effects and balance audio levels",
    "Export at correct settings and watch the full video before uploading",
  ],
  // Mathematics
  math: [
    "Identify the exact concept or formula involved before attempting anything",
    "Write the formula and its variables clearly before substituting values",
    "Solve one worked example step-by-step to confirm your method",
    "Solve 3 fresh problems without looking at examples — show all steps",
    "Check each answer by substituting back into the original equation",
  ],
  // Research
  research: [
    "Write the research question in one precise sentence — ambiguity kills research",
    "Search for 5 credible sources: prioritize peer-reviewed papers and primary data",
    "Read abstracts first — only fully read papers that directly answer your question",
    "Extract key findings, dates, and citations into a structured notes document",
    "Synthesize: write 3 sentences summarizing what the evidence collectively says",
  ],
  // Interview preparation
  interview: [
    "List the exact topics on the job description and rate your confidence in each",
    "Solve 5 problems from your weakest topic area using pen and paper, not IDE",
    "Practice explaining your solution out loud — interviewers assess communication",
    "Prepare 2 strong examples from past projects using the STAR method",
    "Do a 20-minute timed mock interview: solve one problem with a running clock",
  ],
  // Business & Startup
  business: [
    "Write the problem statement in one sentence that a 10-year-old could understand",
    "Define the target user and list 3 specific pain points they have today",
    "Draft the solution in 3 bullet points — what it does, for whom, and why now",
    "Identify the top 3 competitors and note exactly how you are different",
    "Define one success metric for the next 30 days — make it measurable",
  ],
  // Meetings & Presentations
  meeting: [
    "Write the one objective of this meeting in a single sentence",
    "Build the agenda: max 5 points with a time budget assigned to each",
    "Prepare supporting data or slides — one visual per key argument",
    "Run through your talking points once aloud before the meeting starts",
    "In the meeting: capture decisions and action owners in writing, not memory",
  ],
  // Email drafting
  email: [
    "Write the purpose in the subject line: clear, specific, under 8 words",
    "State the context and request in the first 2 sentences — no warm-up",
    "List required actions or questions as a numbered list if there are multiple",
    "End with a specific call to action and deadline, not just 'let me know'",
    "Re-read before sending: check tone, spelling, and that attachments are attached",
  ],
  // Finance & Bills
  finance: [
    "Identify the exact form, portal, or payee needed — locate it before anything else",
    "Gather every required document: ID, account numbers, previous statements",
    "Complete all fields carefully — verify amounts, account numbers, and dates",
    "Pay or submit and immediately save the confirmation number or screenshot",
    "Set a calendar reminder for the next due date or follow-up action",
  ],
  // Shopping
  shopping: [
    "Write a complete list by category before opening any app or website",
    "Check what you already have to avoid duplicates",
    "Compare prices for items over a set budget threshold before buying",
    "Complete the purchase in one session — avoid cart abandonment loops",
    "Check estimated delivery dates and confirm the order confirmation arrives",
  ],
  // Cooking
  cooking: [
    "Read the full recipe once before touching anything in the kitchen",
    "Prep all ingredients: measure, chop, and set them out before heating the stove",
    "Execute the recipe in order — don't improvise until you've made it once",
    "Taste and adjust seasoning during cooking, not just at the end",
    "Plate, store, or serve immediately — clean as you go to avoid a pile-up",
  ],
  // Household
  household: [
    "Clear all surfaces before cleaning any of them — clutter hides the real work",
    "Work top-to-bottom and left-to-right in each area — never go backward",
    "Focus on one room or zone at a time before moving to the next",
    "Handle trash and laundry last — they mark the visible end of the session",
    "Do a final scan with fresh eyes before considering it done",
  ],
  // Admin & Paperwork
  admin: [
    "Find the exact form, portal, or office needed and bookmark it now",
    "Collect every required document in one folder before filling anything out",
    "Complete each field carefully — double-check names, dates, and ID numbers",
    "Submit and save the confirmation number or receipt immediately",
    "Add the next follow-up date to your calendar before closing the browser",
  ],
  // Language learning
  language: [
    "Pick one skill to focus on this session: vocabulary, grammar, speaking, or listening",
    "Learn 10 new words with example sentences — not isolated translations",
    "Practice using each new word in a sentence you compose yourself",
    "Do 15 minutes of listening to native content at natural speed",
    "Record yourself speaking 5 sentences and listen back for pronunciation gaps",
  ],
  // Reading
  reading: [
    "Read the table of contents and introduction first to build a mental map",
    "Set a target: number of pages or chapters to finish this session",
    "Read actively — annotate key arguments, circle unfamiliar terms",
    "After each chapter, write a 2-sentence summary without looking back",
    "Review your annotations and note 3 ideas you want to remember or apply",
  ],
  // Office work / reports
  work: [
    "Write the exact deliverable in one sentence — what does done look like?",
    "Identify the hardest or most uncertain sub-task and tackle it first",
    "Work in 25-minute uninterrupted blocks — close all non-essential tabs",
    "Review your output critically before sharing — read it as the recipient would",
    "Send or submit, then notify the relevant person and log it",
  ],
  // Fallback
  general: [
    "Define what 'done' looks like in one concrete, measurable sentence",
    "Identify the single most important action that moves this forward",
    "Work on that action for 20 focused minutes before evaluating progress",
    "Verify the output against your definition of done",
    "Close every open loop — confirm, submit, or hand off as needed",
  ],
};

// ================================================================
// INTELLIGENT EXECUTION PLAN GENERATOR
// ================================================================
// Returns { steps: string[], insight: string }
// Steps: expert-quality, domain-specific, sequentially actionable
// Insight: one domain-specific expert tip
async function generateSteps(taskText) {
  const domain = detectTaskType(taskText);

  // ── Expert tip library — domain-specific, non-generic ──────────
  const DOMAIN_TIPS = {
    coding:     "Run your code after every logical change — don't accumulate bugs silently.",
    assignment: "Answer what is asked, not what you know. Every extra word risks losing marks.",
    exam:       "Testing yourself before rereading is 2× more effective than passive review.",
    learning:   "One applied example beats ten watched videos. Build something with what you learn.",
    packing:    "Put your documents and charger in your backpack, never in checked luggage.",
    travel:     "Screenshot your hotel address and save it offline — you may not have signal.",
    fitness:    "Proper form over heavy weight, every time. Injury costs more than a lighter set.",
    writing:    "Write the ending before the middle — knowing where you're going speeds the whole draft.",
    design:     "Design for the weakest user, and everyone else will find it easy.",
    video:      "Cut ruthlessly — if a clip doesn't add information or emotion, it slows the video.",
    math:       "Never skip steps on paper. The mistake is almost always in the step you skipped.",
    research:   "Read 10 abstracts before reading 1 full paper — most papers won't survive the abstract.",
    interview:  "Interviewers care more about how you think than whether you reach the answer.",
    business:   "The clearer your problem statement, the faster every other decision becomes.",
    meeting:    "Distribute the agenda 24h before the meeting — prepared participants make better decisions.",
    email:      "The first sentence determines if the email gets read. Put the ask there, not at the end.",
    finance:    "Screenshot every confirmation page the moment it appears — portals can time out.",
    shopping:   "Close the tab after ordering. Revisiting the cart is the beginning of impulse additions.",
    cooking:    "Read the full recipe before you start. Surprises mid-cook ruin timing.",
    household:  "Set a timer before you start. Without one, cleaning sessions expand to fill the day.",
    admin:      "Gather every document before filling the first field — incomplete submissions lose queue.",
    language:   "Speak the language 10 minutes a day rather than studying grammar 2 hours on weekends.",
    reading:    "Summarize each chapter in your own words before moving to the next.",
    work:       "The 25 minutes after you start are the most productive. Guard them aggressively.",
    general:    "The next action is always more important than the perfect plan.",
  };

  // ── Expert persona per domain ───────────────────────────────────
  const EXPERT_PERSONA = {
    coding:     "Senior Software Engineer",
    assignment: "Subject Tutor",
    exam:       "Experienced Teacher",
    learning:   "Learning Specialist",
    packing:    "Experienced Traveller",
    travel:     "Experienced Traveller",
    fitness:    "Certified Personal Trainer",
    writing:    "Professional Editor",
    design:     "Senior UX Designer",
    video:      "Professional Video Editor",
    math:       "Mathematics Instructor",
    research:   "Academic Researcher",
    interview:  "Tech Hiring Coach",
    business:   "Startup Mentor",
    meeting:    "Executive Coach",
    email:      "Communication Specialist",
    finance:    "Financial Advisor",
    shopping:   "Personal Organizer",
    cooking:    "Professional Chef",
    household:  "Professional Organizer",
    admin:      "Administrative Specialist",
    language:   "Language Coach",
    reading:    "Reading Specialist",
    work:       "Productivity Coach",
    general:    "Execution Coach",
  };

  // ── Complexity classification ────────────────────────────────────
  const DOMAIN_COMPLEXITY = {
    coding: "medium",     assignment: "medium",  exam: "large",
    learning: "medium",   packing: "small",      travel: "medium",
    fitness: "small",     writing: "medium",     design: "medium",
    video: "medium",      math: "medium",        research: "large",
    interview: "large",   business: "large",     meeting: "small",
    email: "very_small",  finance: "small",      shopping: "small",
    cooking: "small",     household: "small",    admin: "small",
    language: "medium",   reading: "medium",     work: "medium",
    general: "medium",
  };
  const wordCount = taskText.trim().split(/\s+/).length;
  const tLow = taskText.toLowerCase();
  // Signals that push complexity UP
  const isLargeScope = /\b(full|complete|entire|whole|comprehensive|end.to.end|production|from scratch|redesign|overhaul|migrate|integrate|deploy|launch|release)\b/.test(tLow);
  // Signals that push complexity DOWN (small, focused, quick tasks)
  const isSmallScope = /\b(quick|simple|small|basic|fix|tweak|update|minor|one|single|just|only|brief)\b/.test(tLow);
  const baseComplexity = DOMAIN_COMPLEXITY[domain] || "medium";
  let complexity = wordCount > 15 ? "large" : wordCount > 8 ? baseComplexity : (
    baseComplexity === "large" ? "medium" : baseComplexity
  );
  if (isLargeScope && complexity !== "large")  complexity = complexity === "very_small" ? "small" : complexity === "small" ? "medium" : "large";
  if (isSmallScope && complexity !== "very_small") complexity = complexity === "large" ? "medium" : complexity === "medium" ? "small" : "very_small";

  const STEP_RANGE = {
    very_small: { min: 1, max: 3 },
    small:      { min: 3, max: 5 },
    medium:     { min: 4, max: 7 },
    large:      { min: 6, max: 10 },
  };
  const range = STEP_RANGE[complexity] || STEP_RANGE.medium;

  // ── Execution strategy per domain ───────────────────────────────
  const DOMAIN_STRATEGY = {
    coding:     "Plan → Implement → Test → Debug → Finalize",
    assignment: "Read → Solve → Verify → Format → Submit",
    exam:       "Audit → Target weak areas → Self-test → Review errors → Final pass",
    learning:   "Set outcome → Consume → Summarize → Apply → Identify gaps",
    packing:    "List → Lay out → Pack → Verify essentials → Close",
    travel:     "Confirm bookings → Pack → Verify documents → Prepare → Depart",
    fitness:    "Setup → Warm-up → Main workout → Cool-down → Log",
    writing:    "Thesis → Outline → Draft → Cut → Polish",
    design:     "Define goal → Sketch → Low-fidelity → High-fidelity → Review",
    video:      "Review footage → Rough cut → Trim → Audio → Export",
    math:       "Identify concept → Formula → Worked example → Practice → Verify",
    research:   "Frame question → Source → Filter → Extract → Synthesize",
    interview:  "Audit topics → Practice → Explain aloud → Mock session → Examples",
    business:   "Define problem → Define user → Draft solution → Competition → Metric",
    meeting:    "Define objective → Build agenda → Prepare → Rehearse → Document",
    email:      "Clarify ask → Draft → Trim → Review → Send",
    finance:    "Locate portal → Gather docs → Complete → Submit → Confirm",
    shopping:   "Write list → Check stock → Compare → Purchase → Confirm delivery",
    cooking:    "Read recipe → Prep → Cook → Taste → Serve",
    household:  "Clear → Top-to-bottom → Zone by zone → Handle waste → Final scan",
    admin:      "Find form → Collect docs → Fill → Submit → Save confirmation",
    language:   "Pick skill → Learn → Use in sentences → Listen → Speak",
    reading:    "Survey → Set target → Read actively → Summarize → Review",
    work:       "Define deliverable → Hardest first → Execute → Review → Submit",
    general:    "Define done → Remove blocker → Execute → Verify → Close",
  };
  const strategy   = DOMAIN_STRATEGY[domain] || DOMAIN_STRATEGY.general;
  const persona    = EXPERT_PERSONA[domain]  || EXPERT_PERSONA.general;
  const expertTip  = DOMAIN_TIPS[domain] || DOMAIN_TIPS.general;

  const COMPLEXITY_LABELS = {
    very_small: "Very Small", small: "Small", medium: "Medium", large: "Large"
  };
  const complexityLabel = COMPLEXITY_LABELS[complexity] || "Medium";


  const jsonPrompt = `You are ${persona}. Generate a precise execution plan for the task below.

TASK: "${taskText}"

## PHASE 1 — INTERNAL REASONING (think silently, output nothing from this phase)
1. INTENT: What is the user actually trying to accomplish? What does "done" look like?
2. SPECIFICITY: What details in the task text constrain the steps? (e.g. subject, tool, deliverable)
3. COMPLEXITY: ${complexityLabel} → use ${range.min}–${range.max} steps. Does the task text suggest more or fewer?
4. SEQUENCE: What is the natural order an expert ${persona} would follow for THIS specific task?
5. GAPS: Is any essential information genuinely missing? If so, note it for the coachingTip.

## PHASE 2 — SELF-VALIDATION (check before writing JSON, output nothing)
✓ Every step directly moves THIS task forward — it would NOT make sense for a different task
✓ Each step = exactly ONE concrete action (no "and", no compound actions)
✓ Each step title is 4–12 words, starts with an action verb, no filler openers
✓ Forbidden openers: "Start by", "Begin", "Make sure", "Ensure", "Try to", "Remember to"
✓ Forbidden generic steps: "Gather materials", "Take notes", "Do research", "Think about", "Stay focused"
✓ Each step is completable in 5–20 minutes (break longer work into sub-steps)
✓ Step count matches actual complexity of THIS task (not just domain default)
✓ The final step completes the task — nothing left hanging
✓ If validation fails on any step, rewrite that step before proceeding

## ABSOLUTE RULES:
- Steps must be task-specific. If the same plan fits an unrelated task, it is too generic — rewrite it.
- Never invent tools, technologies, or requirements not implied by the task.
- Never use motivational language or paragraphs inside steps.
- Steps are for doing, not planning or thinking.

## OUTPUT FORMAT — return ONLY valid JSON, no markdown fences, no text outside JSON:
{
  "taskTitle": "string — concise restatement, max 8 words",
  "objective": "string — what done looks like, 1 sentence",
  "domain": "${domain}",
  "expertPersona": "${persona}",
  "complexity": "${complexityLabel}",
  "estimatedCompletionTime": "string — e.g. '45 min', '2 hrs'",
  "recommendedFocusSession": "string — e.g. '25 min'",
  "breakFrequency": "string — e.g. 'After each step'",
  "executionStrategy": "${strategy}",
  "coachingTip": "string — one actionable tip specific to this task (not a generic quote)",
  "steps": [
    {
      "title": "string — action verb + specific object, 4–12 words",
      "duration": "string — realistic per-step time, e.g. '10 min'",
      "difficulty": "Easy | Medium | Hard",
      "reason": "string — why this step matters for THIS task, 1 sentence"
    }
  ],
  "expectedOutcome": "string — concrete deliverable after all steps, 1 sentence",
  "completionReflection": "string — use [TIME] as placeholder for actual time taken"
}

Generate ${range.min}–${range.max} steps. Each step must be specific to: "${taskText}"`;

  // The backend owns the Gemini key and forwards this prompt securely.

  // ── Fully-structured offline fallbacks — all 25 domains ─────────
  const STRUCTURED_FALLBACK = {
    coding: {
      steps: [
        { title: "Read the requirement or error message word-by-word",           duration: "10 min", difficulty: "Easy",   reason: "Misreading requirements is the leading cause of wasted coding time." },
        { title: "Write the expected output as a comment before coding",          duration: "10 min", difficulty: "Easy",   reason: "Defining done before starting prevents scope creep mid-implementation." },
        { title: "Implement the core logic in one focused function",              duration: "40 min", difficulty: "Hard",   reason: "A single clean implementation is easier to test and refactor than scattered code." },
        { title: "Test with one happy path and one edge case — log both",         duration: "20 min", difficulty: "Medium", reason: "Edge cases reveal assumptions you didn't know you were making." },
        { title: "Commit with a message describing the change and why",           duration: "10 min", difficulty: "Easy",   reason: "A meaningful commit message saves future-you hours of archaeology." },
      ],
      estimatedCompletionTime: "90 min", recommendedFocusSession: "25 min", breakFrequency: "Every 25 min",
      expectedOutcome: "A tested, committed implementation that solves the defined requirement.",
      completionReflection: "You worked through the full code → test cycle in [TIME]. Next: code review or the next feature.",
    },
    assignment: {
      steps: [
        { title: "Read every question and underline keywords and constraints",    duration: "10 min", difficulty: "Easy",   reason: "Answering what isn't asked wastes marks and time." },
        { title: "Solve highest-mark questions first while focus is peak",         duration: "40 min", difficulty: "Hard",   reason: "High-value questions deserve your sharpest thinking." },
        { title: "Show all working steps — answer precisely, nothing extra",       duration: "30 min", difficulty: "Medium", reason: "Partial credit exists for correct method even with wrong answers." },
        { title: "Re-read every answer for errors and missed sub-parts",           duration: "15 min", difficulty: "Medium", reason: "One review catches 80% of careless mistakes." },
        { title: "Format and submit — screenshot confirmation if online",           duration: "5 min",  difficulty: "Easy",   reason: "Unsubmitted work earns zero, no matter how correct." },
      ],
      estimatedCompletionTime: "100 min", recommendedFocusSession: "25 min", breakFrequency: "After each question block",
      expectedOutcome: "Submitted assignment with all questions attempted and verified.",
      completionReflection: "Assignment submitted after [TIME]. Next: check if a similar practice sheet exists.",
    },
    exam: {
      steps: [
        { title: "List every syllabus topic — mark Strong, Weak, or Unseen",              duration: "15 min", difficulty: "Easy",   reason: "You can't allocate study time without knowing where the gaps are." },
        { title: "Study each Weak topic: read only the relevant section, not chapter",     duration: "45 min", difficulty: "Hard",   reason: "Focused study on weak areas yields more marks per hour than reviewing strengths." },
        { title: "Write the 5 most important formulas or concepts from memory",             duration: "15 min", difficulty: "Medium", reason: "Retrieval practice is 2× more effective than re-reading." },
        { title: "Solve 5 past exam questions under timed conditions — no peeking",        duration: "40 min", difficulty: "Hard",   reason: "Exam simulation builds the speed and composure you need on the day." },
        { title: "Review wrong answers — write exactly why each mistake happened",          duration: "20 min", difficulty: "Medium", reason: "Understanding the error pattern prevents repeating it." },
        { title: "Final 10-minute mental walkthrough of all key points",                    duration: "10 min", difficulty: "Easy",   reason: "A pre-sleep review consolidates memory better than cramming." },
      ],
      estimatedCompletionTime: "2 hrs 25 min", recommendedFocusSession: "45 min", breakFrequency: "Every 45 min",
      expectedOutcome: "All weak topics revised, key concepts retrievable from memory, and exam questions practiced.",
      completionReflection: "Full study session completed in [TIME]. Prioritize sleep — memory consolidates overnight.",
    },
    learning: {
      steps: [
        { title: "Write one specific outcome: what will you DO after this session?", duration: "5 min",  difficulty: "Easy",   reason: "Vague learning goals produce vague results." },
        { title: "Study only the section that addresses your stated outcome",          duration: "30 min", difficulty: "Medium", reason: "Consuming more than your outcome requires creates confusion, not knowledge." },
        { title: "Type your understanding of each major concept in your own words",   duration: "15 min", difficulty: "Medium", reason: "If you can't explain it simply, you don't understand it yet." },
        { title: "Build one hands-on example applying what you just learned",          duration: "25 min", difficulty: "Hard",   reason: "Application reveals the gaps that passive consumption hides." },
        { title: "Note one thing still unclear — research it before next session",     duration: "5 min",  difficulty: "Easy",   reason: "Unresolved confusion compounds into a larger blocker over time." },
      ],
      estimatedCompletionTime: "80 min", recommendedFocusSession: "25 min", breakFrequency: "After each step",
      expectedOutcome: "One concept fully understood and applied through a working example.",
      completionReflection: "Learning session done in [TIME]. One applied example built. Next: the gap you identified.",
    },
    fitness: {
      steps: [
        { title: "Set up space and timer before changing — eliminate setup friction", duration: "5 min",  difficulty: "Easy",  reason: "Pre-setup removes the micro-decision that causes skipped workouts." },
        { title: "Warm up 5 min: mobility drills for today's targeted muscles",        duration: "8 min",  difficulty: "Easy",  reason: "Cold muscles tear — warm-up is injury prevention, not optional." },
        { title: "Execute main block at full effort — form over weight always",        duration: "30 min", difficulty: "Hard",  reason: "Quality reps build more than sloppy volume and are far safer." },
        { title: "Cool down: static stretching targeting muscles just worked",         duration: "8 min",  difficulty: "Easy",  reason: "Cool-down reduces soreness and prevents next-day mobility loss." },
        { title: "Log reps, weight, and duration immediately — memory fades fast",     duration: "3 min",  difficulty: "Easy",  reason: "Without a log, you can't measure progress or plan the next session." },
      ],
      estimatedCompletionTime: "54 min", recommendedFocusSession: "Full session", breakFrequency: "Between sets",
      expectedOutcome: "Completed workout with all sets logged — baseline set for next session's progression.",
      completionReflection: "Workout done in [TIME]. Next session: add one rep or 2.5kg to one exercise.",
    },
    writing: {
      steps: [
        { title: "Write the single-sentence thesis: what is this piece arguing?", duration: "10 min", difficulty: "Medium", reason: "Every word you write will either support this sentence or be cut." },
        { title: "Draft a 5-point bullet outline before writing any prose",        duration: "15 min", difficulty: "Easy",   reason: "An outline makes writing 3× faster by removing structural decisions mid-draft." },
        { title: "Write the full first draft without stopping to edit",            duration: "45 min", difficulty: "Hard",   reason: "Editing while drafting is the single biggest cause of writer's block." },
        { title: "Cut every sentence that does not directly support your thesis",  duration: "20 min", difficulty: "Hard",   reason: "Ruthless cutting separates professional writing from amateur writing." },
        { title: "Read the final version aloud — fix anything that sounds wrong",  duration: "15 min", difficulty: "Medium", reason: "Your ear catches rhythm and logic errors your eye misses." },
      ],
      estimatedCompletionTime: "105 min", recommendedFocusSession: "45 min", breakFrequency: "Between drafting and editing",
      expectedOutcome: "A polished, thesis-driven piece ready for submission or publication.",
      completionReflection: "Full writing cycle completed in [TIME]. Next: share with one reader for a fresh perspective.",
    },
    design: {
      steps: [
        { title: "Define the design goal: what problem does this solve for whom?", duration: "10 min", difficulty: "Medium", reason: "Design without a defined problem produces beautiful but useless output." },
        { title: "Sketch 3 rough layout options on paper before opening any tool", duration: "20 min", difficulty: "Easy",   reason: "Paper sketches are faster to iterate and prevent early attachment." },
        { title: "Build the chosen layout in low-fidelity — no colors yet",         duration: "30 min", difficulty: "Medium", reason: "Structure and hierarchy must work in grayscale before color is added." },
        { title: "Apply typography, spacing, and color using your style guide",      duration: "30 min", difficulty: "Medium", reason: "Applying the visual layer after structure prevents color from masking bad UX." },
        { title: "Review against the goal — remove anything that doesn't serve it", duration: "15 min", difficulty: "Hard",   reason: "Every pixel should earn its place." },
      ],
      estimatedCompletionTime: "105 min", recommendedFocusSession: "30 min", breakFrequency: "Between each phase",
      expectedOutcome: "A high-fidelity design that solves the defined problem with no decorative clutter.",
      completionReflection: "Design session complete in [TIME]. Next: user test with 2 people who match your target.",
    },
    video: {
      steps: [
        { title: "Watch raw footage once and mark usable takes with timestamps",   duration: "20 min", difficulty: "Medium", reason: "Knowing your material before editing prevents backtracking." },
        { title: "Assemble rough cut in sequence — ignore color and audio now",     duration: "30 min", difficulty: "Medium", reason: "Structure must work before any polish is applied." },
        { title: "Trim every clip — cut 0.5s from start and end if unsure",         duration: "20 min", difficulty: "Hard",   reason: "Most editors keep 10% too much footage. Brevity holds attention." },
        { title: "Add music and voiceover — balance audio levels across the edit",  duration: "20 min", difficulty: "Medium", reason: "Audio quality is more forgiving than video quality to most audiences." },
        { title: "Export at correct settings and watch full video before uploading", duration: "15 min", difficulty: "Easy",   reason: "Catching an error pre-upload costs 2 minutes. Post-upload costs 30." },
      ],
      estimatedCompletionTime: "105 min", recommendedFocusSession: "45 min", breakFrequency: "Between rough cut and trim",
      expectedOutcome: "A fully edited, exported video file ready for upload.",
      completionReflection: "Edit complete in [TIME]. Next: thumbnail and description — they determine 70% of clicks.",
    },
    math: {
      steps: [
        { title: "Identify the exact concept or formula before attempting anything", duration: "10 min", difficulty: "Easy",   reason: "Attempting problems without the right tool wastes time." },
        { title: "Write the formula and all variables clearly before substituting",  duration: "10 min", difficulty: "Easy",   reason: "Written setup prevents errors from missing or swapping variables." },
        { title: "Solve one worked example step-by-step to confirm your method",    duration: "20 min", difficulty: "Medium", reason: "One confirmed method protects you from repeating the same mistake 5 times." },
        { title: "Solve 3 fresh problems — show all steps, no shortcuts",            duration: "30 min", difficulty: "Hard",   reason: "Spaced practice after worked examples is when learning actually happens." },
        { title: "Verify each answer by substituting back into the original",        duration: "10 min", difficulty: "Medium", reason: "Verification is the only way to catch algebraic errors without a teacher." },
      ],
      estimatedCompletionTime: "80 min", recommendedFocusSession: "25 min", breakFrequency: "Every 25 min",
      expectedOutcome: "Formula understood, method confirmed, and 3 independent problems solved correctly.",
      completionReflection: "Math session done in [TIME]. Next: attempt one harder problem to test depth.",
    },
    research: {
      steps: [
        { title: "Write the research question in one precise, unambiguous sentence", duration: "10 min", difficulty: "Medium", reason: "Ambiguous questions produce unfocused research and unusable results." },
        { title: "Search for 5 credible sources — prioritize peer-reviewed papers",  duration: "30 min", difficulty: "Medium", reason: "Source quality determines conclusion quality." },
        { title: "Read abstracts first — fully read only directly relevant papers",  duration: "20 min", difficulty: "Hard",   reason: "Reading full papers without screening wastes 60% of your time." },
        { title: "Extract key findings, dates, and citations into structured notes", duration: "25 min", difficulty: "Medium", reason: "Structured notes make synthesis 3× faster." },
        { title: "Write 3 sentences synthesizing what the evidence collectively says", duration: "20 min", difficulty: "Hard", reason: "Synthesis — not summary — demonstrates real understanding." },
      ],
      estimatedCompletionTime: "105 min", recommendedFocusSession: "25 min", breakFrequency: "After each source",
      expectedOutcome: "A structured evidence base with a clear 3-sentence synthesis ready to use.",
      completionReflection: "Research done in [TIME]. Next: turn your synthesis into an outline or argument.",
    },
    interview: {
      steps: [
        { title: "List every topic on the job description — rate confidence in each", duration: "20 min", difficulty: "Medium", reason: "You can't improve without knowing exactly where the gaps are." },
        { title: "Solve 5 problems from your weakest topic using pen and paper",      duration: "45 min", difficulty: "Hard",   reason: "Pen-and-paper mirrors the interview condition more closely than IDE." },
        { title: "Explain your solution out loud to an imaginary interviewer",         duration: "20 min", difficulty: "Hard",   reason: "Communication is evaluated as heavily as the solution itself." },
        { title: "Prepare 2 strong project examples using the STAR method",           duration: "20 min", difficulty: "Medium", reason: "Behavioral questions decide the offer when technical scores are equal." },
        { title: "Run a 20-minute timed mock with one complete problem",              duration: "20 min", difficulty: "Hard",   reason: "Time pressure in practice means no panic during the real thing." },
      ],
      estimatedCompletionTime: "125 min", recommendedFocusSession: "45 min", breakFrequency: "Between each practice block",
      expectedOutcome: "Weak topics practiced, communication polished, and STAR examples ready.",
      completionReflection: "Interview prep done in [TIME]. Next: repeat with a different weak topic tomorrow.",
    },
    business: {
      steps: [
        { title: "Write the problem in one sentence a 10-year-old understands",   duration: "15 min", difficulty: "Hard",   reason: "If you can't explain the problem simply, you don't understand it well enough to solve it." },
        { title: "Define the target user and list 3 specific current pain points",  duration: "20 min", difficulty: "Medium", reason: "Vague users produce vague products." },
        { title: "Draft the solution in 3 bullets: what, for whom, and why now",    duration: "20 min", difficulty: "Medium", reason: "A concise solution statement tests whether your thinking is clear." },
        { title: "Identify top 3 competitors and note exactly how you differ",      duration: "20 min", difficulty: "Medium", reason: "If you can't articulate differentiation, neither can your customers." },
        { title: "Define one measurable success metric for the next 30 days",       duration: "15 min", difficulty: "Hard",   reason: "One clear metric prevents the 'everything is going okay' delusion." },
      ],
      estimatedCompletionTime: "90 min", recommendedFocusSession: "25 min", breakFrequency: "Every 25 min",
      expectedOutcome: "A clear problem, user, solution, competitive position, and measurable goal.",
      completionReflection: "Business planning done in [TIME]. Next: validate the problem with 3 real potential users.",
    },
    meeting: {
      steps: [
        { title: "Write the one objective of this meeting in a single sentence",   duration: "10 min", difficulty: "Easy",   reason: "A meeting without a clear objective wastes everyone's time." },
        { title: "Build the agenda: max 5 points with time budgets per item",      duration: "15 min", difficulty: "Medium", reason: "Time-boxed agendas prevent single topics from consuming the whole slot." },
        { title: "Prepare supporting data — one visual per key argument",           duration: "20 min", difficulty: "Medium", reason: "Data-backed points are harder to dismiss." },
        { title: "Run through your talking points once aloud before starting",      duration: "10 min", difficulty: "Easy",   reason: "One rehearsal catches gaps before the audience sees them." },
      ],
      estimatedCompletionTime: "55 min", recommendedFocusSession: "25 min", breakFrequency: "As needed",
      expectedOutcome: "Prepared agenda, materials ready, and a clear meeting objective.",
      completionReflection: "Meeting prep done in [TIME]. Next: send the agenda to participants now.",
    },
    email: {
      steps: [
        { title: "Write the ask in the subject line — clear, specific, under 8 words", duration: "5 min",  difficulty: "Easy",   reason: "Subject lines determine whether the email gets read today or next week." },
        { title: "State context and request in the first 2 sentences — no warm-up",    duration: "10 min", difficulty: "Medium", reason: "Busy people skim the first 2 sentences — if the ask isn't there, it gets missed." },
        { title: "List actions or questions as a numbered list if more than one",       duration: "5 min",  difficulty: "Easy",   reason: "Multiple requests buried in prose create ambiguity about what's expected." },
        { title: "Re-read before sending — check tone, spelling, and attachments",     duration: "5 min",  difficulty: "Easy",   reason: "One typo in a professional email undermines everything before it." },
      ],
      estimatedCompletionTime: "25 min", recommendedFocusSession: "25 min", breakFrequency: "Not needed",
      expectedOutcome: "A clear, professional email with an unambiguous ask — ready to send.",
      completionReflection: "Email drafted and sent in [TIME]. Next: set a follow-up reminder if you expect a reply.",
    },
    finance: {
      steps: [
        { title: "Find the exact portal, form, or payee before anything else",     duration: "10 min", difficulty: "Easy",   reason: "Starting without the right destination wastes time and risks the wrong channel." },
        { title: "Collect every required document: ID, account numbers, statements", duration: "15 min", difficulty: "Easy",   reason: "Incomplete documentation gets rejected — gather once, submit once." },
        { title: "Complete all fields carefully — verify amounts and dates twice",   duration: "15 min", difficulty: "Medium", reason: "Financial errors can take weeks to correct. One minute of verification saves hours." },
        { title: "Submit and save confirmation number or screenshot immediately",    duration: "5 min",  difficulty: "Easy",   reason: "Portals time out. Without a confirmation, the transaction may not exist." },
      ],
      estimatedCompletionTime: "45 min", recommendedFocusSession: "45 min", breakFrequency: "Not needed",
      expectedOutcome: "Financial task completed with confirmation saved and next action calendared.",
      completionReflection: "Financial task done in [TIME]. Next: set a calendar reminder for the next due date.",
    },
    shopping: {
      steps: [
        { title: "Write a complete categorized list before opening any app",    duration: "10 min", difficulty: "Easy",   reason: "Shopping without a list results in forgotten items and impulse purchases." },
        { title: "Check what you already have to avoid duplicates",              duration: "5 min",  difficulty: "Easy",   reason: "Duplicate purchases are a quiet budget leak." },
        { title: "Compare prices for high-value items before committing",         duration: "10 min", difficulty: "Easy",   reason: "Five minutes of comparison can save meaningful money." },
        { title: "Complete the purchase in one session — close tab after checkout", duration: "10 min", difficulty: "Easy",  reason: "Revisiting the cart is how impulse additions happen." },
      ],
      estimatedCompletionTime: "35 min", recommendedFocusSession: "25 min", breakFrequency: "Not needed",
      expectedOutcome: "All required items ordered, order confirmed, and delivery tracked.",
      completionReflection: "Shopping done in [TIME]. Next: set a delivery-day reminder.",
    },
    cooking: {
      steps: [
        { title: "Read the full recipe once from start to finish before starting", duration: "5 min",  difficulty: "Easy",   reason: "Mid-cook surprises ruin timing — 5 minutes of reading prevents an hour of frustration." },
        { title: "Measure, chop, and lay out all ingredients before using heat",   duration: "20 min", difficulty: "Medium", reason: "Mise en place prevents burning something because you were still chopping." },
        { title: "Execute the recipe in sequence — no improvisation first time",   duration: "30 min", difficulty: "Medium", reason: "Understand the original before you modify it." },
        { title: "Taste and adjust seasoning during cooking, not just at the end", duration: "5 min",  difficulty: "Easy",   reason: "Seasoning at the end only masks; seasoning during cooking builds depth." },
      ],
      estimatedCompletionTime: "60 min", recommendedFocusSession: "Full session", breakFrequency: "Not needed",
      expectedOutcome: "Completed meal, plated and tasted — baseline established for future iterations.",
      completionReflection: "Cooking done in [TIME]. Next: note what you'd change for the next attempt.",
    },
    household: {
      steps: [
        { title: "Clear all surfaces before cleaning any of them",               duration: "15 min", difficulty: "Easy",   reason: "Cleaning around clutter is cleaning twice." },
        { title: "Work top-to-bottom and left-to-right in each zone",             duration: "20 min", difficulty: "Easy",   reason: "Systematic movement prevents re-dirtying cleaned surfaces." },
        { title: "Complete one room entirely before moving to the next",           duration: "25 min", difficulty: "Medium", reason: "Finishing one room gives visible progress; jumping between rooms creates chaos." },
        { title: "Handle trash and laundry last — they mark visible completion",   duration: "10 min", difficulty: "Easy",   reason: "Ending with the most visible task maximizes the sense of accomplishment." },
      ],
      estimatedCompletionTime: "70 min", recommendedFocusSession: "25 min", breakFrequency: "Between rooms",
      expectedOutcome: "Clean, reset space with all clutter removed and all surfaces cleared.",
      completionReflection: "Cleaning done in [TIME]. Next: a 5-minute nightly reset prevents sessions like this.",
    },
    admin: {
      steps: [
        { title: "Find the exact form, portal, or office and bookmark it",       duration: "10 min", difficulty: "Easy",   reason: "Starting the wrong process resets your queue position." },
        { title: "Collect every required document before filling out anything",   duration: "15 min", difficulty: "Easy",   reason: "Incomplete submissions get rejected and restart the waiting period." },
        { title: "Complete every field carefully — verify names, dates, IDs",     duration: "15 min", difficulty: "Medium", reason: "Typos on official forms cause rejections that take weeks to resolve." },
        { title: "Submit and save confirmation number or screenshot immediately", duration: "5 min",  difficulty: "Easy",   reason: "Without proof of submission, disputes become very difficult to resolve." },
      ],
      estimatedCompletionTime: "45 min", recommendedFocusSession: "45 min", breakFrequency: "Not needed",
      expectedOutcome: "Administrative task submitted with confirmation saved.",
      completionReflection: "Admin task done in [TIME]. Next: add the next deadline to your calendar now.",
    },
    language: {
      steps: [
        { title: "Pick one skill for this session: vocabulary, grammar, or speaking", duration: "5 min",  difficulty: "Easy",   reason: "Trying to improve everything at once produces improvement in nothing." },
        { title: "Learn 10 new words with example sentences — not isolated translations", duration: "15 min", difficulty: "Medium", reason: "Context is how words enter long-term memory; translation alone doesn't work." },
        { title: "Use each new word in a sentence you compose yourself",               duration: "15 min", difficulty: "Hard",   reason: "Production practice cements retention far more than recognition practice." },
        { title: "Listen to 15 minutes of native content at natural speed",            duration: "15 min", difficulty: "Hard",   reason: "Comprehension at native speed is the actual target — slow audio creates false fluency." },
        { title: "Record yourself speaking 5 sentences and listen back for gaps",      duration: "10 min", difficulty: "Hard",   reason: "Hearing your own pronunciation gaps is the fastest path to correcting them." },
      ],
      estimatedCompletionTime: "60 min", recommendedFocusSession: "25 min", breakFrequency: "Between each skill block",
      expectedOutcome: "10 new words learned in context, production practiced, and listening exposure completed.",
      completionReflection: "Language session done in [TIME]. Next: review today's words tomorrow — spaced repetition beats cramming.",
    },
    reading: {
      steps: [
        { title: "Read table of contents and introduction to build a mental map", duration: "10 min", difficulty: "Easy",   reason: "A mental map lets you place each section into a meaningful structure as you read." },
        { title: "Set a specific target: exact pages or chapters to finish today", duration: "3 min",  difficulty: "Easy",   reason: "Without a target, reading sessions expand or contract randomly." },
        { title: "Read actively — annotate key arguments, circle unfamiliar terms", duration: "30 min", difficulty: "Medium", reason: "Active annotation doubles retention over passive reading." },
        { title: "After each chapter, write a 2-sentence summary without looking", duration: "10 min", difficulty: "Hard",   reason: "Free recall is the most powerful learning technique known." },
        { title: "Review annotations and note 3 ideas you want to apply",           duration: "7 min",  difficulty: "Easy",   reason: "Extracting application points converts reading into usable knowledge." },
      ],
      estimatedCompletionTime: "60 min", recommendedFocusSession: "25 min", breakFrequency: "After each chapter",
      expectedOutcome: "Target pages read, annotated, summarized, and 3 applicable ideas extracted.",
      completionReflection: "Reading session done in [TIME]. Next: schedule the next chapter before closing the book.",
    },
    work: {
      steps: [
        { title: "Write the exact deliverable in one sentence — what does done look like?", duration: "5 min",  difficulty: "Easy",   reason: "Vague deliverables produce vague work. One sentence of clarity saves hours." },
        { title: "Identify the hardest sub-task and tackle it while focus is highest",      duration: "30 min", difficulty: "Hard",   reason: "The hardest task expands to fill all available time if left for later." },
        { title: "Work in 25-minute blocks — close all non-essential tabs",                 duration: "25 min", difficulty: "Medium", reason: "Distraction costs 23 minutes of recovery. One closed tab saves your session." },
        { title: "Review output critically — read it as the intended recipient would",      duration: "15 min", difficulty: "Medium", reason: "Your work will be judged from their perspective, not yours." },
        { title: "Send or submit and notify the relevant person — log it as done",          duration: "5 min",  difficulty: "Easy",   reason: "Completed work that isn't submitted doesn't count." },
      ],
      estimatedCompletionTime: "80 min", recommendedFocusSession: "25 min", breakFrequency: "Every 25 min",
      expectedOutcome: "Deliverable completed, reviewed from the recipient's perspective, and submitted.",
      completionReflection: "Work task done in [TIME]. Next: clear the next item from your backlog.",
    },
    packing: {
      steps: [
        { title: "Write categories: clothes, toiletries, documents, electronics, misc", duration: "10 min", difficulty: "Easy",   reason: "Category lists prevent the 'I forgot my charger' moment at the airport." },
        { title: "Lay every item on the bed and cross-check against the list",           duration: "15 min", difficulty: "Easy",   reason: "Visual inventory catches omissions that mental checklists miss." },
        { title: "Pack in order: heaviest base, clothes rolled, fragile items last",      duration: "20 min", difficulty: "Medium", reason: "Packing order prevents wrinkles and protects fragile items." },
        { title: "Final critical check: ID, boarding pass, charger, cash, phone",         duration: "5 min",  difficulty: "Easy",   reason: "These 5 items can't be replaced quickly at the destination." },
      ],
      estimatedCompletionTime: "50 min", recommendedFocusSession: "50 min", breakFrequency: "Not needed",
      expectedOutcome: "Packed bag with all items verified against the list — critical documents confirmed.",
      completionReflection: "Packed in [TIME]. Next: weigh the bag if flying.",
    },
    travel: {
      steps: [
        { title: "Confirm all bookings: transport, hotel, and local connectivity", duration: "15 min", difficulty: "Easy",   reason: "Unconfirmed bookings are assumptions — one call prevents a stranded night." },
        { title: "Write a categorized packing list and cross-check with weather",  duration: "20 min", difficulty: "Easy",   reason: "Weather-aware packing prevents buying essentials at inflated travel prices." },
        { title: "Prepare documents folder: ID, tickets, insurance, confirmations", duration: "15 min", difficulty: "Easy",   reason: "Physical and digital copies of all documents save you if one is lost." },
        { title: "Pack and verify: documents, charger, cash, and medications",      duration: "25 min", difficulty: "Medium", reason: "These four categories cover 90% of travel emergencies." },
        { title: "Share itinerary with one contact and save offline maps",           duration: "10 min", difficulty: "Easy",   reason: "Offline maps work when signal fails — and signal always fails at the worst moment." },
      ],
      estimatedCompletionTime: "85 min", recommendedFocusSession: "25 min", breakFrequency: "As needed",
      expectedOutcome: "All bookings confirmed, bag packed, documents ready, and offline navigation saved.",
      completionReflection: "Travel prep done in [TIME]. Next: charge all devices overnight.",
    },
    general: {
      steps: [
        { title: "Clarify the goal: write what 'completed' looks like in one sentence", duration: "5 min",  difficulty: "Easy",   reason: "A clear goal prevents drifting into the wrong direction." },
        { title: "Break it into the 2–3 smallest possible concrete actions",             duration: "5 min",  difficulty: "Medium", reason: "Small actions are far more likely to get done than vague tasks." },
        { title: "Execute the first action without interruption for 20 minutes",         duration: "20 min", difficulty: "Medium", reason: "The first 20 minutes of focused work determine the session's outcome." },
        { title: "Review what you've done and adjust the remaining steps if needed",     duration: "5 min",  difficulty: "Easy",   reason: "Regular check-ins prevent wasted effort in the wrong direction." },
      ],
      estimatedCompletionTime: "35 min", recommendedFocusSession: "25 min", breakFrequency: "Every 25 min",
      expectedOutcome: "Task completed with a clear outcome and the next action identified.",
      completionReflection: "Done in [TIME]. What did you learn or finish?",
    },
  };

  // ── Parse structured JSON from Gemini's response ────────────────
  function parseStructuredResponse(rawText, minSteps, maxSteps) {
    let jsonStr = rawText.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");

    const firstBrace = jsonStr.indexOf("{");
    const lastBrace  = jsonStr.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1) return null;
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);

    let parsed;
    try { parsed = JSON.parse(jsonStr); }
    catch (e) { console.warn("[Nudge AI] JSON parse failed:", e.message); return null; }

    if (!parsed.steps || !Array.isArray(parsed.steps)) return null;

    const validSteps = parsed.steps
      .filter(s => s && typeof s.title === "string" && s.title.trim().length > 5)
      .slice(0, maxSteps);

    if (validSteps.length < minSteps) return null;

    return {
      taskTitle:               parsed.taskTitle               || taskText.slice(0, 60),
      objective:               parsed.objective               || "",
      domain:                  parsed.domain                  || domain,
      expertPersona:           parsed.expertPersona           || persona,
      complexity:              parsed.complexity              || complexityLabel,
      estimatedCompletionTime: parsed.estimatedCompletionTime || "—",
      recommendedFocusSession: parsed.recommendedFocusSession || "25 min",
      breakFrequency:          parsed.breakFrequency          || "Every 25 min",
      executionStrategy:       parsed.executionStrategy       || strategy,
      coachingTip:             parsed.coachingTip             || expertTip,
      steps:                   validSteps,
      expectedOutcome:         parsed.expectedOutcome         || "",
      completionReflection:    parsed.completionReflection    || "Task completed in [TIME].",
    };
  }

  // ── Send the plan prompt through the secure backend ──────────────
  async function tryModels() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: jsonPrompt }),
        signal: controller.signal
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        console.warn("[Nudge AI] Backend request failed:", err.detail || response.statusText);
        return null;
      }

      const data = await response.json();
      const parsed = parseStructuredResponse(data.text || "", range.min, range.max);
      if (parsed && parsed.steps.length >= range.min) {
        console.log(`[Nudge AI] ✓ backend → ${parsed.steps.length} structured steps, domain:${domain}, persona:${persona}`);
        return parsed;
      }
      console.warn("[Nudge AI] Backend returned insufficient structured output.");
      return null;
    } catch (e) {
      console.warn("[Nudge AI] Backend error:", e.name, e.message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  let planData = null;
  try {
    planData = await Promise.race([
      tryModels(),
      new Promise(resolve => setTimeout(() => resolve(null), 32000)),
    ]);
  } catch (e) {
    console.warn("[Nudge AI] Unexpected error:", e);
  }


  // ── Use expert fallback if API returned nothing usable ──────────
  if (!planData) {
    console.warn(`[Nudge AI] Using expert fallback for domain: ${domain}`);
    const fb = STRUCTURED_FALLBACK[domain] || STRUCTURED_FALLBACK.general;
    planData = {
      taskTitle:               taskText.slice(0, 60),
      objective:               `Successfully complete: ${taskText}`,
      domain,
      expertPersona:           persona,
      complexity:              complexityLabel,
      estimatedCompletionTime: fb.estimatedCompletionTime,
      recommendedFocusSession: fb.recommendedFocusSession,
      breakFrequency:          fb.breakFrequency,
      executionStrategy:       strategy,
      coachingTip:             expertTip,
      steps:                   fb.steps,
      expectedOutcome:         fb.expectedOutcome,
      completionReflection:    fb.completionReflection,
    };
  }

  // ── Persist rich plan metadata on state for UI consumption ──────
  state.planMeta = {
    taskTitle:               planData.taskTitle,
    objective:               planData.objective,
    domain:                  planData.domain,
    expertPersona:           planData.expertPersona,
    complexity:              planData.complexity,
    estimatedCompletionTime: planData.estimatedCompletionTime,
    recommendedFocusSession: planData.recommendedFocusSession,
    breakFrequency:          planData.breakFrequency,
    executionStrategy:       planData.executionStrategy,
    coachingTip:             planData.coachingTip,
    expectedOutcome:         planData.expectedOutcome,
    completionReflection:    planData.completionReflection,
  };

  // ── Return step-title strings (backward-compatible array) ───────
  const stepStrings    = planData.steps.map(s => s.title);
  stepStrings._insight = planData.coachingTip;   // shown in mood banner after plan loads
  stepStrings._meta    = planData.steps;          // per-step metadata: duration, difficulty, reason
  return stepStrings;
}


// ================================================================
// SMART NUDGE SYSTEM
// ================================================================
function getNudgeMessage(type) {
  const idle = [
    { emoji: "😐", text: "Still here? Just start the next step.", cls: "mood-warn" },
    { emoji: "😐", text: "You're delaying. Keep the momentum.", cls: "mood-warn" },
  ];
  const badIdle = [
    { emoji: "😤", text: "The task won't do itself. Go.", cls: "mood-bad" },
    { emoji: "😤", text: "You've been idle too long. Move.", cls: "mood-bad" },
  ];
  const good = [
    { emoji: "🙂", text: "Good job. Keep going.", cls: "mood-good" },
    { emoji: "🙂", text: "Solid. Don't stop now.", cls: "mood-good" },
  ];
  const oneStep = [
    { emoji: "💪", text: "First one down. Build on it.", cls: "mood-good" },
    { emoji: "🔥", text: "Good start. Don't break the flow.", cls: "mood-good" },
  ];
  const multiStep = [
    { emoji: "🚀", text: "You're on a roll. Keep pushing.", cls: "mood-good" },
    { emoji: "⚡", text: "Momentum is building. Finish it.", cls: "mood-good" },
  ];

  const pick = arr => arr[Math.floor(Math.random() * arr.length)];

  if (type === "idle") return pick(idle);
  if (type === "bad") return pick(badIdle);
  if (type === "onestep") return pick(oneStep);
  if (type === "multistep") return pick(multiStep);
  return pick(good);
}

function setMood(type) {
  if (state.currentScreen !== "task") return;
  if (state.isCompleted) return;  // never change mood after task is done

  const m = getNudgeMessage(type);
  const banner = document.getElementById("mood-banner");
  if (!banner) return;
  banner.className = "mood-banner " + m.cls;
  document.getElementById("mood-emoji").textContent = m.emoji;
  document.getElementById("mood-text").textContent = m.text;

  // Only update body background when actively on the task screen
  if (state.currentScreen === "task") updateHomeMood(m.cls);
}

// ================================================================
// HOME MOOD
// ================================================================
function updateHomeMood(moodClass) {
  document.body.classList.remove("mood-good", "mood-warn", "mood-bad");
  if (moodClass) document.body.classList.add(moodClass);
}

// ================================================================
// HOME NUDGE TEXT
// ================================================================
function updateNudgeForMood(type) {
  if (state.currentScreen !== "home") return;
  const map = {
    idle: "⏳ You're slowing down. Keep the momentum.",
    bad: "⚠️ Every minute counts. Start now.",
    onestep: "🔥 First step done. Keep building.",
    multistep: "🚀 You're ahead of most. Don't stop.",
    good: "🔥 You're doing great. Keep going.",
  };
  updateNudge(map[type] || map.good);
}

// ================================================================
// PROGRESS SYSTEM — localStorage-backed streak + daily stats
// ================================================================
function getTodayKey() {
  const n = new Date();
  return n.getFullYear() + "-"
    + String(n.getMonth() + 1).padStart(2, "0") + "-"
    + String(n.getDate()).padStart(2, "0");
}

function getProgressData() {
  return {
    streak: parseInt(localStorage.getItem("nudge_streak") || "0", 10),
    bestStreak: parseInt(localStorage.getItem("nudge_bestStreak") || "0", 10),
    lastDate: localStorage.getItem("nudge_lastDate") || "",
    todayCount: parseInt(localStorage.getItem("nudge_todayCount") || "0", 10),
    todayKey: localStorage.getItem("nudge_todayKey") || "",
    history: JSON.parse(localStorage.getItem("nudge_history") || "[]"),
  };
}

function recordDailyProgress() {
  const today = getTodayKey();
  const data = getProgressData();

  let todayCount = (data.todayKey === today) ? data.todayCount : 0;
  todayCount++;

  let history = data.history.filter(h => h.date !== today);
  history.push({ date: today, count: todayCount });
  history.sort((a, b) => a.date.localeCompare(b.date));
  history = history.slice(-28);

  localStorage.setItem("nudge_todayCount", todayCount);
  localStorage.setItem("nudge_todayKey", today);
  localStorage.setItem("nudge_history", JSON.stringify(history));
}

function recordTaskCompletion() {
  const today = getTodayKey();
  const data = getProgressData();

  if (data.lastDate === today) return;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yKey = yesterday.toISOString().slice(0, 10);

  const newStreak = (data.lastDate === yKey) ? data.streak + 1 : 1;
  const newBest = Math.max(newStreak, data.bestStreak);

  localStorage.setItem("nudge_streak", newStreak);
  localStorage.setItem("nudge_bestStreak", newBest);
  localStorage.setItem("nudge_lastDate", today);

  return newStreak;
}

function getActiveStreak() {
  const data = getProgressData();
  const today = getTodayKey();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yKey = yesterday.toISOString().slice(0, 10);
  if (data.lastDate && data.lastDate !== today && data.lastDate !== yKey) return 0;
  return data.streak;
}

function renderStreak() {
  const activeStreak = getActiveStreak();
  const label = activeStreak === 0 ? "Start your streak" : `${activeStreak} day streak`;
  document.querySelectorAll(".streak-badge span").forEach(el => {
    el.textContent = label;
  });
}

// ================================================================
// STATS SCREEN
// ================================================================
function renderStatsScreen() {
  const body = document.getElementById("stats-body");
  if (!body) return;

  const data = getProgressData();
  const today = getTodayKey();
  const activeStreak = getActiveStreak();
  const todayCount = (data.todayKey === today) ? data.todayCount : 0;

  const days = [];
  const fullDayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const entry = data.history.find(h => h.date === key);
    days.push({ key, count: entry ? entry.count : 0, date: d });
  }

  const maxCount = Math.max(...days.map(d => d.count), 1);
  const weekTotal = days.reduce((sum, d) => sum + d.count, 0);
  const activeDays = days.filter(d => d.count > 0).length;

  const graphBars = days.map(d => {
    const pct = Math.max(6, Math.round((d.count / maxCount) * 100));
    const isToday = d.key === today;
    const dayName = fullDayNames[d.date.getDay()];
    const dateNum = d.date.getDate();
    const cls = isToday ? "sbar-today" : (d.count > 0 ? "sbar-done" : "sbar-empty");
    return `
      <div class="sbar-col">
        <div class="sbar-count">${d.count > 0 ? d.count : ""}</div>
        <div class="sbar-wrap">
          <div class="sbar ${cls}" style="height:${pct}%"></div>
        </div>
        <div class="sbar-day${isToday ? " sbar-day-today" : ""}">
          <div class="sbar-day-name">${dayName}</div>
          <div class="sbar-day-date">${dateNum}</div>
        </div>
      </div>`;
  }).join("");

  const WEEKS = 4;
  const heatRows = [];
  const dayLetters = ["M", "T", "W", "T", "F", "S", "S"];
  heatRows.push(`<div class="heat-row heat-header">${dayLetters.map(l => `<div class="heat-day-label">${l}</div>`).join("")}</div>`);

  for (let w = WEEKS - 1; w >= 0; w--) {
    const cells = [];
    for (let d = 6; d >= 0; d--) {
      const daysAgo = w * 7 + d;
      const dt = new Date();
      dt.setDate(dt.getDate() - daysAgo);
      const dow = (dt.getDay() + 6) % 7;
      cells[dow] = dt;
    }
    const rowCells = cells.map(dt => {
      if (!dt) return `<div class="heat-cell heat-0"></div>`;
      const key = dt.toISOString().slice(0, 10);
      const entry = data.history.find(h => h.date === key);
      const count = entry ? entry.count : 0;
      const isToday = key === today;
      const dateNum = dt.getDate();
      let level = 0;
      if (count > 0) level = 1;
      if (count >= 3) level = 2;
      if (count >= 6) level = 3;
      return `<div class="heat-cell heat-${level}${isToday ? " heat-today" : ""}" title="${key}">
        <span class="heat-date">${dateNum}</span>
      </div>`;
    }).join("");
    heatRows.push(`<div class="heat-row">${rowCells}</div>`);
  }

  const streakMsg = activeStreak === 0
    ? "Start your first streak today — one task is enough!"
    : activeStreak === 1
      ? "Great start — show up again tomorrow!"
      : `${activeStreak} days straight — don't break the chain!`;

  // Get task counts for the stats page
  const tasks = loadTasks();
  const completedAll = tasks.filter(t => t.state === "completed").length;
  const pendingCount = tasks.filter(t => t.state === "pending" || t.state === "active").length;

  body.innerHTML = `
    <div class="sc-cards">
      <div class="sc-card sc-card-today">
        <div class="sc-card-icon">🎯</div>
        <div class="sc-card-value">${todayCount}</div>
        <div class="sc-card-label">Steps today</div>
      </div>
      <div class="sc-card sc-card-streak">
        <div class="sc-card-icon">🔥</div>
        <div class="sc-card-value">${activeStreak}</div>
        <div class="sc-card-label">Day streak</div>
      </div>
      <div class="sc-card sc-card-best">
        <div class="sc-card-icon">🏆</div>
        <div class="sc-card-value">${data.bestStreak}</div>
        <div class="sc-card-label">Best streak</div>
      </div>
    </div>

    <div class="sc-streak-msg">${streakMsg}</div>

    <div class="sc-week-summary">
      <span class="sc-week-icon">📅</span>
      <span class="sc-week-text">Active <strong>${activeDays} of 7</strong> days this week &nbsp;·&nbsp; <strong>${weekTotal}</strong> steps logged</span>
    </div>

    <div class="sc-task-summary">
      <div class="sc-task-pill">
        <span class="sc-task-pill-icon">✅</span>
        <span class="sc-task-pill-text"><strong>${completedAll}</strong> tasks completed</span>
      </div>
      <div class="sc-task-pill">
        <span class="sc-task-pill-icon">⚡</span>
        <span class="sc-task-pill-text"><strong>${pendingCount}</strong> in progress</span>
      </div>
    </div>

    <div class="sc-section">
      <div class="sc-section-title">Last 7 Days — steps per day</div>
      <div class="sc-chart">${graphBars}</div>
    </div>

    <div class="sc-section">
      <div class="sc-section-title">28-Day Activity</div>
      <div class="sc-heatmap-grid">
        ${heatRows.join("")}
      </div>
      <div class="sc-heat-legend">
        <span class="sc-heat-label">Less</span>
        <div class="heat-cell heat-0"></div>
        <div class="heat-cell heat-1"></div>
        <div class="heat-cell heat-2"></div>
        <div class="heat-cell heat-3"></div>
        <span class="sc-heat-label">More</span>
      </div>
    </div>
  `;
}

// ================================================================
// HOME AI ASSISTANT — Sprint 1: thinking animation + dynamic messages
// ================================================================

/** Thinking steps shown before the final message on Home load */
const HOME_ASSISTANT_THINKING = [
  "Analyzing today's workload…",
  "Checking pending tasks…",
  "Understanding your progress…",
  "Preparing today's recommendation…",
  "Done.",
];

/** Tracks in-flight animation so we can cancel on re-entry */
let _homeAssistantRunId = 0;
let _homeAssistantTypingTimer = null;

/**
 * Build a contextual message from current app state.
 * Priority: active → snoozed → one left → pending → no tasks → streak → fallback
 * @returns {{ message: string, ctaLabel: string }}
 */
function getHomeAssistantContext() {
  const tasks = loadTasks();
  const activeTasks  = tasks.filter(t => t.state === "active");
  const snoozedTasks = tasks.filter(t => t.state === "snoozed");
  const pendingTasks = tasks.filter(t => t.state === "pending");
  const incomplete   = activeTasks.length + snoozedTasks.length + pendingTasks.length;
  const streak       = getActiveStreak();
  const data         = getProgressData();
  const today        = getTodayKey();
  const completedToday = data.lastDate === today;

  // Active task — user paused mid-work
  if (activeTasks.length > 0) {
    const t = activeTasks[0];
    const shortTitle = (t.title || "your task").length > 28
      ? (t.title || "your task").slice(0, 28) + "…"
      : (t.title || "your task");
    return {
      message: `You paused ${shortTitle} halfway.\nLet's continue where you left off.`,
      ctaLabel: "Ask AI Coach →",
    };
  }

  // Snoozed task — treat as unfinished
  if (snoozedTasks.length > 0) {
    const t = snoozedTasks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    const shortTitle = (t.title || "your task").length > 28
      ? (t.title || "your task").slice(0, 28) + "…"
      : (t.title || "your task");
    return {
      message: `You left ${shortTitle} unfinished.\nReady to pick it back up?`,
      ctaLabel: "Ask AI Coach →",
    };
  }

  // Exactly one task remaining today
  if (incomplete === 1) {
    return {
      message: "You're one task away from finishing today's work.",
      ctaLabel: "Ask AI Coach →",
    };
  }

  // Pending tasks waiting
  if (pendingTasks.length > 0) {
    const n = pendingTasks.length;
    return {
      message: `You have ${n} pending task${n > 1 ? "s" : ""} today.`,
      ctaLabel: "Ask AI Coach →",
    };
  }

  // No tasks at all
  if (tasks.length === 0) {
    return {
      message: streak === 0
        ? "Let's build your first productive streak.\nWant me to help plan your next goal?"
        : "You're free today.\nWant me to help plan your next goal?",
      ctaLabel: "Ask AI Coach →",
    };
  }

  // All tasks done / no incomplete — streak-aware encouragement
  if (streak === 0) {
    return {
      message: "Let's build your first productive streak.",
      ctaLabel: "Ask AI Coach →",
    };
  }

  if (completedToday && streak >= 3) {
    return {
      message: "You're ahead of most. Don't stop.",
      ctaLabel: "Ask AI Coach →",
    };
  }

  if (completedToday) {
    return {
      message: "You showed up today. Keep showing up.",
      ctaLabel: "Ask AI Coach →",
    };
  }

  if (streak >= 3) {
    return {
      message: "Consistency is rare. Protect your streak.",
      ctaLabel: "Ask AI Coach →",
    };
  }

  return {
    message: "Your future self is watching. Start now.",
    ctaLabel: "Ask AI Coach →",
  };
}

/** Update the CTA button — always opens AI Coach */
function _setAssistantCta() {
  const ctaLabel = document.getElementById("da-cta-label");
  const ctaIcon  = document.querySelector(".da-cta-icon");
  if (ctaLabel) ctaLabel.textContent = "Ask AI Coach";
  if (ctaIcon)  ctaIcon.textContent = "⚡";
}

/** Cancel any running assistant animation */
function _cancelHomeAssistantAnimation() {
  _homeAssistantRunId++;
  if (_homeAssistantTypingTimer) {
    clearTimeout(_homeAssistantTypingTimer);
    _homeAssistantTypingTimer = null;
  }
}

/** Promise-based delay helper */
function _homeAssistantDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Type the final message with a blinking cursor.
 * @param {string} text
 * @param {number} runId
 */
function _typeHomeAssistantMessage(text, runId) {
  const msgEl    = document.getElementById("da-message");
  const cursorEl = document.getElementById("da-cursor");
  const wrapEl   = document.getElementById("da-message-wrap");
  const ctaEl    = document.getElementById("da-cta");
  if (!msgEl || !cursorEl || !wrapEl) return;

  const ctx = getHomeAssistantContext();
  _setAssistantCta();

  msgEl.textContent = "";
  cursorEl.classList.remove("is-hidden");
  wrapEl.classList.add("is-visible");

  let i = 0;
  const speed = 16; // ms per char — fast but readable

  function tick() {
    if (runId !== _homeAssistantRunId) return;
    if (i >= text.length) {
      cursorEl.classList.add("is-hidden");
      if (ctaEl) ctaEl.classList.add("is-visible");
      return;
    }
    msgEl.textContent += text[i];
    i++;
    const pause = text[i - 1] === "\n" ? speed * 2.5 : speed;
    _homeAssistantTypingTimer = setTimeout(tick, pause);
  }

  tick();
}

/**
 * Run the full thinking → typing sequence (Home load / navigate to Home).
 * @param {number} runId
 */
async function _runHomeAssistantThinking(runId) {
  const thinkingEl     = document.getElementById("da-thinking");
  const thinkingTextEl = document.getElementById("da-thinking-text");
  const wrapEl         = document.getElementById("da-message-wrap");
  const ctaEl          = document.getElementById("da-cta");
  if (!thinkingEl || !thinkingTextEl) return;

  // Reset UI to thinking phase
  thinkingEl.classList.remove("is-hidden");
  if (wrapEl) {
    wrapEl.classList.remove("is-visible");
    const msgEl = document.getElementById("da-message");
    if (msgEl) msgEl.textContent = "";
  }
  if (ctaEl) ctaEl.classList.remove("is-visible");

  for (let s = 0; s < HOME_ASSISTANT_THINKING.length; s++) {
    if (runId !== _homeAssistantRunId) return;
    thinkingTextEl.classList.add("is-fading");
    await _homeAssistantDelay(120);
    if (runId !== _homeAssistantRunId) return;
    thinkingTextEl.textContent = HOME_ASSISTANT_THINKING[s];
    thinkingTextEl.classList.remove("is-fading");
    const delay = s === HOME_ASSISTANT_THINKING.length - 1 ? 280 : 420;
    await _homeAssistantDelay(delay);
  }

  if (runId !== _homeAssistantRunId) return;

  // Fade out thinking, reveal typed message
  thinkingEl.classList.add("is-hidden");
  await _homeAssistantDelay(200);
  if (runId !== _homeAssistantRunId) return;

  const ctx = getHomeAssistantContext();
  _typeHomeAssistantMessage(ctx.message, runId);
}

/**
 * Quick message refresh — fade transition, no thinking replay.
 * Used when state changes while already on Home.
 */
function _quickRefreshHomeAssistant() {
  const runId = ++_homeAssistantRunId;
  const thinkingEl = document.getElementById("da-thinking");
  const wrapEl     = document.getElementById("da-message-wrap");
  const ctaEl      = document.getElementById("da-cta");
  const msgEl      = document.getElementById("da-message");
  const ctx        = getHomeAssistantContext();

  if (thinkingEl) thinkingEl.classList.add("is-hidden");
  if (wrapEl) wrapEl.classList.add("is-visible");
  if (ctaEl) ctaEl.classList.add("is-visible");
  _setAssistantCta();

  if (!msgEl) return;

  // Smooth fade between messages
  msgEl.style.transition = "opacity 0.25s ease";
  msgEl.style.opacity = "0";
  setTimeout(() => {
    if (runId !== _homeAssistantRunId) return;
    msgEl.textContent = ctx.message;
    msgEl.style.opacity = "1";
    const cursorEl = document.getElementById("da-cursor");
    if (cursorEl) cursorEl.classList.add("is-hidden");
  }, 250);
}

/**
 * Refresh the Home AI Assistant card.
 * @param {{ fullSequence?: boolean }} opts
 *   fullSequence — run thinking animation (default: true on first call)
 */
function refreshHomeAssistant(opts = {}) {
  if (state.currentScreen !== "home") return;

  const fullSequence = opts.fullSequence !== false;
  _cancelHomeAssistantAnimation();
  const runId = _homeAssistantRunId;

  if (fullSequence) {
    _runHomeAssistantThinking(runId);
  } else {
    _quickRefreshHomeAssistant();
  }
}

// ================================================================
// HOME SCREEN SYNC — single entry point for all Home sidebar updates
// ================================================================

/**
 * Refresh every Home sidebar widget from current task state.
 * Always normalizes snoozed tasks first so counts are never stale.
 * @param {{ thinking?: boolean }} opts
 *   thinking — run the full assistant thinking animation (first load only)
 */
function syncHomeUI(opts = {}) {
  // Step 1: normalize task state before any UI reads it
  checkSnoozedTasks();

  // Step 2: render Home widgets from fresh data (even if user is on another screen)
  updateHomeActiveTask();
  renderTodayPlan();
  updateTasksBadge();

  // Step 3: refresh assistant message when Home is visible
  if (state.currentScreen === "home") {
    refreshHomeAssistant({ fullSequence: !!opts.thinking });
  }
}

// ================================================================
// HOME SCREEN MESSAGE (legacy entry points)
// ================================================================
function updateHomeMessage() {
  syncHomeUI({ thinking: false });
}

/** Called on first load with thinking animation */
function initHomeAssistant() {
  syncHomeUI({ thinking: true });
}

/**
 * Show/hide the active-task or pending-tasks nudge card on the Home screen.
 * This keeps Home minimal: only appears when there's something actionable.
 */
function updateHomeActiveTask() {
  const container = document.getElementById("home-task-nudge");
  if (!container) return;

  const tasks = loadTasks();
  const activeTasks  = tasks.filter(t => t.state === "active");
  const snoozedTasks = tasks.filter(t => t.state === "snoozed");
  const pendingTasks = tasks.filter(t => t.state === "pending");

  if (activeTasks.length > 0) {
    const t = activeTasks[0];
    const steps = t.aiSteps || [];
    const doneCount = steps.filter(s => s.done).length;
    const total = steps.length;
    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
    const remaining = total - doneCount;
    container.innerHTML = `
      <div class="home-task-nudge-card">
        <div class="htn-left">
          <div class="htn-label">🤖 Nudge AI</div>
          <div class="htn-title">${escapeHtml(t.title)}</div>
          <div class="htn-sub">Continue where you left off. Step ${doneCount + 1} of ${total}${remaining > 0 ? ` · ${remaining} remaining` : ''}.</div>
          <div class="htn-progress-wrap">
            <div class="htn-progress-bar"><div class="htn-progress-fill" style="width:${pct}%"></div></div>
            <span class="htn-progress-label">${doneCount}/${total} steps done</span>
          </div>
        </div>
      </div>`;
  } else if (snoozedTasks.length > 0) {
    const t = snoozedTasks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    const steps = t.aiSteps || [];
    const doneCount = steps.filter(s => s.done).length;
    const total = steps.length;
    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
    container.innerHTML = `
      <div class="home-task-nudge-card" style="border-left-color: var(--warning); border-color: rgba(245,166,35,0.3);">
        <div class="htn-left">
          <div class="htn-label" style="color:var(--warning)">🤖 Nudge AI</div>
          <div class="htn-title">${escapeHtml(t.title)}</div>
          <div class="htn-sub" style="color:var(--warning)">You paused halfway. Continue where you left off.</div>
          ${total > 0 ? `<div class="htn-progress-wrap">
            <div class="htn-progress-bar"><div class="htn-progress-fill" style="width:${pct}%"></div></div>
            <span class="htn-progress-label">${doneCount}/${total} steps done</span>
          </div>` : ''}
        </div>
      </div>`;
  } else if (pendingTasks.length > 0) {
    container.innerHTML = `
      <div class="home-task-nudge-card home-task-nudge-pending" style="cursor:pointer" onclick="goToTasks()">
        <div class="htn-left">
          <div class="htn-label">🤖 Nudge AI</div>
          <div class="htn-title">${pendingTasks.length} task${pendingTasks.length > 1 ? 's' : ''} waiting for you</div>
          <div class="htn-sub">Use Plan with AI Coach to start working on them.</div>
        </div>
      </div>`;
  } else {
    container.innerHTML = '';
  }

  // Mark ready — prevents flicker from stale pre-sync render
  container.classList.add("is-ready");
}

// ================================================================
// SCHEDULE SYSTEM
// ================================================================
function loadSchedule() {
  const d = localStorage.getItem("nudge_schedDate") || "";
  const t = localStorage.getItem("nudge_schedStart") || "";
  const dur = parseInt(localStorage.getItem("nudge_schedDur") || "0", 10);
  if (d && t && dur > 0) {
    state.scheduleDate = d;
    state.scheduleStart = t;
    state.scheduleDuration = dur;
    state.focusTime = dur;
    state.scheduleSet = true;
  }
}

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function buildTimePicker() {
  const card = document.getElementById("time-window-card");
  if (!card) return;

  if (state.scheduleSet) {
    const dt = new Date(state.scheduleDate + "T00:00:00");
    const todayStr = getTodayDateString();
    const dayLabel = state.scheduleDate === todayStr
      ? "Today"
      : dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

    const [hh, mm] = state.scheduleStart.split(":").map(Number);
    const ap = hh >= 12 ? "PM" : "AM";
    const dh = hh % 12 || 12;
    const timeLabel = `${dh}:${String(mm).padStart(2, "0")} ${ap}`;

    const dur = state.scheduleDuration;
    const durLabel = dur >= 60
      ? `${Math.floor(dur / 60)}h${dur % 60 > 0 ? ` ${dur % 60}m` : ""}`
      : `${dur} min`;

    const isFuture = state.scheduleDate > todayStr;
    const pillClass = isFuture ? "schedule-pill schedule-pill-future" : "schedule-pill";
    const icon = isFuture ? "📅" : "⏰";
    const statusLabel = isFuture ? "Upcoming" : "Today";

    card.innerHTML = `
      <div class="${pillClass}">
        <span class="sp-icon">${icon}</span>
        <div class="sp-body">
          <div class="sp-main">${dayLabel} · ${timeLabel} · ${durLabel}</div>
          <div class="sp-status">${statusLabel} · ${state.focusTime} min per step</div>
        </div>
        <button type="button" class="btn-change-time" onclick="showFullTimePicker()">Edit</button>
      </div>`;
    return;
  }

  const DURATIONS = [2, 5, 10, 15, 25, 45, 60];
  const durChips = DURATIONS.map(d => {
    const label = d >= 60 ? `${d / 60}h` : `${d}m`;
    const isActive = d === state.focusTime;
    return `<button type="button" class="dur-chip${isActive ? " active" : ""}" data-dur="${d}" onclick="selectDurChip(${d})">${label}</button>`;
  }).join("");

  card.innerHTML = `
    <div class="schedule-picker-card">
      <div class="spc-header">
        <span class="spc-icon">🗓</span>
        <div>
          <p class="spc-title">When are you working on this?</p>
          <p class="spc-sub">Set a date, time, and how long to spend per step.</p>
        </div>
      </div>
      <div class="spc-fields">
        <div class="spc-field">
          <label class="spc-label">Date</label>
          <input type="date" id="sched-date" class="spc-input" value="${getTodayDateString()}" min="${getTodayDateString()}" />
        </div>
        <div class="spc-field">
          <label class="spc-label">Start Time</label>
          <input type="time" id="sched-time" class="spc-input" value="09:00" />
        </div>
      </div>
      <div class="spc-dur-section">
        <label class="spc-label">Focus per step</label>
        <div class="dur-chips">${durChips}</div>
        <div class="dur-custom-row">
          <input type="number" id="sched-custom-dur" class="spc-input spc-input-sm"
            placeholder="Or type a custom duration (min)" min="1" max="180"
            oninput="handleCustomDurInput(this.value)" />
        </div>
      </div>
      <button type="button" class="btn-save-schedule" onclick="saveSchedule()">Set Schedule →</button>
      <button type="button" class="btn-skip-schedule" onclick="skipSchedule()">Skip for now</button>
    </div>`;

  document.querySelectorAll(".dur-chip").forEach(btn => {
    btn.classList.toggle("active", parseInt(btn.dataset.dur, 10) === state.focusTime);
  });
}

/**
 * Live-update state.focusTime when user types a custom duration.
 * Deselects all chips so the custom value is clearly "active".
 */
function handleCustomDurInput(val) {
  const parsed = parseInt(val, 10);
  if (parsed > 0 && parsed <= 180) {
    state.focusTime = parsed;
    // Deselect all chips since a custom value is now active
    document.querySelectorAll(".dur-chip").forEach(btn => btn.classList.remove("active"));
  }
}

function selectDurChip(minutes) {
  state.focusTime = minutes;
  document.querySelectorAll(".dur-chip").forEach(btn => {
    btn.classList.toggle("active", parseInt(btn.dataset.dur, 10) === minutes);
  });
  const custom = document.getElementById("sched-custom-dur");
  if (custom) custom.value = "";
}

function saveSchedule() {
  const dateEl = document.getElementById("sched-date");
  const timeEl = document.getElementById("sched-time");
  const customEl = document.getElementById("sched-custom-dur");

  const date = dateEl?.value || getTodayDateString();
  const time = timeEl?.value || "09:00";

  let dur = state.focusTime;
  if (customEl?.value && parseInt(customEl.value, 10) > 0) {
    dur = parseInt(customEl.value, 10);
  }

  state.scheduleDate = date;
  state.scheduleStart = time;
  state.scheduleDuration = dur;
  state.focusTime = dur;
  state.scheduleSet = true;

  localStorage.setItem("nudge_schedDate", date);
  localStorage.setItem("nudge_schedStart", time);
  localStorage.setItem("nudge_schedDur", dur);

  buildTimePicker();
  updateHomeMessage();
}

function skipSchedule() {
  state.scheduleSet = true;
  state.scheduleDate = getTodayDateString();
  state.scheduleStart = "";
  state.scheduleDuration = state.focusTime;

  const card = document.getElementById("time-window-card");
  if (card) card.innerHTML = `
    <div class="schedule-pill schedule-pill-minimal">
      <span class="sp-icon">⏱</span>
      <span class="sp-body"><span class="sp-main">${state.focusTime} min per step · Today</span></span>
      <button type="button" class="btn-change-time" onclick="showFullTimePicker()">Edit</button>
    </div>`;
}

function showFullTimePicker() {
  state.scheduleSet = false;
  buildTimePicker();
}

// ================================================================
// PARTICLES
// ================================================================
function createParticles(count = 18) {
  const container = document.getElementById("mood-particles");
  if (!container) return;
  container.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const p = document.createElement("div");
    p.className = "particle";
    const size = 2 + Math.random() * 5;
    p.style.cssText = [
      `width:${size}px`,
      `height:${size}px`,
      `left:${(Math.random() * 100).toFixed(1)}vw`,
      `top:${(Math.random() * 100).toFixed(1)}vh`,
      `animation-delay:-${(Math.random() * 20).toFixed(1)}s`,
      `animation-duration:${(16 + Math.random() * 18).toFixed(1)}s`,
    ].join(";");
    container.appendChild(p);
  }
}

// ================================================================
// MARK CURRENT STEP DONE
// ================================================================
function markCurrentDone() {
  if (state.activeIndex === -1) return;
  handleStepClick(state.activeIndex);
}

// ================================================================
// OVERTIME NUDGE SYSTEM
// ================================================================
const OVERTIME_NUDGES = [
  { level: 1, cls: "",             icon: "⏰", text: "Time's up. Try to wrap this step." },
  { level: 2, cls: "",             icon: "💡", text: "Still on this? Do one small action." },
  { level: 3, cls: "nudge-level-2",icon: "⚠️", text: "Don't drag it. Finish or snooze." },
];

function checkOvertimeNudge(elapsedSecs) {
  const focusSecs = state.focusTime * 60;
  if (focusSecs <= 0) return;

  const ratio = elapsedSecs / focusSecs;
  let targetLevel = 0;
  if (ratio >= 2.0) targetLevel = 3;
  else if (ratio >= 1.5) targetLevel = 2;
  else if (ratio >= 1.0) targetLevel = 1;

  if (targetLevel > 0 && targetLevel > state.overtimeNudgeShown) {
    state.overtimeNudgeShown = targetLevel;
    showOvertimeNudge(OVERTIME_NUDGES[targetLevel - 1]);
  }
}

function showOvertimeNudge(nudge) {
  const container = document.getElementById("overtime-nudge-container");
  if (!container) return;
  container.innerHTML = `
    <div class="overtime-nudge ${nudge.cls}">
      <span class="overtime-nudge-icon">${nudge.icon}</span>
      <span>${nudge.text}</span>
    </div>`;
}

function clearOvertimeNudge() {
  const container = document.getElementById("overtime-nudge-container");
  if (container) container.innerHTML = "";
  state.overtimeNudgeShown = 0;
}

// ================================================================
// MOOD THRESHOLDS — 3-level interruption ladder
// Level 1: 90s  → soft nudge (mood-warn banner)
// Level 2: 4min → strong pressure (mood-bad banner)
// Level 3: 8min → focus lock overlay
// ================================================================
const MOOD_WARN_MS = 90 * 1000;      // 1.5 min → soft nudge
const MOOD_BAD_MS = 4 * 60 * 1000; // 4 min   → stronger
const MOOD_FOCUSLOCK_MS = 8 * 60 * 1000; // 8 min   → focus lock overlay

function resetMoodTimer() {
  if (state.currentScreen !== "task") return;
  if (state.isCompleted) return;

  state.lastActionTime = Date.now();
  state.focusLockActive = false;
  clearInterval(state.moodTimer);

  // Dismiss focus lock if showing
  const overlay = document.getElementById("focus-lock-overlay");
  if (overlay) overlay.style.display = "none";

  if (state._reEngageNudge) {
    const m = state._reEngageNudge;
    state._reEngageNudge = null;
    const banner = document.getElementById("mood-banner");
    if (banner) {
      banner.className = "mood-banner " + m.cls;
      document.getElementById("mood-emoji").textContent = m.emoji;
      document.getElementById("mood-text").textContent = m.text;
    }
  } else {
    const done = state.completedCount;
    if (done >= 2) setMood("multistep");
    else if (done === 1) setMood("onestep");
    else setMood("good");
  }

  state.moodTimer = setInterval(() => {
    if (state.isCompleted || state.currentScreen !== "task") return;
    const idle = Date.now() - state.lastActionTime;

    if (idle >= MOOD_FOCUSLOCK_MS && !state.focusLockActive) {
      // Level 3 — focus lock overlay
      showFocusLock();
    } else if (idle >= MOOD_BAD_MS) {
      // Level 2 — strong pressure in banner
      setMood("bad");
    } else if (idle >= MOOD_WARN_MS) {
      // Level 1 — soft nudge in banner
      setMood("idle");
    }
  }, 5000);
}

// ================================================================
// FOCUS LOCK OVERLAY — Level 3 nudge
// ================================================================
function showFocusLock() {
  if (state.focusLockActive) return;
  state.focusLockActive = true;

  const overlay = document.getElementById("focus-lock-overlay");
  if (overlay) overlay.style.display = "flex";
}

/**
 * User makes a choice in the focus lock overlay.
 * @param {'continue'|'snooze'|'skip'} action
 */
function dismissFocusLock(action) {
  state.focusLockActive = false;
  const overlay = document.getElementById("focus-lock-overlay");
  if (overlay) overlay.style.display = "none";

  if (action === "continue") {
    // Reset timer — they're back
    resetMoodTimer();
    setMood("good");
  } else if (action === "snooze") {
    // Snooze the current active task
    snoozeActiveTask();
  } else if (action === "skip") {
    // Skip the current step
    nextStep();
    resetMoodTimer();
  }
}

// ================================================================
// CHECKBOX FEEDBACK
// ================================================================
const FEEDBACK_MESSAGES = [
  "Nice. One step closer.",
  "That's how it's done.",
  "Keep going. You're doing it.",
  "Finish strong.",
  "One less thing in your way.",
  "Momentum is real. Use it.",
];

/**
 * updateNudge — legacy hook; refreshes assistant message without thinking replay.
 * The bottom quote card is static HTML and must never be touched by JS.
 */
function updateNudge(text) {
  if (state.currentScreen !== "home") return;
  const msgEl = document.getElementById("da-message");
  const wrapEl = document.getElementById("da-message-wrap");
  const thinkingEl = document.getElementById("da-thinking");
  if (!msgEl) return;
  if (thinkingEl) thinkingEl.classList.add("is-hidden");
  if (wrapEl) wrapEl.classList.add("is-visible");
  msgEl.style.transition = "opacity 0.35s ease, transform 0.35s cubic-bezier(0.22,1,0.36,1)";
  msgEl.style.opacity = "0";
  msgEl.style.transform = "translateY(5px)";
  requestAnimationFrame(() => {
    msgEl.textContent = text;
    msgEl.style.opacity = "1";
    msgEl.style.transform = "translateY(0)";
    const cursorEl = document.getElementById("da-cursor");
    if (cursorEl) cursorEl.classList.add("is-hidden");
    const ctaEl = document.getElementById("da-cta");
    if (ctaEl) ctaEl.classList.add("is-visible");
  });
}

function showCheckboxFeedback() {
  const banner = document.getElementById("mood-banner");
  const textEl = document.getElementById("mood-text");
  const emojiEl = document.getElementById("mood-emoji");
  if (!banner) return;

  const msg = FEEDBACK_MESSAGES[Math.floor(Math.random() * FEEDBACK_MESSAGES.length)];
  banner.className = "mood-banner mood-good";
  emojiEl.textContent = "✅";
  textEl.textContent = msg;

  setTimeout(() => resetMoodTimer(), 2000);
}

// ================================================================
// SCREEN NAVIGATION
// ================================================================
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");

  if (id === "screen-task")     state.currentScreen = "task";
  else if (id === "screen-stats")    state.currentScreen = "stats";
  else if (id === "screen-tasks")    state.currentScreen = "tasks";
  else if (id === "screen-calendar") state.currentScreen = "calendar";
  else state.currentScreen = "home";

  // Sync body class so CSS can target current screen (e.g. body.screen-task)
  document.body.classList.remove("screen-home", "screen-task", "screen-tasks", "screen-stats", "screen-calendar");
  document.body.classList.add("screen-" + state.currentScreen);

  // Tab bar: hide during task focus work
  const tabBar = document.getElementById("tab-bar");
  // Tab bar removed — navigation is now via top-nav only

  // Update tab active states
  document.getElementById("tab-home")?.classList.toggle("tab-active", state.currentScreen === "home");
  document.getElementById("tab-tasks")?.classList.toggle("tab-active", state.currentScreen === "tasks");
  document.getElementById("tab-calendar")?.classList.toggle("tab-active", state.currentScreen === "calendar");
  document.getElementById("tab-stats")?.classList.toggle("tab-active", state.currentScreen === "stats");

  if (state.currentScreen === "home") {
    clearInterval(state.moodTimer);
    clearInterval(state.focusBarTimer);
    state.moodTimer = null;
    state.focusBarTimer = null;
    document.body.classList.remove("mood-warn", "mood-bad");
    document.body.classList.add("mood-good");
    // Hide focus mode overlay when leaving task screen
    const fmOverlayLeave = document.getElementById("focus-mode-overlay");
    if (fmOverlayLeave) fmOverlayLeave.classList.remove("active");
    renderStreak();
    syncHomeUI({ thinking: false });
    startCursorCluster();
    // Dashboard widgets
    updateTopNav();
    updateDashStreak();

  } else if (state.currentScreen === "stats") {
    clearInterval(state.moodTimer);
    clearInterval(state.focusBarTimer);
    state.moodTimer = null;
    state.focusBarTimer = null;
    document.body.classList.remove("mood-warn", "mood-bad");
    document.body.classList.add("mood-good");
    const fmOverlayStats = document.getElementById("focus-mode-overlay");
    if (fmOverlayStats) fmOverlayStats.classList.remove("active");
    renderStatsScreen();
    stopCursorCluster();
    updateTopNav();

  } else if (state.currentScreen === "tasks") {
    clearInterval(state.moodTimer);
    clearInterval(state.focusBarTimer);
    state.moodTimer = null;
    state.focusBarTimer = null;
    document.body.classList.remove("mood-warn", "mood-bad");
    document.body.classList.add("mood-good");
    const fmOverlayTasks = document.getElementById("focus-mode-overlay");
    if (fmOverlayTasks) fmOverlayTasks.classList.remove("active");
    checkSnoozedTasks();
    renderTasksTab();
    stopCursorCluster();
    updateTopNav();

  } else if (state.currentScreen === "task") {
    // mood timer starts via resetMoodTimer() called from planTask / resumeTaskById
    // Toggle focus mode overlay
    const fmOverlay = document.getElementById("focus-mode-overlay");
    if (fmOverlay) fmOverlay.classList.toggle("active", state.activeIndex !== -1 && !state.isCompleted);
    stopCursorCluster();
    closeTaskInput();
    updateTopNav();
  } else if (state.currentScreen === "calendar") {
    clearInterval(state.moodTimer);
    clearInterval(state.focusBarTimer);
    state.moodTimer = null;
    state.focusBarTimer = null;
    document.body.classList.remove("mood-warn", "mood-bad");
    document.body.classList.add("mood-good");
    const fmOverlayCal = document.getElementById("focus-mode-overlay");
    if (fmOverlayCal) fmOverlayCal.classList.remove("active");
    renderCalendar();
    stopCursorCluster();
    updateTopNav();
  }
}


function goToStats()    { showScreen("screen-stats"); }
function goToHome()     { showScreen("screen-input"); }
function goToTasks()    { showScreen("screen-tasks"); }
function goToCalendar() { showScreen("screen-calendar"); }

// ================================================================
// AI COACH — conversational entry point (welcome + first question)
// ================================================================

const USER_NAME_KEY = "nudge_user_name";

function getUserName() {
  try {
    const n = (localStorage.getItem(USER_NAME_KEY) || "").trim();
    return n || "";
  } catch (e) {
    return "";
  }
}

function setUserName(name) {
  try { localStorage.setItem(USER_NAME_KEY, name); } catch (e) { /* ignore */ }
}

function showNamePrompt() {
  const overlay = document.getElementById("name-prompt-overlay");
  if (!overlay) return;
  overlay.style.display = "flex";
  document.body.style.overflow = "hidden";
  setTimeout(() => {
    const input = document.getElementById("user-name-input");
    if (input) input.focus();
  }, 80);
}

function saveUserName() {
  const input = document.getElementById("user-name-input");
  if (!input) return;
  const name = input.value.trim();
  if (!name) {
    input.classList.add("np-input-error");
    setTimeout(() => input.classList.remove("np-input-error"), 600);
    return;
  }
  setUserName(name);
  const overlay = document.getElementById("name-prompt-overlay");
  if (overlay) overlay.style.display = "none";
  // Now open the coach for real
  _openAICoachPanel();
}

// State for the conversation
const coachState = {
  hasGreeted: false,
  isSending: false,
  // Conversation stage machine:
  //  'awaiting_first'           — waiting for the very first task description
  //  'awaiting_duration'        — standard task, asked for duration once
  //  'awaiting_long_term_today' — recognised goal, asked for today's first step
  //  'idle'                     — finished / not in a flow
  stage: 'idle',
  pendingTaskText: '',
  pendingDuration: 25,
  pendingType: null, // 'quick' | 'standard' | 'long_term'
};

// ── INTELLIGENT CLASSIFIER (lightweight heuristics, NO LLM) ─────
// Long-term goal patterns
const COACH_GOAL_PATTERNS = [
  /\bmaster\b/i,
  /\bbecome\s+(a|an|the|fluent|good|better|great)\b/i,
  /\bget good at\b/i,
  /\bget better at\b/i,
  /\bcrack\s+(gsoc|placement|placements|jee|neet|gate|upsc)\b/i,
  /\bprepare\s+for\s+(placement|placements|gsoc|exam|exams|jee|neet|gate|upsc|career)\b/i,
  /\blose\s+weight\b/i,
  /\bgain\s+(weight|muscle|mass)\b/i,
  /\bget\s+fit\b/i,
  /\b(?:be|become)\s+(?:more\s+)?fluent\b/i,
  /\b(?:be|become)\s+(?:more\s+)?productive\b/i,
  /\bstart\s+a\s+(business|startup|company|youtube|blog|channel|brand|podcast)\b/i,
  /\bbuild\s+a\s+(startup|business|company|brand|habit|career|side\s+project)\b/i,
  /\bgrow\s+(my|the)\s+(business|company|channel|audience|following|brand)\b/i,
  /\bimprove\s+my\s+(english|writing|speaking|fitness|health|career|skills|grades)\b/i,
  /\bget\s+into\s+(iit|nit|iim|fang|google|meta|amazon|microsoft|college|university|grad\s*school)\b/i,
  /\bbuild\s+(a|my)\s+(habit|routine|skill|portfolio)\b/i,
  /\blearn\s+(javascript|python|react|java|rust|go|dsa|machine\s+learning|ml|ai|spanish|french|german|japanese|hindi|guitar|piano|to\s+code|to\s+draw|to\s+sing)\b/i,
];

// Quick task verbs — short, single-action errands
const COACH_QUICK_VERBS = /\b(buy|call|email|text|message|reply|send|pay|submit|book|schedule|remind|order|pickup|grab|check|confirm|cancel|renew|sign|file|mail|drop\s+off|pick\s+up|return|refill|recharge|register|rsvp|drink|eat|water|take)\b/i;

function classifyCoachMessage(text) {
  const t = String(text || "").trim();
  if (!t) return 'standard';
  const words = t.split(/\s+/).length;

  // 1) Long-term goal patterns
  for (const p of COACH_GOAL_PATTERNS) {
    if (p.test(t)) return 'long_term';
  }
  // Generic "Learn X" without explicit deliverable → goal
  if (/^learn\s+[a-z][a-z\s]{2,}$/i.test(t) && words <= 4) return 'long_term';

  // 2) Quick task — short text + simple action verb
  // Very short (≤3 words) with quick verb is always quick (covers "Submit assignment", "Pay electricity bill")
  if (words <= 3 && COACH_QUICK_VERBS.test(t)) return 'quick';
  // Up to 7 words: quick verb AND no complex deliverable noun
  const hasComplexNoun = /\b(assignment|project|chapter|essay|report|exam|interview|workout|tutorial)\b/i.test(t);
  if (words <= 7 && COACH_QUICK_VERBS.test(t) && !hasComplexNoun) return 'quick';

  // 3) Default
  return 'standard';
}

// Extract explicit duration hint from user text → minutes
function extractDurationMinutes(text) {
  const t = String(text || "").toLowerCase();
  let m = t.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr)\b/);
  if (m) return Math.max(1, Math.round(parseFloat(m[1]) * 60));
  m = t.match(/(\d+)\s*(minutes?|mins?|min)\b/);
  if (m) return Math.max(1, parseInt(m[1], 10));
  m = t.match(/(\d+)\s*h\s*(\d+)\s*m\b/);
  if (m) return Math.max(1, parseInt(m[1], 10) * 60 + parseInt(m[2], 10));
  m = t.match(/(\d+)h\b/);
  if (m) return Math.max(1, parseInt(m[1], 10) * 60);
  return null;
}

function estimateCoachDuration(text, type) {
  if (type === 'quick') {
    const lower = String(text || "").toLowerCase();
    if (/\b(call|text|message|reply|remind)\b/.test(lower)) return 10;
    if (/\b(email|send)\b/.test(lower)) return 15;
    if (/\b(pay|submit|book|schedule|order|sign|file|register|rsvp)\b/.test(lower)) return 10;
    if (/\b(buy|grab|pickup|pick\s+up|drop\s+off|return|refill|recharge)\b/.test(lower)) return 15;
    return 10;
  }
  // standard: use existing detectTaskType
  const domain = detectTaskType(text);
  const map = {
    coding: 60, assignment: 60, exam: 90, learning: 45, packing: 30, travel: 45,
    fitness: 45, writing: 60, design: 60, video: 60, math: 45, research: 60,
    interview: 60, business: 45, meeting: 30, email: 15, finance: 30, shopping: 30,
    cooking: 45, household: 45, admin: 30, language: 30, reading: 45, work: 45,
    general: 30,
  };
  return map[domain] || 30;
}

function _formatDurLabel(min) {
  if (min >= 60 && min % 60 === 0) return `${min / 60}h`;
  if (min >= 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${min}m`;
}

// ── MULTI-GOAL SPLITTER ────────────────────────────────────────
// Returns array of goal strings if the message contains 2+ separable goals,
// otherwise null (single goal).
const COACH_ACTION_VERB_START = /^(buy|call|email|text|message|reply|send|pay|submit|book|schedule|remind|order|pickup|grab|check|confirm|cancel|renew|sign|file|mail|drop|pick|return|refill|recharge|register|rsvp|finish|complete|learn|start|build|prepare|prep|study|write|edit|read|practice|review|do|attend|fix|create|design|cook|clean|wash|organize|plan|crack|master|lose|gain|get|become|drink|eat|run|walk|update|setup|develop|teach|train|figure|sort|install|configure|deploy|test|debug|watch|listen|join|launch|publish|ship|draft|outline|research|revise|refactor|interview|memorize|meditate|stretch|pack|go|apply|take|make|open|close|visit|follow|upload|save|share|post|record|fill|log|measure|compare|evaluate|meet|use|try|keep|move|find|give|show|help|track|shop|exercise|jog|swim|play)(?:\s|$)/i;

function splitGoals(text) {
  if (!text) return null;
  let t = String(text).trim();
  // Strip common preambles
  t = t.replace(
    /^(i\s+(?:want|need|have|would\s+like|am\s+going|gotta|have\s+to)\s+to\s+|today\s+i\s+(?:want|need|have)\s+(?:to\s+)?|today\s+i'll\s+|i'll\s+|let's\s+|i\s+plan\s+to\s+|i\s+wanna\s+|gonna\s+|i\s+must\s+|i'm\s+going\s+to\s+)/i,
    ''
  );

  // ── Helpers ───────────────────────────────────────────────────────────
  // Check if a segment starts with an action verb (base form or gerund).
  // Gerund: "buying groceries" → stem "buy" → match.
  // Returns true if any word in the segment is a recognisable action verb
  // (base form or gerund), so "trip packing" passes because "packing" → "pack".
  const isGoalStart = seg => {
    if (COACH_ACTION_VERB_START.test(seg)) return true;
    // Scan every word for gerund forms
    for (const word of seg.trim().split(/\s+/)) {
      const m = word.match(/^([a-z]{2,}?)ing$/i);
      if (!m) continue;
      const stem = m[1];
      // bare stem | silent-e restored (tak→take) | double-consonant stripped (shopp→shop)
      if (COACH_ACTION_VERB_START.test(stem + ' ') ||
          COACH_ACTION_VERB_START.test(stem + 'e ') ||
          (stem.length > 2 && COACH_ACTION_VERB_START.test(stem.slice(0, -1) + ' '))) {
        return true;
      }
    }
    return false;
  };

  // Reject single-noun qualifiers that look like connectors:
  // "Buy groceries for dinner" — 'for' is not a goal separator.
  // Only split if each part is independently actionable (starts with goal verb).

  // ── Strong separators: comma / semicolon ─────────────────────────────
  if (/[,;]/.test(t)) {
    const strong = t.split(/\s*[,;]\s*/).map(p => p.trim()).filter(p => p.length >= 2);
    if (strong.length >= 2 && strong.every(p => p.split(/\s+/).length <= 8)) {
      return strong.slice(0, 5);
    }
  }

  // ── Weak connectors: and / then / & / after / before / while ─────────
  // Each segment MUST start with an action verb (base or gerund) so that
  // "Finish my Java and Python assignment" → ["Finish my Java", "Python assignment"]
  // fails ("Python assignment" has no verb) and stays as one task.
  const WEAK_CONNECTOR = /\s*(?:\band\b|&|\bplus\b|\balso\b|\bthen\b|\bafter\b|\bbefore\b|\bwhile\b)\s*/i;
  let parts = t.split(WEAK_CONNECTOR).map(p => p.trim()).filter(p => p.length >= 2);
  if (parts.length < 2) return null;
  if (!parts.every(p => isGoalStart(p))) return null;
  return parts.slice(0, 5);
}

// ── CONFIDENCE RATING ──────────────────────────────────────────
// 'high'   → create immediately, no duration question
// 'medium' → show "I estimate ~X min" with Looks good / Change buttons
// 'low'    → ask the duration question
function coachConfidence(text, type) {
  if (type === 'quick') return 'high';
  if (type !== 'standard') return null;

  const t = String(text || "").trim();

  // Low-confidence vague patterns
  const LOW_CONFIDENCE = [
    /^(complete|finish|do|work\s+on|wrap\s+up)\s+(my\s+|the\s+)?(project|portfolio|stuff|things|app|product|side\s+project|work)$/i,
    /^build\s+(a\s+|my\s+|the\s+)?(portfolio|app|product|business|brand|side\s+project|tool|prototype)$/i,
    /^(prepare|prep|get\s+ready)\s+for\s+(interview|interviews|placement|placements|presentation|exam|exams|meeting)$/i,
    /^plan\s+(my\s+|the\s+)?(week|month|day|trip|vacation|project|sprint|roadmap)$/i,
    /^organize\s+(my\s+|the\s+)?(life|work|stuff|things|files|inbox)$/i,
    /^(review|go\s+through)\s+(my\s+|the\s+)?(work|notes|stuff|things|portfolio|code)$/i,
    /^figure\s+out\b/i,
    /^think\s+about\b/i,
  ];
  for (const p of LOW_CONFIDENCE) if (p.test(t)) return 'low';

  // Medium = task maps to a concrete domain we have a per-domain duration for
  const domain = detectTaskType(text);
  if (domain !== 'general') return 'medium';
  return 'low';
}

// ── CLARIFICATION CHIPS — domain-aware quick-picks for long-term goals ──
function _buildClarificationChips(text, forDomain) {
  const domain = forDomain || detectTaskType(text);
  const t = String(text || '').toLowerCase();
  const DOMAIN_CHIPS = {
    learning: /\bjavascript\b|\bjs\b/.test(t) ? ['Arrays', 'Objects', 'DOM', 'Async/Await', 'Build a small project'] :
               /\bpython\b/.test(t)            ? ['Functions', 'Lists & Dicts', 'File I/O', 'Build a script'] :
               /\breact\b/.test(t)             ? ['Components', 'useState', 'useEffect', 'Build a mini app'] :
               ['Read theory', 'Solve examples', 'Build something', 'Watch tutorial'],
    coding:    ['Fix a bug', 'Build a feature', 'Write tests', 'Refactor code', 'Review PR'],
    exam:      ['Study weak topics', 'Solve past papers', 'Write notes', 'Do a mock test'],
    fitness:   ['Warm-up & stretch', 'Cardio session', 'Strength training', 'Yoga / mobility'],
    writing:   ['Draft outline', 'Write first draft', 'Edit draft', 'Finalize & proofread'],
    design:    ['Portfolio', 'Landing Page', 'Blog', 'Dashboard', 'Mobile App'],
    video:     ['Import & review footage', 'Rough cut', 'Trim & polish', 'Add audio & export'],
    research:  ['Find sources', 'Read & extract', 'Synthesize findings', 'Write summary'],
    language:  ['Vocabulary', 'Grammar', 'Listening practice', 'Speaking practice'],
    business:  ['Define problem', 'Define target user', 'Draft solution', 'Validate idea'],
    interview: ['DSA practice', 'System design', 'Behavioral questions', 'Mock interview'],
    reading:   ['Read target pages', 'Summarize chapter', 'Review annotations'],
    general:   ['Portfolio', 'Landing Page', 'Blog', 'E-commerce', 'Web App'],
  };
  const chips = DOMAIN_CHIPS[domain] || DOMAIN_CHIPS.general;
  // Always append 'Other' if not already present
  return chips.includes('Other') ? chips : [...chips, 'Other'];
}

// ── EDITABLE PLAN REVIEW (Part 5) — show steps before committing ────────
function _appendPlanReviewCard(steps, onConfirm) {
  const thread = document.getElementById('acp-conv-thread');
  if (!thread) return;

  // Deep copy so edits don't affect original
  let editableSteps = steps.map(s => ({ ...s }));

  const row = document.createElement('div');
  row.className = 'acp-msg-row acp-msg-coach acp-plan-review-row';

  function render() {
    const safe = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    row.innerHTML = `<div class="acp-msg-avatar" aria-hidden="true">⚡</div>
      <div class="acp-msg-bubble acp-msg-actions acp-plan-review">
        <div class="acp-actions-label">📋 Review your plan — edit before starting:</div>
        <ol class="acp-review-list">${editableSteps.map((s, i) => `
          <li class="acp-review-item" data-idx="${i}">
            <span class="acp-review-label">${safe(s.label || s.title || '')}</span>
            <span class="acp-review-actions">
              <button type="button" class="acp-review-edit" data-idx="${i}" title="Edit">✏️</button>
              <button type="button" class="acp-review-remove" data-idx="${i}" title="Remove">✕</button>
            </span>
          </li>`).join('')}
        </ol>
        <div class="acp-review-footer">
          <button type="button" class="acp-chip acp-review-add">+ Add step</button>
          <button type="button" class="acp-start-btn acp-review-start">▶ Start →</button>
        </div>
      </div>`;
    thread.scrollTop = thread.scrollHeight;

    row.querySelectorAll('.acp-review-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        editableSteps.splice(idx, 1);
        render();
      });
    });

    row.querySelectorAll('.acp-review-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const item = row.querySelector(`.acp-review-item[data-idx="${idx}"] .acp-review-label`);
        if (!item) return;
        const current = editableSteps[idx].label || editableSteps[idx].title || '';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = current;
        inp.className = 'acp-chip-custom-input acp-review-input';
        inp.style.cssText = 'flex:1;min-width:0;font-size:0.88rem;padding:4px 8px;';
        item.replaceWith(inp);
        inp.focus();
        const commit = () => {
          const v = inp.value.trim();
          if (v) { editableSteps[idx].label = v; editableSteps[idx].title = v; }
          render();
        };
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
        inp.addEventListener('blur', commit);
      });
    });

    const addBtn = row.querySelector('.acp-review-add');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const newStep = { label: 'New step', title: 'New step', done: false, skipped: false };
        editableSteps.push(newStep);
        render();
        // Auto-edit the new step
        const lastItem = row.querySelector(`.acp-review-item[data-idx="${editableSteps.length - 1}"] .acp-review-edit`);
        if (lastItem) lastItem.click();
      });
    }

    const startBtn = row.querySelector('.acp-review-start');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        if (editableSteps.length === 0) return;
        // Freeze the card
        row.querySelectorAll('button').forEach(b => { b.disabled = true; b.style.opacity = '0.55'; });
        onConfirm(editableSteps);
      });
    }
  }

  render();
  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
  return row;
}

// ── PENDING TASK CREATION (reuses generateSteps + createTask + saveTasks) ──
async function _createPendingTaskFromCoach(text, duration) {
  const aiSteps = await generateSteps(text);
  const stepMeta = aiSteps._meta || [];

  // Build initial editable step list
  const initialSteps = aiSteps.map((label, i) => ({
    label,
    title: label,
    done: false,
    skipped: false,
    duration:   stepMeta[i]?.duration   || '',
    difficulty: stepMeta[i]?.difficulty || '',
    reason:     stepMeta[i]?.reason     || '',
  }));

  // Show editable review card and wait for user confirmation
  const confirmedSteps = await new Promise(resolve => {
    _appendPlanReviewCard(initialSteps, resolve);
  });

  // Build task from confirmed (possibly edited) steps
  const stepLabels = confirmedSteps.map(s => s.label || s.title || '');
  const task = createTask(text, stepLabels, duration);
  task.aiSteps = task.aiSteps.map((s, i) => ({
    ...s,
    duration:   confirmedSteps[i]?.duration   || '',
    difficulty: confirmedSteps[i]?.difficulty || '',
    reason:     confirmedSteps[i]?.reason     || '',
  }));
  task.state = 'pending';
  const tasks = loadTasks();
  tasks.push(task);
  saveTasks(tasks);
  updateTasksBadge();
  return task;
}

function openAICoach() {
  const name = getUserName();
  if (!name) {
    showNamePrompt();
    return;
  }
  _openAICoachPanel();
}

function _openAICoachPanel() {
  const overlay = document.getElementById("ai-coach-overlay");
  if (!overlay) return;
  overlay.style.display = "flex";
  document.body.style.overflow = "hidden";

  // Reset conversation each open — single-question flow
  const thread = document.getElementById("acp-conv-thread");
  const input  = document.getElementById("acp-input");
  const send   = document.getElementById("acp-send");
  if (thread) thread.innerHTML = "";
  if (input)  { input.value = ""; input.disabled = true; }
  if (send)   send.disabled = true;
  coachState.hasGreeted = false;
  coachState.isSending  = false;
  coachState.stage = 'idle';
  coachState.pendingTaskText = '';
  coachState.pendingDuration = 25;
  coachState.pendingType = null;
  coachState.goalQueue = [];
  coachState.goalQueueIndex = 0;
  coachState.queuedTaskIds = [];

  // Stagger the welcome → first question with typing animations
  runCoachWelcome();
}

function closeAICoach() {
  const overlay = document.getElementById("ai-coach-overlay");
  if (!overlay) return;
  overlay.style.display = "none";
  document.body.style.overflow = "";
}

function handleAICoachOverlayClick(e) {
  if (e.target.id === "ai-coach-overlay") closeAICoach();
}

// ── Conversation helpers ──────────────────────────────────────────

function _appendCoachBubble(html, opts = {}) {
  const thread = document.getElementById("acp-conv-thread");
  if (!thread) return null;
  const row = document.createElement("div");
  row.className = "acp-msg-row acp-msg-coach" + (opts.extraClass ? " " + opts.extraClass : "");
  row.innerHTML = `
    <div class="acp-msg-avatar" aria-hidden="true">⚡</div>
    <div class="acp-msg-bubble">${html}</div>
  `;
  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
  return row;
}

function _appendUserBubble(text) {
  const thread = document.getElementById("acp-conv-thread");
  if (!thread) return null;
  const row = document.createElement("div");
  row.className = "acp-msg-row acp-msg-user";
  // Escape simple HTML
  const safe = String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  row.innerHTML = `<div class="acp-msg-bubble acp-msg-bubble-user">${safe}</div>`;
  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
  return row;
}

function _appendTypingBubble() {
  const thread = document.getElementById("acp-conv-thread");
  if (!thread) return null;
  const row = document.createElement("div");
  row.className = "acp-msg-row acp-msg-coach acp-typing-row";
  row.innerHTML = `
    <div class="acp-msg-avatar" aria-hidden="true">⚡</div>
    <div class="acp-msg-bubble acp-typing-bubble" aria-label="AI Coach is typing">
      <span class="acp-typing-dot"></span>
      <span class="acp-typing-dot"></span>
      <span class="acp-typing-dot"></span>
    </div>
  `;
  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
  return row;
}

// Type out text inside a bubble that already has a `.acp-typed` span
async function _typewriter(node, text, speed = 18) {
  return new Promise(resolve => {
    let i = 0;
    function tick() {
      if (i <= text.length) {
        node.textContent = text.slice(0, i);
        i++;
        setTimeout(tick, speed);
      } else {
        resolve();
      }
    }
    tick();
  });
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runCoachWelcome() {
  const name = getUserName() || "there";
  const thread = document.getElementById("acp-conv-thread");
  if (!thread) return;

  // 1. Typing indicator (premium feel)
  const typing1 = _appendTypingBubble();
  await _sleep(700);
  typing1.remove();

  // 2. Welcome bubble (line 1 + line 2)
  const welcome = _appendCoachBubble(`
    <div class="acp-typed-line"><span class="acp-typed" data-line="1"></span></div>
    <div class="acp-typed-line acp-typed-line-2"><span class="acp-typed" data-line="2"></span></div>
  `, { extraClass: "acp-msg-welcome" });
  const line1 = welcome.querySelector('[data-line="1"]');
  const line2 = welcome.querySelector('[data-line="2"]');
  await _typewriter(line1, `👋 Welcome back, ${name}.`, 28);
  await _sleep(180);
  await _typewriter(line2, `I'm here to help you build today's execution plan.`, 18);

  // 3. Brief pause, then second typing indicator, then the first question
  await _sleep(420);
  const typing2 = _appendTypingBubble();
  await _sleep(900);
  typing2.remove();

  const question = _appendCoachBubble(`
    <div class="acp-typed-line"><span class="acp-typed" data-line="q"></span></div>
  `, { extraClass: "acp-msg-question" });
  const qLine = question.querySelector('[data-line="q"]');
  await _typewriter(qLine, "What would you like to accomplish?", 22);

  // 4. Enable composer — ready for the first user message
  const input = document.getElementById("acp-input");
  const send  = document.getElementById("acp-send");
  if (input) { input.disabled = false; input.focus(); }
  if (send)  send.disabled = false;
  coachState.hasGreeted = true;
  coachState.stage = 'awaiting_first';
}

function _enableCoachComposer(placeholder) {
  const input = document.getElementById("acp-input");
  const send  = document.getElementById("acp-send");
  if (input) {
    input.disabled = false;
    if (placeholder) input.placeholder = placeholder;
    input.focus();
  }
  if (send) send.disabled = false;
}

function _disableCoachComposer() {
  const input = document.getElementById("acp-input");
  const send  = document.getElementById("acp-send");
  if (input) input.disabled = true;
  if (send)  send.disabled = true;
}

// Disable all inline action buttons in the conversation thread —
// prevents stale buttons (e.g. an earlier "Looks good") from being clicked
// after the conversation has progressed.
function _disableAllCoachActionCards() {
  document.querySelectorAll('#acp-conv-thread .acp-start-btn, #acp-conv-thread .acp-secondary-btn, #acp-conv-thread .acp-chip').forEach(b => {
    b.disabled = true;
    b.style.pointerEvents = 'none';
    b.style.opacity = '0.55';
  });
}

// ── Action card with chips + start button (inline coach UI) ─────
function _appendActionCard({ label, chips, selected, startLabel, startTestId, withCustom }) {
  const thread = document.getElementById("acp-conv-thread");
  if (!thread) return null;
  const row = document.createElement("div");
  row.className = "acp-msg-row acp-msg-coach";
  const chipsHtml = chips.map(d => `
    <button type="button" class="acp-chip${d === selected ? ' active' : ''}" data-dur="${d}" data-testid="ai-coach-chip-${d}">${_formatDurLabel(d)}</button>
  `).join('');
  const customBtn = withCustom
    ? `<button type="button" class="acp-chip acp-chip-custom" data-action="custom" data-testid="ai-coach-chip-custom">Custom…</button>`
    : '';
  row.innerHTML = `
    <div class="acp-msg-avatar" aria-hidden="true">⚡</div>
    <div class="acp-msg-bubble acp-msg-actions">
      <div class="acp-actions-label">${label}</div>
      <div class="acp-chip-row">${chipsHtml}${customBtn}</div>
      <button type="button" class="acp-start-btn" data-testid="${startTestId}" onclick="commitCoachPlan()">${startLabel}</button>
    </div>
  `;
  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
  row.querySelectorAll('.acp-chip').forEach(btn => {
    btn.addEventListener('click', () => _onCoachChipClick(btn));
  });
  return row;
}

function _onCoachChipClick(btn) {
  if (btn.dataset.action === 'custom') {
    _activateCustomChipInput(btn);
    return;
  }
  const d = parseInt(btn.dataset.dur, 10);
  if (!d) return;
  coachState.pendingDuration = d;
  const row = btn.closest('.acp-chip-row');
  if (row) row.querySelectorAll('.acp-chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
}

// Replace the "Custom…" chip with an inline number input — confirms on Enter/blur
function _activateCustomChipInput(originalBtn) {
  const row = originalBtn.closest('.acp-chip-row');
  if (!row) return;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.max = '480';
  input.step = '1';
  input.inputMode = 'numeric';
  input.placeholder = 'min';
  input.className = 'acp-chip acp-chip-custom-input';
  input.setAttribute('data-testid', 'ai-coach-custom-input');
  input.value = coachState.pendingDuration || '';

  const commit = () => {
    const n = parseInt(input.value, 10);
    if (!(n > 0 && n <= 480)) {
      // Invalid — restore the original Custom… chip
      input.replaceWith(originalBtn);
      return;
    }
    coachState.pendingDuration = n;
    // Build a new active custom chip showing the value
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'acp-chip acp-chip-custom active';
    newBtn.dataset.action = 'custom';
    newBtn.setAttribute('data-testid', 'ai-coach-chip-custom');
    newBtn.textContent = `${n}m`;
    newBtn.addEventListener('click', () => _onCoachChipClick(newBtn));
    // Deactivate other chips
    row.querySelectorAll('.acp-chip').forEach(c => c.classList.remove('active'));
    input.replaceWith(newBtn);
    newBtn.classList.add('active');
  };

  let committed = false;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      committed = true;
      commit();
    } else if (e.key === 'Escape') {
      input.replaceWith(originalBtn);
    }
  });
  input.addEventListener('blur', () => {
    if (committed) return;
    // If empty, restore; otherwise commit
    if (!input.value) input.replaceWith(originalBtn);
    else commit();
  });

  originalBtn.replaceWith(input);
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

// ── Commit: hand off to existing planner pipeline (no duplication) ──
async function commitCoachPlan() {
  if (!coachState.pendingTaskText) return;
  // Capture and clear immediately to make this idempotent
  const text = coachState.pendingTaskText;
  const dur  = coachState.pendingDuration || 25;
  coachState.pendingTaskText = '';
  _disableCoachComposer();
  _disableAllCoachActionCards();

  const hasQueue = coachState.goalQueue && coachState.goalQueue.length > 0;
  const isFinalInQueue = hasQueue && coachState.goalQueueIndex >= coachState.goalQueue.length - 1;

  // INTERMEDIATE goal in a multi-goal queue — create as pending and continue
  if (hasQueue && !isFinalInQueue) {
    const ack  = _appendCoachBubble(`
      <div class="acp-typed-line"><span class="acp-typed" data-line="a"></span></div>
    `, { extraClass: "acp-msg-ack" });
    await _typewriter(ack.querySelector('[data-line="a"]'), `Queued · ${_formatDurLabel(dur)}. Adding it to your list…`, 22);
    const t = _appendTypingBubble();
    try {
      const created = await _createPendingTaskFromCoach(text, dur);
      if (created && created.id) coachState.queuedTaskIds.push(created.id);
    } catch (e) { /* keep flow alive */ }
    t.remove();
    coachState.goalQueueIndex += 1;
    coachState.pendingDuration = 25;
    coachState.pendingType = null;
    await _processNextQueuedGoal();
    return;
  }

  // FINAL queued goal OR single-goal mode → create as pending then show summary
  const ackText = hasQueue
    ? `Last one · ${_formatDurLabel(dur)}. Adding it…`
    : `Got it · ${_formatDurLabel(dur)}. Building your plan…`;
  const ack  = _appendCoachBubble(`
    <div class="acp-typed-line"><span class="acp-typed" data-line="a"></span></div>
  `, { extraClass: "acp-msg-ack" });
  await _typewriter(ack.querySelector('[data-line="a"]'), ackText, 22);
  const t = _appendTypingBubble();
  try {
    const created = await _createPendingTaskFromCoach(text, dur);
    if (created && created.id) coachState.queuedTaskIds.push(created.id);
  } catch (e) { /* keep flow alive */ }
  t.remove();
  await _showQueueComplete();
}

async function _showQueueComplete() {
  const total = coachState.queuedTaskIds.length;
  if (total === 0) {
    closeAICoach();
    coachState.stage = 'idle';
    return;
  }

  // Auto-order by common-sense priority and persist for the Start CTA
  coachState.queuedTaskIds = _orderQueueByPriority(coachState.queuedTaskIds);

  // Conversational summary
  const intro = _appendCoachBubble(`
    <div class="acp-typed-line"><span class="acp-typed" data-line="i1"></span></div>
    <div class="acp-typed-line acp-typed-line-2"><span class="acp-typed" data-line="i2"></span></div>
  `, { extraClass: "acp-msg-welcome" });
  await _typewriter(intro.querySelector('[data-line="i1"]'), `I've finished preparing your plan. ✨`, 22);
  await _sleep(140);
  await _typewriter(intro.querySelector('[data-line="i2"]'), `Here's today's queue.`, 18);
  await _sleep(280);

  // Premium queue card
  _appendQueueCard(coachState.queuedTaskIds);

  await _sleep(200);
  // Intelligent recommendation (one rule-based suggestion + Why? toggle)
  _appendRecommendation(coachState.queuedTaskIds);

  await _sleep(180);
  // Single CTA — Start Today's Plan
  _appendStartTodayCTA();
  coachState.stage = 'queue_complete';
}

// Order queue by common-sense priority:
//   1) Errands (short, time-sensitive) first
//   2) Deep Work (long focused work) while user is fresh
//   3) Focus (medium standard work)
//   4) Quick (short standard work)
// Within a tier, group similar domains together (stable sort by domain).
function _orderQueueByPriority(taskIds) {
  const tasks = taskIds.map(id => getTaskById(id)).filter(Boolean);
  const tierOf = t => {
    const badge = _badgeForTask(t);
    if (badge === 'Errand')     return 0;
    if (badge === 'Deep Work')  return 1;
    if (badge === 'Focus')      return 2;
    return 3; // Quick
  };
  const domainOf = t => detectTaskType(t.title || '');
  tasks.sort((a, b) => {
    const ta = tierOf(a), tb = tierOf(b);
    if (ta !== tb) return ta - tb;
    const da = domainOf(a), db = domainOf(b);
    if (da < db) return -1;
    if (da > db) return 1;
    return 0;
  });
  return tasks.map(t => t.id);
}

// Badge classification for the queue card
const _COACH_ERRAND_VERB = /\b(buy|call|email|text|message|pay|submit|book|pickup|grab|drop|order|remind|reply|send|register|rsvp|drink|eat|mail)\b/i;
function _badgeForTask(task) {
  const min = task.focusTime || 25;
  const title = String(task.title || '');
  if (_COACH_ERRAND_VERB.test(title) && min <= 20) return 'Errand';
  if (min >= 60) return 'Deep Work';
  if (min <= 20) return 'Quick';
  return 'Focus';
}

function _appendQueueCard(orderedIds) {
  const thread = document.getElementById("acp-conv-thread");
  if (!thread) return;
  const row = document.createElement("div");
  row.className = "acp-msg-row acp-msg-coach";
  const items = orderedIds.map((id, i) => {
    const t = getTaskById(id);
    if (!t) return '';
    const min = t.focusTime || 25;
    const badge = _badgeForTask(t);
    const badgeSlug = badge.toLowerCase().replace(/\s+/g, '-');
    const safeTitle = String(t.title)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `
      <li class="acp-q-item" data-testid="ai-coach-queue-item-${i + 1}">
        <div class="acp-q-order">${i + 1}</div>
        <div class="acp-q-body">
          <div class="acp-q-title">${safeTitle}</div>
          <div class="acp-q-meta">
            <span class="acp-q-time">⏱ ${_formatDurLabel(min)}</span>
            <span class="acp-q-badge acp-q-badge-${badgeSlug}">${badge}</span>
          </div>
        </div>
      </li>
    `;
  }).join('');
  const total = orderedIds.length;
  const totalMin = orderedIds.reduce((s, id) => {
    const t = getTaskById(id); return s + (t ? (t.focusTime || 25) : 0);
  }, 0);
  row.innerHTML = `
    <div class="acp-msg-avatar" aria-hidden="true">⚡</div>
    <div class="acp-msg-bubble acp-msg-queue-card" data-testid="ai-coach-queue-card">
      <div class="acp-q-header">
        <span class="acp-q-header-title">Today's plan</span>
        <span class="acp-q-header-meta">${total} task${total > 1 ? 's' : ''} · ${_formatDurLabel(totalMin)}</span>
      </div>
      <ol class="acp-q-list">${items}</ol>
    </div>
  `;
  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
}

function _appendStartTodayCTA() {
  const thread = document.getElementById("acp-conv-thread");
  if (!thread) return;
  const row = document.createElement("div");
  row.className = "acp-msg-row acp-msg-coach acp-msg-start-row";
  row.innerHTML = `
    <div class="acp-msg-avatar" aria-hidden="true">⚡</div>
    <div class="acp-msg-bubble acp-msg-start-card">
      <button type="button" class="acp-start-btn acp-start-today-btn" data-testid="ai-coach-start-today" onclick="_startTodaysPlan()">
        <span class="acp-start-icon">▶</span> Start Today's Plan
      </button>
    </div>
  `;
  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
}

function _startTodaysPlan() {
  const id = coachState.queuedTaskIds && coachState.queuedTaskIds[0];
  if (!id) { closeAICoach(); return; }
  closeAICoach();
  coachState.stage = 'idle';
  // Reuse the existing pipeline — opens the first planned task in Active Mode
  resumeTaskById(id);
}

// ── INTELLIGENT RECOMMENDATION (rule-based, consumes the queue only) ──
function _buildRecommendation(orderedIds) {
  const tasks = orderedIds.map(id => getTaskById(id)).filter(Boolean);
  if (tasks.length === 0) return null;

  // 1) Same-domain batching (2+ tasks of the same domain → reduce context switching)
  const byDomain = {};
  tasks.forEach(t => {
    const d = detectTaskType(t.title || '');
    (byDomain[d] = byDomain[d] || []).push(t);
  });
  const batch = Object.entries(byDomain).find(([d, arr]) => arr.length >= 2 && d !== 'general');
  if (batch) {
    const [domain, arr] = batch;
    return {
      headline: `Complete both ${domain} tasks together to reduce context switching.`,
      reason:   `You have ${arr.length} ${domain} tasks queued. Grouping similar work keeps you in flow and avoids the mental reset between contexts.`,
    };
  }

  // 2) First task is an Errand → clear mental clutter
  const first = tasks[0];
  const firstBadge = _badgeForTask(first);
  if (firstBadge === 'Errand') {
    return {
      headline: `Finish ${first.title} first to remove mental clutter.`,
      reason:   `Errands are small but distracting. Clearing them first frees focus for the deeper work below.`,
    };
  }

  // 3) Deep Work present → tackle while energy is highest
  const deep = tasks.find(t => _badgeForTask(t) === 'Deep Work');
  if (deep) {
    return {
      headline: `Start with ${deep.title} while your energy is highest.`,
      reason:   `It requires the highest focus on your list. Tackling it early — before fatigue sets in — protects the quality of the output.`,
    };
  }

  // 4) Fallback — momentum
  return {
    headline: `Begin with ${first.title} to build momentum.`,
    reason:   `Starting with the first item gets the wheel turning. Momentum carries you through the rest of the queue.`,
  };
}

function _appendRecommendation(orderedIds) {
  const rec = _buildRecommendation(orderedIds);
  if (!rec) return;
  const thread = document.getElementById("acp-conv-thread");
  if (!thread) return;
  const safe = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const row = document.createElement("div");
  row.className = "acp-msg-row acp-msg-coach";
  row.innerHTML = `
    <div class="acp-msg-avatar" aria-hidden="true">⚡</div>
    <div class="acp-msg-bubble acp-msg-rec" data-testid="ai-coach-recommendation">
      <div class="acp-rec-label">💡 Recommendation</div>
      <div class="acp-rec-headline">${safe(rec.headline)}</div>
      <button type="button" class="acp-rec-why-btn" data-testid="ai-coach-rec-why" aria-expanded="false" onclick="_toggleCoachWhy(this)">
        <span class="acp-rec-why-text">Why?</span>
        <span class="acp-rec-why-chev" aria-hidden="true">▾</span>
      </button>
      <div class="acp-rec-why-panel" data-testid="ai-coach-rec-why-panel">
        <div class="acp-rec-why-inner">${safe(rec.reason)}</div>
      </div>
    </div>
  `;
  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
}

function _toggleCoachWhy(btn) {
  const panel = btn.parentElement.querySelector('.acp-rec-why-panel');
  if (!panel) return;
  const open = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', open ? 'false' : 'true');
  panel.classList.toggle('open', !open);
  btn.classList.toggle('open', !open);
}

async function sendCoachMessage() {
  if (coachState.isSending || !coachState.hasGreeted) return;
  const input = document.getElementById("acp-input");
  const send  = document.getElementById("acp-send");
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  coachState.isSending = true;
  input.value = "";
  input.disabled = true;
  if (send) send.disabled = true;

  _appendUserBubble(text);

  await _sleep(380);
  const typing = _appendTypingBubble();
  await _sleep(750);
  typing.remove();

  try {
    if (coachState.stage === 'awaiting_duration') {
      await _handleDurationAnswer(text);
    } else if (coachState.stage === 'awaiting_long_term_today') {
      await _handleLongTermToday(text);
    } else {
      await _handleFirstMessage(text);
    }
  } finally {
    coachState.isSending = false;
  }
}

// ── Voice Input (Speech-to-Text) ────────────────────────────────
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const _vs = { recognition: null, listening: false };

  function _micBtn()   { return document.getElementById('acp-mic'); }
  function _coachInput() { return document.getElementById('acp-input'); }

  function _setListening(on) {
    _vs.listening = on;
    const btn = _micBtn();
    if (!btn) return;
    btn.classList.toggle('listening', on);
    btn.setAttribute('aria-label', on ? 'Stop listening' : 'Voice input');
    btn.title = on ? 'Stop listening' : 'Voice input';
  }

  function _voiceError(msg) {
    // Show error as a coach bubble (reuses existing pattern, no alert())
    _appendCoachBubble(`<span style="color:#ef4444;font-size:0.88rem;">🎤 ${msg}</span>`);
  }

  function _stop() {
    if (_vs.recognition) {
      try { _vs.recognition.stop(); } catch (_) {}
    }
    _setListening(false);
  }

  window.toggleVoiceInput = function () {
    if (_vs.listening) { _stop(); return; }

    if (!SR) {
      _voiceError('Voice input is not supported in this browser.');
      return;
    }

    const input = _coachInput();
    if (input && input.disabled) {
      // Coach not ready yet — silently ignore (avoids confusing the user mid-welcome)
      return;
    }

    const rec = new SR();
    _vs.recognition = rec;
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;

    rec.onstart = () => _setListening(true);

    rec.onresult = (e) => {
      const transcript = e.results[0][0].transcript.trim();
      if (!transcript) { _voiceError('No speech detected. Please try again.'); return; }
      const inp = _coachInput();
      if (inp) {
        // Append to existing text (or replace if empty) — user can still edit
        inp.value = inp.value ? inp.value + ' ' + transcript : transcript;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.focus();
      }
    };

    rec.onerror = (e) => {
      _setListening(false);
      if (e.error === 'not-allowed' || e.error === 'permission-denied') {
        _voiceError('Microphone permission denied. Please allow access in your browser settings.');
      } else if (e.error === 'no-speech') {
        _voiceError('No speech detected. Please try again.');
      } else if (e.error === 'network') {
        _voiceError('Network error during speech recognition. Please check your connection.');
      } else if (e.error === 'audio-capture') {
        _voiceError('Microphone unavailable. Please check your device.');
      } else {
        _voiceError('Voice input failed. Please try typing instead.');
      }
    };

    rec.onend = () => _setListening(false);

    try {
      rec.start();
    } catch (err) {
      _setListening(false);
      _voiceError('Could not start voice input. Please try again.');
    }
  };
})();

// ── Stage handlers ──────────────────────────────────────────────


async function _handleFirstMessage(text) {
  // 1) Check for multi-goal split
  const goals = splitGoals(text);
  if (goals && goals.length >= 2) {
    coachState.goalQueue = goals;
    coachState.goalQueueIndex = 0;
    coachState.queuedTaskIds = [];

    const intro = _appendCoachBubble(`
      <div class="acp-typed-line"><span class="acp-typed" data-line="m1"></span></div>
      <div class="acp-typed-line acp-typed-line-2"><span class="acp-typed" data-line="m2"></span></div>
    `, { extraClass: "acp-msg-welcome" });
    await _typewriter(intro.querySelector('[data-line="m1"]'), `I found ${goals.length} different goals. 🎯`, 22);
    await _sleep(140);
    await _typewriter(intro.querySelector('[data-line="m2"]'), `Let's handle them one by one.`, 18);

    // Show the goal list as a small bubble
    const list = _appendCoachBubble(
      `<ol class="acp-goal-list">${goals.map(g => `<li>${String(g).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</li>`).join('')}</ol>`,
      { extraClass: "acp-msg-list" }
    );

    await _sleep(420);
    await _processNextQueuedGoal();
    return;
  }

  // 2) Single-goal classification
  await _runReasoningForGoal(text);
}

// Called for each goal in the queue OR for a single message
async function _runReasoningForGoal(goalText) {
  const type = classifyCoachMessage(goalText);
  coachState.pendingTaskText = goalText;
  coachState.pendingType = type;

  if (type === 'long_term') {
    const bub = _appendCoachBubble(`
      <div class="acp-typed-line"><span class="acp-typed" data-line="g1"></span></div>
      <div class="acp-typed-line acp-typed-line-2"><span class="acp-typed" data-line="g2"></span></div>
    `, { extraClass: "acp-msg-welcome" });
    await _typewriter(bub.querySelector('[data-line="g1"]'), "This sounds like a long-term goal. 🌱", 22);
    await _sleep(160);
    await _typewriter(bub.querySelector('[data-line="g2"]'), "What would you like to accomplish today?", 20);

    await _sleep(380);
    const t2 = _appendTypingBubble();
    await _sleep(650);
    t2.remove();

    // Show clarification chips based on the detected domain
    const clarChips = _buildClarificationChips(goalText);
    if (clarChips.length > 0) {
      const thread = document.getElementById('acp-conv-thread');
      if (thread) {
        const chipRow = document.createElement('div');
        chipRow.className = 'acp-msg-row acp-msg-coach acp-clarif-row';
        chipRow.innerHTML = `<div class="acp-msg-avatar" aria-hidden="true">⚡</div>
          <div class="acp-msg-bubble acp-msg-actions" style="gap:8px">
            <div class="acp-actions-label">Pick a focus for today:</div>
            <div class="acp-chip-row" id="acp-clarif-chip-row-lt">${clarChips.map(c => `<button type="button" class="acp-chip acp-clarif-chip" data-testid="ai-coach-clarif-${c.replace(/\s+/g,'-').toLowerCase()}">${escapeHtml(c)}</button>`).join('')}</div>
          </div>`;
        thread.appendChild(chipRow);
        thread.scrollTop = thread.scrollHeight;
        chipRow.querySelectorAll('.acp-clarif-chip').forEach(btn => {
          btn.addEventListener('click', () => {
            _disableAllCoachActionCards();
            chipRow.querySelectorAll('.acp-clarif-chip').forEach(b => { b.disabled = true; b.style.opacity = '0.55'; });
            btn.classList.add('active');
            const chosen = btn.textContent.trim();
            if (chosen === 'Other') {
              // Show inline text input for custom focus
              btn.style.opacity = '1';
              btn.disabled = false;
              _activateClarifOtherInput(chipRow, goalText, 'long_term');
              return;
            }
            const refinedText = goalText + ' — ' + chosen;
            _appendUserBubble(chosen);
            coachState.stage = 'idle';
            _runReasoningAsStandard(refinedText);
          });
        });
      }
    }

    coachState.stage = 'awaiting_long_term_today';
    _enableCoachComposer("Or type your own focus…");
    return;
  }

  if (type === 'quick') {
    // HIGH confidence — auto-create immediately, no question
    const explicit = extractDurationMinutes(goalText);
    const dur = explicit || estimateCoachDuration(goalText, 'quick');
    coachState.pendingDuration = dur;

    const ack = _appendCoachBubble(`
      <div class="acp-typed-line"><span class="acp-typed" data-line="qa"></span></div>
      <div class="acp-typed-line acp-typed-line-2"><span class="acp-typed" data-line="qb"></span></div>
    `, { extraClass: "acp-msg-ack" });
    await _typewriter(ack.querySelector('[data-line="qa"]'), "Got it! I've added this as a quick task. ⚡", 22);
    await _sleep(120);
    await _typewriter(ack.querySelector('[data-line="qb"]'), `Estimated ~${_formatDurLabel(dur)} · creating now…`, 18);
    await _sleep(420);
    await commitCoachPlan();
    return;
  }

  // Standard — apply confidence rating
  const conf = coachConfidence(goalText, 'standard');

  // Always honor an explicit duration in the user's message → high confidence
  const explicit = extractDurationMinutes(goalText);
  if (explicit) {
    coachState.pendingDuration = explicit;
    await _proceedWithPlanning(`Got it — ${_formatDurLabel(explicit)}. Building your plan now…`);
    return;
  }

  if (conf === 'medium') {
    const inferred = estimateCoachDuration(goalText, 'standard');
    coachState.pendingDuration = inferred;

    const est = _appendCoachBubble(`
      <div class="acp-typed-line"><span class="acp-typed" data-line="e"></span></div>
    `, { extraClass: "acp-msg-question" });
    await _typewriter(est.querySelector('[data-line="e"]'), `I estimate this will take about ${_formatDurLabel(inferred)}.`, 22);
    await _sleep(200);
    _appendEstimateCard(inferred);
    return;
  }

  // LOW confidence — ask ONE clarification question, then duration
  const clarChipsStd = _buildClarificationChipsForVague(goalText);
  if (clarChipsStd) {
    const inferred = estimateCoachDuration(goalText, 'standard');
    coachState.pendingDuration = inferred;
    const thread = document.getElementById('acp-conv-thread');
    if (thread) {
      const chipRow = document.createElement('div');
      chipRow.className = 'acp-msg-row acp-msg-coach acp-clarif-row';
      chipRow.innerHTML = `<div class="acp-msg-avatar" aria-hidden="true">⚡</div>
        <div class="acp-msg-bubble acp-msg-actions" style="gap:8px">
          <div class="acp-actions-label">${escapeHtml(clarChipsStd.question)}</div>
          <div class="acp-chip-row">${clarChipsStd.options.map(c => `<button type="button" class="acp-chip acp-clarif-chip" data-testid="ai-coach-clarif-${c.replace(/\s+/g,'-').toLowerCase()}">${c}</button>`).join('')}</div>
        </div>`;
      thread.appendChild(chipRow);
      thread.scrollTop = thread.scrollHeight;
      _disableCoachComposer();
      chipRow.querySelectorAll('.acp-clarif-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          _disableAllCoachActionCards();
          chipRow.querySelectorAll('.acp-clarif-chip').forEach(b => { b.disabled = true; b.style.opacity = '0.55'; });
          btn.classList.add('active');
          const chosen = btn.textContent.trim();
          if (chosen === 'Other') {
            btn.style.opacity = '1';
            btn.disabled = false;
            _activateClarifOtherInput(chipRow, goalText, 'standard');
            return;
          }
          const refinedText = goalText + ' — ' + chosen;
          _appendUserBubble(chosen);
          coachState.stage = 'idle';
          _runReasoningAsStandard(refinedText);
        });
      });
    }
    coachState.stage = 'awaiting_duration';
    return;
  }

  // Fallback — ask the duration question
  const inferred = estimateCoachDuration(goalText, 'standard');
  coachState.pendingDuration = inferred;

  const dq = _appendCoachBubble(`
    <div class="acp-typed-line"><span class="acp-typed" data-line="dq"></span></div>
  `, { extraClass: "acp-msg-question" });
  await _typewriter(dq.querySelector('[data-line="dq"]'), "Approximately how long do you think this will take?", 22);
  await _sleep(200);

  const chips = Array.from(new Set([15, 25, 45, 60, 90, 120, inferred])).sort((a, b) => a - b);
  _appendActionCard({
    label: `Pick one (suggested · ${_formatDurLabel(inferred)})`,
    chips,
    selected: inferred,
    startLabel: "Looks good · Start →",
    startTestId: "ai-coach-start-standard",
    withCustom: true,
  });
  coachState.stage = 'awaiting_duration';
  _enableCoachComposer("Or just type a number (e.g. 40)");
}

// ── Vague standard task clarification (ONE question only) ──────────────
// Returns { question, options } or null if no clarification needed.
function _buildClarificationChipsForVague(text) {
  const t = String(text || '').toLowerCase();
  // Website/Web build
  if (/\bbuild\b.*\bwebsite\b|\bcreate\b.*\bwebsite\b|\bmake\b.*\bwebsite\b|\bwebsite\b/.test(t)) {
    return { question: 'What are you building?', options: ['Portfolio', 'Landing Page', 'Blog', 'E-commerce', 'Other'] };
  }
  // App build (vague)
  if (/\bbuild\b.*\bapp\b|\bcreate\b.*\bapp\b|\bmake\b.*\bapp\b/.test(t) && !/\bmobile\b/.test(t)) {
    return { question: 'What kind of app?', options: ['Web App', 'Mobile App', 'Desktop App', 'CLI Tool', 'Other'] };
  }
  // Portfolio
  if (/\bportfolio\b/.test(t)) {
    return { question: 'What type of portfolio?', options: ['Developer', 'Designer', 'Photographer', 'Writer', 'Other'] };
  }
  // Interview prep (vague)
  if (/^(prepare|prep|get\s+ready)\s+for\s+(interview|interviews|placement|placements)$/i.test(t)) {
    return { question: 'What are you preparing for?', options: ['DSA / Coding', 'System Design', 'Behavioral', 'Full Mock', 'Other'] };
  }
  // Plan (vague)
  if (/^plan\s+(my\s+|the\s+)?(week|month|day|trip|project|sprint)$/i.test(t)) {
    return { question: 'What are you planning?', options: ['Work sprint', 'Personal goals', 'Travel', 'Project roadmap', 'Other'] };
  }
  return null;
}

// ── "Other" chip → show inline text input, then continue ───────────────
function _activateClarifOtherInput(chipRow, originalGoal, mode) {
  const chipRowInner = chipRow.querySelector('.acp-chip-row');
  if (!chipRowInner) return;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.placeholder = 'Describe your focus…';
  inp.className = 'acp-chip acp-chip-custom-input';
  inp.style.cssText = 'min-width:160px;flex:1;font-size:0.88rem;padding:6px 10px;border-radius:8px;';
  const confirmOther = () => {
    const val = inp.value.trim();
    if (!val) return;
    inp.disabled = true;
    _disableAllCoachActionCards();
    const refinedText = originalGoal + ' — ' + val;
    _appendUserBubble(val);
    coachState.stage = 'idle';
    _runReasoningAsStandard(refinedText);
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); confirmOther(); } });
  inp.addEventListener('blur', () => { setTimeout(confirmOther, 150); });
  chipRowInner.appendChild(inp);
  setTimeout(() => inp.focus(), 50);
}

// Process the next goal in the multi-goal queue
async function _processNextQueuedGoal() {
  if (!coachState.goalQueue || coachState.goalQueueIndex >= coachState.goalQueue.length) {
    return;
  }
  const idx = coachState.goalQueueIndex;
  const total = coachState.goalQueue.length;
  const goal = coachState.goalQueue[idx];

  const prefixMap = ['First up', 'Next', 'Then', 'After that', 'Last one'];
  const prefix = idx === total - 1 ? 'Last one' : (prefixMap[idx] || 'Next');

  const intro = _appendCoachBubble(`
    <div class="acp-typed-line"><span class="acp-typed" data-line="p"></span></div>
  `, { extraClass: "acp-msg-question" });
  await _typewriter(intro.querySelector('[data-line="p"]'), `${prefix}: ${goal} (${idx + 1}/${total})`, 22);
  await _sleep(280);

  await _runReasoningForGoal(goal);
}

// Estimate card for MEDIUM confidence — Looks good / Change estimate
function _appendEstimateCard(estimatedMin) {
  const thread = document.getElementById("acp-conv-thread");
  if (!thread) return;
  const row = document.createElement("div");
  row.className = "acp-msg-row acp-msg-coach";
  row.innerHTML = `
    <div class="acp-msg-avatar" aria-hidden="true">⚡</div>
    <div class="acp-msg-bubble acp-msg-actions">
      <div class="acp-actions-label">Estimated · ${_formatDurLabel(estimatedMin)}</div>
      <div class="acp-est-btns">
        <button type="button" class="acp-start-btn" data-testid="ai-coach-confirm-estimate" onclick="commitCoachPlan()">✓ Looks good</button>
        <button type="button" class="acp-secondary-btn" data-testid="ai-coach-edit-estimate" onclick="_revealEstimateChips(${estimatedMin})">✏ Change estimate</button>
      </div>
    </div>
  `;
  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
}

function _revealEstimateChips(inferred) {
  const chips = Array.from(new Set([15, 25, 45, 60, 90, 120, inferred])).sort((a, b) => a - b);
  _appendActionCard({
    label: `Pick a new duration (was · ${_formatDurLabel(inferred)})`,
    chips,
    selected: inferred,
    startLabel: "Looks good · Start →",
    startTestId: "ai-coach-start-standard",
    withCustom: true,
  });
}

async function _handleDurationAnswer(text) {
  const explicit = extractDurationMinutes(text);
  let n = explicit;
  if (!n) {
    const num = parseInt(text.trim(), 10);
    if (num > 0 && num <= 480) n = num;
  }
  if (n) coachState.pendingDuration = n;
  await _proceedWithPlanning(`Perfect — ${_formatDurLabel(coachState.pendingDuration)}. Building your plan now…`);
}

async function _handleLongTermToday(text) {
  // Treat the user's today-step answer as the new task description
  // and run it through the same confidence-aware reasoning pipeline.
  // (If they re-typed a long-term-ish phrase, reclassify it as a standard task
  //  so we don't loop forever.)
  coachState.stage = 'idle';
  const sub = classifyCoachMessage(text);
  if (sub === 'long_term') {
    // Soft-coerce to standard for this leg of the conversation
    coachState.pendingType = 'standard';
    // Use the runner with the original text but bypass long_term path
    await _runReasoningAsStandard(text);
    return;
  }
  await _runReasoningForGoal(text);
}

// Coerced standard runner — for cases where the user re-states a goal as today's step
async function _runReasoningAsStandard(text) {
  if (coachState.isSending) return;
  coachState.isSending = true;
  coachState.pendingTaskText = text;
  coachState.pendingType = 'standard';
  try {
  const explicit = extractDurationMinutes(text);
  if (explicit) {
    coachState.pendingDuration = explicit;
    await _proceedWithPlanning(`Got it — ${_formatDurLabel(explicit)}. Building your plan now…`);
    return;
  }
  const conf = coachConfidence(text, 'standard');
  if (conf === 'medium') {
    const inferred = estimateCoachDuration(text, 'standard');
    coachState.pendingDuration = inferred;
    const est = _appendCoachBubble(`
      <div class="acp-typed-line"><span class="acp-typed" data-line="e"></span></div>
    `, { extraClass: "acp-msg-question" });
    await _typewriter(est.querySelector('[data-line="e"]'), `I estimate this will take about ${_formatDurLabel(inferred)}.`, 22);
    await _sleep(200);
    _appendEstimateCard(inferred);
    return;
  }
  const inferred = estimateCoachDuration(text, 'standard');
  coachState.pendingDuration = inferred;
  const dq = _appendCoachBubble(`
    <div class="acp-typed-line"><span class="acp-typed" data-line="dq"></span></div>
  `, { extraClass: "acp-msg-question" });
  await _typewriter(dq.querySelector('[data-line="dq"]'), "How much time can you give it today?", 22);
  await _sleep(200);
  const chips = Array.from(new Set([15, 25, 45, 60, 90, inferred])).sort((a, b) => a - b);
  _appendActionCard({
    label: `Pick one (suggested · ${_formatDurLabel(inferred)})`,
    chips, selected: inferred,
    startLabel: "Looks good · Start →",
    startTestId: "ai-coach-start-standard",
    withCustom: true,
  });
  coachState.stage = 'awaiting_duration';
  _enableCoachComposer("Or just type a number (e.g. 40)");
  } finally {
    coachState.isSending = false;
  }
}

async function _proceedWithPlanning(ackText) {
  const ack = _appendCoachBubble(`
    <div class="acp-typed-line"><span class="acp-typed" data-line="a"></span></div>
  `, { extraClass: "acp-msg-ack" });
  await _typewriter(ack.querySelector('[data-line="a"]'), ackText, 22);
  await _sleep(420);
  await commitCoachPlan();
}

/**
 * goBack() — the actual leave action (after confirmation).
 * Called by the focus-lock leave overlay or directly if task is completed.
 */
function goBack() {
  clearInterval(state.moodTimer);
  clearInterval(state.focusBarTimer);
  stopSessionTimer();
  state.moodTimer = null;
  state.focusBarTimer = null;

  // Sync progress before leaving
  if (state.taskId && !state.isCompleted) {
    syncTaskSteps(state.taskId, state.steps, state.completedCount);
  }

  // Dismiss overlays
  document.getElementById("focus-lock-overlay")?.style && (document.getElementById("focus-lock-overlay").style.display = "none");
  document.getElementById("leave-task-overlay")?.style && (document.getElementById("leave-task-overlay").style.display = "none");
  state.focusLockActive = false;

  if (state.callerScreen === "tasks") {
    showScreen("screen-tasks");
  } else {
    showScreen("screen-input");
  }
}

/**
 * confirmLeaveTask() — shown when user taps "← Home" or "📋 Tasks" mid-task.
 * Shows a gentle overlay with Continue / Snooze / Leave options.
 * If the task is completed, leaves immediately without warning.
 */
function confirmLeaveTask(destination) {
  // If completed, leave without warning
  if (state.isCompleted) {
    goBack();
    return;
  }
  // Show overlay as soon as real AI steps are loaded (even 0 steps completed)
  // This gives gentle friction during any active focus session.
  const hasRealSteps = state.steps.length > 1 || (
    state.steps.length === 1 &&
    !state.steps[0].label.includes("Generating")
  );
  if (!hasRealSteps) {
    // Still generating or no steps — leave freely
    state.callerScreen = destination || state.callerScreen;
    goBack();
    return;
  }

  // Show the gentle leave overlay
  state._leaveDestination = destination || state.callerScreen;
  const overlay = document.getElementById("leave-task-overlay");
  if (overlay) overlay.style.display = "flex";
}

/**
 * Handle the user's choice from the leave-task overlay.
 * @param {'continue'|'snooze'|'leave'} action
 */
function dismissLeaveOverlay(action) {
  const overlay = document.getElementById("leave-task-overlay");
  if (overlay) overlay.style.display = "none";

  if (action === "continue") {
    // Back to work — reset mood timer
    resetMoodTimer();
    setMood("good");
  } else if (action === "snooze") {
    snoozeActiveTask();
  } else if (action === "leave") {
    const dest = state._leaveDestination || state.callerScreen;
    state.callerScreen = dest;
    goBack();
  }
}

// ================================================================
// TASKS TAB — render 4 sections
// ================================================================
function renderTasksTab() {
  const body = document.getElementById("tasks-body");
  if (!body) return;

  checkSnoozedTasks(); // always check on render

  const tasks = loadTasks();
  const pending = tasks.filter(t => t.state === "pending");
  const active = tasks.filter(t => t.state === "active");
  const snoozed = tasks.filter(t => t.state === "snoozed");
  const completed = tasks.filter(t => t.state === "completed");

  // Sort: newest first for most sections, oldest first for completed
  const sortNew = arr => [...arr].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const sortOld = arr => [...arr].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  body.innerHTML = `
    ${renderTaskSection("active", "⚡ Active", sortNew(active), "Currently being worked on")}
    ${renderTaskSection("pending", "📋 Pending", sortNew(pending), "Ready to start")}
    ${renderTaskSection("snoozed", "😴 Snoozed", sortNew(snoozed), "Paused — will return automatically")}
    ${renderTaskSection("completed", "✅ Completed", sortOld(completed), "All done")}
  `;
}

function renderTaskSection(state, title, tasks, subtitle) {
  const isEmpty = tasks.length === 0;
  return `
    <div class="task-section">
      <div class="task-section-header">
        <div>
          <div class="task-section-title">${title}</div>
          <div class="task-section-sub">${subtitle}</div>
        </div>
        <div class="task-section-count">${tasks.length}</div>
      </div>
      <div class="task-section-body">
        ${isEmpty
      ? `<div class="task-empty">${getEmptyMessage(state)}</div>`
      : tasks.map(t => renderTaskCard(t)).join("")
    }
      </div>
    </div>
  `;
}

function getEmptyMessage(sectionState) {
  const map = {
    active: "No active tasks — start one from Pending or Home.",
    pending: "Nothing pending. Add a task from Home.",
    snoozed: "No snoozed tasks — everything is accounted for. 👍",
    completed: "No completed tasks yet. Get one done!",
  };
  return map[sectionState] || "Nothing here.";
}

function renderTaskCard(task) {
  const stateLabels = {
    pending: "Pending",
    active: "Active",
    snoozed: "Snoozed",
    completed: "Done",
  };

  const steps = task.aiSteps || [];
  const totalSteps = steps.length;
  const doneSteps = steps.filter(s => s.done).length;
  const pct = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;
  const showProgress = totalSteps > 0;

  // Format snooze time remaining
  let snoozeLabel = "";
  if (task.state === "snoozed" && task.snoozeUntil) {
    const remaining = new Date(task.snoozeUntil) - Date.now();
    if (remaining > 0) {
      const mins = Math.ceil(remaining / 60000);
      const hours = Math.floor(mins / 60);
      snoozeLabel = hours >= 1
        ? `Wakes up in ${hours}h ${mins % 60}m`
        : `Wakes up in ${mins}m`;
    } else {
      snoozeLabel = "Waking up...";
    }
  }

  // Action buttons per state
  let actions = "";
  if (task.state === "pending") {
    actions = `
      <button class="tc-btn tc-btn-primary" type="button" onclick="resumeTaskById('${task.id}')">▶ Start</button>
      <button class="tc-btn tc-btn-snooze"  type="button" onclick="openSnoozeModal('${task.id}')">😴 Snooze</button>
    `;
  } else if (task.state === "active") {
    actions = `
      <button class="tc-btn tc-btn-primary" type="button" onclick="resumeTaskById('${task.id}')">▶ Resume</button>
      <button class="tc-btn tc-btn-snooze"  type="button" onclick="openSnoozeModal('${task.id}')">😴 Snooze</button>
      <button class="tc-btn tc-btn-done"    type="button" onclick="completeTaskFromTab('${task.id}')">✓ Done</button>
    `;
  } else if (task.state === "snoozed") {
    actions = `
      <button class="tc-btn tc-btn-primary" type="button" onclick="resumeTaskById('${task.id}')">↺ Resume now</button>
    `;
  } else if (task.state === "completed") {
    actions = `
      <button class="tc-btn tc-btn-ghost" type="button" onclick="reopenTask('${task.id}')">↩ Re-open</button>
    `;
  }

  // State-based card class for visual distinction
  const cardClass = task.state === "active" ? " task-card-active"
    : task.state === "snoozed" ? " task-card-snoozed"
    : task.state === "completed" ? " task-card-completed"
    : "";

  return `
    <div class="task-card${cardClass}" id="tc-${task.id}">
      <div class="task-card-top">
        <div class="task-card-info">
          <span class="tc-badge tc-badge-${task.state}">${stateLabels[task.state]}</span>
          <h4 class="tc-title">${escapeHtml(task.title)}</h4>
          ${snoozeLabel ? `<div class="tc-snooze-label">⏰ ${snoozeLabel}</div>` : ""}
        </div>
        ${showProgress ? `
          <div class="tc-progress-wrap">
            <div class="tc-progress-bar">
              <div class="tc-progress-fill" style="width:${pct}%"></div>
            </div>
            <span class="tc-progress-label">${doneSteps}/${totalSteps}</span>
          </div>
        ` : ""}
      </div>
      <div class="task-card-actions">${actions}</div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ================================================================
// TASK ACTIONS — called from Tasks tab
// ================================================================

/**
 * Resume (or start) a task from the Tasks tab — opens the task screen.
 * @param {string} id
 */
function resumeTaskById(id) {
  const task = getTaskById(id);
  if (!task) return;

  // Transition: pending/snoozed → active
  if (task.state !== "completed") {
    setTaskState(id, "active", { snoozeUntil: null });
  }

  // Close What Next panel if it's open (user chose to resume)
  closeWhatNext();

  // Track which tab launched the task screen
  state.callerScreen = state.currentScreen;

  // Load into memory state
  state.taskId = task.id;
  state.taskTitle = task.title;
  state.steps = task.aiSteps.map(s => ({ ...s }));
  state.focusTime = task.focusTime || 25;
  state.completedCount = task.aiSteps.filter(s => s.done).length;
  state.isCompleted = false;

  // Find the first non-done, non-skipped step
  const firstPending = state.steps.findIndex(s => !s.done && !s.skipped);
  state.activeIndex = firstPending !== -1 ? firstPending : -1;

  renderTaskScreen();
  showScreen("screen-task");
  resetMoodTimer();
  startSessionTimer(); // ← Resume live session clock
}

/**
 * Mark a task as completed directly from the Tasks tab (skips steps).
 * @param {string} id
 */
function completeTaskFromTab(id) {
  setTaskState(id, "completed");
  recordTaskCompletion();
  renderStreak();
  updateTasksBadge();
  renderTasksTab();
}

/**
 * Re-open a completed task (back to pending).
 * @param {string} id
 */
function reopenTask(id) {
  setTaskState(id, "pending");
  updateTasksBadge();
  renderTasksTab();
}

// ================================================================
// SNOOZE MODAL
// ================================================================

/**
 * Open the snooze modal for a specific task.
 * @param {string} id
 */
function openSnoozeModal(id) {
  state.snoozingTaskId = id;
  const modal = document.getElementById("snooze-modal");
  if (modal) modal.style.display = "flex";
}

/**
 * Close the snooze modal (click outside or cancel).
 * @param {Event|undefined} event
 */
function closeSnoozeModal(event) {
  if (event && event.target !== document.getElementById("snooze-modal")) return;
  const modal = document.getElementById("snooze-modal");
  if (modal) modal.style.display = "none";
  state.snoozingTaskId = null;
}

/**
 * Confirm snooze with a duration in milliseconds.
 * @param {number} durationMs
 */
function confirmSnooze(durationMs) {
  const id = state.snoozingTaskId;
  if (!id) return;

  const snoozeUntil = new Date(Date.now() + durationMs).toISOString();
  setTaskState(id, "snoozed", { snoozeUntil });

  const modal = document.getElementById("snooze-modal");
  if (modal) modal.style.display = "none";
  state.snoozingTaskId = null;

  // If we snoozed the currently active task on screen, go back
  if (id === state.taskId && state.currentScreen === "task") {
    clearInterval(state.moodTimer);
    state.moodTimer = null;
    const overlay = document.getElementById("focus-lock-overlay");
    if (overlay) overlay.style.display = "none";
    state.focusLockActive = false;
    showScreen("screen-input");
    return;
  }

  updateTasksBadge();
  if (state.currentScreen === "tasks") renderTasksTab();
}

/**
 * Snooze until tomorrow 08:00.
 */
function confirmSnoozeTomorrow() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  const durationMs = tomorrow.getTime() - Date.now();
  confirmSnooze(durationMs);
}

/**
 * Snooze the currently active task (called from the task screen snooze button).
 */
function snoozeActiveTask() {
  if (!state.taskId) return;
  // Sync current progress before snoozing
  syncTaskSteps(state.taskId, state.steps, state.completedCount);
  openSnoozeModal(state.taskId);
}

// ================================================================
// PLAN TASK (entry point from Home)
// ================================================================
async function planTask() {
  closeTaskInput();
  if (isGenerating) return;

  const input = document.getElementById("task-input");
  const raw = input.value.trim();

  if (!raw) {
    // Re-open modal to get task text
    openTaskInput();
    if (input) {
      input.style.borderColor = "#f25f5c";
      input.focus();
      setTimeout(() => { input.style.borderColor = ""; }, 1200);
    }
    return;
  }

  isGenerating = true;
  // Disable both possible plan buttons
  ["btn-plan", "btn-next-step"].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = true;
  });


  state.taskTitle = raw;
  state.taskId = null; // will be set after task creation
  state.steps = [{ label: "\u2728 Generating your steps with AI...", done: false, skipped: false }];
  state.activeIndex = 0;
  state.completedCount = 0;
  state.isCompleted = false;
  state.callerScreen = "home"; // launched from home

  renderTaskScreen();
  showScreen("screen-task");
  resetMoodTimer();
  startSessionTimer(); // ← Start live session clock

  const aiSteps = await generateSteps(raw);
  const expertInsight = aiSteps._insight || null;

  // Store per-step metadata (duration, difficulty, reason) alongside label
  const stepMeta = aiSteps._meta || [];
  state.steps = aiSteps.map((label, i) => ({
    label,
    done: false,
    skipped: false,
    duration:   stepMeta[i]?.duration   || "",
    difficulty: stepMeta[i]?.difficulty || "",
    reason:     stepMeta[i]?.reason     || "",
  }));
  state.activeIndex = 0;
  state.completedCount = 0;

  // Create task in the store as 'active'
  const task = createTask(raw, aiSteps, state.focusTime,
    state.scheduleSet ? state.scheduleDate : null);
  const tasks = loadTasks();
  tasks.push(task);
  saveTasks(tasks);
  state.taskId = task.id;

  renderTaskScreen();
  updateTasksBadge();

  // Show the domain-specific expert tip in the mood banner briefly
  if (expertInsight && state.currentScreen === "task") {
    const banner  = document.getElementById("mood-banner");
    const emojiEl = document.getElementById("mood-emoji");
    const textEl  = document.getElementById("mood-text");
    if (banner && emojiEl && textEl) {
      banner.className = "mood-banner mood-good";
      emojiEl.textContent = "💡";
      textEl.textContent  = expertInsight;
      // After 4.5s, transition to the normal activity-based mood
      setTimeout(() => {
        if (state.currentScreen === "task" && !state.isCompleted) resetMoodTimer();
      }, 4500);
    }
  }

  isGenerating = false;
  ["btn-plan", "btn-next-step"].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = false;
  });
}


// ================================================================
// RENDER TASK SCREEN
// ================================================================
function renderTaskScreen() {
  document.getElementById("task-title-display").textContent = state.taskTitle;
  document.getElementById("completion-card").classList.remove("visible");

  // ── Render plan-meta pill (persona + estimated time) ──────────
  const pm = state.planMeta;
  let metaPill = document.getElementById("plan-meta-pill");
  if (pm && pm.expertPersona) {
    if (!metaPill) {
      metaPill = document.createElement("div");
      metaPill.id = "plan-meta-pill";
      metaPill.className = "plan-meta-pill";
      const header = document.querySelector(".task-header");
      if (header) header.insertAdjacentElement("afterend", metaPill);
    }
    const difficultyIcon = { Easy: "🟢", Medium: "🟡", Hard: "🔴" };
    metaPill.innerHTML = `
      <span class="pmp-persona">🧠 ${escapeHtml(pm.expertPersona)}</span>
      <span class="pmp-divider">·</span>
      <span class="pmp-time">⏱ ~${escapeHtml(pm.estimatedCompletionTime)}</span>
      <span class="pmp-divider">·</span>
      <span class="pmp-complexity">${escapeHtml(pm.complexity)}</span>
    `;
  }

  const list = document.getElementById("step-list");
  list.innerHTML = "";

  // Apply focus-mode class to step list when there is an active step
  const hasFocusMode = state.activeIndex !== -1 && !state.isCompleted;
  list.classList.toggle("focus-mode-active", hasFocusMode);

  // Toggle focus-mode overlay
  const overlay = document.getElementById("focus-mode-overlay");
  if (overlay) overlay.classList.toggle("active", hasFocusMode);

  const diffBadgeCls = { Easy: "step-diff-easy", Medium: "step-diff-med", Hard: "step-diff-hard" };

  state.steps.forEach((step, i) => {
    const li = document.createElement("li");
    let cls = "step-item";
    if (i === state.activeIndex && !step.done && !step.skipped) cls += " active";
    if (step.done) cls += " done";
    if (step.skipped) cls += " skipped";
    li.className = cls;
    li.id = "step-" + i;
    li.setAttribute("data-index", i);
    li.setAttribute("role", "button");
    li.setAttribute("aria-label", step.label);
    li.style.setProperty("--step-i", i);

    // Build metadata badges (duration + difficulty)
    const hasMeta = step.duration || step.difficulty;
    const metaBadges = hasMeta ? `
      <div class="step-meta-row">
        ${step.duration ? `<span class="step-badge step-badge-dur">⏱ ${escapeHtml(step.duration)}</span>` : ""}
        ${step.difficulty ? `<span class="step-badge ${diffBadgeCls[step.difficulty] || ''}">● ${escapeHtml(step.difficulty)}</span>` : ""}
      </div>` : "";

    if (step.skipped) {
      li.innerHTML = `
        <div class="step-checkbox step-skipped-icon">↷</div>
        <div class="step-content">
          <span class="step-label">${escapeHtml(step.label)}</span>
          <button type="button" class="btn-restore" onclick="restoreStep(${i})">Restore</button>
        </div>
      `;
    } else {
      li.innerHTML = `
        <div class="step-checkbox" id="checkbox-${i}">${step.done ? "✔" : ""}</div>
        <div class="step-content">
          <span class="step-label" id="label-${i}">${escapeHtml(step.label)}</span>
          ${metaBadges}
        </div>
      `;
      if (!step.done) {
        li.addEventListener("click", () => handleStepClick(i));
      }
    }

    list.appendChild(li);
  });

  updateActionBox();
  updateProgress();
}

// ================================================================
// HANDLE STEP CLICK (mark done)
// ================================================================
function handleStepClick(index) {
  if (index !== state.activeIndex) return;
  if (state.steps[index].done || state.steps[index].skipped) return;

  // Check if this step was completed over time — show awareness message
  const stepElapsed = state.stepStartTime ? Math.floor((Date.now() - state.stepStartTime) / 1000) : 0;
  const focusSecs   = state.focusTime * 60;
  const wasOverTime  = focusSecs > 0 && stepElapsed > focusSecs;

  state.steps[index].done = true;
  state.completedCount++;

  recordDailyProgress();

  const li = document.getElementById("step-" + index);
  const checkbox = document.getElementById("checkbox-" + index);

  if (li) {
    li.classList.remove("active");
    li.classList.add("done", "just-completed");
    setTimeout(() => li && li.classList.remove("just-completed"), 700);
  }
  if (checkbox) {
    checkbox.textContent = "✔";
    checkbox.classList.remove("bounce");
    void checkbox.offsetWidth;
    checkbox.classList.add("bounce");
    setTimeout(() => checkbox.classList.remove("bounce"), 500);
  }

  // Sync progress to the task store
  if (state.taskId) syncTaskSteps(state.taskId, state.steps, state.completedCount);

  // Clear overtime nudge — step done
  clearOvertimeNudge();

  // Reset step timer for the next step
  resetStepTimer();

  // Notify assistant of step completion
  if (wasOverTime) {
    // Show awareness message in the mood banner briefly
    const banner  = document.getElementById("mood-banner");
    const emojiEl = document.getElementById("mood-emoji");
    const textEl  = document.getElementById("mood-text");
    if (banner) {
      banner.className = "mood-banner mood-warn";
      if (emojiEl) emojiEl.textContent = "🙌";
      if (textEl)  textEl.textContent  = "Took longer than planned. Still good you finished.";
      setTimeout(() => resetMoodTimer(), 2500);
    }
  } else {
    showCheckboxFeedback();
  }

  advanceActive();
  updateProgress();
  updateActionBox();
}

// ================================================================
// SKIP STEP
// ================================================================
function nextStep() {
  if (state.activeIndex === -1) return;

  state.steps[state.activeIndex].skipped = true;

  const li = document.getElementById("step-" + state.activeIndex);
  if (li) {
    const idx = state.activeIndex;
    li.className = "step-item skipped";
    li.innerHTML = `
      <div class="step-checkbox step-skipped-icon">↷</div>
      <span class="step-label">${escapeHtml(state.steps[idx].label)}</span>
      <button type="button" class="btn-restore" onclick="restoreStep(${idx})">Restore</button>
    `;
  }

  // Clear overtime nudge when skipping
  clearOvertimeNudge();

  const next = findNextPending(state.activeIndex + 1);

  if (next !== -1) {
    const prevLi = document.getElementById("step-" + state.activeIndex);
    if (prevLi) prevLi.classList.remove("active");
    state.activeIndex = next;
    const nextLi = document.getElementById("step-" + next);
    if (nextLi) {
      nextLi.classList.add("active", "step-entering");
      setTimeout(() => nextLi && nextLi.classList.remove("step-entering"), 550);
    }
    // Reset step timer on skip → next
    resetStepTimer();
  } else {
    const hasSkipped = state.steps.some(s => s.skipped && !s.done);
    if (hasSkipped) {
      state.activeIndex = -1;
      updateActionBox();
      showSkippedPrompt();
    } else {
      state.activeIndex = -1;
      checkCompletion();
    }
  }

  if (state.taskId) syncTaskSteps(state.taskId, state.steps, state.completedCount);
  updateActionBox();
  resetMoodTimer();
}

function findNextPending(startFrom) {
  for (let i = startFrom; i < state.steps.length; i++) {
    if (!state.steps[i].done && !state.steps[i].skipped) return i;
  }
  return -1;
}

// ================================================================
// RESTORE A SKIPPED STEP
// ================================================================
function restoreStep(index) {
  state.steps[index].skipped = false;

  const li = document.getElementById("step-" + index);
  if (li) {
    li.className = "step-item active";
    li.innerHTML = `
      <div class="step-checkbox" id="checkbox-${index}"></div>
      <span class="step-label" id="label-${index}">${escapeHtml(state.steps[index].label)}</span>
    `;
    li.addEventListener("click", () => handleStepClick(index));
  }

  if (state.activeIndex !== -1) {
    const oldLi = document.getElementById("step-" + state.activeIndex);
    if (oldLi) oldLi.classList.remove("active");
  }
  state.activeIndex = index;

  const prompt = document.getElementById("skipped-prompt");
  if (prompt) prompt.remove();

  if (state.taskId) syncTaskSteps(state.taskId, state.steps, state.completedCount);
  updateActionBox();
  updateProgress();
  resetStepTimer();  // Step timer resets for the restored step
  resetMoodTimer();
}

function showSkippedPrompt() {
  const existing = document.getElementById("skipped-prompt");
  if (existing) existing.remove();

  const stepsSection = document.querySelector(".steps-section");
  if (!stepsSection) return;

  const div = document.createElement("div");
  div.id = "skipped-prompt";
  div.className = "skipped-prompt";
  div.innerHTML = `
    <span class="sp-icon">↷</span>
    <span>You have skipped steps — restore them to finish.</span>
  `;
  stepsSection.insertBefore(div, stepsSection.firstChild);
}

// ================================================================
// ADVANCE ACTIVE to next pending step
// ================================================================
function advanceActive() {
  const next = findNextPending(state.activeIndex + 1);

  if (next !== -1) {
    state.activeIndex = next;
    const nextLi = document.getElementById("step-" + next);
    if (nextLi) {
      nextLi.classList.add("active", "step-entering");
      // Scroll the new active step into view smoothly
      setTimeout(() => {
        nextLi.scrollIntoView({ behavior: "smooth", block: "nearest" });
        nextLi.classList.remove("step-entering");
      }, 550);
    }
    // Reset the step timer for the new active step
    resetStepTimer();
  } else {
    const hasSkipped = state.steps.some(s => s.skipped && !s.done);
    if (hasSkipped) {
      state.activeIndex = -1;
      showSkippedPrompt();
    } else {
      state.activeIndex = -1;
      checkCompletion();
    }
  }
}

// ================================================================
// COMPLETION CHECK
// ================================================================
function checkCompletion() {
  // A task is complete only when every step is marked done.
  // Skipped steps (s.skipped=true, s.done=false) block completion.
  const allDone = state.steps.every(s => s.done);
  if (allDone) showCompletion();
}

// ================================================================
// UPDATE ACTION BOX
// ================================================================
function updateActionBox() {
  const actionBox = document.getElementById("action-box");
  const actionText = document.getElementById("action-step-text");
  const actionLabel = document.getElementById("action-step-label");
  const btnNext = document.getElementById("btn-next");
  const btnDone = document.getElementById("btn-mark-done");
  const focusEl = document.getElementById("focus-timer-text");
  const btnSnooze = document.getElementById("btn-task-snooze");
  const dualTimer = document.getElementById("dual-timer");

  if (state.activeIndex === -1) {
    if (actionBox) actionBox.style.display = "none";
    if (btnDone) btnDone.disabled = true;
    if (btnSnooze) btnSnooze.style.display = "none";
    // Disable focus-mode visuals
    const list = document.getElementById("step-list");
    if (list) list.classList.remove("focus-mode-active");
    const fmOverlay = document.getElementById("focus-mode-overlay");
    if (fmOverlay) fmOverlay.classList.remove("active");
    return;
  }

  if (actionBox) actionBox.style.display = "block";
  if (dualTimer) dualTimer.style.display = "flex";
  if (btnSnooze) btnSnooze.style.display = "inline-flex";
  if (actionText) actionText.textContent = state.steps[state.activeIndex]?.label || "—";
  if (focusEl) focusEl.textContent = state.focusTime + " min";
  if (btnDone) btnDone.disabled = false;

  // Show "Step X of N" in the action label
  if (actionLabel) {
    actionLabel.textContent = `Step ${state.activeIndex + 1} of ${state.steps.length}`;
  }

  // Show "why this step matters" reason from planMeta
  const currentStep = state.steps[state.activeIndex];
  let reasonEl = document.getElementById("action-step-reason");
  if (currentStep?.reason) {
    if (!reasonEl) {
      reasonEl = document.createElement("div");
      reasonEl.id = "action-step-reason";
      reasonEl.className = "action-step-reason";
      if (actionText) actionText.insertAdjacentElement("afterend", reasonEl);
    }
    reasonEl.textContent = "💡 " + currentStep.reason;
    reasonEl.style.display = "";
  } else if (reasonEl) {
    reasonEl.style.display = "none";
  }

  // Apply focus-mode highlighting to the step list
  const list = document.getElementById("step-list");
  if (list) list.classList.add("focus-mode-active");
  const fmOverlay = document.getElementById("focus-mode-overlay");
  if (fmOverlay && !state.isCompleted) fmOverlay.classList.add("active");

  const pendingAfter = findNextPending(state.activeIndex + 1);
  const hasOtherSkipped = state.steps.some((s, i) => i !== state.activeIndex && s.skipped);
  if (btnNext) btnNext.disabled = (pendingAfter === -1 && !hasOtherSkipped);

  // Re-trigger entrance animation on step change
  if (actionBox) {
    actionBox.classList.remove("step-changed");
    void actionBox.offsetWidth;
    actionBox.classList.add("step-changed");
  }
}

// ================================================================
// UPDATE PROGRESS BAR
// ================================================================
function updateProgress() {
  const total = state.steps.length;
  const done = state.steps.filter(s => s.done).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const fill = document.getElementById("progress-fill");
  const label = document.getElementById("progress-label");
  if (fill) fill.style.width = pct + "%";
  if (label) label.textContent = `${done} / ${total} done`;
}

// ================================================================
// SHOW COMPLETION STATE — with full-screen celebration
// ================================================================
function showCompletion() {
  if (!state.steps.every(s => s.done)) return;

  state.isCompleted = true;
  clearInterval(state.moodTimer);
  clearInterval(state.sessionTimerInterval);
  clearInterval(state.stepTimerInterval);
  clearInterval(state.taskTimerInterval);
  state.moodTimer = null;
  state.sessionTimerInterval = null;
  state.stepTimerInterval = null;
  state.taskTimerInterval = null;

  // Clear overtime nudge — task is done
  clearOvertimeNudge();

  // Disable focus mode overlay on completion
  const focusModeOverlay = document.getElementById("focus-mode-overlay");
  if (focusModeOverlay) focusModeOverlay.classList.remove("active");
  const stepList = document.getElementById("step-list");
  if (stepList) stepList.classList.remove("focus-mode-active");

  // Check if task was completed over the total focus budget
  const totalFocusSecs = state.focusTime * 60 * state.steps.length;
  const totalElapsed = state.taskStartTime
    ? Math.floor((Date.now() - state.taskStartTime) / 1000)
    : 0;
  const taskWasOverTime = totalFocusSecs > 0 && totalElapsed > totalFocusSecs;

  // Mark task as completed in the store
  if (state.taskId) {
    syncTaskSteps(state.taskId, state.steps, state.completedCount);
    setTaskState(state.taskId, "completed");
  }

  recordTaskCompletion();
  renderStreak();
  updateTasksBadge();

  document.getElementById("skipped-prompt")?.remove();

  // Dismiss any overlays
  const focusOverlay = document.getElementById("focus-lock-overlay");
  if (focusOverlay) focusOverlay.style.display = "none";
  const leaveOverlay = document.getElementById("leave-task-overlay");
  if (leaveOverlay) leaveOverlay.style.display = "none";
  state.focusLockActive = false;

  // Lock mood to positive — no timer can override this
  updateHomeMood("mood-good");

  // Build the completion reflection with actual elapsed time
  const sessionSecs = state.taskStartTime
    ? Math.floor((Date.now() - state.taskStartTime) / 1000)
    : totalElapsed;
  const sessionMins = Math.round(sessionSecs / 60);
  const elapsedLabel = sessionMins >= 60
    ? `${Math.floor(sessionMins / 60)}h ${sessionMins % 60}m`
    : `${sessionMins} min`;

  const rawReflection = state.planMeta?.completionReflection || "";
  const reflectionText = rawReflection
    ? rawReflection.replace("[TIME]", elapsedLabel)
    : (taskWasOverTime
        ? "Took longer than planned. Still good you finished."
        : "You did it. Every step, done.");

  const banner = document.getElementById("mood-banner");
  const emojiEl = document.getElementById("mood-emoji");
  const textEl = document.getElementById("mood-text");
  if (banner) banner.className = "mood-banner mood-good";
  if (emojiEl) emojiEl.textContent = "✦";
  if (textEl) textEl.textContent = reflectionText;

  // Notify assistant — task is done!

  // === Full-screen celebration overlay ===
  const cel = document.getElementById("celebration-overlay");
  if (cel) {
    cel.style.display = "flex";
    // Force reflow so class applies with animation
    void cel.offsetWidth;
    cel.classList.add("visible");
    cel.classList.remove("fading");

    // After 1.8s — fade out celebration, then show What Next
    setTimeout(() => {
      cel.classList.add("fading");
      cel.classList.remove("visible");
      setTimeout(() => {
        cel.style.display = "none";
        cel.classList.remove("fading");
        // Show inline completion card + What Next panel
        const actionBox = document.getElementById("action-box");
        const completion = document.getElementById("completion-card");
        if (actionBox) actionBox.style.display = "none";
        if (completion) completion.classList.add("visible");
        showWhatNext();
      }, 700);
    }, 1800);
  } else {
    // Fallback if overlay element missing
    const actionBox = document.getElementById("action-box");
    const completion = document.getElementById("completion-card");
    if (actionBox) actionBox.style.display = "none";
    if (completion) completion.classList.add("visible");
    showWhatNext();
  }
}

// ================================================================
// WHAT NEXT PANEL
// ================================================================

/**
 * Build and show the "What next?" bottom-sheet panel.
 * Detects available tasks so it can offer a resume option.
 */
function showWhatNext() {
  const panel = document.getElementById("what-next-overlay");
  const actionsEl = document.getElementById("wnp-actions");
  if (!panel || !actionsEl) return;

  // Find the most recent unfinished (pending / active / snoozed) task
  const tasks = loadTasks();
  const resumable = tasks.find(t =>
    (t.state === "pending" || t.state === "active" || t.state === "snoozed") &&
    t.id !== state.taskId
  );

  let resumeBtn = "";
  if (resumable) {
    const resumeLabel = resumable.state === "snoozed"
      ? "Resume snoozed task"
      : "Continue where you left off";
    const resumeSub = truncateText(resumable.title, 52);
    resumeBtn = `
      <button class="wnp-btn wnp-btn-resume" type="button"
        onclick="closeWhatNext(); resumeTaskById('${resumable.id}')">
        <span class="wnp-btn-icon">↺</span>
        <span class="wnp-btn-body">
          <div class="wnp-btn-title">${resumeLabel}</div>
          <div class="wnp-btn-sub">${escapeHtml(resumeSub)}</div>
        </span>
      </button>`;
  }

  actionsEl.innerHTML = `
    <button class="wnp-btn wnp-btn-primary" type="button"
      onclick="closeWhatNext(); resetApp()">
      <span class="wnp-btn-icon">⚡</span>
      <span class="wnp-btn-body">
        <div class="wnp-btn-title">Start a new task</div>
        <div class="wnp-btn-sub">Keep the momentum going</div>
      </span>
    </button>
    ${resumeBtn}
    <button class="wnp-btn" type="button"
      onclick="closeWhatNext(); goToStats()">
      <span class="wnp-btn-icon">📊</span>
      <span class="wnp-btn-body">
        <div class="wnp-btn-title">View my stats</div>
        <div class="wnp-btn-sub">See your streak and progress</div>
      </span>
    </button>
    <button class="wnp-btn" type="button"
      onclick="closeWhatNext()">
      <span class="wnp-btn-icon">☕</span>
      <span class="wnp-btn-body">
        <div class="wnp-btn-title">Take a short break</div>
        <div class="wnp-btn-sub">You earned it — rest and return</div>
      </span>
    </button>
  `;

  panel.style.display = "flex";
}

/**
 * Close the "What next?" panel.
 */
function closeWhatNext() {
  const panel = document.getElementById("what-next-overlay");
  if (panel) panel.style.display = "none";
}

/**
 * Click on the backdrop (not the panel itself) closes the panel.
 */
function handleWhatNextOverlayClick(event) {
  if (event.target === document.getElementById("what-next-overlay")) {
    closeWhatNext();
  }
}

/**
 * Truncate text with ellipsis for display.
 */
function truncateText(str, maxLen) {
  if (!str) return "";
  return str.length > maxLen ? str.slice(0, maxLen) + "\u2026" : str;
}

// ================================================================
// RE-ENGAGE NUDGES
// ================================================================
const RE_ENGAGE_NUDGES = [
  { emoji: "🔥", text: "You're in motion. Keep it going.", cls: "mood-good" },
  { emoji: "⚡", text: "Don't break the streak. Add one more.", cls: "mood-good" },
  { emoji: "🚀", text: "Momentum is rare. Use it.", cls: "mood-good" },
  { emoji: "💪", text: "One more task. You're on a roll.", cls: "mood-good" },
];

// ================================================================
// DUAL TIMER SYSTEM
// ================================================================

/**
 * Format seconds as M:SS
 */
function formatTime(totalSecs) {
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Start the TASK timer (macro — runs for the whole session, does not reset).
 */
function startTaskTimer() {
  clearInterval(state.taskTimerInterval);
  if (!state.taskStartTime) state.taskStartTime = Date.now();

  state.taskTimerInterval = setInterval(() => {
    if (state.isCompleted || state.currentScreen !== "task") return;
    const elapsed = Math.floor((Date.now() - state.taskStartTime) / 1000);
    const el = document.getElementById("task-timer-display");
    if (el) el.textContent = formatTime(elapsed);
  }, 1000);
}

/**
 * Reset and start the STEP timer (micro — resets every time a new step becomes active).
 */
function resetStepTimer() {
  clearInterval(state.stepTimerInterval);
  state.stepStartTime = Date.now();
  state.overtimeNudgeShown = 0;
  clearOvertimeNudge();

  // Update display immediately
  const stepEl = document.getElementById("step-timer-display");
  if (stepEl) {
    stepEl.textContent = "0:00";
    stepEl.classList.remove("timer-warn", "timer-bad");
  }

  state.stepTimerInterval = setInterval(() => {
    if (state.isCompleted || state.currentScreen !== "task") return;
    const elapsed = Math.floor((Date.now() - state.stepStartTime) / 1000);
    const focusSecs = state.focusTime * 60;
    const el = document.getElementById("step-timer-display");
    if (el) {
      el.textContent = formatTime(elapsed);
      // Color coding: normal → warn (100%) → bad (150%)
      if (focusSecs > 0 && elapsed >= focusSecs * 1.5) {
        el.className = "timer-value timer-bad";
      } else if (focusSecs > 0 && elapsed >= focusSecs) {
        el.className = "timer-value timer-warn";
      } else {
        el.className = "timer-value";
      }
    }
    // Check if we should show an overtime nudge
    checkOvertimeNudge(elapsed);
  }, 1000);
}

/**
 * Start the live session timer (kept for backward compat — no-op; dual timer takes over).
 */
function startSessionTimer() {
  // Start both dual timers
  state.taskStartTime = Date.now();
  startTaskTimer();
  resetStepTimer();
  // Also keep the old sessionStartTime for any external references
  state.sessionStartTime = state.taskStartTime;
}

/**
 * Stop all timers and reset displays.
 */
function stopSessionTimer() {
  clearInterval(state.sessionTimerInterval);
  clearInterval(state.stepTimerInterval);
  clearInterval(state.taskTimerInterval);
  state.sessionTimerInterval = null;
  state.stepTimerInterval = null;
  state.taskTimerInterval = null;
  state.sessionStartTime = null;
  state.stepStartTime = null;
  state.taskStartTime = null;
  state.overtimeNudgeShown = 0;

  const stepEl = document.getElementById("step-timer-display");
  if (stepEl) { stepEl.textContent = "0:00"; stepEl.className = "timer-value"; }
  const taskEl = document.getElementById("task-timer-display");
  if (taskEl) taskEl.textContent = "0:00";
  clearOvertimeNudge();
}

// ================================================================
// RESET APP (Start a new task)
// ================================================================
function resetApp() {
  const wasCompleted = state.isCompleted;

  clearInterval(state.moodTimer);
  stopSessionTimer();
  state.moodTimer = null;
  state.isCompleted = false;
  state.completedCount = 0;
  state._reEngageNudge = null;
  state.steps = [];
  state.activeIndex = 0;
  state.taskId = null;

  // Remove focus mode overlay
  const fmOverlay = document.getElementById("focus-mode-overlay");
  if (fmOverlay) fmOverlay.classList.remove("active");
  clearOvertimeNudge();

  // Dismiss all overlays
  const overlay = document.getElementById("focus-lock-overlay");
  if (overlay) overlay.style.display = "none";
  closeWhatNext();
  state.focusLockActive = false;

  const input = document.getElementById("task-input");
  if (input) {
    input.value = "";
    input.placeholder = wasCompleted
      ? "What's next on your list?"
      : "e.g. Complete my science project due tomorrow...";
  }
  const charCount = document.getElementById("char-count");
  if (charCount) charCount.textContent = "0";

  if (wasCompleted) {
    state._reEngageNudge = RE_ENGAGE_NUDGES[Math.floor(Math.random() * RE_ENGAGE_NUDGES.length)];
  }

  showScreen("screen-input");
}

// ================================================================
// CHARACTER COUNTER
// ================================================================
document.getElementById("task-input").addEventListener("input", function () {
  document.getElementById("char-count").textContent = this.value.length;
});

document.getElementById("task-input").addEventListener("keydown", function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") planTask();
});

// ================================================================
// INIT
// ================================================================
document.addEventListener("DOMContentLoaded", function () {
  loadSchedule();
  createParticles();
  renderStreak();
  initCursorCluster();

  // Single atomic Home render — snooze check runs before any UI paints
  initHomeAssistant();

  document.body.classList.add("screen-home");
  startCursorCluster();
  updateTopNav();
  updateDashStreak();

  // Periodic snooze check
  setInterval(() => {
    checkSnoozedTasks();
    if (state.currentScreen === "home") syncHomeUI({ thinking: false });
    else updateTasksBadge();
  }, 60 * 1000);
});

// ================================================================
// CURSOR DOT CLUSTER — Home only
// ================================================================

const CURSOR_DOTS = 6;   // lightweight — only 6 dots
const DOT_SIZES  = [6, 5, 4, 4, 3, 3];
const DOT_OPACITIES = [0.22, 0.16, 0.12, 0.10, 0.08, 0.06];
// Each dot lags behind the cursor by a different amount
const DOT_LAGS   = [0.18, 0.26, 0.34, 0.44, 0.55, 0.68];

let _dotPositions = [];   // [{x, y}] — current smoothed position of each dot
let _cursorRawX   = -200; // last known cursor X
let _cursorRawY   = -200; // last known cursor Y
let _clusterRAF   = null; // requestAnimationFrame id
let _clusterActive = false;

function initCursorCluster() {
  const container = document.getElementById("cursor-cluster");
  if (!container) return;

  // Build the dots
  container.innerHTML = "";
  for (let i = 0; i < CURSOR_DOTS; i++) {
    const d = document.createElement("div");
    d.className = "cursor-dot";
    const size = DOT_SIZES[i];
    d.style.cssText = [
      `width:${size}px`,
      `height:${size}px`,
      `opacity:${DOT_OPACITIES[i]}`,
      `margin-left:-${size / 2}px`,
      `margin-top:-${size / 2}px`,
    ].join(";");
    container.appendChild(d);
    _dotPositions.push({ x: -200, y: -200 });
  }

  // Track mouse — only fires on home screen
  document.addEventListener("mousemove", (e) => {
    if (state.currentScreen !== "home") return;
    _cursorRawX = e.clientX;
    _cursorRawY = e.clientY;
  });

  // Touch support
  document.addEventListener("touchmove", (e) => {
    if (state.currentScreen !== "home") return;
    const t = e.touches[0];
    if (!t) return;
    _cursorRawX = t.clientX;
    _cursorRawY = t.clientY;
  }, { passive: true });
}

function startCursorCluster() {
  if (_clusterActive) return;
  _clusterActive = true;
  document.getElementById("cursor-cluster")?.classList.add("visible");
  _animateCursorCluster();
}

function stopCursorCluster() {
  _clusterActive = false;
  document.getElementById("cursor-cluster")?.classList.remove("visible");
  if (_clusterRAF) {
    cancelAnimationFrame(_clusterRAF);
    _clusterRAF = null;
  }
}

function _animateCursorCluster() {
  if (!_clusterActive) return;

  const container = document.getElementById("cursor-cluster");
  const dots = container ? container.querySelectorAll(".cursor-dot") : [];

  for (let i = 0; i < dots.length; i++) {
    const lag = DOT_LAGS[i];
    // Lerp each dot toward the cursor (or toward the dot in front of it)
    const targetX = i === 0 ? _cursorRawX : _dotPositions[i - 1].x;
    const targetY = i === 0 ? _cursorRawY : _dotPositions[i - 1].y;

    _dotPositions[i].x += (targetX - _dotPositions[i].x) * (1 - lag);
    _dotPositions[i].y += (targetY - _dotPositions[i].y) * (1 - lag);

    dots[i].style.transform = `translate(${_dotPositions[i].x}px, ${_dotPositions[i].y}px)`;
  }

  _clusterRAF = requestAnimationFrame(_animateCursorCluster);
}


// ================================================================
// TASK INPUT MODAL  open / close / backdrop click
// ================================================================
function openTaskInput() {
  const modal = document.getElementById("task-input-modal");
  if (!modal) return;
  // Always start at step 1
  showTaskStep();
  modal.style.display = "flex";
  const card = document.getElementById("tim-card");
  if (card) { card.style.animation = "none"; void card.offsetWidth; card.style.animation = ""; }
  setTimeout(() => { const input = document.getElementById("task-input"); if (input) input.focus(); }, 80);
}

function showTaskStep() {
  const s1 = document.getElementById("tim-step-1");
  const s2 = document.getElementById("tim-step-2");
  if (s1) s1.style.display = "block";
  if (s2) s2.style.display = "none";
}

function showScheduleStep() {
  const input = document.getElementById("task-input");
  const raw = input ? input.value.trim() : "";
  if (!raw) {
    if (input) {
      input.style.borderColor = "#f25f5c";
      input.focus();
      setTimeout(() => { input.style.borderColor = ""; }, 1200);
    }
    return;
  }

  const s1 = document.getElementById("tim-step-1");
  const s2 = document.getElementById("tim-step-2");
  if (s1) s1.style.display = "none";
  if (s2) s2.style.display = "block";

  // Populate date with today
  const dateEl = document.getElementById("sched-date");
  if (dateEl) {
    dateEl.value = getTodayDateString();
    dateEl.min   = getTodayDateString();
  }

  // Render duration chips into modal
  const DURATIONS = [2, 5, 10, 15, 25, 45, 60];
  const chipsCont = document.getElementById("tim-dur-chips");
  if (chipsCont) {
    chipsCont.innerHTML = DURATIONS.map(d => {
      const label = d >= 60 ? `${d / 60}h` : `${d}m`;
      const isActive = d === state.focusTime;
      return `<button type="button" class="dur-chip${isActive ? ' active' : ''}" data-dur="${d}" onclick="selectModalDurChip(${d})">${label}</button>`;
    }).join("");
  }

  // Clear custom field
  const customEl = document.getElementById("sched-custom-dur");
  if (customEl) customEl.value = "";
}

function selectModalDurChip(minutes) {
  state.focusTime = minutes;
  document.querySelectorAll("#tim-dur-chips .dur-chip").forEach(btn => {
    btn.classList.toggle("active", parseInt(btn.dataset.dur, 10) === minutes);
  });
  const custom = document.getElementById("sched-custom-dur");
  if (custom) custom.value = "";
}

function saveScheduleAndPlan() {
  const dateEl   = document.getElementById("sched-date");
  const timeEl   = document.getElementById("sched-time");
  const customEl = document.getElementById("sched-custom-dur");

  const date = dateEl?.value || getTodayDateString();
  const time = timeEl?.value || "09:00";
  let dur = state.focusTime;
  if (customEl?.value && parseInt(customEl.value, 10) > 0) {
    dur = parseInt(customEl.value, 10);
  }

  state.scheduleDate     = date;
  state.scheduleStart    = time;
  state.scheduleDuration = dur;
  state.focusTime        = dur;
  state.scheduleSet      = true;

  localStorage.setItem("nudge_schedDate",  date);
  localStorage.setItem("nudge_schedStart", time);
  localStorage.setItem("nudge_schedDur",   dur);

  planTask();
}

function closeTaskInput() {
  const modal = document.getElementById("task-input-modal");
  if (modal) modal.style.display = "none";
}

function handleTaskModalClick(event) {
  if (event.target === document.getElementById("task-input-modal")) closeTaskInput();
}

// ================================================================
// TOP NAV  sync active tab + mood indicator
// ================================================================
function updateTopNav() {
  const nav = document.getElementById("top-nav");
  if (!nav) return;
  nav.style.display = state.currentScreen === "task" ? "none" : "";
  ["home","tasks","calendar","stats"].forEach(tab => {
    const tnBtn = document.getElementById("tn-" + tab);
    if (tnBtn) tnBtn.classList.toggle("tn-active", state.currentScreen === tab);
    const tabBtn = document.getElementById("tab-" + tab);
    if (tabBtn) tabBtn.classList.toggle("tab-active", state.currentScreen === tab);
  });
  const moodVal = document.getElementById("tn-mood-val");
  if (moodVal) {
    if (document.body.classList.contains("mood-bad")) { moodVal.textContent = "Stressed"; moodVal.className = "tn-mood-val bad"; }
    else if (document.body.classList.contains("mood-warn")) { moodVal.textContent = "Okay"; moodVal.className = "tn-mood-val warn"; }
    else { moodVal.textContent = "Good"; moodVal.className = "tn-mood-val"; }
  }
}

// ================================================================
// DASHBOARD STREAK CARD
// ================================================================
function updateDashStreak() {
  const streak = getActiveStreak();
  const data   = getProgressData();
  const today  = getTodayKey();
  const titleEl = document.getElementById("ds-title");
  if (titleEl) titleEl.textContent = streak > 0 ? streak + " Day Streak" : "Start your streak";
  const weekEl = document.getElementById("ds-week");
  if (!weekEl) return;
  const DAY_LABELS = ["M","T","W","T","F","S","S"];
  let html = "";
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key    = d.toISOString().slice(0, 10);
    const dayIdx = d.getDay() === 0 ? 6 : d.getDay() - 1;
    const entry  = (data.history || []).find(h => h.date === key);
    const done   = entry && entry.count > 0;
    const isToday= key === today;
    html += `<div class="ds-day"><div class="ds-day-label">${DAY_LABELS[dayIdx]}</div><div class="ds-dot${done?" done":""}${isToday?" today":""}">${done?"&#10003;":""}</div></div>`;
  }
  weekEl.innerHTML = html;
}

// ================================================================
// TODAY'S PLAN CARD
// ================================================================
// ================================================================
// DOMAIN ICON HELPER — colored icon cells for Today's Plan
// ================================================================
function getDomainIconHtml(title) {
  const domain = detectTaskType(title || "");
  const ICONS = {
    coding:     { g: "</>",  bg: "rgba(124,110,245,0.18)", bd: "rgba(124,110,245,0.3)",  c: "#9d92f8" },
    assignment: { g: "\u2713",  bg: "rgba(245,166,35,0.14)",  bd: "rgba(245,166,35,0.28)",  c: "#f5c659" },
    exam:       { g: "\u25ce",  bg: "rgba(91,138,245,0.14)",  bd: "rgba(91,138,245,0.28)",  c: "#7bb8f5" },
    learning:   { g: "\u25ce",  bg: "rgba(157,146,248,0.15)", bd: "rgba(157,146,248,0.3)",  c: "#c4bcff" },
    fitness:    { g: "\u2665",  bg: "rgba(242,95,92,0.14)",   bd: "rgba(242,95,92,0.28)",   c: "#f47f7d" },
    packing:    { g: "\u25a3",  bg: "rgba(91,138,245,0.14)",  bd: "rgba(91,138,245,0.28)",  c: "#7bb8f5" },
    travel:     { g: "\u2708",  bg: "rgba(62,207,142,0.12)",  bd: "rgba(62,207,142,0.25)",  c: "#5ddba5" },
    writing:    { g: "\u270d",  bg: "rgba(62,207,142,0.12)",  bd: "rgba(62,207,142,0.25)",  c: "#5ddba5" },
    design:     { g: "\u2736",  bg: "rgba(245,120,35,0.14)",  bd: "rgba(245,120,35,0.28)",  c: "#f59a50" },
    video:      { g: "\u25b6",  bg: "rgba(242,95,92,0.12)",   bd: "rgba(242,95,92,0.25)",   c: "#f47f7d" },
    math:       { g: "\u03a3",  bg: "rgba(157,146,248,0.15)", bd: "rgba(157,146,248,0.3)",  c: "#c4bcff" },
    research:   { g: "\u25d0",  bg: "rgba(62,207,142,0.12)",  bd: "rgba(62,207,142,0.25)",  c: "#5ddba5" },
    interview:  { g: "\u25c8",  bg: "rgba(245,166,35,0.14)",  bd: "rgba(245,166,35,0.28)",  c: "#f5c659" },
    business:   { g: "\u25c6",  bg: "rgba(124,110,245,0.15)", bd: "rgba(124,110,245,0.28)", c: "#9d92f8" },
    meeting:    { g: "\u25c8",  bg: "rgba(245,166,35,0.14)",  bd: "rgba(245,166,35,0.28)",  c: "#f5c659" },
    email:      { g: "\u2709",  bg: "rgba(62,207,142,0.12)",  bd: "rgba(62,207,142,0.25)",  c: "#5ddba5" },
    finance:    { g: "$",       bg: "rgba(62,207,142,0.12)",  bd: "rgba(62,207,142,0.25)",  c: "#5ddba5" },
    shopping:   { g: "\u25ce",  bg: "rgba(245,120,35,0.14)",  bd: "rgba(245,120,35,0.28)",  c: "#f59a50" },
    cooking:    { g: "\u2668",  bg: "rgba(245,120,35,0.14)",  bd: "rgba(245,120,35,0.28)",  c: "#f59a50" },
    household:  { g: "\u2302",  bg: "rgba(91,138,245,0.14)",  bd: "rgba(91,138,245,0.28)",  c: "#7bb8f5" },
    admin:      { g: "\u25a4",  bg: "rgba(100,100,130,0.2)",  bd: "rgba(100,100,130,0.3)",  c: "#9090b0" },
    language:   { g: "\u3042",  bg: "rgba(62,207,142,0.12)",  bd: "rgba(62,207,142,0.25)",  c: "#5ddba5" },
    reading:    { g: "\u25af",  bg: "rgba(91,138,245,0.14)",  bd: "rgba(91,138,245,0.28)",  c: "#7bb8f5" },
    work:       { g: "\u25a3",  bg: "rgba(124,110,245,0.15)", bd: "rgba(124,110,245,0.28)", c: "#9d92f8" },
    general:    { g: "\u25c6",  bg: "rgba(100,100,130,0.18)", bd: "rgba(100,100,130,0.28)", c: "#9090b0" },
  };
  const cfg = ICONS[domain] || ICONS.general;
  return `<div class="dt-icon" style="background:${cfg.bg};border-color:${cfg.bd};color:${cfg.c};font-size:0.8rem;font-weight:700;letter-spacing:-0.5px">${cfg.g}</div>`;
}

function renderTodayPlan() {
  const container = document.getElementById("today-plan-list");
  if (!container) return;

  // Only show real, actionable tasks — never completed or demo data
  const all = loadTasks();
  const ordered = [
    ...all.filter(t => t.state === "active"),
    ...all.filter(t => t.state === "pending"),
    ...all.filter(t => t.state === "snoozed"),
  ];

  if (!ordered.length) {
    container.innerHTML = '<div class="dt-empty">No tasks yet.<br>Try <strong>⚡ Plan with AI Coach</strong>.</div>';
    return;
  }

  container.innerHTML = ordered.map(task => {
    const isSnz    = task.state === "snoozed";
    const iconHtml = getDomainIconHtml(task.title);
    const mins     = task.focusTime || 25;
    const rawName  = task.title || "";
    const name     = rawName.length > 26 ? rawName.slice(0, 26) + "\u2026" : rawName;
    const safeName = name.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const click    = task.id ? `onclick="resumeTaskById('${task.id}')"` : "";
    const durExtra = isSnz ? " &middot; &#128564;" : "";
    const stateLabel = task.state === "active" ? "In progress" : task.state === "snoozed" ? "Snoozed" : "Pending";
    return `<div class="dt-item" ${click}>${iconHtml}<div class="dt-info"><div class="dt-name">${safeName}</div><div class="dt-dur">${stateLabel} &middot; ${mins} min${durExtra}</div></div><div class="dt-status"></div></div>`;
  }).join("");
}

// ================================================================
// GLOBE � particle sphere on canvas
// ================================================================
(function() {
  function setupGlobe() {
    const canvas = document.getElementById("globe-canvas");
    if (!canvas) return;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      if (r.width > 0) { canvas.width = r.width; canvas.height = r.height; }
    };
    resize();
    window.addEventListener("resize", resize);
    const ctx = canvas.getContext("2d");
    const N = 500;
    const particles = [];
    for (let i = 0; i < N; i++) {
      const theta = Math.random()*Math.PI*2;
      const phi   = Math.acos(2*Math.random()-1);
      const roll  = Math.random();
      const color = roll<0.54 ? {r:124,g:110,b:245} : roll<0.78 ? {r:91,g:138,b:245} : {r:245,g:120,b:35};
      const size  = Math.random()<0.07 ? 2.2+Math.random() : 0.7+Math.random()*1.1;
      particles.push({theta,phi,color,size});
    }
    let rot=0, rafId=null;
    function draw() {
      const W=canvas.width, H=canvas.height;
      if (!W||!H) { rafId=requestAnimationFrame(draw); return; }
      ctx.clearRect(0,0,W,H);
      const cx=W*0.55, cy=H*0.48, R=Math.min(W,H)*0.40;
      rot+=0.0022;
      const glow=ctx.createRadialGradient(cx,cy,0,cx,cy,R*1.25);
      glow.addColorStop(0,"rgba(90,60,245,0.07)");
      glow.addColorStop(0.7,"rgba(60,30,200,0.04)");
      glow.addColorStop(1,"transparent");
      ctx.fillStyle=glow; ctx.beginPath(); ctx.arc(cx,cy,R*1.25,0,Math.PI*2); ctx.fill();
      const proj=particles.map(p=>{
        const x0=R*Math.sin(p.phi)*Math.cos(p.theta), y0=R*Math.cos(p.phi), z0=R*Math.sin(p.phi)*Math.sin(p.theta);
        const x=x0*Math.cos(rot)-z0*Math.sin(rot), z=x0*Math.sin(rot)+z0*Math.cos(rot);
        const depth=(z+R)/(2*R);
        return {px:cx+x,py:cy-y0,depth,color:p.color,size:p.size};
      });
      proj.sort((a,b)=>a.depth-b.depth);
      for(const p of proj){
        const op=(0.08+p.depth*0.88).toFixed(2), sz=p.size*(0.35+p.depth*0.65);
        ctx.beginPath(); ctx.arc(p.px,p.py,sz,0,Math.PI*2);
        ctx.fillStyle=`rgba(${p.color.r},${p.color.g},${p.color.b},${op})`; ctx.fill();
      }
      rafId=requestAnimationFrame(draw);
    }
    draw();
    document.addEventListener("visibilitychange",()=>{
      if(document.hidden){cancelAnimationFrame(rafId);rafId=null;}
      else if(state.currentScreen==="home"&&!rafId) draw();
    });
  }
  // Run after layout paints so getBoundingClientRect gives real dimensions
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",()=>setTimeout(setupGlobe,80));
  else setTimeout(setupGlobe,80);
})();
