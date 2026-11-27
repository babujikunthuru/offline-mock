# TalkReady: Backend Build Prompts (Phase-Wise)

Stack: Node.js + Express.js + local MongoDB (`mongodb://127.0.0.1:27017/talkready`) + Socket.io. 100% offline, no cloud calls.

## How to use this document

1. Open an AI coding assistant (Claude Code, Cursor, etc.) in an empty `backend/` folder.
2. Paste **Section A (Shared Contract)** once at the start of the session. Keep it in context for every phase.
3. Paste **one phase prompt at a time**, in order. Do not start the next phase until every item in the "Acceptance checks" of the current phase passes.
4. The frontend developer uses the same Section A, so both sides always agree on payloads.

Items marked **[ADDED]** are small additions that are not written in the original PDF but are required for the feature to work end to end. They are kept minimal.

---

## Section A: Shared Contract (paste first, reuse in every phase)

```
PROJECT: TalkReady, an offline voice-based interview practice app (MERN).
I am Developer 2 and I am building ONLY the backend/ folder. A separate developer builds frontend/ (React + Vite). Both sides must follow this contract exactly.

GLOBAL RULES
- Node.js 18+, Express, Mongoose, Socket.io, JWT (jsonwebtoken), bcryptjs, multer, pdf-parse, csv writer (use built-in streaming, no external service).
- Everything runs locally. No external HTTP calls except the optional local AI bridge at http://127.0.0.1:8000.
- Every REST response uses this envelope:
  success: { "success": true, "data": ... }
  failure: { "success": false, "error": { "code": "STRING_CODE", "message": "Human readable" } }
- Use ES modules or CommonJS consistently (choose CommonJS). Use async/await with a central error handler. Never crash the process on a bad request.
- Roles: 'student' | 'admin'. JWT is sent as `Authorization: Bearer <token>`. Socket.io handshake sends the same token in `auth: { token }`.
- Server port: 5000. CORS allows http://localhost:5173.
- Grading is ALWAYS deterministic in Node.js. The LLM/AI bridge never computes scores.

INTERVIEW STATES (exactly 9):
WARMUP, ASK, LISTEN, THINKING, REACT, FOLLOWUP, HINT, NEXT, WRAPUP
Flow: WARMUP -> ASK -> LISTEN -> THINKING -> REACT -> (FOLLOWUP | HINT | NEXT) -> ... -> WRAPUP

SOCKET EVENTS
Client -> Server
- interview:start      { noteSetId, style, questionCount, mode, sessionId? }   ack -> { sessionId }
- audio:chunk          binary ArrayBuffer of 16kHz mono PCM16 (only during LISTEN)
- interview:tts_done   { state }               [ADDED] client finished playing TTS, server may enter LISTEN
- interview:listen_end { reason: 'silence' | 'manual' }   [ADDED] client VAD detected end of turn
- interview:answer_text{ text }                [ADDED] used in text mode
- interview:command    { command: 'repeat'|'hint'|'skip'|'pause'|'resume'|'stop'|'slower'|'faster' }  [ADDED]
Server -> Client
- interview:state      { sessionId, state, text, audioBase64, hintLevel, coaching, questionIndex, totalQuestions, remainingSec }
                       (audioBase64 may be null; the client then falls back to browser speech synthesis)
- interview:timer      { sessionId, remainingSec }   [ADDED] periodic server timer updates
- interview:transcript { text, isFinal, words:[{w,start,end,conf}] }   [ADDED] live captions
- interview:error      { code, message }       [ADDED]
- admin:live_feed      { sessionId, studentId, studentName, questionIndex, totalQuestions, liveWpm, runningScore, state, updatedAt }   (admin room only)

REST ENDPOINTS
POST   /api/auth/register           public   { name, email, password }  (always creates role 'student')
POST   /api/auth/login              public   { email, password } -> { token, user:{ id,name,email,role,ramTier } }
GET    /api/auth/me                 any
PUT    /api/auth/settings           any      { ramTier }   [ADDED]
DELETE /api/auth/purge-data        student  deletes personal notes, chunks, questions, sessions, answers, progress, and daily practice
POST   /api/notes/upload            both     multipart(file .md/.txt/.pdf, max 5 MB, extension and MIME must match) OR JSON { title, text } -> { noteSet, topicCount, questionCount }
GET    /api/notes                   both     prebuilt + own note sets   [ADDED]
GET    /api/notes/:id               both     note set + topic list      [ADDED]
DELETE /api/notes/:id               owner    [ADDED]
POST   /api/interview/start         student  same payload as the socket event; returns session + question queue [equivalent REST path]
POST   /api/interview/:id/retry/:qid student { transcript, words?, durationSec?, usedHintLevel? } -> { newAnswer, previousAnswer, delta }
GET    /api/interview/sessions      student  history list   [ADDED]
GET    /api/interview/:id/report    student  full report with answers, coaching, sayItBetter   [ADDED]
GET    /api/progress/me             student  { streakDays, practicedToday, weakTopics:[top 3], topicStats[], recentSessions:[last 5] }   [ADDED]
POST   /api/drills/score            student  { drillType, transcript, durationSec?, wpm?, fillerCount?, words? } -> { score, passed, feedback }   [ADDED]
GET    /api/admin/analytics         admin    { batchAvgScore, weakTopicDistribution, activeSessions, totals }
GET    /api/admin/export-csv        admin    streams Excel-safe CSV
GET    /api/admin/rubric            admin    weights, phrase banks, AI mode, RAM-tier hints
PUT    /api/admin/rubric            admin    { contentWeight, deliveryWeight, phraseBanks?, aiPackMode?, ramTierHints? }
GET    /api/admin/students          admin    student list
GET    /api/admin/students/:id/history admin all sessions with scores
POST   /api/admin/notes-pack        admin    upload one or more prebuilt notes
POST   /api/admin/model-pack        admin    multipart file + { sha256 } -> verifies checksum   [ADDED]
GET    /api/health                  public   { status:'ok', mongo:true|false, aiBridge:true|false }

SCORING (never change these formulas)
content  = 0.50*keywordCoverage + 0.30*semanticSimilarity + 0.20*completeness     (each 0..1)
delivery = 0.30*paceScore + 0.30*fillerScore + 0.20*pauseScore + 0.10*lengthScore + 0.10*clarityScore
finalScore = Math.round(100 * (wC*content + wD*delivery))   where wC=0.60, wD=0.40 by default and read from SystemConfig
paceScore: 110..150 WPM = 1.0 | 90..110 or 150..175 = 0.7 | else 0.4
fillerScore: penalize "um","uh","like","you know","basically","actually" when rate > 3 per minute
pauseScore: penalize word gaps > 2.0 s
lengthScore: ideal 20..90 s
clarityScore: STT word confidence minus weak hedges ("I think maybe","kind of")

LOCAL AI BRIDGE (optional, separate service, assumed contract) [ADDED]
Base URL http://127.0.0.1:8000
- GET  /health
- POST /stt       { audioBase64, sampleRate:16000 }              -> { text, words:[{w,start,end,conf}] }
- POST /tts       { text, speed }                                -> { audioBase64 }
- POST /embed     { texts:[string] }                             -> { vectors:[[number]] }
- POST /generate  { prompt, maxTokens }                          -> { text }
The backend MUST keep working when the bridge is down: embeddings fall back to TF-IDF cosine similarity, TTS reports unavailable (browser speech is used), STT reports unavailable and the UI switches to text mode, "Say It Better" uses a rule-based template. Run the local stub with `npm run mock:bridge`.
```

