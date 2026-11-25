# TalkReady: AI Assistant Microservice Build Prompts (Phase-Wise)

Stack: Python 3.10+ + FastAPI + Uvicorn, bound ONLY to `127.0.0.1:8000`. Offline STT/VAD (sherpa-onnx + Silero VAD), Piper TTS, ONNX MiniLM embeddings, fuzzy keyword repair, optional local LLM (llama-cpp-python). No cloud APIs, no API keys at runtime.

## How to use this document

1. Open an AI coding assistant in an empty `ai-assistant/` folder.
2. Paste **Section A (Shared Contract)** once at the start and keep it in context.
3. Paste **one phase prompt at a time**, in order. Move on only when all "Acceptance checks" pass.
4. **Phase 12 is mandatory.** It updates the backend's `aiBridgeService.js`, because the real routes of this module differ from the placeholder routes assumed in the Backend prompt file (see the note below).

Items marked **[ADDED]** are small additions that are not written in the original PDF but are needed for end-to-end operation.

### Important alignment note

The Backend prompt file assumed a bridge with `/stt`, `/tts`, `/embed`, `/generate`, `/health`. Your Module 3 PDF defines the real routes: `/ai/parse-notes`, `/ai/transcribe`, `/ai/synthesize`, `/ai/similarity`, `/ai/llm-assist`, `/ai/import-pack`. Those real routes are the source of truth. Phase 12 contains the prompt that realigns the backend.

### Model download note

Runtime is fully offline, but the model files must be downloaded **once** during setup (`scripts/fetch_models.*`). Download URLs and SHA-256 values must come from the official model release pages. Phase 1 tells the assistant NOT to invent hashes; you verify the first download and pin the hashes in `models/manifest.json`.

---

## Section A: Shared Contract (paste first, reuse in every phase)

```
PROJECT: TalkReady, an offline voice-based interview practice app (MERN).
I am building ONLY the ai-assistant/ microservice (Python). The Node backend (port 5000) calls it over HTTP. It must run with zero internet access.

GLOBAL RULES
- Python 3.10+, FastAPI, Uvicorn, pydantic v2, numpy, onnxruntime (CPU), sherpa-onnx, tokenizers, piper-tts (or piper ONNX via onnxruntime), pdfminer.six or pypdf, rapidfuzz, optional llama-cpp-python.
- Server binds to 127.0.0.1:8000 ONLY (never 0.0.0.0). Reject requests whose client host is not 127.0.0.1/::1.
- All models are loaded from models/ (gitignored). Load lazily, cache in memory, and keep the server usable if an optional model is missing.
- Every JSON response uses: success { "success": true, "data": ... } / failure { "success": false, "error": { "code", "message" } }.
- Never crash on bad input; validate with pydantic and return a clear error code.
- Audio format everywhere: 16 kHz, mono, PCM signed 16-bit little-endian, sent as base64 in JSON.

HARDWARE TIERS (set via env AI_TIER or POST /ai/tier, values: base | standard | high)
- base     (~3 GB): streaming English STT + Piper low voice + MiniLM embeddings. NO LLM.
- standard (4-6 GB): base + optional 1B-1.5B 4-bit GGUF LLM.
- high     (8 GB+): Whisper tiny/base STT + Piper medium voice + 3B 4-bit GGUF LLM.

ROUTES (the contract the Node backend relies on)
GET  /ai/health
  -> { status:'ok', tier, models:{ stt:bool, vad:bool, tts:bool, embeddings:bool, llm:bool, whisper:bool }, version }
POST /ai/parse-notes
  in : { text?: string, fileBase64?: string, filename?: string, title?: string }   (one of text or fileBase64; .md/.txt/.pdf)
  out: { topics:[string], chunks:[{ topic, text, wordCount, keywords:[string], hasDefinition:boolean, hasExample:boolean, definitions:[{term,definition}], embedding:[384 floats] }] }
POST /ai/transcribe
  in : { audioBase64, sampleRate:16000, keywords:[string], sessionId?:string, final?:boolean }
  out: { text, words:[{ w, start, end, conf }], corrected:[{ from, to }], speechDetected:boolean, endOfSpeech:boolean }
POST /ai/synthesize
  in : { text, rate?:number (1.0 normal, 0.7..1.3), variance?:boolean }
  out: { audioBase64 (WAV, base64), sampleRate, durationSec }
POST /ai/similarity
  in : { answer:string, chunkVector:[384 floats] }
  out: { similarity: number 0.0..1.0 }
POST /ai/llm-assist
  in : { chunk:string, answer:string, mode:'followup'|'say_it_better', style?:string, missedKeywords?:[string] }
  out: { text: string|null, llm:boolean }   (text null and llm:false when no LLM is active: the backend then uses its template)
POST /ai/import-pack
  in : { filePath:string, sha256:string, packType:'model'|'ai'|'notes' }
  out: { installed:boolean, packType, files:[string], sha256 }
POST /ai/tier  [ADDED]  { tier } -> switches active tier and (un)loads models.

SCORING IS NEVER DONE HERE. This service only returns text, timestamps, vectors, similarity numbers and audio. The Node backend computes grades deterministically.
```

