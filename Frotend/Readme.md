# TalkReady: Frontend Build Prompts (Phase-Wise)

Stack: React 18 + Vite + React Router v6 + Tailwind CSS (local only) + socket.io-client + Web Audio API (AudioWorklet) + IndexedDB. 100% offline-capable: no CDN fonts, scripts or icons.

## How to use this document

1. Open an AI coding assistant in an empty `frontend/` folder.
2. Paste **Section A (Shared Contract)** once at the start of the session and keep it in context for every phase.
3. Paste **one phase prompt at a time**, in order. Move on only when all "Acceptance checks" pass.
4. Develop against the real backend (port 5000). If the backend is not ready, use the mock instructions in Phase 0.

Items marked **[ADDED]** are small additions that are not written in the original PDF but are needed for the feature to work end to end.

---

## Section A: Shared Contract (paste first, reuse in every phase)

```
PROJECT: TalkReady, an offline voice-based interview practice app (MERN).
I am Developer 1 and I am building ONLY the frontend/ folder (React + Vite). A separate developer builds backend/ (Node/Express/MongoDB/Socket.io). Both sides follow this contract exactly.

GLOBAL RULES
- React 18, Vite, React Router v6, Tailwind CSS configured locally. No CDN links, no Google Fonts, no external scripts or images. Use system font stack or locally bundled fonts and inline SVG icons.
- Backend base URL: http://localhost:5000 (Vite proxy: /api and /socket.io -> 5000). Env: VITE_API_URL optional.
- REST envelope: success { "success": true, "data": ... } / failure { "success": false, "error": { "code", "message" } }. Axios interceptor unwraps data and shows errors consistently.
- JWT is stored in localStorage and sent as `Authorization: Bearer <token>`; the socket sends `auth: { token }`.
- Roles: 'student' | 'admin'. Student routes /student/*, admin routes /admin/*.
- Never leave a blank screen: every async view needs loading, empty and error states.

INTERVIEW STATES (exactly 9):
WARMUP, ASK, LISTEN, THINKING, REACT, FOLLOWUP, HINT, NEXT, WRAPUP

SOCKET EVENTS
Client -> Server
- interview:start      { noteSetId, style, questionCount, mode } (ack -> { sessionId })
- audio:chunk          ArrayBuffer of 16kHz mono PCM16, sent only during LISTEN
- interview:tts_done   { state }          [ADDED] sent after TTS finished playing
- interview:listen_end { reason: 'silence' | 'manual' }   [ADDED]
- interview:answer_text{ text }           [ADDED] text mode
- interview:command    { command: 'repeat'|'hint'|'skip'|'pause'|'resume'|'stop'|'slower'|'faster' }  [ADDED]
Server -> Client
- interview:state      { sessionId, state, text, audioBase64, hintLevel, coaching, questionIndex, totalQuestions, remainingSec }
                       (audioBase64 may be null: then use window.speechSynthesis as fallback)
- interview:transcript { text, isFinal, words:[{w,start,end,conf}] }   [ADDED]
- interview:error      { code, message }  [ADDED]
- admin:live_feed      { sessionId, studentId, studentName, questionIndex, totalQuestions, liveWpm, runningScore, state, updatedAt }

REST ENDPOINTS used by the frontend
POST /api/auth/register {name,email,password} | POST /api/auth/login {email,password} -> { token, user:{id,name,email,role,ramTier} }
GET /api/auth/me | PUT /api/auth/settings {ramTier} | DELETE /api/auth/purge-data
GET /api/notes | GET /api/notes/:id | POST /api/notes/upload (multipart file OR JSON {title,text}) -> { noteSet, topicCount, questionCount } | DELETE /api/notes/:id
GET /api/progress/me -> { streakDays, practicedToday, weakTopics[], topicStats[], recentSessions[] }
GET /api/interview/sessions | GET /api/interview/:id/report | POST /api/interview/:id/retry/:qid -> { newAnswer, previousAnswer, delta }
POST /api/drills/score { drillType, transcript, durationSec, wpm, fillerCount } -> { score, passed, feedback }
GET /api/admin/analytics | GET /api/admin/rubric | PUT /api/admin/rubric | GET /api/admin/students | GET /api/admin/students/:id/history | GET /api/admin/export-csv | POST /api/admin/notes-pack | POST /api/admin/model-pack (file + sha256)

SCORING DISPLAY: Overall = Content 60% + Delivery 40% (weights come from the report/rubric, never hard-code them in math; only use them as labels).
```