---

## Phase 0: Project Bootstrap

```
Using the shared contract above, bootstrap the backend/ project.

Create this exact structure (empty files are fine for now except where stated):
backend/
  config/db.js
  controllers/{authController,notesController,interviewController,scoringController,adminController}.js
  models/{User,NoteSet,Chunk,Question,Session,Answer,ProgressStat,SystemConfig}.js
  routes/{authRoutes,notesRoutes,interviewRoutes,adminRoutes}.js
  services/{questionEngine,followUpEngine,scoringRubric,aiBridgeService}.js
  sockets/interviewSocket.js
  middleware/{auth,roles,errorHandler}.js
  utils/{apiResponse,logger}.js
  assets/prebuilt-notes/
  server.js
  .env.example   (PORT=5000, MONGO_URI=mongodb://127.0.0.1:27017/talkready, JWT_SECRET, AI_BRIDGE_URL=http://127.0.0.1:8000, CLIENT_ORIGIN=http://localhost:5173, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD)
  package.json   (scripts: start, dev with nodemon, seed, test)

Implement now:
1. server.js: Express app, JSON body limit 2mb, CORS for CLIENT_ORIGIN, http server shared with Socket.io (CORS the same), route mounting under /api, GET /api/health, central error handler, graceful shutdown.
2. config/db.js: connect to MongoDB with retry (5 attempts, 2 s apart), log clear message if mongod is not running.
3. utils/apiResponse.js helpers: ok(res,data,status=200) and fail(res,code,message,status).
4. middleware/errorHandler.js converts thrown errors and Mongoose validation/duplicate-key errors into the failure envelope.

Acceptance checks:
- `npm run dev` starts without errors when MongoDB is running.
- GET http://localhost:5000/api/health returns { success:true, data:{ status:'ok', mongo:true, aiBridge:false } }.
- Stopping MongoDB produces a readable log message, not a stack-trace crash.
- Unknown route returns the failure envelope with 404.
```