---

## Phase 0: Project Bootstrap & FastAPI Skeleton

```
Using the shared contract, bootstrap ai-assistant/.

Create:
ai-assistant/
  models/ (with .gitkeep subfolders: stt/sherpa-streaming-en, stt/whisper-tiny-en, vad, tts/piper-en-medium, embeddings, llm)
  scripts/{fetch_models.sh,fetch_models.ps1}
  src/{stt_vad_engine,tts_engine,nlp_parser,embedding_engine,fuzzy_corrector,local_llm_adapter,pack_manager,app}.py
  src/{config.py,schemas.py,errors.py,model_registry.py}   [ADDED helpers]
  tests/
  requirements.txt, README.md, .gitignore (ignore models/*, __pycache__, .venv)

Implement now:
1. config.py: read env (AI_TIER default 'base', HOST fixed 127.0.0.1, PORT 8000, MODELS_DIR, MAX_AUDIO_SECONDS 180, MAX_UPLOAD_MB 10, WORKERS).
2. schemas.py: pydantic models for every route in the contract.
3. errors.py: custom exception -> failure envelope; global handlers for validation errors and unexpected exceptions (no stack traces in responses).
4. model_registry.py: a thread-safe lazy loader registry with load(name), unload(name), is_loaded(name), status(); each engine registers itself.
5. app.py: FastAPI app, localhost-only middleware (reject non-loopback clients with 403), GET /ai/health, stub handlers for all other routes returning 501 NOT_IMPLEMENTED for now, startup log of the tier and model availability.
6. requirements.txt with pinned versions; README with `python -m venv .venv`, install and run commands (`uvicorn src.app:app --host 127.0.0.1 --port 8000`).

Acceptance checks:
- The server starts with NO models present and /ai/health returns status ok with every model flag false.
- Starting with --host 0.0.0.0 is not documented anywhere and the loopback guard rejects remote clients.
- Sending invalid JSON returns the failure envelope, not a stack trace.
```

---

## Phase 1: Model Fetch Scripts & SHA-256 Verification