---

## Phase 0: Project Bootstrap, Tailwind & Offline Setup

```
Using the shared contract, bootstrap frontend/ with Vite + React.

Create this structure:
frontend/
  public/audio-worklets/vad-pcm-processor.js
  src/api/{axiosClient.js,socketClient.js}
  src/components/common/{Navbar.jsx,RoleGuard.jsx,AudioVisualizer.jsx}
  src/components/interview/{StateBanner.jsx,LiveTranscript.jsx,HintLadder.jsx,CommandHUD.jsx}
  src/components/coaching/{ScoreBreakdown.jsx,FillerHighlighter.jsx,SayItBetterCard.jsx}
  src/components/admin/{NotesUploader.jsx,RubricEditor.jsx,LiveMonitorTable.jsx}
  src/context/{AuthContext.jsx,InterviewContext.jsx}
  src/pages/auth/{Login.jsx,Register.jsx}
  src/pages/student/{StudentDashboard.jsx,NotesLibrary.jsx,InterviewSetup.jsx,LiveInterview.jsx,SessionReport.jsx,SkillDrills.jsx,Settings.jsx}
  src/pages/admin/{AdminDashboard.jsx,AdminContent.jsx,AdminRubric.jsx}
  src/utils/{indexedDb.js,fillers.js,voiceCommands.js,audio.js}
  src/App.jsx, src/main.jsx, src/index.css
  vite.config.js, tailwind.config.js, postcss.config.js

Do now:
1. Install and configure Tailwind locally (npm packages only). Use a system font stack. Add a clean, accessible design system in tailwind.config.js (primary, success, warning, danger colors, rounded cards, focus rings).
2. vite.config.js: dev server port 5173 and proxy /api and /socket.io (ws:true) to http://localhost:5000.
3. Add a global ErrorBoundary and a Toast system (small, self-written).
4. Verify there are no external URLs anywhere in index.html or CSS.
5. Add .env.example and a README with run steps.

Acceptance checks:
- `npm run dev` shows the app shell at localhost:5173 without console errors.
- Network tab shows zero requests to external domains.
- Tailwind classes render correctly.
```

---

## Phase 1: API Clients, Auth Context, Routing & Role Guard

```
Implement the plumbing.

1. api/axiosClient.js: baseURL '/api', request interceptor adds the JWT, response interceptor unwraps { data } and normalizes errors to { code, message }; on 401 clear auth and redirect to /login.
2. api/socketClient.js: a singleton factory connect(token) / disconnect() with auth token, automatic reconnection (exponential backoff), connection status events (connected, reconnecting, offline) exposed to the UI.
3. context/AuthContext.jsx: user, token, role, login(), register(), logout(), refresh via GET /api/auth/me on app load, loading state.
4. components/common/RoleGuard.jsx: <RoleGuard role="student"> / role="admin". Not logged in -> /login; wrong role -> redirect to that role's home.
5. App.jsx routes (React Router v6): /login, /register, /student/{dashboard,notes,setup,interview,report/:id,drills,settings}, /admin/{dashboard,content,rubric}, "/" redirects by role, and a 404 page.
6. components/common/Navbar.jsx: role-aware links (student links vs admin links), user name, logout, and an offline/online indicator driven by navigator.onLine plus socket status and a backend /api/health ping every 15 s (show "Backend offline" distinctly from "Browser offline").

Acceptance checks:
- A student opening /admin/dashboard is redirected; an admin opening /student/dashboard is redirected.
- Refreshing the page keeps the user logged in.
- Stopping the backend flips the indicator within 15 s and restores it automatically when the backend returns.
```

---

## Phase 2: Login & Register Pages

```
Build pages/auth/Login.jsx and Register.jsx.

Requirements:
- Clean forms with client-side validation (email format, password >= 8, name required), inline error text, disabled button while submitting, and server error display.
- Register always creates a student (do not show a role selector).
- After login, redirect by role: student -> /student/dashboard, admin -> /admin/dashboard.
- Accessible: labels, aria-live error region, keyboard friendly, show/hide password toggle.

Acceptance checks:
- Invalid inputs show errors without calling the API.
- Wrong password shows "Invalid email or password".
- Admin seeded account logs into the admin area; a new registered user lands on the student dashboard.
```