---

## Phase 1: Data Models, Indexes & Seeding

```
Implement all 8 Mongoose models with timestamps, validation and the indexes below.

users: name, email (unique, lowercase), passwordHash, role enum('student','admin') default 'student', ramTier enum('3GB','4-6GB','8GB+') default '3GB', createdAt.
notesets: title, source enum('prebuilt','user'), ownerId ref User (null for prebuilt), level, language, topics [String], topicCount, questionCount, createdAt. Index ownerId.
chunks: noteSetId (indexed), topic, text (80-200 words), keywords [String], hasDefinition Boolean, hasExample Boolean, embedding [Number], useTfidfFallback Boolean.
questions: noteSetId, chunkId, type enum of 12 values (definition, explain_simply, example, why_purpose, compare, scenario, fill_gap, rapid_fire, challenge, interview_style, star_behavioral, dynamic_followup), text, expectedKeywords [String], difficulty enum(1,2,3). Index noteSetId.
sessions: studentId (indexed), noteSetId, style enum('Friendly','Standard','Strict','Rapidfire'), mode enum('voice','text'), questionIds [ObjectId], questionIndex, remainingSec, pausedAt, promptState, currentPrompt, rootAnswerId, hintLevel, followUpsUsed, ttsSpeed, totalScore, status enum('active','paused','completed','aborted'), startedAt, endedAt, timeLimitSec default 900.
answers: sessionId, questionId, followUpOf ref Answer (nullable), attemptNum default 1, skipped Boolean, transcript, wpm, fillerCount, fillerMap (Mixed), longPauseCount, avgConfidence, durationSec, scoredMode enum('voice','text'), usedHintLevel default 0, contentScore, deliveryScore, finalScore, coaching (Mixed: tips[], missedKeywords[], starFeedback), sayItBetter String. Index {sessionId, questionId, attemptNum}.
progressstats: studentId, topic, avgScore, attempts, streakDays, lastSeen. COMPOUND UNIQUE index {studentId, topic}.
systemconfig (single document, key:'main'): contentWeight 0.6, deliveryWeight 0.4, aiPackMode enum('base','mid','high') default 'base', phraseBanks { openers:[String], reactions:[String], transitions:[String] }, followUpMax { default:1, strict:2 }, silenceEndSec default 1.5, modelPack { name, sha256, importedAt }.

Seeding (config/db.js -> seed function, idempotent):
- Create SystemConfig 'main' with at least 15 openers, 15 reactions and 15 transitions so anti-repetition works over a 15-question session.
- Create an admin user from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD if none exists.
- Add the `npm run seed` script.

Acceptance checks:
- Run seed twice: no duplicates are created.
- Inserting two progressstats with the same studentId+topic throws a duplicate key error.
- Mongo shell shows the expected indexes.
```

---

## Phase 2: Authentication & Role-Based Access Control

```
Implement authController, authRoutes, middleware/auth.js and middleware/roles.js.

Requirements:
1. POST /api/auth/register: validate name, email format, password length >= 8; hash with bcryptjs (10 rounds); ALWAYS create role 'student' (admins are only created by seed). Return the same payload shape as login.
2. POST /api/auth/login: verify credentials, return { token, user:{ id,name,email,role,ramTier } }. JWT expires in 7 days and contains id and role. Use a generic "Invalid email or password" message.
3. GET /api/auth/me and PUT /api/auth/settings (updates ramTier only).
4. middleware/auth.js: verifies Bearer token, loads the user, attaches req.user; returns 401 with code AUTH_REQUIRED otherwise.
5. middleware/roles.js: requireRole('admin') / requireRole('student') returning 403 with code FORBIDDEN.
6. DELETE /api/auth/purge-data (student only): delete this student's user-owned notesets, their chunks and questions, sessions, answers and progressstats. Do NOT delete the user account itself and never touch prebuilt notes. Return counts of deleted documents.
7. Add a Socket.io auth middleware that verifies the handshake token and stores socket.data.user; reject unauthenticated sockets.
8. Rate-limit login (10 attempts / 15 min per IP) using a small in-memory limiter.

Acceptance checks:
- Register, login, and /me work in Postman.
- A student token calling /api/admin/analytics returns 403; no token returns 401.
- Purge removes only that student's data (verify in MongoDB); another student's data is untouched.
- A socket connecting without a token is refused.
```

---

## Phase 3: Notes Ingestion (Upload, Parsing, Chunking, Keywords)