```
Implement scripts/fetch_models.sh (Linux/macOS) and scripts/fetch_models.ps1 (Windows PowerShell) plus models/manifest.json.

Requirements:
1. manifest.json lists every model: name, tier, destination folder, download URL, expected sha256, size. IMPORTANT: do NOT invent URLs or hashes. Use the official release locations (sherpa-onnx streaming English zipformer int8, sherpa-onnx whisper tiny.en int8, Silero VAD ONNX, Piper en_US medium and low voices (.onnx + .onnx.json), all-MiniLM-L6-v2 ONNX int8 with tokenizer.json, optional 1B-1.5B and 3B GGUF 4-bit models). For any hash you cannot verify, set "sha256": "PIN_ME" and print a clear warning.
2. Script options: --tier base|standard|high (default base), --only <name>, --pin (after a manual verification, writes the computed SHA-256 into the manifest), --verify-only.
3. Download with resume support (curl -C - / Invoke-WebRequest), verify SHA-256 (sha256sum / shasum -a 256 / Get-FileHash). On mismatch delete the file and exit non-zero with a clear message. Extract archives to the right folders.
4. Print a summary table: model, size, status (OK / MISSING / BAD HASH / UNPINNED).
5. The scripts must be idempotent: already verified files are skipped.
6. Document in README that this is the only step that needs internet.

Acceptance checks:
- Running with --verify-only on an empty models/ folder lists everything as MISSING without crashing.
- A tampered file is rejected and deleted.
- After downloading, `GET /ai/health` reports the matching model flags as true (after later phases wire them).
```

---

## Phase 2: Embedding Engine (MiniLM ONNX) & Cosine Similarity

```
Implement src/embedding_engine.py and the /ai/similarity route.

1. Load models/embeddings/all-MiniLM-L6-v2.onnx with onnxruntime CPUExecutionProvider and its tokenizer (tokenizers library, tokenizer.json). Max sequence length 256, truncation on.
2. embed(texts: list[str]) -> np.ndarray (n, 384): tokenize in batches (size 16), run the model, mean-pool over attention mask, L2-normalize, return float32.
3. cosine_similarity(a, b) -> float clamped to 0.0..1.0 (negative values clamp to 0).
4. POST /ai/similarity { answer, chunkVector }: validate vector length 384, embed the answer, return { similarity }. Empty or under-3-word answers return similarity 0.0 without error.
5. Run inference off the event loop (run_in_executor) with a small LRU cache (256 entries) keyed by text hash.
6. If the model is missing, return error code MODEL_MISSING (HTTP 503) so the Node backend can fall back to TF-IDF similarity.

Acceptance checks:
- Two paraphrases score > 0.7; unrelated sentences score < 0.35.
- 20 sequential calls average under 100 ms each on a normal laptop CPU.
- Missing model returns MODEL_MISSING and the server stays alive.
```

---

## Phase 3: Notes Parser & /ai/parse-notes (Local RAG Pipeline)

```
Implement src/nlp_parser.py and POST /ai/parse-notes.

Pipeline (5 steps from the spec):
1. Input handling: text, or fileBase64 with filename. Support .md, .txt (UTF-8 with fallback encodings) and .pdf (pypdf/pdfminer). Enforce MAX_UPLOAD_MB. A PDF with no text -> error EMPTY_DOCUMENT.
2. Heading & paragraph chunking: split Markdown on # and ## (also ### if sections are too large); subdivide each section into 80-200 word chunks on sentence boundaries; merge very short paragraphs; never cut mid-sentence; keep the topic name = nearest heading (or a generated name from the first sentence).
3. Keyword extraction: RAKE (implement a simple one) combined with TF-IDF across all chunks; return the top 5-8 lowercase keywords per chunk with stopwords removed.
4. Definition & example detection: regex patterns for "X is a/an/the ...", "X refers to ...", "X means ...", "X is defined as ..." returning definitions:[{term, definition}]; hasExample true when the text contains "for example", "e.g.", "such as", "for instance", or a code fence.
5. Embeddings: encode every chunk through embedding_engine.embed and return 384-float arrays. If embeddings are unavailable, return embedding: [] and continue (do not fail the whole request).

Output exactly as in the shared contract (topics + chunks). Keep processing under 5 seconds for a 20-page PDF by batching embeddings.

Acceptance checks:
- A markdown file with 6 headings yields 6+ topics, all chunks within 80-200 words (except a final short remainder, which is merged back or flagged).
- Definitions such as "A thread is a lightweight unit of execution" are extracted correctly.
- Works with a scanned (no-text) PDF by returning EMPTY_DOCUMENT.
```

---