---

## Phase 3: Student Dashboard & Notes Library

```
Build StudentDashboard.jsx and NotesLibrary.jsx.

StudentDashboard (/student/dashboard):
- Fetch GET /api/progress/me and GET /api/notes.
- Quick-start cards for Prebuilt Notes (Java/Python, DBMS, OS, HR, Communication), "Use My Notes", and "Communication Drills". Clicking a prebuilt card goes to /student/setup?noteSetId=<id>.
- Daily practice streak counter (flame-style inline SVG) and "Top 3 weak topics" list with a "Practice this" button.
- Recent sessions list linking to /student/report/:id.
- Skeleton loaders and friendly empty states.

NotesLibrary (/student/notes):
- Paste-text area (with title) and file upload for .md, .txt, .pdf (drag-and-drop + button). Validate extension and size (5 MB) before upload.
- Show upload progress, then the parsing feedback banner using the API response: "We found {topicCount} topics and {questionCount} possible questions."
- List of the student's own notes and prebuilt notes with topic/question counts, preview (GET /api/notes/:id topic list) and delete (own notes only, with confirmation).
- Handle errors such as UNSUPPORTED_FILE and EMPTY_DOCUMENT with clear messages.

Acceptance checks:
- Uploading a PDF shows the banner with real counts from the backend.
- Deleting a note removes it from the list without a page reload.
- Streak and weak topics reflect real data.
```

---

## Phase 4: Interview Setup & Mic / Noise Check

```
Build InterviewSetup.jsx (/student/setup).

Controls:
- Topic/note set selection (from GET /api/notes; preselect from the query string).
- Interview Style: Friendly Coach, Standard, Strict, Rapid-fire (map to Friendly, Standard, Strict, Rapidfire for the API).
- Question Count: 5, 10, 15 with a visible hint "Max 15-minute session".
- Mode: Voice or Text.
- Mandatory Mic & Ambient Noise Check (Voice mode only): request getUserMedia, show live level bar (AudioVisualizer), measure ambient noise for 3 seconds, classify Quiet / Moderate / Noisy with advice, and ask the student to say a test sentence to confirm the mic hears speech. The Start button stays DISABLED until the check passes (Text mode skips it).
- Handle permission denied with step-by-step instructions and a one-click "Switch to Text mode" option.
- Remember the last selections in localStorage.

On Start: store the setup in InterviewContext, navigate to /student/interview. Stop the check's stream tracks before navigating.

Also build components/common/AudioVisualizer.jsx: takes a MediaStream, renders a canvas waveform plus a decibel meter using AnalyserNode with requestAnimationFrame, cleans up on unmount.

Acceptance checks:
- Start is disabled until the mic check passes in Voice mode.
- Denying mic permission shows guidance and Text mode works.
- No leftover mic usage (the browser's recording indicator goes off after leaving the page).
```

---

## Phase 5: Audio Pipeline (AudioWorklet, 16 kHz PCM, VAD)

```
Build the audio capture pipeline.

1. public/audio-worklets/vad-pcm-processor.js (AudioWorkletProcessor):
   - Receives input at the context sample rate, downsamples to 16 kHz mono, converts to Int16 PCM.
   - Posts PCM buffers of about 100 ms to the main thread.
   - Computes RMS energy per frame and posts speech/silence flags with a simple adaptive noise floor (calibrated from the first 500 ms) and a hysteresis threshold, so brief noise is not treated as speech.
2. utils/audio.js: startCapture({ onPcm, onLevel, onSpeechStart, onSpeechEnd, silenceEndMs }) that creates the AudioContext, loads the worklet from /audio-worklets/vad-pcm-processor.js, connects the mic MediaStream, and returns { stop(), setSilenceEndMs(ms), setEnabled(boolean), stream }.
   - Turn end: after speech has been detected, trailing silence >= silenceEndMs (default 1500, user adjustable 1500-2000) triggers onSpeechEnd.
   - Initial silence: if no speech has started within 6000 ms of listening, call onInitialSilence.
   - setEnabled(false) must set MediaStreamTrack.enabled = false AND stop emitting PCM; setEnabled(true) resumes.
3. Handle AudioContext 'suspended' state by resuming on a user gesture.
4. Cross-browser fallback: if AudioWorklet is unsupported, show a clear message and switch the interview to Text mode.

Acceptance checks:
- Logging shows PCM frames of ~3200 bytes at 16 kHz mono.
- Speaking then staying silent for 1.5 s fires onSpeechEnd exactly once.
- With setEnabled(false), no PCM is produced and the track is disabled.
- Keyboard clicks do not trigger speech start repeatedly.
```