```
Implement notesController, notesRoutes and the parsing pipeline (put parsing helpers in services/noteParser.js).

Requirements:
1. POST /api/notes/upload accepts multipart `file` (.md, .txt, .pdf, max 5 MB, validated by extension AND mimetype) or JSON { title, text }. Reject others with code UNSUPPORTED_FILE.
2. Extraction: .md/.txt as UTF-8; .pdf with pdf-parse. If a PDF has no extractable text, return code EMPTY_DOCUMENT with a helpful message.
3. Topic detection: split by Markdown headings (#, ##, ###); if there are no headings, split by blank-line paragraphs and generate topic names from the first sentence.
4. Chunking: each chunk is 80-200 words. Merge short paragraphs, split long ones on sentence boundaries. Never cut mid-sentence.
5. Per chunk compute: keywords (top 5-8 terms by TF-IDF across the note set, stopwords removed, lowercase), hasDefinition (patterns such as "is a", "refers to", "is defined as"), hasExample (patterns such as "for example", "e.g.", code fences).
6. Embeddings: call aiBridgeService.embed(texts). If the bridge is unavailable store an empty embedding array and mark the chunk so similarity later uses TF-IDF fallback. The upload must NEVER fail because the AI bridge is down.
7. After chunking, call questionEngine.generateForNoteSet(noteSetId) to create the note set's questions.
8. Response: { noteSet, topicCount, questionCount } so the UI can show "We found 12 topics and 48 possible questions."
9. Prebuilt notes: load all files in assets/prebuilt-notes/ at seed time as source 'prebuilt' (java-basics.md, python-basics.md, dbms.md, os.md, hr-interview.md, communication.md). Write real starter content (at least 6 headed sections each, with definitions and examples) so questions can be generated.
10. GET /api/notes (prebuilt + the requester's own), GET /api/notes/:id (with topic list and counts), DELETE /api/notes/:id (owner only, cascades chunks and questions).

Acceptance checks:
- Upload a 3-page PDF, a .md and a pasted text: each returns correct topic counts and chunks within 80-200 words.
- Uploading a .exe returns UNSUPPORTED_FILE.
- Works with the AI bridge turned off.
- Student A cannot read or delete Student B's note set.
```

---

## Phase 4: Question Engine (12 Types, Difficulty Ramp, Anti-Repetition)

```
Implement services/questionEngine.js.

1. generateForNoteSet(noteSetId): create questions from chunks using 12 templates:
   (1) Definition, (2) Explain Simply, (3) Example, (4) Why/Purpose, (5) Compare, (6) Scenario, (7) Fill the Gap (spoken), (8) Rapid-fire, (9) Challenge, (10) Interview-style wrapper, (11) STAR Behavioral (only for HR/behavioral notes), (12) Dynamic Follow-up (created at runtime, not stored in bulk).
   Template rules: Definition needs hasDefinition; Example needs hasExample; Compare needs two chunks with related keywords; STAR only when the note set title/topics suggest HR or behavioral content. Each question stores expectedKeywords from its chunk and a difficulty (Definition=1; Example/Why=2; Scenario/Compare/Challenge=3). Update noteSet.topicCount and noteSet.questionCount.
2. buildQueue({ studentId, noteSetId, count, style }): returns an ordered array of questions:
   - count is 5, 10 or 15.
   - Ramp difficulty: first third difficulty 1, middle third 2, final third 3 (fall back gracefully if a level is short).
   - Contain at least 3 different question types (when the note set allows it).
   - Weight topics with low ProgressStat.avgScore higher (weighted random).
   - Exclude questions the student answered in their last 3 sessions; if that leaves too few, relax the filter and log it.
   - Rapidfire style prefers short question types (Rapid-fire, Definition).
3. Phrase bank anti-repetition: createPhraseTracker(sessionId) returns next(kind) for 'openers' | 'reactions' | 'transitions'; it keeps used indices per session in memory and never repeats within one interview (reshuffle only after the list is exhausted). Phrase banks are read from SystemConfig.
4. Question wording must sound natural when spoken aloud: no markdown, no code symbols read out, under 35 words.

Acceptance checks (write a small test script):
- For a 15-question queue: difficulties are non-decreasing in blocks, at least 3 distinct types, no question from the student's last 3 sessions.
- 15 consecutive reactions contain no duplicate phrase.
- A note set without HR content never yields STAR questions.
```

---

## Phase 5: Deterministic Scoring Rubric & Coaching