## Phase 4: Speech Engine (Silero VAD + sherpa-onnx STT + Word Timestamps)

```
Implement src/stt_vad_engine.py.

1. Silero VAD (models/vad/silero_vad.onnx via onnxruntime): process 16 kHz PCM16 audio in 512-sample frames, maintain the model state, return per-frame speech probability. Implement a turn detector with these parameters: speech start threshold 0.5, speech end threshold 0.35, min speech 250 ms, trailing silence end threshold configurable 1500-2000 ms (default 1500). Expose: detect(audio) -> { speechDetected, endOfSpeech, speechSegments:[(start,end)] }.
2. STT with sherpa-onnx OnlineRecognizer (streaming English int8 zipformer from models/stt/sherpa-streaming-en/). Feed float32 samples, decode, and output words with token-level timestamps converted to word-level { w, start, end, conf }:
   - start/end in seconds relative to the start of the audio buffer.
   - conf 0..1 from the token log-probabilities when available; otherwise a documented default of 0.8 (flag in the response meta that confidence is estimated).
3. High tier: optional Whisper tiny/base (sherpa-onnx OfflineRecognizer) selected when tier is 'high'. Whisper does not give native word confidences: set conf from VAD-gated heuristics or the default and document this.
4. A session store keyed by sessionId (TTL 10 minutes, cleaned automatically) to support incremental audio: transcribe(audio_bytes, sessionId, final) appends to the session buffer and re-decodes. If no sessionId is given, the call is stateless and decodes the single buffer.
5. Guard rails: reject audio longer than MAX_AUDIO_SECONDS, reject non-16 kHz input with SAMPLE_RATE_UNSUPPORTED, handle odd byte lengths, and return text '' with speechDetected false for silence.
6. Thread-safety: use a lock or a per-session recognizer; never share one stream across sessions.

Acceptance checks (write tests with a short recorded WAV in tests/data):
- Word timestamps are monotonic and inside the audio duration.
- Pure silence returns speechDetected false with empty text.
- 1.5 s of trailing silence after speech sets endOfSpeech true; a 0.8 s pause does not.
- Two concurrent sessions do not mix transcripts.
```

---

## Phase 5: Fuzzy Keyword Repair

```
Implement src/fuzzy_corrector.py.

Goal: fix technical terms mis-heard by small STT models, e.g. "poly more fism" -> "polymorphism", "sequel" -> "SQL", "jay son" -> "JSON", "oh oh p" -> "OOP".

Requirements:
1. correct(words, keywords) -> { words, corrected:[{from, to}] } operating on the STT word list so timestamps are preserved. When several words are merged into one term, the merged word takes the first word's start and the last word's end and the minimum confidence.
2. Build a domain dictionary from the active note set keywords passed in the request (lowercased, deduplicated, up to 500 terms) plus a small built-in tech list (SQL, JSON, API, OOP, JVM, DBMS, CPU, RAM, HTTP, Python, Java, polymorphism, inheritance, encapsulation, deadlock, semaphore, normalization, etc.).
3. Matching: try n-gram windows of 1-4 consecutive words against each term using (a) Levenshtein ratio via rapidfuzz (threshold >= 85 for short terms, >= 80 for terms of 10+ characters) on the space-removed string, and (b) a phonetic key (Metaphone-style, write a small implementation) equality check. Accept a replacement only when it clearly improves the match and the original word is NOT a common English word with the same meaning in context (keep a small stoplist so words like "the", "is", "like" are never altered).
4. Never over-correct: do not change a word that already exactly matches a keyword; limit corrections to 25% of words in an answer.
5. Case: output the dictionary's canonical casing (e.g., "SQL", "JSON").
6. Return the list of corrections so the UI/backend can audit them.

Acceptance checks (unit tests):
- "poly more fism" -> "polymorphism"; "sequel" -> "SQL" only when SQL is in the keyword list.
- A normal sentence without technical terms is unchanged.
- Corrections keep timestamps ordered.
```