---

## Phase 6: Interview Context & Real-Time State Machine

```
Implement context/InterviewContext.jsx and the glue to the socket. This is the heart of the frontend.

State held: setup, sessionId, state (one of the 9), questionText, hintLevel, transcript (partial + final), coaching, questionIndex, totalQuestions, remainingSec, micMuted, connectionStatus, error, isPaused.

Behavior:
1. startInterview(setup): connect socket (token), emit interview:start with { noteSetId, style, questionCount, mode } and wait for the ack sessionId.
2. On interview:state: update state; then
   - If audioBase64 exists, decode and play it (HTMLAudioElement or AudioBufferSourceNode). If null/empty or playback fails, use window.speechSynthesis with the same text (respect user speed). When playback ends, emit interview:tts_done { state }.
   - If the state does not need speech (e.g., LISTEN, THINKING), do not play anything.
3. HARD MUTE RULE (Acoustic Echo Cancellation): whenever the state is WARMUP, ASK, REACT, HINT, or FOLLOWUP (any state where the interviewer speaks) the mic MediaStreamTrack.enabled must be set to false BEFORE playback starts and stay false until playback ends. Re-enable ONLY when the state is LISTEN. Also stop sending audio:chunk outside LISTEN. Reflect this in micMuted so the UI shows a "Interviewer speaking, mic locked" indicator.
4. During LISTEN (voice mode): start streaming PCM via audio:chunk; on onSpeechEnd emit interview:listen_end { reason:'silence' }; on onInitialSilence show and speak "Take your time. Want a hint?" (the server also sends it; make sure it is not spoken twice).
5. Text mode: send interview:answer_text on submit.
6. Commands: sendCommand('repeat' | 'hint' | 'skip' | 'pause' | 'resume' | 'stop' | 'slower' | 'faster') emits interview:command; pause also stops capture and speech; resume restores.
7. interview:transcript updates the live caption (partial in grey, final in normal text).
8. WRAPUP: stop all audio, close mic, navigate to /student/report/:sessionId after the closing message finishes.
9. Cleanup: on unmount or leaving the page stop tracks, close AudioContext, cancel speechSynthesis, remove socket listeners (no duplicate listeners after remounting), and disconnect.
10. Resilience: on socket disconnect show a "Reconnecting..." overlay; on reconnect re-emit interview:start with { sessionId } to resume. If the mic is lost, offer Text mode.
11. Guard against React 18 StrictMode double-invocation (do not start two sessions).

Acceptance checks:
- The order of states shown in the UI matches the server events and never skips the mic mute while the interviewer talks (verify in devtools: track.enabled is false during ASK/REACT/HINT/FOLLOWUP/WARMUP).
- The app never transcribes its own TTS voice.
- Refreshing during an interview does not create duplicate sessions.
- Text mode completes a full interview with no microphone.
```

---

## Phase 7: Live Interview UI, Hint Ladder & Voice Commands