```
Implement services/scoringRubric.js and controllers/scoringController.js. Follow the formulas in the shared contract EXACTLY. No LLM is used for scores.

Inputs per answer: transcript, words[{w,start,end,conf}], durationSec, the question (expectedKeywords, chunk text) and the SystemConfig weights.

Compute:
- keywordCoverage = matched expectedKeywords (stemmed, case-insensitive) / total expectedKeywords.
- semanticSimilarity: cosine similarity between answer embedding and chunk embedding (aiBridgeService.embed). Fallback when unavailable: TF-IDF cosine similarity between transcript and chunk text. Clamp to 0..1.
- completeness: min(1, answerWordCount / targetWords) combined with presence of definition/example when the chunk has them (document your rule in a code comment).
- wpm = words / (durationSec/60). Use word timestamps when available.
- fillerCount and fillerMap for: um, uh, like, you know, basically, actually (match as whole words; do not count "like" in "I would like to explain"-style verbs if you can detect a comparison/verb use, otherwise count it and note the limitation in a comment). Filler rate per minute drives fillerScore: <=3/min = 1.0, then decreasing linearly to 0.3 at >=10/min.
- longPauseCount = number of gaps > 2.0 s between consecutive words; pauseScore = max(0.3, 1 - 0.15*longPauseCount).
- lengthScore: 20..90 s = 1.0; linearly drops outside to a floor of 0.4.
- clarityScore = avgConfidence minus 0.05 per weak hedge ("I think maybe", "kind of", "sort of", "I guess"), clamped 0..1. In text mode (no confidence) use 0.8 and skip pace/pause by redistributing weights: document this rule and mark the answer with scoredMode:'text'.
- finalScore exactly as the contract.

Coaching output stored in answer.coaching:
{ tips:[3 short actionable tips derived from the lowest sub-scores], missedKeywords:[...], starFeedback (only for STAR questions: detects Situation, Task, Action, Result markers), contentBreakdown, deliveryBreakdown }.
sayItBetter: a rewritten model answer. Use aiBridge /generate when available (prompt must include the chunk text and ask for a 3-5 sentence spoken answer including the missed keywords); otherwise assemble it from the chunk's definition/example sentences. The result is text only; it never changes the score.

Also implement session-level scoring: Session.totalScore = average of the best attempt finalScore per question. Update ProgressStat per topic (running average, attempts, lastSeen) and streakDays (increments when the last practice day was yesterday, keeps if today, resets otherwise, using the server's local date).

Acceptance checks (unit tests with fixed inputs):
- Same input always returns the same finalScore.
- A perfect-pace, no-filler answer with all keywords scores > 85; a 5-word answer scores < 40.
- Changing weights in SystemConfig to 0.7/0.3 changes finalScore as expected.
- Everything works with the AI bridge offline.
```

---

## Phase 6: Follow-Up Engine

```
Implement services/followUpEngine.js.

decideNext({ question, answer, style, followUpsUsedForThisQuestion, hintLevel }) returns one of:
{ action:'FOLLOWUP', text, reason } | { action:'HINT', level } | { action:'NEXT', reaction }

Rules:
- Maximum follow-ups per question: 1 normally, 2 in Strict style (read from SystemConfig.followUpMax).
- If the answer is too short (< 15 words or < 8 seconds): FOLLOWUP asking for an example ("Can you give me a quick example of that?" style, varied through the phrase tracker).
- Else if expectedKeywords were missed: FOLLOWUP asking specifically about the single top missed keyword (highest-weight keyword from the chunk).
- Else: NEXT with a praising reaction from the phrase tracker.
- If the student requested a hint, or stayed silent > 6 s initially, the HINT path is used instead (see Phase 7). Hint Ladder content: Level 1 Nudge (topic + first letter style hint), Level 2 Clue (one expected keyword and a related sentence from the chunk), Level 3 Answer (a concise model answer). Hint level never exceeds 3 and a used hint is recorded on the answer (usedHintLevel) so it can reduce the contentScore by 5% per level (document this in code).
- Follow-up answers are stored as linked answers (`followUpOf`) and merged into the question's content score as max(first, followUp), retaining the original answer's delivery score.
- Style flavors: Friendly Coach (encouraging, longer pauses allowed), Standard, Strict (2 follow-ups, shorter praise), Rapid-fire (no follow-ups unless the answer is under 5 words, short reactions).

Acceptance checks (unit tests):
- Short answer -> FOLLOWUP for an example; keywords missed -> FOLLOWUP naming the top missed keyword; complete answer -> NEXT.
- Strict allows 2 follow-ups, Standard only 1, Rapid-fire almost never.
```

---

## Phase 7: AI Bridge Service (Graceful Degradation)

