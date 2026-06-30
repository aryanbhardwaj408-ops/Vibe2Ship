# Nudge AI — Product Requirements Document

## Latest Sprint (Jan 2026 — Sprint 4): Plan Summary + Auto-Ordered Queue + Single CTA

### Scope
Complete the AI Coach planning pipeline. After all goals are collected (single or multi), show a conversational plan summary with an auto-ordered premium queue card and **one** "Start Today's Plan" CTA that opens the first task via the existing pipeline. No changes to planner, step generation, recommendation engine, Active Mode, navigation, Home, Tasks, Stats, timers, mood.

### What was added
1. **Unified commit path** — both single-goal and multi-goal flows now create tasks as pending and end in `_showQueueComplete()`. Single-goal no longer navigates immediately via `planTask`; instead it goes through the same summary → Start CTA path. The planner pipeline (`generateSteps`, `createTask`, `saveTasks`) is fully reused inside `_createPendingTaskFromCoach()`.
2. **Auto-ordering (`_orderQueueByPriority`)** — sorts by tier (Errand → Deep Work → Focus → Quick), then groups similar tasks within a tier by `detectTaskType()` domain. Stable sort.
3. **Premium queue card (`_appendQueueCard`)** — for each task shows order number, title, ⏱ duration, and a colored badge (Errand / Quick / Focus / Deep Work). Card header shows total task count and total time.
4. **Single CTA (`_appendStartTodayCTA`)** — one prominent gradient "▶ Start Today's Plan" button with a glow animation. Removed the previous dual-button row (Start + View Tasks).
5. **`_startTodaysPlan()`** — closes coach, calls existing `resumeTaskById()` on the first ordered task. Active Mode opens with steps already generated.

### Verified Flows
| Flow | Result |
|---|---|
| Single goal ("Buy milk") | Summary shows 1 task · 15m · ERRAND, Start button opens Buy milk Active Mode ✓ |
| Multi goal ("Edit YouTube video, buy milk and finish JavaScript chapter") | Ordering: buy milk (Errand) → finish JS chapter (Deep Work / exam) → Edit YouTube video (Deep Work / video); single CTA visible; clicking opens buy milk Active Mode ✓ |
| Confidence flows (high/medium/low) | All still working from Sprint 3 ✓ |
| Home / Tasks / Stats / Active Mode / navigation | Untouched, verified working ✓ |

### Files Touched (Sprint 4)
- `/app/script.js` — rewrote `commitCoachPlan` (unified single + multi), rewrote `_showQueueComplete`. Added `_orderQueueByPriority`, `_badgeForTask`, `_appendQueueCard`, `_appendStartTodayCTA`, `_startTodaysPlan`. Removed `_startFirstQueuedTask` (replaced by `_startTodaysPlan`).
- `/app/style.css` — added `.acp-msg-queue-card`, `.acp-q-header`, `.acp-q-list`, `.acp-q-item`, `.acp-q-order`, `.acp-q-title`, `.acp-q-meta`, `.acp-q-time`, `.acp-q-badge` + per-badge color variants, `.acp-msg-start-card`, `.acp-start-today-btn` with entrance + idle glow animations.

### Files NOT Touched (per scope)
Planner, step generation, recommendation engine, task cards, Active Mode, navigation, Home page, timers, scheduling, stats, mood system.

---

## Earlier Sprints (summary)

- **Sprint 1**: Conversational AI Coach with welcome screen + name capture + typing animation.
- **Sprint 2**: Intelligent classifier (Quick / Standard / Long-Term goal) + handoff to existing planner + Home CTA restructure (primary AI Coach, secondary Quick add).
- **Sprint 3**: Multi-goal detection, confidence-based questioning (high/medium/low), Custom-duration inline input.

## Architecture
- Static HTML/CSS/JS, served by `serve` on port 3000 via supervisor.
- Stub FastAPI on 8001 for env compliance.
- All state in `localStorage`.

## Backlog / Next Action Items
- **P1**: Conversation history persistence across sessions.
- **P1**: "Edit name" affordance in Coach header.
- **P2**: Drag-to-reorder the queue from the summary card (currently fixed by priority sort).
- **P2**: Show estimated finish time ("done by 4:15 PM") in the queue header.
- **P2**: Real LLM (Claude / GPT via Emergent LLM key) for warmer copy.

## Enhancement Idea
A subtle **"📅 Add to calendar"** button next to "Start Today's Plan" — exports the queue with estimated durations into the user's calendar (.ics). Tiny add, big retention boost: now their plan exists outside the app.