```
Build pages/student/LiveInterview.jsx and the interview components, using InterviewContext.

Components:
- StateBanner.jsx: shows the current state with distinct color/icon/label for WARMUP, ASK, LISTEN, THINKING, REACT, FOLLOWUP, HINT, NEXT, WRAPUP and an aria-live announcement of changes. Also show "Question 3 of 10" and a countdown timer from remainingSec.
- AudioVisualizer (reuse): animated waveform during LISTEN, dimmed and labeled "Mic locked" while the interviewer speaks.
- LiveTranscript.jsx: streaming caption box; partial text styled lighter; auto-scroll.
- HintLadder.jsx: 3-level progressive hint UI (1 Nudge, 2 Clue, 3 Answer). Buttons unlock sequentially, display the hint text received from the server, and show the current level (hintLevel).
- CommandHUD.jsx: small panel listing available voice commands and flashing the last triggered command.
- Manual fallback buttons: Repeat, Hint, Skip, Pause/Resume, Stop (with confirmation). Keyboard shortcuts optional.
- Text input box (Text mode) with Submit.

Voice Command Isolation Guard (utils/voiceCommands.js):
- Match only when the TOTAL utterance is under 4 words. Commands: "repeat", "say that again", "hint", "help me", "skip", "next question", "slower", "faster", "pause", "resume", "I'm done", "that's all", "stop interview".
- Use fuzzy matching (normalize case/punctuation, Levenshtein distance <= 1 for words longer than 4 chars). "I'm done" and "that's all" send the end-of-turn command (listen_end manual); "stop interview" asks for confirmation before stopping.
- Anything of 4 or more words, e.g. "I would skip the index when...", is ALWAYS treated as an answer and never as a command.
- Apply the guard to the partial and final transcripts only during LISTEN and write unit tests.

Acceptance checks:
- Saying "skip" skips the question; saying "I would skip the index for small tables" is submitted as an answer.
- The Hint Ladder never goes beyond level 3.
- Layout works at 360 px width (mobile) and desktop.
- Pause freezes the timer and mic; resume restores them.
```

---

## Phase 8: Session Report & Coaching

```
Build SessionReport.jsx (/student/report/:id) and the coaching components.

Data: GET /api/interview/:id/report.

Show:
- Overall Score (large) with Content and Delivery breakdown (ScoreBreakdown.jsx: stacked bars labeled with the weights received from the API, defaulting to 60%/40%).
- Per-question accordion: question text, transcript, WPM gauge (green zone 110-150 WPM), filler count, long pauses, missed keywords, STAR/Structure feedback when present, coaching tips.
- FillerHighlighter.jsx: highlights "um", "uh", "like", "you know", "basically", "actually" and hedges ("I think maybe", "kind of", "sort of") inside the transcript using utils/fillers.js (whole-word matching, case-insensitive, escape regex).
- SayItBetterCard.jsx: side-by-side "Your answer" vs "Say it better" plus a Retry Question button.
- Retry flow: Retry navigates to a lightweight retry screen/modal that records (or accepts typed) a new answer for that single question, calls POST /api/interview/:id/retry/:qid, then shows the delta (+/- points for final, content, delivery) with green/red indicators.
- Download/print report button (window.print with a print stylesheet).
- Handle loading, 404 (not your session) and empty states.

Acceptance checks:
- Numbers shown match the API response exactly (no recalculation on the client except formatting).
- Retry shows a delta against the previous attempt.
- Filler highlighting never breaks on text containing regex characters.
```

---

## Phase 9: Skill Drills

```
Build pages/student/SkillDrills.jsx (/student/drills) with four mini-games, each with a countdown timer:
1. 30-Second Answer: a prompt appears, the student speaks for 30 s; show a progress ring.
2. No-Filler Challenge: speak for 20 s with live filler counter (use the local STT transcript from the AI bridge or text input fallback).
3. Pace Control: live WPM meter with a target band of 110-150 WPM.
4. Explain It Simply: explain a given term in plain words within a time limit.

Technical notes:
- Reuse utils/audio.js. For voice drills, stream audio over the existing socket (audio:chunk) and read interview:transcript for live words; if STT is unavailable, provide a typed fallback so drills always work.
- After finishing, call POST /api/drills/score and show { score, passed, feedback } with a retry button.
- Drill prompts come from a local array in the frontend (at least 8 per drill).
- Mic is released when a drill ends or the page is left.

Acceptance checks:
- Each drill runs start to finish in both voice and text fallback.
- Timer cleanup works (no timer continues after leaving the page).
- Score and feedback come from the backend response.
```

---

## Phase 10: Admin Dashboard, Content & Rubric