---

## Phase 6: /ai/transcribe Endpoint Integration

```
Wire the STT, VAD and fuzzy corrector into POST /ai/transcribe.

Flow:
1. Validate { audioBase64, sampleRate:16000, keywords, sessionId?, final? }. Base64-decode safely (size limit) and convert to int16 -> float32.
2. Run VAD and STT through the session store. The Node backend sends the accumulated answer buffer about every 1.5 s (partials) and once more with final:true.
3. Apply fuzzy_corrector with the provided keywords; return { text, words, corrected, speechDetected, endOfSpeech }.
4. For final:true: run a full re-decode of the whole buffer for best accuracy, delete the session, and return the final transcript.
5. Latency target: partial responses under 400 ms for a 3-second buffer on CPU in base tier. Add timing logs.
6. Return STT_UNAVAILABLE (503) if the STT model is missing so the Node backend can tell the UI to switch to Text mode.

Acceptance checks:
- Posting a known recorded sentence returns the correct text (corrected terms included) with word timestamps and confidences.
- final:true clears the session.
- Missing model returns STT_UNAVAILABLE.
```

---

## Phase 7: Piper TTS Engine with Human Cadence

```
Implement src/tts_engine.py and POST /ai/synthesize.

1. Load the Piper voice (.onnx + .onnx.json) from models/tts/piper-en-medium/ (base tier may load a 'low' voice if present). Keep the voice loaded in memory.
2. synthesize(text, rate=1.0, variance=True):
   - Convert rate to Piper length_scale = 1.0 / rate (clamp rate to 0.7-1.3).
   - Cadence variation: when variance is true, split text into sentences/clauses and apply a random speed factor within +/-5% per sentence; insert natural micro-pauses (80-180 ms of silence) after commas and 250-450 ms after sentence endings. Keep pauses deterministic for tests by allowing a seed.
   - Clean text for speech: expand common abbreviations, remove markdown symbols and code fences, convert "e.g." to "for example".
   - Concatenate audio and return a WAV (PCM16, mono) as base64 plus sampleRate and durationSec.
3. First-byte target under 250 ms for a short sentence in base tier; synthesize sentence by sentence and generate the first sentence first (the endpoint still returns one WAV; document a future streaming option).
4. Cache recent identical (text, rate) syntheses (LRU 64) because the Hint and Repeat commands replay the same text.
5. If the voice is missing return TTS_UNAVAILABLE (503); the frontend then uses the browser speech synthesis.
6. Limit text length to 1000 characters per request.

Acceptance checks:
- Output is a valid playable WAV (open with a Python wave reader).
- rate 0.8 produces a longer duration than rate 1.2 for the same text.
- Repeated identical calls are served from cache quickly.
```

---

## Phase 8: Optional Local LLM Adapter (Strict Grounding)

```
Implement src/local_llm_adapter.py and POST /ai/llm-assist.

1. Use llama-cpp-python to load a GGUF model from models/llm/ ONLY when the tier is 'standard' or 'high' and a model file exists. Context size 2048, threads = min(4, cpu_count), no GPU requirement. Lazy load and unload on tier change.
2. Strict grounding system prompt, used for every call:
   "Generate one short follow-up question or 'Say it better' rewrite using ONLY facts from the provided note chunk. If the chunk does not contain the information, say nothing extra. Do not add outside knowledge. Keep it under 60 words. Do not give a score."
3. Modes:
   - followup: input chunk, student answer, optional missedKeywords -> one short spoken-style follow-up question.
   - say_it_better: produce a 3-5 sentence improved spoken answer that includes the missed keywords, using only chunk facts.
4. Post-generation validation: reject (and return text:null, llm:true with a reason 'ungrounded') outputs where more than 40% of the content words do not appear in the chunk or answer; strip markdown, enforce the length limit, and ensure a follow-up ends with a question mark.
5. When no LLM is active (base tier or missing model) return { text:null, llm:false } with HTTP 200 so the Node backend uses its templates.
6. Generation timeout of 20 s (run in a worker thread); on timeout return text:null.
7. The LLM never produces or influences scores. Remove any numeric score from the output.

Acceptance checks:
- Base tier returns llm:false instantly.
- With a model present, the follow-up question references only terms from the chunk (verify with a unit test using the validation function).
- A timeout returns a controlled response.
```