```
Implement services/aiBridgeService.js. (Build this BEFORE Phase 8 if you want live STT/TTS; the rest of the app must still work without it.)

Functions: health(), stt(pcmBuffer), tts(text, speed), embed(texts), generate(prompt, maxTokens).
Requirements:
- Base URL from AI_BRIDGE_URL. Use the built-in fetch with AbortController timeouts (health 1 s, embed 5 s, stt 8 s, tts 6 s, generate 20 s).
- Cache the health result for 5 seconds. If the bridge is down, return { available:false } style results instead of throwing; callers decide on the fallback.
- Never block the Node event loop: process audio asynchronously.
- Respect the RAM tier from SystemConfig.aiPackMode: for 'base' skip generate() entirely (rule-based Say It Better); for 'mid'/'high' allow it.
- Wire /api/health to include aiBridge:true|false.
- Add a tiny mock bridge script (scripts/mockBridge.js on port 8000) that returns fake STT text, a silent short WAV for TTS and random vectors for embed, so developers can test without the real AI module.
- Run the mock bridge with `npm run mock:bridge`; set `AI_BRIDGE_URL` to override its default address.

Acceptance checks:
- With the mock bridge running, /api/health shows aiBridge:true; stop it and the app continues to work.
- Timeouts return a controlled failure in the stated time.
```

---

## Phase 8: Real-Time Interview Socket State Machine

```
Implement sockets/interviewSocket.js using the shared contract. This is the core of the product, so build it carefully.

Session lifecycle (per socket, one active interview per student):
1. interview:start { noteSetId, style, questionCount, mode } -> validate; call questionEngine.buildQueue; create a Session; ack { sessionId }; join room `session:<id>` and, for admins, room `admins`.
2. State WARMUP: emit interview:state with an opener from the phrase tracker, audioBase64 from aiBridge.tts (null if unavailable), questionIndex 0.
3. Client sends interview:tts_done -> server moves to ASK (emits the question text + TTS) -> after tts_done -> LISTEN.
4. LISTEN: accept audio:chunk (PCM16 16 kHz). Buffer chunks per question; every ~1.5 s send the accumulated audio to aiBridge.stt for partial transcripts and emit interview:transcript (isFinal false). Reject audio:chunk in any other state (ignore silently, never crash). Text mode: accept interview:answer_text instead.
5. interview:listen_end (silence or manual) -> THINKING: finalize STT (full buffer), compute durationSec, call scoringRubric, save the Answer.
6. REACT: emit a reaction + a short coaching hint (interview:state.coaching = { score, tip }) then ask followUpEngine.decideNext:
   - FOLLOWUP -> emit state FOLLOWUP with the follow-up text -> tts_done -> LISTEN again for that same question.
   - HINT -> emit state HINT with hintLevel -> tts_done -> LISTEN.
   - NEXT -> state NEXT (transition phrase) -> ASK the next question.
7. After the last question or the 15-minute limit (Session.timeLimitSec) -> WRAPUP: compute totalScore, update progress stats and streaks, emit interview:state { state:'WRAPUP', coaching:{ sessionId, totalScore, summary } } with a spoken closing message. Mark the session 'completed'.
8. Commands (interview:command): repeat (re-emit the current question or hint), hint (advance hintLevel up to 3; record it), skip (record a zero-score skipped answer, go NEXT), pause/resume (stop the timer and stop accepting audio), stop (go to WRAPUP early with partial score), slower/faster (adjust TTS speed by +/-0.1 within 0.7..1.3 for the rest of the session).
9. Silence rule: if the student has not started speaking within 6 s of LISTEN, emit state HINT with text "Take your time. Want a hint?" (do not consume a hint level until they ask).
10. Timers: server owns remainingSec; include it in each state. Use per-session timers that are cleaned up on disconnect, stop and completion (no memory leaks).
11. Disconnect/reconnect: on disconnect mark the session 'paused'; if the same student reconnects within 2 minutes and sends interview:start with { sessionId } resume at the last question (add optional sessionId to the payload).
12. Admin live feed: on every state change and answer save, emit admin:live_feed to the `admins` room with { sessionId, studentId, studentName, questionIndex, totalQuestions, liveWpm, runningScore, state, updatedAt }. Also emit one final feed event on completion.
13. Guard rails: validate the payload of every event; wrap every handler in try/catch emitting interview:error { code, message } instead of crashing; an invalid state transition is ignored and logged.
14. Also expose POST /api/interview/start (same logic through REST), GET /api/interview/sessions, GET /api/interview/:id/report, and POST /api/interview/:id/retry/:qid which re-scores a retry with scoringRubric and returns { newAnswer, previousAnswer, delta:{ finalScore, contentScore, deliveryScore } } while storing attemptNum+1.

Acceptance checks (write a Node script using socket.io-client that plays a full 5-question text-mode interview):
- The state order is exactly WARMUP, ASK, LISTEN, THINKING, REACT, then FOLLOWUP/HINT/NEXT, ending with WRAPUP.
- Sending audio:chunk during ASK is ignored.
- A skipped question produces a skipped answer; stop ends the session with a partial score.
- Disconnecting mid-interview leaves no running timers (check with a log).
- The admin socket receives admin:live_feed events.
- Retry endpoint returns a delta and increments attemptNum.
```