```
Build the admin screens (all protected by RoleGuard role="admin").

AdminDashboard.jsx (/admin/dashboard):
- Connect the socket and subscribe to admin:live_feed. LiveMonitorTable.jsx shows active student sessions: student name, current question index (e.g., 4/10), state, live WPM, running score, last update time. Update rows in place, remove completed sessions after 30 s, and mark stale rows (no update > 60 s).
- Cards from GET /api/admin/analytics: cohort average score, active sessions count, and weakest-topic alerts (topics under a configurable threshold, default 60).
- Student list with a link to history (GET /api/admin/students/:id/history).

AdminContent.jsx (/admin/content):
- NotesUploader.jsx: drag-and-drop .md/.txt/.pdf for global prebuilt packs (POST /api/admin/notes-pack) with per-file status.
- Editors for the phrase banks openers, reactions, transitions (list editor: add, edit, delete, reorder; require >= 10 unique entries each; save through PUT /api/admin/rubric).
- Offline Model/AI pack import: choose file, enter the expected SHA-256, upload to POST /api/admin/model-pack, show progress, success, or a clear CHECKSUM_MISMATCH error. Optionally compute SHA-256 in the browser (crypto.subtle for small files) to pre-validate.

AdminRubric.jsx (/admin/rubric):
- RubricEditor.jsx: sliders for Content vs Delivery weights that are locked to sum to 100 (moving one adjusts the other). Save through PUT /api/admin/rubric.
- Hardware LLM tier toggle: Base 3GB, 4-6GB, 8GB+.
- Student histories table and a one-click "Export CSV" button downloading GET /api/admin/export-csv with the auth header (use axios blob + object URL).

Acceptance checks:
- Starting a student interview in another browser shows a live row in the admin table within 2 s and updates as the interview proceeds.
- Weights always total 100; the saved values persist after refresh.
- CSV downloads and opens correctly.
```

---

## Phase 11: Privacy, Settings, IndexedDB & Offline Behavior

```
Build pages/student/Settings.jsx and utils/indexedDb.js.

1. Privacy guarantee: audio recordings are OFF by default. A toggle "Save Recordings" (stored in localStorage) controls whether the answer audio is saved. When ON, record each answer with MediaRecorder and store blobs ONLY in the browser's IndexedDB (database 'talkready', store 'recordings' keyed by sessionId+questionId). Never upload audio blobs anywhere. Show a plain-language privacy explanation.
2. Recordings list with playback and per-item delete.
3. Settings also include: silence-end time slider (1.5-2.0 s), TTS speed, preferred mode, and RAM tier (PUT /api/auth/settings).
4. "Delete All Data" button: confirmation modal, then clear IndexedDB (recordings + cached sessions) and localStorage preferences (keep nothing personal), call DELETE /api/auth/purge-data, show the result, and keep the account logged in.
5. Offline behavior: cache the last fetched dashboard and reports in IndexedDB so they open without the backend; show an "Offline copy" tag. Optionally add a service worker (vite-plugin-pwa or a hand-written minimal one) that caches the built assets so the UI loads without a network.
6. Wire the settings values into InterviewContext and the audio pipeline.

Acceptance checks:
- With recordings OFF there are zero entries in IndexedDB.
- Turning recordings ON stores blobs locally and no network request carries audio blobs.
- Delete All Data empties IndexedDB and the backend confirms the purge.
- Dashboard still loads cached data when the backend is stopped.
```

---

## Phase 12: QA, Performance, Accessibility & Build

```
Finalize the frontend.

1. End-to-end manual test script (write it in docs/QA.md): register, upload notes, set up interview (voice and text), complete a 5-question interview, read the report, retry a question, run all drills, admin live monitor, rubric change, CSV export, purge data.
2. Performance: lazy-load pages with React.lazy and Suspense, memoize heavy components, throttle visualizer rendering, keep the audio worklet free of allocations in the process loop.
3. Accessibility: keyboard navigation, focus management on route change, color contrast AA, aria-live regions for state changes and errors, reduced-motion support.
4. Error handling: ErrorBoundary around LiveInterview; every API failure shows a human readable message.
5. Browser support: test on latest Chrome and Edge (primary); show a compatibility warning if AudioWorklet or getUserMedia is missing.
6. Production build: `npm run build` and `npm run preview` work with the backend; document serving the dist folder from Express (static) as an option.
7. Add unit tests (Vitest + React Testing Library) for voiceCommands, fillers, RoleGuard and the state banner.

Final acceptance checklist:
- Zero external network requests in any screen.
- Full interview works in Voice and Text mode with the backend; the mic is always muted while the interviewer speaks.
- Student and admin flows are fully protected by role.
- All tests pass and the production build has no warnings that affect functionality.
```