---

## Phase 9: Pack Manager & /ai/import-pack (SHA-256)

```
Implement src/pack_manager.py and POST /ai/import-pack.

1. Input { filePath, sha256, packType: 'model'|'ai'|'notes' }. Only allow files inside a configured IMPORT_DIR (default ai-assistant/imports/) or an absolute path explicitly whitelisted in env IMPORT_ALLOWED_DIRS. Resolve and reject paths that escape these directories (path traversal) with PATH_NOT_ALLOWED.
2. Stream the file through SHA-256 in 1 MB blocks, compare case-insensitively to the expected value. Mismatch -> error CHECKSUM_MISMATCH and nothing is installed.
3. Supported archives: .zip and .tar.gz containing a pack.json (name, version, type, files[] with per-file sha256). Verify each inner file hash as well.
4. Safe extraction: reject absolute paths, '..' segments, symlinks and files above a size limit (zip-slip protection). Extract to a temporary folder first, then move atomically into the right destination:
   - model/ai packs -> models/<category>/...
   - notes packs -> an imports/notes-packs/ folder and return the file list so the Node backend can ingest them through its notes pipeline.
5. After installing a model/ai pack, refresh the model registry and report the new /ai/health flags.
6. Return { installed, packType, files, sha256 }. Log the action. Keep a backup of replaced files for one rollback (models/.backup/).

Acceptance checks:
- Wrong hash installs nothing.
- A zip with '../evil.txt' is rejected.
- A valid pack installs and /ai/health reflects the new model.
```

---

## Phase 10: Tier Management, Performance & Concurrency

```
Finalize hardware-tier behavior and performance.

1. POST /ai/tier { tier }: switch tier at runtime: base -> unload LLM and Whisper; standard -> allow LLM; high -> load Whisper (if present) and the 3B LLM (if present). Include memory estimates in logs. Reject unknown tiers.
2. Auto fall-back: if a tier's required model files are missing, fall back to the next lower tier, log a warning and show it in /ai/health ({ requestedTier, activeTier }).
3. Concurrency: use a bounded thread pool (WORKERS default 2) so STT, TTS and embeddings do not block each other; apply a semaphore for LLM (1 at a time). Return BUSY (429) with a Retry-After header if the queue exceeds the limit.
4. Warm-up on startup: run a tiny dummy inference for each loaded model so the first real request is fast.
5. Memory protection: cap request body size, cap session store size (max 50 sessions) and cleanup expired sessions every 60 s.
6. Structured logging with request id, route, duration; never log full audio or full note text.

Acceptance checks:
- Switching tiers changes /ai/health model flags immediately.
- 10 parallel /ai/similarity calls and 2 /ai/transcribe calls complete without errors.
- Memory usage stays stable after 200 sequential requests.
```

---

## Phase 11: Tests, Packaging & README

```
1. Write pytest tests for: embedding similarity, parser chunk sizes, definition extraction, fuzzy corrector, VAD end-of-speech, TTS WAV validity and rate difference, pack checksum and zip-slip, loopback guard, tier switching. Mark tests that need model files with @pytest.mark.models so the suite also runs on a machine without models.
2. Add a tests/smoke_client.py that calls every route against a running server and prints PASS/FAIL per route.
3. README: prerequisites, setup (venv, requirements, fetch_models), run command, route table with sample curl commands, tiers and RAM guidance, troubleshooting (missing model flags, microphone sample rate errors, slow CPU), and the privacy statement (no network at runtime).
4. Provide start scripts: run_ai.sh and run_ai.ps1 that activate the venv and start uvicorn on 127.0.0.1:8000.
5. Verify that with the network disabled (airplane mode) every route still works.

Acceptance checks:
- `pytest` passes without models (model tests skipped) and with models.
- smoke_client reports PASS for all routes with base-tier models.
- No outbound network connections occur at runtime (check with a socket-blocking test fixture).
```