---

## Phase 9: Progress, Streaks & Student Dashboard Data [ADDED]

```
Implement GET /api/progress/me and the supporting logic in a small progressController (or inside interviewController).

Return: { streakDays, practicedToday:boolean, weakTopics:[{ topic, avgScore }] (lowest 3 with at least 1 attempt), topicStats:[...], recentSessions:[{ id, noteSetTitle, totalScore, startedAt }] (last 5) }.
Also implement a lightweight drill scoring endpoint used by the frontend Skill Drills:
POST /api/drills/score { drillType: 'thirty_second'|'no_filler'|'pace_control'|'explain_simply', transcript, durationSec, wpm, fillerCount, words? } -> { score, passed, feedback }
Rules: thirty_second passes if 25..35 s and >= 40 words; no_filler passes if fillerCount == 0 over >= 20 s; pace_control passes if the average WPM is within 110..150; explain_simply passes if the transcript has >= 30 words and an average word length under 6.5 characters. A completed drill counts toward the daily streak.

Acceptance checks:
- A new student sees streakDays 0 and empty weakTopics.
- After two completed sessions on consecutive days, streakDays is 2.
- Drill scoring returns deterministic results for fixed inputs.
```

---

## Phase 10: Admin Controller (Analytics, Rubric, Content, Export, Model Packs)

```
Implement adminController and adminRoutes (all routes require role 'admin').

1. GET /api/admin/analytics -> { batchAvgScore, weakTopicDistribution:[{ topic, avgScore, count }], activeSessions:[...], totals:{ students, sessions } }.
2. GET /api/admin/rubric and PUT /api/admin/rubric: update contentWeight and deliveryWeight (must be between 0 and 1 and sum to 1.0 within 0.001, otherwise 400), phraseBanks (openers, reactions, transitions; each needs >= 10 non-empty unique strings), aiPackMode ('base'|'mid'|'high') and ramTier hints. Changes apply to new sessions only.
3. GET /api/admin/students and GET /api/admin/students/:id/history (all sessions with scores).
4. GET /api/admin/export-csv: STREAM a CSV (do not buffer everything) with columns: studentName, email, sessionId, date, noteSet, style, mode, question, type, attemptNum, wpm, fillerCount, longPauseCount, contentScore, deliveryScore, finalScore. Escape quotes/commas/newlines and prefix cells starting with = + - @ with a single quote to prevent CSV formula injection. Set Content-Disposition attachment filename talkready-export-YYYY-MM-DD.csv.
5. POST /api/admin/notes-pack: upload one or more .md/.txt/.pdf files as source 'prebuilt' using the same pipeline as Phase 3.
6. POST /api/admin/model-pack: multipart file + sha256 field; stream the file through crypto SHA-256, compare to the provided checksum (case-insensitive), store only on match under backend/assets/model-packs/ and record SystemConfig.modelPack; on mismatch delete the file and return 400 CHECKSUM_MISMATCH.

Acceptance checks:
- A weights payload that sums to 1.2 is rejected.
- Export opens correctly in Excel and a cell like =CMD() is neutralized.
- A model pack with a wrong checksum is rejected and not stored.
- All routes return 403 for a student token.
```

---

## Phase 11: Hardening, Security, Testing & Handover

```
Finalize the backend for real-time reliability.

1. Security: helmet, input validation on every route (use zod or express-validator), MIME/extension checks, upload size limits, sanitize regex input, no stack traces in production responses, never log passwords or tokens.
2. Reliability: unhandledRejection/uncaughtException logging, DB reconnect handling, socket per-event rate limiting (e.g., audio:chunk max 20 per second), maximum audio buffer per answer (3 minutes) to avoid memory blowups.
3. Tests: Jest + supertest for auth, notes upload, scoring (deterministic), question engine rules, follow-up rules, and one socket integration test running a full interview in text mode.
4. Documentation: README.md with prerequisites (Node 18+, MongoDB running locally), setup (`npm i`, copy .env.example, `npm run seed`, `npm run dev`), a table of every REST route and socket event, and troubleshooting (Mongo not running, port in use, AI bridge offline).
5. Add a Postman collection (JSON) in docs/ covering every endpoint.

Final acceptance checklist:
- Fresh clone -> npm i -> seed -> dev works with the AI bridge offline and online.
- All tests pass.
- A text-mode interview completes end to end through sockets and the report endpoint returns scores, coaching and sayItBetter.
- Admin CSV export, rubric update and live feed work.
- Purge-data removes all personal data.
```

## Local setup and troubleshooting

Prerequisites: Node.js 18 or newer, npm, and MongoDB running locally. The default MongoDB URL is `mongodb://127.0.0.1:27017/talkready`.

From the `Backend` directory, run:

```powershell
npm i
Copy-Item .env.example .env
npm run seed
npm run dev
```

Before seeding, set `JWT_SECRET`, `SEED_ADMIN_EMAIL`, and `SEED_ADMIN_PASSWORD` in `.env`. The API listens on port 5000 by default. Run the optional local AI stub in a separate terminal with `npm run mock:bridge`; it listens on port 8000. Set `AI_BRIDGE_URL` in `.env` to override that address. The backend remains usable when the AI bridge is offline.

Run all built-in Node and Jest tests with `npm test`; run only Jest tests with `npm run test:jest`.

| Problem | Check |
| --- | --- |
| MongoDB is unavailable | Start the local MongoDB service and verify `MONGO_URI`; the server starts in degraded mode and retries the connection. |
| Port 5000 is already in use | Stop the other process or set `PORT` to an available port in `.env`. |
| AI features report unavailable | Start the mock bridge or configure `AI_BRIDGE_URL`. Notes, scoring, and interviews retain their offline fallbacks. |
| Admin routes return 403 | Log in with the seeded admin account and send its bearer token. |

## REST API reference

All responses use the `{ "success": true, "data": ... }` or `{ "success": false, "error": ... }` envelope. Protected routes require a bearer JWT; admin routes require the admin role.

| Method | Route | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | Public | API, MongoDB, and AI bridge status |
| POST | `/api/auth/register` | Public | Register a student |
| POST | `/api/auth/login` | Public | Log in and receive a JWT |
| GET | `/api/auth/me` | Authenticated | Get the current user |
| PUT | `/api/auth/settings` | Authenticated | Update user settings, including RAM tier |
| DELETE | `/api/auth/purge-data` | Student | Purge the student's personal data |
| POST | `/api/notes/upload` | Authenticated | Upload a supported file or pasted notes |
| GET | `/api/notes` | Authenticated | List prebuilt and owned note sets |
| GET | `/api/notes/:id` | Authenticated | Get an accessible note set and its topics |
| DELETE | `/api/notes/:id` | Owner | Delete an owned note set |
| POST | `/api/interview/start` | Student | Create an interview session over REST |
| GET | `/api/interview/sessions` | Student | List the student's sessions |
| GET | `/api/interview/:id/report` | Student | Get the session report |
| POST | `/api/interview/:id/retry/:qid` | Student | Rescore an answer retry |
| GET | `/api/progress/me` | Student | Get progress, topic stats, and streak |
| POST | `/api/drills/score` | Student | Score a skill drill |
| GET | `/api/admin/analytics` | Admin | Get aggregate analytics and active sessions |
| GET | `/api/admin/rubric` | Admin | Read rubric and AI configuration |
| PUT | `/api/admin/rubric` | Admin | Update weights, phrase banks, and model settings |
| GET | `/api/admin/students` | Admin | List students |
| GET | `/api/admin/students/:id/history` | Admin | Get a student's session history |
| GET | `/api/admin/export-csv` | Admin | Stream an Excel-safe CSV export |
| POST | `/api/admin/notes-pack` | Admin | Upload prebuilt notes |
| POST | `/api/admin/model-pack` | Admin | Verify and store a model pack |

## Socket.IO event reference

Authenticate the Socket.IO handshake with `auth: { token }`. The `interview:start` acknowledgement returns `{ sessionId }`; emitted states contain the current state and session timing.

| Direction | Event | Purpose / payload |
| --- | --- | --- |
| Client -> server | `interview:start` | Start or resume an interview with `{ noteSetId, style, questionCount, mode, sessionId? }` |
| Client -> server | `interview:tts_done` | Signal that playback of the current prompt or response has finished |
| Client -> server | `audio:chunk` | Send a PCM16, 16 kHz audio chunk while in voice LISTEN state |
| Client -> server | `interview:answer_text` | Submit `{ text }` in text mode |
| Client -> server | `interview:listen_end` | End listening with `{ reason: "silence" \| "manual" }` |
| Client -> server | `interview:command` | Send repeat, hint, skip, pause, resume, stop, slower, or faster |
| Server -> client | `interview:state` | State, prompt text, optional audio, coaching, question index, and remaining time |
| Server -> client | `interview:timer` | Periodic `{ sessionId, remainingSec }` timer update |
| Server -> client | `interview:transcript` | Partial/final transcript and available word timing/confidence |
| Server -> client | `interview:error` | Controlled `{ code, message }` for a rejected event |
| Server -> admin room | `admin:live_feed` | Session, student, question, score, WPM, state, and update time |
| Socket.IO | `disconnect` | Pauses the active session and clears its timers |

The Postman collection covering the REST routes is available at [docs/TalkReady.postman_collection.json](./docs/TalkReady.postman_collection.json).