---

## Phase 12: Backend Integration Alignment (run this in the BACKEND project)

```
CONTEXT: In my Node backend (backend/), services/aiBridgeService.js was written for a placeholder bridge contract (/stt, /tts, /embed, /generate, /health). The real Python microservice at http://127.0.0.1:8000 exposes the routes below. Update the backend to use the REAL routes.

REAL ROUTES (envelope: { success, data } or { success:false, error:{code,message} })
GET  /ai/health
POST /ai/parse-notes   { text?, fileBase64?, filename?, title? } -> { topics, chunks:[{ topic, text, wordCount, keywords, hasDefinition, hasExample, definitions, embedding }] }
POST /ai/transcribe    { audioBase64, sampleRate:16000, keywords, sessionId?, final? } -> { text, words:[{w,start,end,conf}], corrected, speechDetected, endOfSpeech }
POST /ai/synthesize    { text, rate, variance } -> { audioBase64, sampleRate, durationSec }
POST /ai/similarity    { answer, chunkVector } -> { similarity }
POST /ai/llm-assist    { chunk, answer, mode:'followup'|'say_it_better', style?, missedKeywords? } -> { text|null, llm:boolean }
POST /ai/import-pack   { filePath, sha256, packType } -> { installed, packType, files, sha256 }
POST /ai/tier          { tier }

Tasks:
1. Rewrite services/aiBridgeService.js with: health(), parseNotes(), transcribe(), synthesize(), similarity(), llmAssist(), importPack(), setTier(). Unwrap the envelope, use AbortController timeouts (health 1 s, similarity 3 s, transcribe 8 s, synthesize 6 s, parse-notes 30 s, llm-assist 20 s), cache health for 5 s, and NEVER throw to callers when the bridge is down: return { available:false } style results.
2. notesController: when the bridge is available, call parseNotes() and store the returned chunks, keywords, hasDefinition, hasExample and embeddings; when it is not available, use the existing JavaScript parser. Question generation stays in questionEngine.js.
3. scoringRubric: semanticSimilarity = aiBridge.similarity(answer, chunk.embedding); on any failure or empty embedding, fall back to the TF-IDF cosine similarity. Scores remain fully deterministic and the LLM is never used for scoring.
4. interviewSocket: LISTEN partial transcripts call transcribe() with the active note set keywords and a per-question sessionId, with final:true on listen_end. Use the returned word timestamps and confidences for WPM, pauses and clarityScore. If transcribe returns STT_UNAVAILABLE, emit interview:error { code:'STT_UNAVAILABLE' } so the frontend switches to Text mode.
5. TTS: map the session speed (slower/faster) to the `rate` parameter. On TTS_UNAVAILABLE send audioBase64:null so the frontend uses browser speech synthesis.
6. followUpEngine and Say It Better: only when SystemConfig.aiPackMode is 'mid' or 'high' AND llmAssist() returns llm:true with non-null text, use it; otherwise use the existing templates.
7. adminController: the model-pack endpoint saves the uploaded file into the AI folder's imports/ directory, then calls importPack({ filePath, sha256, packType }).
8. Update scripts/mockBridge.js to expose the real /ai/* routes with fake but valid responses (384-dim vectors, a tiny valid WAV) so the backend can be tested without models.
9. Update the Postman collection and README table accordingly.

Acceptance checks:
- With the Python service running: a full voice interview shows real transcripts, a real similarity value feeds the score, and TTS audio plays in the browser.
- With the Python service stopped: notes upload, scoring (TF-IDF fallback), text-mode interviews and admin features still work.
- Stopping the service mid-interview produces a clear interview:error and the UI can continue in Text mode.
```
