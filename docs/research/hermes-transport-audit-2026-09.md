# Hermes transport audit 2026-09

## Introduction

A 92-agent read-only audit ran on 2026-09-16 and 2026-09-17 against the AOS Hermes
adapter pinned at `NousResearch/hermes-agent@47685348eaca9d673719003b9e03a71becfa6423`
(HEAD 2026-09-16). Each finding required two independent confirmation votes and zero
refutation votes. The audit produced 37 confirmed defects across five root-cause
clusters: transport reliability, run lifecycle, rejection handling, replay/dedup
ownership, and interactions protocol mismatch. This document records each confirmed
finding for engineering reference and fix tracking.

Raw audit data: `~/.claude/projects/-home-anakin-projects-aos-ui/3ee71a8b-d477-45da-841e-682cc0304ea7/research/hermes-audit.json`

---

## Finding 1: discover() replays the whole retained ring, so a previous turn's terminal frames settle the freshly discovered run while Hermes is mid-turn

**Severity:** HIGH  
**Location:** `packages/proxy/adapters/hermes/run.ts:1057`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

Session discovery recovers with no cursor, replays every retained frame of the live session (including earlier turns), and the first replayed message.complete / idle session.info terminates the new run before the current native turn produces anything.

### Mechanism

1. packages/proxy/routes/sessions.ts:41-45 calls sessions.discover whenever the coordinator has no execution and the dashboard reports the Session active; coordinator #discover (packages/proxy/core/session-coordinator.ts:258-268) calls engine.discover. 2) interactions.ts #reconcile (740-806) does session.resume and reports status 'running' when result.running===true. 3) run.ts:1054-1058 then calls this.recover(scope,{threadId,runId}) with NO position. 4) recover() (run.ts:950-953) calls native.recover(liveSessionId, undefined); adapter.ts:1248-1251 omits last_seen; upstream methods_session.py:2214 defaults last_seen=0 and event_replay.py events_since returns every retained frame (ring is per-session, 512 events / 4 MiB, FIFO only; nothing clears it at turn boundaries). 5) run.ts:961 sets lastSeen=0 and validatedRecovery(recovery, liveId, undefined) (453-491) accepts all frames because previous===undefined. 6) run.ts:1017 #accept()s each frame in order: the previous turn's message.complete status:'complete' hits run.ts:1408 #finish -> RUN_FINISHED and #settle; if the previous turn ended status:'error', run.ts:1401 sets failedCompletionObserved and the previous turn's session.info running:false (always emitted, prompt_turn.py:917-942) hits run.ts:1346-1351 -> RUN_ERROR 'Hermes could not complete this run.'. The run is terminal (run.ts:1162), so the live turn's frames are dropped. Test run.test.ts:2817 ('discovers and reattaches...') mocks recover with an empty ring and does not pin this; validatedRecovery's initialLastSeen (487-490) is computed for exactly this cursor and never used.

### Repro

native mock: inspectExecution -> {status:'running'}; recover(liveId, undefined) -> {epoch:'e1', lastSeen:8, events:[ {type:'message.start',seq:1}, {type:'message.delta',seq:2,payload:{text:'old'}}, {type:'message.complete',seq:3,payload:{text:'old',status:'error',error:'x'}}, {type:'session.info',seq:4,payload:{running:false}}, {type:'message.start',seq:5}, {type:'message.delta',seq:6,payload:{text:'new'}} ]}. await engine.discover(scope,'aos-recovered-1'); collect(handle.events) -> [RUN_STARTED, TEXT 'old', TEXT_MESSAGE_END, RUN_ERROR AOS_PROVIDER_RUN_FAILED 'Hermes could not complete this run.'] and the 'new' delta is never emitted. Variant with seq 3 status:'complete' yields a premature RUN_FINISHED.

### Fix sketch

Give discover() a real cursor: either (a) pass a seq barrier derived from the ring itself — after recover(liveId, undefined) drop every replayed frame at or before the last frame that closed a turn (message.complete or session.info running:false) that precedes the last message.start, or (b) seed from the current turn: compute lastSeen = seq of the last message.start with no later terminal frame minus 1, and reject discovery when no open turn exists in the ring (reconcile from HTTP history instead). Also stop treating replayed frames older than the current native turn as authoritative for nativeErrorObserved. Add the repro above as a contract test next to run.test.ts:2817.

---

## Finding 2: Definitive prompt.submit rejections are collapsed into AOS_SEND_UNCERTAIN, which fences the Session forever (every later run fails with run_conflict)

**Severity:** HIGH  
**Location:** `packages/proxy/adapters/hermes/run.ts:869`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

An authoritative JSON-RPC rejection of prompt.submit (4001 stale session id, 4090 session-slot limit, 5070/5071 storage) is reported as 'may have accepted', the ActiveRun stays in #active with a closed queue, and nothing ever releases it because Hermes never emits the idle session.info that the fence waits for.

### Mechanism

1. adapter.ts:1341-1347: any throw from transport.request('prompt.submit') goes through throwUnavailable (adapter.ts:301-304), which erases HermesRpcRejectedError(code) into HermesUnavailableError. 2) run.ts:860-869: the generic catch sets acknowledgement='uncertain'. 3) run.ts:882-887 -> #markUncertain (1725-1734): emits RUN_ERROR AOS_SEND_UNCERTAIN, closes the queue, sets active.uncertain=true but does NOT #settle, so the scope key stays in #active. 4) Release paths: a session.info running:false reaching run.ts:1331-1352 (#settle at 1352, pinned by run.test.ts:3051) — but for a refused prompt Hermes never set running=True (methods_prompt.py:592-596 refuses before _lock_in_submit_turn; 4001 from _sess_nowait server.py:1161-1177 means the sid is gone), so no idle edge ever arrives; or a /reconnect with the exact runId (run.ts:902-914) — the browser only redials for AOS_CONNECTION_INTERRUPTED (aos-client.ts reconnectingSse). 5) Every subsequent engine.start throws ServerRunConflictError at run.ts:679; the coordinator independently holds state 'uncertain' (session-coordinator.ts:191-199, 653-657) and rejects at 344-345. The 4001 case is realistic: the registry keeps returning the cached liveSessionId (attachment-registry.ts:64-66) even after Hermes reaped/closed that live session (another client closed it, or the orphan reaper ran after a half-open socket), so submit targets a dead sid.

### Repro

native mock where submit rejects: transport.request('prompt.submit') rejects with new HermesRpcRejectedError(4090) (or 4001). collect(await engine.start(scope,input())) -> [RUN_STARTED, RUN_ERROR AOS_SEND_UNCERTAIN]. Then engine.start(scope,input({runId:'run-2'})) rejects with ServerRunConflictError; no native frame will ever arrive to release it. Engine-level version: submit: async () => { throw new HermesUnavailableError() } then a second start() -> conflict.

### Fix sketch

Preserve rejection identity across the adapter boundary: let submit() return {acknowledgement:'rejected', reason: code} for HermesRpcRejectedError (prompt.submit path, mirroring the slash path at adapter.ts:1332-1333) and reserve 'uncertain' for HermesRpcUncertainError/timeouts. In run.ts map rejected -> #fail (settled, AOS_PROVIDER_RUN_FAILED with a sanitized reason class) and only real uncertainty -> #markUncertain. For 4001 additionally invalidate the registry entry (drop the cached liveSessionId) so the next resume re-attaches. Independently, give the uncertain fence an exit: on the next start() for an uncertain scope, run a status()/resume reconciliation instead of throwing conflict.

---

## Finding 3: Pre-submit status() rejects with AOS_SESSION_BUSY during Hermes' post-completion window right after AOS already emitted RUN_FINISHED

**Severity:** MEDIUM  
**Location:** `packages/proxy/adapters/hermes/run.ts:819`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

AOS finishes a run at message.complete and immediately admits the next run, but Hermes keeps session.running=True until its turn thread's finally block; a fast follow-up submit sees active_list 'working' and is terminally failed as busy instead of waiting or being queued.

### Mechanism

1. run.ts:1403-1408: message.complete status!=='error' -> #finish -> RUN_FINISHED and #settle (removes the scope from #active, 1798). Coordinator marks the execution idle on RUN_FINISHED (session-coordinator.ts:643-652), so the next POST /runs is admitted. 2) Upstream emits message.complete at prompt_turn.py:901, then runs _goal_followup_after_turn, _after_complete_turn (LoopManager read + DB set_session_title, 359-384), _publish_session_control_snapshot, and _finish_turn (768+, includes trim_memory/malloc_trim, TTS sentinel, model restore) before session['running']=False at 917 and session.info at 942. 3) During that window _session_live_status returns 'working' (server.py:2668-2675). 4) run.ts:810-825: status()!=='idle' -> #fail AOS_SESSION_BUSY 'Hermes is already running this Session.' — terminal; the user's message is lost. Upstream itself would not reject: prompt.submit while running goes through _handle_busy_submit and returns queued/steered (methods_prompt.py:636-647). The AOS message queue (message-queue.tsx / thread.aui.tsx:1055-1063 steer -> run_conflict fallback -> submitOrdinary) makes the follow-up submit land exactly at RUN_FINISHED, maximising the race. run.test.ts:2794 pins busy-rejection generally but not this timing conflict with AOS's own early finish.

### Repro

native mock: status = vi.fn().mockResolvedValueOnce('idle').mockResolvedValueOnce('running').mockResolvedValue('idle'); observe captures publish; run-1: start -> publish message.start(seq1), message.complete(seq2,{text:'ok',status:'complete'}); await handle.settled. Immediately engine.start(scope,input({runId:'run-2'})) -> events [RUN_STARTED, RUN_ERROR AOS_SESSION_BUSY] and submit count stays 1, although publishing session.info running:false a few ms later shows Hermes was merely settling.

### Fix sketch

Do not treat a single 'working' read as terminal when AOS itself just completed the previous run on this scope: keep a per-scope 'settling' marker from #finish until the observer sees session.info running:false (the previous run's observer is currently torn down at #settle, so retain a lightweight idle-watcher or re-poll status() with a short bounded backoff before deciding). Alternatively drop the pre-check and let Hermes queue the prompt, treating a 'queued' prompt.submit result as accepted and waiting for the next message.start. Keep AOS_SESSION_BUSY only for a genuinely foreign turn (no AOS completion observed).

---

## Finding 4: No client heartbeat: a half-open socket is reused, so in-flight runs silently stall and Stop/Send become 'uncertain' while Hermes reaps the parked session

**Severity:** MEDIUM  
**Location:** `packages/proxy/adapters/hermes/transport.ts:410`  
**Fixed by vendoring:** Yes — resolved by vendoring upstream client

### Summary

The transport reuses any socket with readyState===1 and never pings, so a dead-but-open connection is only discovered by 15 s RPC timeouts that are classified as uncertain, while Hermes has already detached the session and armed the 20 s orphan reaper.

### Mechanism

1. transport.ts:409-416 #ensureSocket returns the existing socket whenever readyState===1; there is no gateway.ping, no read-deadline (grep ping|heartbeat in transport.ts is empty), unlike upstream json-rpc-channel.ts (15 s heartbeat / 45 s deadline). 2) After a NAT/proxy/TCP half-open failure, Hermes' side closes (ws.py drain kill / socket close) and _close_sessions_for_transport parks every AOS session on the drop sentinel and schedules the orphan reap (session_lifecycle.py:648-690; idle sessions torn down after grace, running ones interrupted as client_gone once stale). 3) AOS keeps believing it is attached: events stop arriving (no observer 'disconnected' since no close event), so the active run hangs; a Stop -> session.interrupt -> 15 s timeout -> HermesRpcUncertainError (transport.ts:363-368) -> adapter.ts:1357 throwUnavailable -> run.ts:1564-1566 AOS_STOP_UNCERTAIN; a new Send -> prompt.submit timeout -> run.ts:869 uncertain -> AOS_SEND_UNCERTAIN fence (see the rejection finding). 4) Once the socket finally errors, #lost -> #invalidate (505-519) fires AOS_CONNECTION_INTERRUPTED for every run and the registry zeroes every live id (attachment-registry.ts:183-191); the browser redial then hits session.resume on a possibly reaped session.

### Repro

FakeSocket that stays readyState 1 but never delivers frames after prompt.submit was acknowledged: publish message.start; then stop the fake from echoing; call handle.stop() -> rejects with HermesRunPublicError AOS_STOP_UNCERTAIN after timeoutMs; the ActiveRun is still in #active and no AG-UI terminal event was emitted. With the upstream client the deadline would have invalidated the socket and surfaced a disconnect within 45 s.

### Fix sketch

Adopt the vendored JsonRpcRequestChannel heartbeat (start on gateway.ready.heartbeat===true, any-inbound liveness) and treat deadline expiry as a connection loss that triggers the wrapper's redial with reconnect-backoff plus session.resume re-attachment for every registry entry, so Hermes never sees AOS as an orphan for >20 s. Keep RPC timeouts classified as uncertain only for mutations that were actually written to a live socket.

---

## Finding 5: Socket loss leaks transport observers: after N redials every frame is delivered N+1 times and pre-active buffers fill N+1 times faster

**Severity:** LOW  
**Location:** `packages/proxy/adapters/hermes/transport.ts:404`  
**Fixed by vendoring:** Yes — resolved by vendoring upstream client

### Summary

#disconnectObservers notifies but never removes observers, and the registry discards its stop handle without calling it, so each reconnect adds another live observer; duplicates are only hidden by seq dedup in #accept, not in the pre-active buffer.

### Mechanism

1. transport.ts:404-407 #disconnectObservers iterates #eventObservers and calls disconnected() but does not delete them; observeEvents (382-392) only removes on the returned stop. 2) attachment-registry.ts:183-191: the disconnected handler sets #stopObservation=undefined and #observation=undefined without invoking the old stop, then #observe() (171-173) registers a NEW observer on the next subscribe. The old observer remains in the transport set and receives frames from the new socket (#publishEvent 400-402 publishes to all). 3) Each frame is therefore routed to each ActiveRun listener N+1 times. run.ts:1170-1172 drops duplicates by seq once accepting, but start()/recover()/#reattach buffer pre-active frames without dedup (run.ts:706, 369-384) against MAX_PREACTIVE_EVENTS=4096 / 4 MiB (run.ts:39-40); overflow at 760/1000/1124 -> RUN_ERROR AOS_RESET_REQUIRED. 4) disconnected also fires N+1 times per loss, re-running the registry wipe and every reset callback.

### Repro

Transport test: observeEvents(l1,d1); simulate socket close -> d1 fires; call observeEvents(l2,d2) (as the registry does after reset) without calling l1's stop; deliver one event frame on the new socket -> both l1 and l2 receive it (2 deliveries). Registry test: resolve observe once, invoke the disconnected callback, subscribe again -> native.observe called twice and the first stop never invoked.

### Fix sketch

In the vendored wrapper, own exactly one event subscription per gateway client and clear observers on invalidate; in the registry call the previous stop before re-observing (or make the wrapper's subscription survive redials so the registry never re-subscribes). Add seq dedup to bufferNativeEvent or dedupe at the single replay owner.

---

## Finding 6: message.complete status:'interrupted' is reported as a successful RUN_FINISHED (open tools marked completed)

**Severity:** LOW  
**Location:** `packages/proxy/adapters/hermes/run.ts:1408`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

Only status:'error' is special-cased; a turn cancelled by another client or by Hermes' client_gone orphan reaper ends as an ordinary success in AOS.

### Mechanism

1. Upstream _result_status yields 'interrupted' when the agent loop was interrupted (prompt_turn.py:289-292) and message.complete carries it (TurnStatus complete|error|interrupted). Producers: session.interrupt from Hermes Desktop/TUI on the same session (methods_session.py:2017-2045) and the WS orphan reaper's client_gone interrupt (session_lifecycle.py:609-611). 2) run.ts:1397 checks only payload.status==='error'; every other status falls to 1403-1408 -> #finish(active) with result undefined -> #settleOpenTools(...,'completed') (1668-1676) and RUN_FINISHED outcome success. 3) The AOS-initiated Stop path (#stop, 1558-1579) also relies on this frame when status() was not yet idle: the run then finishes as success without {stopped:true}, unlike the 1344/1571 paths.

### Repro

native mock: submit publishes message.start(seq1), tool.start(seq2,{tool_id:'t1',name:'search'}), message.complete(seq3,{text:'',status:'interrupted'}). collect(start) -> [..., TOOL_CALL_RESULT content '{"status":"completed"}', RUN_FINISHED outcome success with no result.stopped].

### Fix sketch

Map status:'interrupted' to #finish(active,{stopped:true}) (tools settled as 'stopped'), consistent with run.ts:1344/1571, and keep status:'complete' as the only plain success. Add a contract test for the interrupted completion frame.

---

## Finding 7: Half-open socket is never detected: no heartbeat and RPC timeouts do not invalidate the socket

**Severity:** HIGH  
**Location:** `packages/proxy/adapters/hermes/transport.ts:365`  
**Fixed by vendoring:** Yes — resolved by vendoring upstream client

### Summary

After a silent TCP drop (sleep, NAT/proxy idle timeout, VPN reconnect) the socket keeps readyState 1, every RPC times out as HermesRpcUncertainError, observers are never told, and the transport never redials because #ensureSocket reuses the dead socket.

### Mechanism

transport.ts has no gateway.ping/heartbeat at all (grep ping|heartbeat is empty; gateway.ready.heartbeat from upstream ws.py ~301 is ignored). request() arms a 15 s timer that only deletes the pending entry and rejects uncertain (transport.ts:365-368); it does not call #lost/#invalidate. #ensureSocket returns the existing socket whenever readyState===1 (transport.ts:409-410), and a half-open socket stays at 1 until the OS reports the TCP failure (Linux keepalive default ~2 h, or never). #disconnectObservers only runs from #invalidate(notify=true) (transport.ts:511-519), which only runs from #lost (505-509) on error/close/bad frame. So: live events stop arriving, prompt.submit -> 15 s -> uncertain -> adapter.ts:1346 throwUnavailable -> run.ts:869 acknowledgement='uncertain' -> #markUncertain (run.ts:882-887) -> AOS_SEND_UNCERTAIN; session.active_list/session.resume reads -> HermesUnavailableError -> 503; running runs hang without AOS_CONNECTION_INTERRUPTED so the browser never redials. Upstream documents exactly this failure (json-rpc-channel.ts:129-135: 'A silent drop ... kills the TCP socket without a close event, so the client hangs forever (issue #32997)') and answers it with a 15 s ping / 45 s deadline that fails the transport (json-rpc-channel.ts:461-471 failHeartbeat; json-rpc-gateway.ts ~312-333 invalidate -> dropSocket; ~377-380 startHeartbeat on gateway.ready.heartbeat===true). Meanwhile Hermes itself sees the socket die, detaches the sessions and orphan-reaps idle ones after 20 s (session_lifecycle.py:556-634), so the registry's live ids also go stale (see finding 3).

### Repro

Unit (transport.test.ts style, fake timers): 1) open transport with FakeSocket whose send() records but never replies; 2) const stop = await transport.observeEvents(listener, disconnected); 3) const p = transport.request('session.active_list', {}); advance 15_000 ms -> p rejects HermesRpcUncertainError; 4) assert socket.readyState===1, disconnected not called; 5) await transport.request('profiles.list', {}) -> socketFactory still called once (same dead socket reused), request times out again. Expected: after a heartbeat deadline (or on RPC timeout) the socket is invalidated, observers get disconnected, and the next request redials.

### Fix sketch

Vendor JsonRpcGatewayClient/JsonRpcRequestChannel and start the heartbeat on gateway.ready.heartbeat===true (any-inbound liveness is fine server-side). In the thin wrapper, treat channel failure/deadline the same as close: invalidate generation, reject pendings as uncertain, notify observers once, and let the wrapper's redial (reconnect-backoff) reopen. As a minimal stopgap in the current transport, call this.#lost(socket) when an RPC times out so at least the next call redials.

---

## Finding 8: session.events.since replies can exceed the 2 MiB frame bound (upstream ring is 4 MiB) and one such reply kills the shared socket for every Session

**Severity:** HIGH  
**Location:** `packages/proxy/adapters/hermes/transport.ts:454`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

A legitimate replay reply larger than 2 MiB is treated as a protocol violation: the whole multiplexed socket is closed, all pending RPCs become uncertain and every active run gets AOS_CONNECTION_INTERRUPTED; discover() requests the full ring so this recurs on every history load of a busy Session.

### Mechanism

MAX_NATIVE_SOCKET_FRAME_BYTES = 2 MiB (transport.ts:4). #receive checks socketFrameWithinBound(event) before knowing which request the frame answers and calls #lost(socket) on failure (transport.ts:453-461) -> #invalidate rejects every pending RPC uncertain and fires disconnected on every observer (511-519) -> registry wipes all live ids and fires every reset (attachment-registry.ts:183-191) -> each active run emits AOS_CONNECTION_INTERRUPTED (run.ts:1747-1757). Upstream retains up to _REPLAY_BUFFER_BYTES_MAX = 4 MiB of params per session (event_replay.py:28-34; comment: 'many bounded 64 KiB tool results') and session.events.since returns all of them in one frame with no size cap, last_seen defaulting to 0 (methods_session.py: int(params.get('last_seen', 0)); events_since returns every retained event). AOS asks for the full ring whenever discover() runs: run.ts:1057 calls recover(scope,{threadId,runId}) with no position -> adapter.ts:1250 omits last_seen. discover() runs on every history load while Hermes reports the Session running and the coordinator has no execution (routes/sessions.ts:41-45; session-coordinator.ts:237-244). A turn with ~35 tool results near the 64 KiB cap already exceeds 2 MiB. The reply frame kills the socket; the in-flight recover rejects -> run.ts:985-988 throws providerUnavailable -> discover rejects -> history load fails; the browser retries the load -> same request -> same kill. transport.test.ts:558-580 pins 'oversized reply closes the socket', but that intent is wrong against the upstream contract for this RPC.

### Repro

Unit: 1) transport with FakeSocket; 2) observeEvents(l1,d1) and observeEvents(l2,d2) (two Sessions); 3) const r = transport.request('session.events.since',{session_id:'live-a'}); 4) reply on the socket with a valid JSON-RPC result frame whose events array serializes to 2 MiB + 1 byte (well under upstream's 4 MiB ring). Observe: r rejects HermesRpcUncertainError, d1 and d2 both called, socket.readyState===3. Expected: only r fails (typed 'response too large'), other Sessions unaffected. Integration: HermesRunEngine.discover on a Session whose ring holds >2 MiB -> every active run receives AOS_CONNECTION_INTERRUPTED.

### Fix sketch

Keep bounds in the wrapper but scope them: enforce a per-request response bound by rejecting that request with a typed HermesRpcRejectedError-like 'oversized response' instead of dropping the socket; set the ceiling for session.events.since to >= 4 MiB + envelope (match event_replay.py) and only treat truly unparseable/oversized _event_ frames as socket faults. Independently, never request the full ring: discover/recover without a position should seed last_seen from latest_seq (or the current turn's message.start seq) and reconcile from HTTP history, which also fixes the stale-replay false failures noted in the run-engine map.

---

## Finding 9: Authoritative 4001/4007 rejection of prompt.submit on a stale live id becomes AOS_SEND_UNCERTAIN and the registry never invalidates the binding, bricking the Session

**Severity:** HIGH  
**Location:** `packages/proxy/adapters/hermes/adapter.ts:1346`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

When Hermes no longer holds the cached live session id, prompt.submit is refused with a JSON-RPC error (nothing was mutated) but AOS reports the send as uncertain, keeps the stale id bound (and retained by the uncertain run), and every reconnect reuses it, so the Session is stuck until proxy restart.

### Mechanism

Registry ensure() returns the cached liveSessionId without any RPC (attachment-registry.ts:65) for up to idleMs (default 300 s, configurable to 24 h, config.ts:115) and indefinitely while retained (subscriber retain at 105; pending-interaction retain at adapter.ts:1145-1152). Hermes drops runtime ids without any socket event: idle TTL (_SESSION_TTL_S default 6 h, server.py:355), LRU eviction, session.close from another client (Desktop/TUI), or orphan reap after a socket drop that the registry did not observe (its disconnected handler at attachment-registry.ts:183-191 only runs if #observe was ever called; #requireAttachedSession only ensure()s, adapter.ts:720-728). Upstream then answers any session-scoped RPC with 4001 'session not found' and states 'the client should session.resume the STORED id' (server.py:1161-1177), or 4007 'session no longer live; retry resume' (session_lifecycle.py:497-501). In AOS: start() -> resume (cached stale id) -> observe -> recover(stale, MAX_SAFE_INTEGER) succeeds (events_since returns [] for unknown sid, no error) -> status(stale) returns 'idle' because the row is absent (adapter.ts:1395) -> submit -> transport rejects with HermesRpcRejectedError(4001) -> adapter.ts:1341-1348 catch -> throwUnavailable (296-299) erases the rejected/uncertain distinction -> run.ts:860-869 sets acknowledgement='uncertain' -> #markUncertain (882-887) emits AOS_SEND_UNCERTAIN and closes the queue but keeps the run in #active with its subscriber retainer. Coordinator marks the execution uncertain; a later /reconnect -> #reattach -> native.resume -> registry ensure -> still the cached stale id (no invalidation anywhere) -> recover returns [] -> nothing ever settles (run.ts:1089-1145). New Sends get run_conflict (session-coordinator.ts:344-345). run.test.ts:1931-1955 pins 'any throw from submit = uncertain' for the engine; no adapter test covers a rejected prompt.submit.

### Repro

Adapter-level test: rpc router { 'session.resume' -> {session_id:'live-a', running:false}, 'session.events.since' -> {events:[],latest_seq:0,truncated:false,epoch:'e'}, 'session.active_list' -> {sessions:[]}, 'prompt.submit' -> throw new HermesRpcError(4001) }. 1) engine.start(scope, input()) -> collect -> observe RUN_ERROR AOS_SEND_UNCERTAIN (expected: not uncertain; either re-resume once and retry, or AOS_RESET_REQUIRED/AOS_PROVIDER_RUN_FAILED). 2) engine.recover(scope,{threadId, runId:'run-1'}) -> assert 'session.resume' was called again (it is not; registry served the cache) and the handle never settles.

### Fix sketch

In adapter.submit/interrupt/redirect, propagate HermesRpcRejectedError as an authoritative outcome (rejected, never uncertain) and reserve 'uncertain' for HermesRpcUncertainError; on codes 4001/4007 invalidate the registry entry (drop byLiveId + liveSessionId, evict #attachmentInfo) and re-resume once before failing. Give the registry an explicit invalidate(liveSessionId) used by that path and by the reattach flow so a rebinding always goes through session.resume on the current socket.

---

## Finding 10: Event observers leak across socket generations: each redial multiplies event and disconnect fan-out

**Severity:** MEDIUM  
**Location:** `packages/proxy/adapters/hermes/transport.ts:404`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

#disconnectObservers notifies but never removes observers, and the registry discards its stop() on disconnect then re-observes, so after N redials every native frame is delivered N+1 times and every disconnect fires N+1 times, with unbounded growth on a flaky link.

### Mechanism

transport.ts:404-407 iterates #eventObservers and calls disconnected(...) but leaves the set intact; #invalidate (511-519) never clears it. The registry's disconnected handler sets #stopObservation = undefined without calling the old stop (attachment-registry.ts:183-185), so the transport still holds observer A. The next subscribe() -> #observe -> native.observe (171-173) -> transport.observeEvents adds observer B (transport.ts:386-388) after redialing. #publishEvent (400-402) now invokes A and B; both route through the same #byLiveId/entry.listeners (175-181), so each run listener sees each frame twice (thrice after the next loss, etc.). run.ts hides it only for frames carrying seq (1170-1172 drops seq <= lastSeen); frames dispatched before accepting are buffered twice (run.ts:706, bufferNativeEvent has its own byte bound -> earlier overflow -> AOS_RESET_REQUIRED at 760-767). subscribeSessionInvalidation listeners (adapter.ts:1192-1205 via events/service.ts:85) receive duplicate invalidations. On the next loss #disconnectObservers calls A.disconnected and B.disconnected, each running the registry's full wipe loop; #markInterrupted is idempotent so the visible effect is CPU/memory growth, not a wrong terminal event.

### Repro

Transport unit test: 1) sockets[]; observeEvents(l1,d1) -> socket A; 2) A.emit('close',{}) -> d1 called once; 3) observeEvents(l2,d2) -> socket B created; 4) B.emit('message', event frame for session 'live-x') -> assert l1 NOT called (currently it is called) and l2 called once; 5) B.emit('close') -> d1 called a second time (currently) although its observation was already reported dead. Registry-level: native.observe records listeners; after one disconnected(...) and a second subscribe, publish one event -> the single run listener is invoked twice.

### Fix sketch

Make a disconnected observer dead by contract: in #invalidate, snapshot the set, clear it, then notify (or have the registry call its stop before discarding it). In the vendored design the wrapper owns the observer set, so implement 'one generation, one observer set' there and add the test above.

---

## Finding 11: Frame-decode chain and pending-frame counter survive socket loss, so a redialed socket is killed by stale backlog

**Severity:** LOW  
**Location:** `packages/proxy/adapters/hermes/transport.ts:462`  
**Fixed by vendoring:** Yes — resolved by vendoring upstream client

### Summary

#frameChain and #pendingFrames are per-transport, not per-socket; after a frame-queue overflow (#pendingFrames stuck at 256) the next socket's first frame trips the same bound and is dropped immediately, and any frame still queued from the old socket is published to the new generation's observers.

### Mechanism

#receive increments #pendingFrames and appends to the shared #frameChain (transport.ts:462-465); the decrement runs only in .finally of each step (500-502). #lost/#invalidate (505-519) reset #socket but not #frameChain or #pendingFrames. The 'closes an observation whose asynchronous frame queue exceeds its bound' test (transport.test.ts:363-386) leaves 256 steps parked forever. A subsequent request()/observeEvents() redials (409-416); the new socket's first message enters #receive with #pendingFrames >= 256 (457) -> #lost(newSocket) -> all observers disconnected again. Also, chain steps do not re-check socket === this.#socket inside the async step (464-498), so a frame received on the dead socket but decoded after redial is published to the new socket's observers. Realism caveat: this needs frame decoding to be genuinely asynchronous or a burst dispatched without a microtask checkpoint; with Bun's default binaryType the decode path is effectively synchronous, so this is mainly a latent hazard of the hand-written chain.

### Repro

Extend transport.test.ts:363-386: after the 257 stalled Blob frames close socket A, call transport.request('profiles.list', {}) -> socket B opens; B.emit('message', {data: JSON.stringify(valid result frame)}) -> observe B.readyState===3 immediately and the request rejects HermesRpcUncertainError; disconnected called again.

### Fix sketch

Drop the hand-written chain when vendoring: JsonRpcRequestChannel.handleFrame decodes text synchronously per frame (wireFrameText) with no queue. If any backlog state remains in the wrapper, key it to the socket generation and reset it in the generation drop path.

---

## Finding 12: close() during an in-flight dial leaves a connected socket and its observers alive after shutdown

**Severity:** LOW  
**Location:** `packages/proxy/adapters/hermes/transport.ts:394`  
**Fixed by vendoring:** Yes — resolved by vendoring upstream client

### Summary

close() only invalidates the current #socket; a #connecting promise completes afterwards, assigns #socket and attaches handlers, so the transport stays connected (and #eventObservers is never cleared) after adapter.close().

### Mechanism

close() reads this.#socket (undefined while dialing), calls #invalidate(undefined,false) and socket?.close() (transport.ts:394-398); it does not reject or cancel #connecting. #openSocket then resolves, sets this.#socket = socket and installs message/error/close handlers (446-450). The observer set survives (#invalidate never clears it, 511-519), so events keep being published to registry closures that reference cleared maps. The Bun process keeps a live WebSocket; Hermes keeps the sessions bound to a client that AOS considers closed, so they are not orphan-reaped on schedule.

### Repro

Transport test: socketFactory returns a FakeSocket that opens on a deferred promise; const p = transport.request('profiles.list',{}); await transport.close(); resolve the open -> socket.readyState===1, socketFactory called once, the socket now receives events and publishes to previously registered observers; p resolves normally after a reply.

### Fix sketch

Track a 'closed' flag/generation: close() should reject #connecting (or mark the generation stale so #openSocket closes the socket on resolve), clear #eventObservers, and make request()/observeEvents() reject after close. Upstream's client uses the generation guard for this (json-rpc-gateway.ts invalidate: 'Drop the generation BEFORE closing'); reuse it in the wrapper.

---

## Finding 13: discover()/post-restart reconnect replays the whole Hermes ring and settles the live turn from stale frames

**Severity:** HIGH  
**Location:** `packages/proxy/adapters/hermes/run.ts:1057`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

Fresh recover() without a position omits last_seen, so Hermes returns the entire per-session replay ring (previous turns included) and #accept treats a previous turn's message.complete/session.info as the current run's terminal edge, emitting a premature RUN_FINISHED or the public 'Hermes could not complete this run.' while Hermes is still mid-turn.

### Mechanism

1. run.ts:1054-1057 discover() calls this.recover(scope,{threadId,runId}) with no position; the coordinator does the same for /reconnect when it has no execution (session-coordinator.ts:437-443 only passes position when `existing`). 2) run.ts:950-953 calls native.recover(liveSessionId, undefined); adapter.ts:1250 omits last_seen; upstream tui_gateway/methods_session.py `session.events.since` does int(params.get('last_seen', 0)) and event_replay.py events_since() returns every retained frame with seq>0 (512 events / 4 MiB FIFO, never cleared per turn). 3) run.ts:961 sets lastSeen=0 and run.ts:1017 feeds every replayed frame to #accept, which has no notion of turn boundaries: a retained message.complete status:'complete' hits #finish (run.ts:1408); a retained message.complete status:'error' sets failedCompletionObserved (1401) and the retained session.info running:false then emits AOS_PROVIDER_RUN_FAILED 'Hermes could not complete this run.' (1346-1351). A retained clarify.request is also re-delivered to acceptInteraction (1175-1195); after a proxy restart interactions' #completed set is empty so it becomes a phantom RUN_FINISHED interrupt. 4) Triggers: routes/sessions.ts:41-45 runs discover on every history load when the coordinator is idle but session.status is running (proxy restart mid-turn, turn started from Hermes Desktop/TUI, or a queued follow-up turn that started right after AOS's RUN_FINISHED); aos-client.ts:338 redials /reconnect after an SSE body failure, which after a proxy restart lands in #recoverExecution without a position. Note 4ad2e35 fixed exactly this for start() via the MAX_SAFE_INTEGER barrier (run.ts:714-720) but left recover()/discover() on the unbounded path; run.test.ts:2817 mocks an empty ring so nothing pins it. Verified with a bun repro: ring=[start,delta,complete(error),info(running:false),start,delta] + inspectExecution running → discovered handle yields RUN_STARTED, TEXT_MESSAGE_START/CONTENT 'Previous turn', TEXT_MESSAGE_END, RUN_ERROR AOS_PROVIDER_RUN_FAILED 'Hermes could not complete this run.' and recover() was called with last_seen=undefined.

### Repro

native.recover(id,lastSeen) returns {epoch:'e1', lastSeen:6, events: lastSeen===undefined ? [message.start seq1, message.delta seq2 'Previous turn', message.complete seq3 status:'error', session.info seq4 running:false, message.start seq5, message.delta seq6 'Current'] : []}; native.inspectExecution → {status:'running'}; native.status → 'running'. Call engine.discover(scope,'recovered-run'); collect(handle.events). Expected: RUN_STARTED then live continuation only. Actual: RUN_STARTED, TEXT_MESSAGE_START m-1, TEXT_MESSAGE_CONTENT 'Previous turn', TEXT_MESSAGE_END, RUN_ERROR AOS_PROVIDER_RUN_FAILED 'Hermes could not complete this run.'. Same via coordinator.recover(scope,{threadId,runId,after}) with no existing execution.

### Fix sketch

Never call session.events.since without a watermark. In discover()/position-less recover(): read the barrier exactly like start() (native.recover(id, Number.MAX_SAFE_INTEGER) → epoch + latest_seq), set lastSeen to that barrier, then seed the in-flight assistant state from session.resume's `inflight` snapshot (or authoritative HTTP history) instead of replaying the ring, and accept only live frames with seq > barrier. Share one #attach(active, barrierOrPosition) helper across start/recover/#reattach so the rule lives in one place. Add a run.test.ts case where the mocked ring contains a finished previous turn and assert discover() does not emit a terminal event.

---

## Finding 14: Emitting into a closed (uncertain) queue triggers #overflow, drops the frame and unsubscribes; reattach then replays past the hole

**Severity:** MEDIUM  
**Location:** `packages/proxy/adapters/hermes/run.ts:1762`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

After #markUncertain/#markUncertainInteraction close the queue while the socket stays alive, the first native frame that produces an AG-UI event makes queue.push() return false, which #emit misreads as a buffer overflow: the run is marked overflowed/detached and unsubscribed, the frame's content is lost (its seq already advanced lastSeen), and a later #reattach replays only after that seq while textStarted/tool state claims the lost structures were already delivered.

### Mechanism

run.ts:1733/1744 call active.queue.close() for AOS_SEND_UNCERTAIN / AOS_INTERACTION_UNCERTAIN but keep the observer attached. EventQueue.push returns false when #closed (run.ts:237). #emit (1759-1764) treats any false push as overflow → #overflow (1767-1778) sets uncertain/detached/overflowed and safelyUnsubscribe(active.unsubscribe). Because #accept advanced lastSeen before emitting (1170-1172) and #startText set textStarted=true before the failed emit (1459-1461), the run's state says the text message started and seq N was consumed although nothing reached any consumer. #reattach (1061-1146) resets uncertain/detached/overflowed and replays from request.position.lastSeen (1078, 1103-1106) = the advanced watermark, so seq N is never re-fetched, and the new queue receives TEXT_MESSAGE_CONTENT/TEXT_MESSAGE_END for a message whose TEXT_MESSAGE_START was never delivered (same for TOOL_CALL_* if the lost frame was tool.start). Verified with a bun repro: submit throws → AOS_SEND_UNCERTAIN; publish message.start seq11, message.delta seq12 'Hello' → unsubscribe count 1, recoveryPosition lastSeen 12; engine.recover → second stream = RUN_STARTED, TEXT_MESSAGE_CONTENT ' world', TEXT_MESSAGE_END, RUN_FINISHED — 'Hello' and TEXT_MESSAGE_START are gone. Reachable today whenever submit/respondInteractions throw while Hermes actually accepted (RPC timeout, or any HermesUnavailableError since run.ts:869 maps every non-rewind throw to 'uncertain'); it becomes user-facing as soon as the browser is taught to reconnect after AOS_SEND_UNCERTAIN, which the team plans.

### Repro

native.submit rejects; native.observe captures `publish`; recover(id,lastSeen) returns events with seq>lastSeen from [message.start seq11, message.delta seq12 'Hello', message.delta seq13 ' world', message.complete seq14 'Hello world']. engine.start → stream ends with RUN_ERROR AOS_SEND_UNCERTAIN. publish(message.start seq11); publish(message.delta seq12 'Hello'). Assert observe's unsubscribe was called and handle.recoveryPosition().lastSeen===12. engine.recover(scope,{threadId,runId:'run-1'}) → stream is RUN_STARTED, TEXT_MESSAGE_CONTENT ' world', TEXT_MESSAGE_END, RUN_FINISHED; 'Hello' never appears.

### Fix sketch

Separate 'queue closed because the run is uncertain' from 'queue full': make #emit return early (like the detached branch) when active.uncertain && !active.terminal, and do not advance lastSeen for frames whose AG-UI projection was not delivered — simplest is to record lastSeen only after #accept completes without triggering overflow, or to stop consuming (unsubscribe) at #markUncertain time so the watermark stays at the last delivered frame and #reattach replays from there. Add a test for uncertain → live frame → reattach asserting no gap and a delivered TEXT_MESSAGE_START.

---

## Finding 15: Transport observers accumulate across redials: every frame and every disconnect is delivered N+1 times

**Severity:** MEDIUM  
**Location:** `packages/proxy/adapters/hermes/transport.ts:404`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

On socket loss the transport notifies observers but never removes them, and the registry discards its stop handle without calling it, so each redial adds another registry observer; after N reconnects each native frame reaches run.ts listeners N+1 times and each disconnect fires N+1 reset callbacks.

### Mechanism

transport.ts:382-392 observeEvents() adds to #eventObservers and only the returned closure removes it. #invalidate → #disconnectObservers (transport.ts:404-407, 511-519) iterates and calls disconnected() without deleting. attachment-registry.ts:183-191 (disconnect handler) sets #stopObservation = undefined without invoking the old stop, then the next subscribe()/subscribeLive() runs #observe() (170-173), which calls native.observe again → a second transport observer whose listener is the same registry closure looking up the same #byLiveId map. Result verified with a bun repro through the real HermesWebSocketRpcTransport + HermesAttachmentRegistry and a fake socket factory: deliveries to one subscriber per frame = 1 → 2 → 3 after 1 and 2 redials; reset callbacks on the third loss = 3. run.ts survives only because #accept drops seq <= lastSeen (1170-1172), but pre-accept buffering (run.ts:706, 942, 1095 → bufferNativeEvent) counts duplicates toward MAX_PREACTIVE_EVENTS/BYTES so a long-lived proxy hits buffered.overflow → AOS_RESET_REQUIRED (760-767, 1000, 1124) N+1 times sooner, every frame is graph-walked N+1 times, and the observer set grows without bound.

### Repro

transport = new HermesWebSocketRpcTransport({... socketFactory: fake that opens on microtask}); registry = new HermesAttachmentRegistry({resume: async()=>({liveSessionId:'live-secret'}), close, observe:(l,d)=>transport.observeEvents(l,d)}); await registry.subscribe(scope, ()=>delivered++, ()=>resets++); emit one event frame on socket[0] → delivered===1; emit 'close' on socket[0]; await registry.ensure(scope); await registry.subscribe(scope, noop, noop); emit one event frame on socket[1] → delivered===2 (expected 1); repeat once more → 3; emit close → original subscriber's reset fires 3 times.

### Fix sketch

Own exactly one event subscription per transport generation: in the registry disconnect handler call the previous stop (or have the transport clear #eventObservers after notifying, since the contract is 'observers die with the socket'). With a vendored JsonRpcGatewayClient, register a single persistent onEvent handler once in the wrapper and never re-observe on reconnect; the registry then only re-resumes bindings. Add a registry/transport test asserting one delivery per frame after two redials.

---

## Finding 16: Recovered segments have no journal, so a page reload during a reconciled run shows an error while Hermes keeps running

**Severity:** MEDIUM  
**Location:** `packages/proxy/core/session-coordinator.ts:450`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

The coordinator drops the compacted journal on every RUN_ERROR including the recoverable AOS_CONNECTION_INTERRUPTED and builds the recovered segment with journalComplete=false, so after any socket blip a mid-run page reload gets AOS_RESET_REQUIRED and the browser renders the assistant message as failed although the run is still running.

### Mechanism

session-coordinator.ts:653-654: on any RUN_ERROR #forgetJournal(segment) runs before the uncertain/idle decision (657), so the journal built so far is discarded for AOS_CONNECTION_INTERRUPTED too. #recoverExecution (445-451) creates the new segment via #segment(..., false) → journal undefined, and #forgetJournal(existing.segment) (452). Later recover() with after===undefined (page reload: aos-thread-list.ts:51-56 sets unstable_resume when execution.status==='running'; reconnectRun sends no `after`, aos-client.ts:1193-1273) matches 385-391 and, because !existing.segment.journal, returns #resetSubscription → RUN_ERROR AOS_RESET_REQUIRED. aos-thread-list.ts:130-165 then reloads history; execution.status is 'running' so it falls to the else branch and yields status {type:'incomplete', reason:'error', error:'AOS run history must be reloaded before continuing.'} and returns — no further resume. Verified with a bun repro against SessionCoordinator: start → RUN_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, RUN_ERROR AOS_CONNECTION_INTERRUPTED (state uncertain) → recover(after:4) attaches a new segment (state running) → recover() without after yields {sequence:3, RUN_ERROR AOS_RESET_REQUIRED 'AOS run history must be reloaded before continuing.'}. The coordinator tests pin only the too-large journal case (548) and the post-terminal case (419); none pins a recovered segment.

### Repro

coordinator.start(scope,input,access); source emits RUN_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, RUN_ERROR{code:'AOS_CONNECTION_INTERRUPTED'}; await state==='uncertain'; coordinator.recover(scope,{threadId,runId,after:4},access) with engine.recover returning a second live handle emitting RUN_STARTED; then coordinator.recover(scope,{threadId,runId},access) (no after). Expected: replay of the journaled prefix + live tail. Actual: single RUN_ERROR AOS_RESET_REQUIRED.

### Fix sketch

Treat recoverable RUN_ERRORs as non-terminal for the journal: skip #forgetJournal when uncertainError(event) is true (and do not journal the interrupt event itself), and in #recoverExecution carry existing.segment.journal (and nextSequence, see the cursor finding) into the new segment instead of passing journalComplete=false. Then #subscribeJournal works across reattach. Add a coordinator test: interrupted → recovered → reload replays the prefix once and continues live.

---

## Finding 17: Recovered segment restarts the AOS sequence at 0, so a stale browser cursor silently skips recovered events

**Severity:** LOW  
**Location:** `packages/proxy/core/session-coordinator.ts:403`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

AOS `after` cursors are per-segment but the browser treats them as per-run; after an engine reattach creates a new segment numbered from 1, a redial that still carries the old segment's cursor is served by #subscribe(existing.segment, after) and drops every recovered-segment event with sequence <= that cursor.

### Mechanism

#segment() initialises nextSequence: 0 (session-coordinator.ts:614) and #recoverExecution builds a fresh segment (445-451), so post-reattach SSE ids restart at 1 while the browser's `after` from the old segment can be large (aos-client.ts:296-297 keeps the last seen id). The first redial goes through #recoverExecution and correctly ignores `after` (425: #subscribe(recovered.segment, 0)). But if that response body is lost before any frame reaches the browser (browser↔proxy blip; reconnectingSse catches read errors as interrupted at 324-337 and redials with the unchanged `after`), the second redial matches 397-404 (same runId, not overflow, state 'running') → #subscribe(existing.segment, after) → the async iterator skips replay and live values with sequence <= after (771-781). Verified with a bun repro: old segment cursor 10; recover(after:10) then close(); recovered handle emits RUN_STARTED + a full TOOL_CALL_START/ARGS/END/RESULT (sequences 1-5) + TEXT_MESSAGE_CONTENT (6); recover(after:10) again → the subscription yields nothing (it blocked until the process was killed) — the tool call and text are never delivered to that browser.

### Repro

coordinator.start → source emits RUN_STARTED + 8 TEXT_MESSAGE_CONTENT + RUN_ERROR AOS_CONNECTION_INTERRUPTED; read all → last sequence 10. re1 = coordinator.recover({after:10}); re1.close() before reading. Recovered handle emits RUN_STARTED, TOOL_CALL_START/ARGS/END/RESULT. re2 = coordinator.recover({after:10}); read re2.events → expected the recovered events; actual: nothing is yielded (all have sequence <= 10).

### Fix sketch

Make sequences monotonic per run: in #recoverExecution set segment.nextSequence = existing.segment.nextSequence (and carry the journal, see previous finding) so a cursor is never ambiguous; alternatively include a segment epoch in the SSE id and have the coordinator ignore cursors from another segment. One-line change plus a test with two redials carrying the same cursor.

---

## Finding 18: Hermes seq counter can reset within the same epoch (64-session ring eviction); AOS then drops every later frame of an active run

**Severity:** LOW  
**Location:** `packages/proxy/adapters/hermes/run.ts:1171`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

Upstream evicts the oldest session's replay buffer AND its seq counter when a 65th session emits its first event, while the epoch stays the same; AOS's dedup rule seq <= lastSeen then discards all subsequent live frames of that session, so a run in progress never sees message.complete and stays 'running' until Stop.

### Mechanism

Upstream tui_gateway/event_replay.py _stamp_event(): when a new sid gets a buffer and len(_replay_buffers) > _REPLAY_SESSIONS_MAX (64), it pops the oldest-created buffer and `_replay_next_seq.pop(oldest_sid, None)`; eviction order is buffer creation order (OrderedDict insertion, appends do not reorder), so the longest-lived session is evicted regardless of activity. Its next event is stamped seq=1 under the unchanged process epoch. AOS run.ts:1170-1172 drops any frame with seq <= active.lastSeen (e.g. 300) and never re-checks monotonicity, so message.delta/tool.*/message.complete/session.info for the rest of that turn are all ignored; the run only ends via Stop (#stop 1558-1579) or a reattach, where validatedRecovery (453-465) sees latest_seq < position.lastSeen and emits AOS_RESET_REQUIRED. Upstream's own client has the same weakness (json-rpc-gateway.ts recordSeq/dispatchIfNewer ignore non-increasing seq), so vendoring does not change this. Reachability needs 64 other sessions to have emitted events in the same gateway process while the oldest session is mid-turn — rare for a single operator but possible on a long-lived gateway shared with Desktop/TUI.

### Repro

Start a run; publish frames seq 301..305 (accepted, lastSeen=305); then publish message.delta seq 1, message.complete seq 2, session.info running:false seq 3 with the same epoch. Expected: run completes (or reset-required). Actual: no AG-UI events after seq 305; handle.settled never resolves; a later recover() with position {epoch, lastSeen:305} against latest_seq 3 yields AOS_RESET_REQUIRED.

### Fix sketch

Once double delivery (observer accumulation) is fixed, a live socket frame with seq <= lastSeen can only mean a counter reset; treat a live frame with seq < lastSeen arriving outside replay/buffer drain as a reset (fail AOS_RESET_REQUIRED and reconcile from HTTP history) rather than a duplicate. Keep plain equality dedup for the replay/buffer race. Optionally report the upstream eviction behaviour to Hermes so counters are not popped for sessions that are still live.

---

## Finding 19: Interactions protocol does not exist at the pinned Hermes: clarify/approval arrive as server->client JSON-RPC requests that transport.ts silently drops, and `clarify.respond` is not a server method

**Severity:** CRITICAL  
**Location:** `packages/proxy/adapters/hermes/interactions.ts:469`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

AOS listens for `approval.request`/`clarify.request`/`clarify.expire` events and answers with `approval.respond`/`clarify.respond`, but at 47685348 Hermes sends clarify/approval as server->client requests (`{id:"srq-…",method:"clarify"|"approval"}`) answered by a plain JSON-RPC response, so questions never reach the user and a cancelled/answered question yields `AOS_INTERACTION_UNCERTAIN` that bricks the Session.

### Mechanism

1. Upstream emits clarify via `server_requests.send("clarify", sid, …)` (tui_gateway/server.py:1355,1361) and approval via `server_requests.send_async("approval", …)` (server.py:745); the frame is `{"jsonrpc":"2.0","id":"srq-…","method":<m>,"params":{session_id,…}}` (server_requests.py:55-57). No `clarify.request`/`approval.request`/`clarify.expire` event exists at the pin (grep over tui_gateway/*.py: only `request.cancel`, server_requests.py:84). The older pin 643b3f45 did emit those events and had `pending_clarify` (server_old.py:653-689, 2752) — AOS was written against that contract. 2) transport.ts:467-479: a frame whose `method !== "event"` falls through; `id` is a string but `#pending.get(frame.id)` misses (srq ids are never ours) → returned silently. Nothing in AOS ever answers, so Hermes waits until `_clarify_timeout_seconds()` (300 s default, `<=0` = forever, server.py:1338-1345) then emits `request.cancel` (ignored by AOS) and the tool returns `""`. 3) `session.active_list` reports `waiting` while the request is open (server.py:2668-2670), so AOS keeps the run open with a `question` tool call that never completes. 4) `interactions.ts:647-675` answers questions with `clarify.respond`; the pinned server registers only `clarify.lock`, `request.answer`, `approval.pending`, `approval.received`, `approval.respond` (methods_prompt.py:1116,1137,1164,1173,1214) → `-32601` → `HermesRpcError` → `respond()` catch (interactions.ts:700-705) → `{status:"uncertain"}` → run.ts:799-800 `#markUncertainInteraction` → coordinator `uncertain` (session-coordinator.ts:191-199) → every later `start` throws `ServerRunConflictError` (session-coordinator.ts:344-345). The only live entry into this path is `session.resume.pending_approval` (server.py:2814) via `inspectExecution` → `#reconcile` (interactions.ts:765-778).

### Repro

Unit: feed transport `#receive` the frame `{"jsonrpc":"2.0","id":"srq-abc","method":"clarify","params":{"session_id":"live-secret","question":"Which file?","choices":null}}` and assert an observer/onRequest callback fires — today nothing is published and no response is sent. Unit 2: `HermesInteractions.respond` with a `questions` interaction where `transport.request("clarify.respond")` rejects with `HermesRpcError(-32601)` → returns `{status:"uncertain"}` instead of a definitive outcome. Live: ask the agent a question that triggers the clarify tool; observe no question UI and `session.active_list` = waiting.

### Fix sketch

Adopt the upstream server-request contract in the wrapper: register `onRequest` handlers for `clarify`/`approval` (params → `RunFinishedInterruptOutcome`), answer with a JSON-RPC response `{id, result:{answer}|{answers}|{choice,all?}}` (single clarify: `{answer}`; batch: `clarify.lock` per question or final `{answers}`; approval: `{choice}`), treat `request.cancel {id}` as expiry, and re-deliver `open_requests` from `session.resume`/`session.events.since` as pending interrupts. Delete `clarify.request`/`approval.request`/`clarify.expire`/`clarify.respond`/`pending_clarify` handling and the tests that pin them (interactions.test.ts:17-441). Update UPSTREAM.md pin.

---

## Finding 20: Stop during the agent-build window settles the AOS run while Hermes keeps `running=True`; the next Send is silently queued, then the build-cancel `error` fails the new run with "Hermes could not complete this run."

**Severity:** HIGH  
**Location:** `packages/proxy/adapters/hermes/run.ts:1570`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

`#stop` confirms Stop with `status()`, which maps native `starting` to `idle` (adapter.ts:1401-1402), so a Stop issued while Hermes is still building the agent finishes the run as stopped even though Hermes only latched `_turn_cancel_requested`; the follow-up Send is queued by Hermes, never drained, and the delayed cancel `error` is attributed to the new run.

### Mechanism

1. User sends on a cold Session: `prompt.submit` returns `streaming` and spawns the turn thread that waits for the build (methods_prompt.py:667-676, 488-495); `running=True` (methods_prompt.py:545-546); `_session_live_status` = `starting` (server.py:2671-2673). 2) User presses Stop: run.ts:1563 → `session.interrupt` → `_interrupt_session_turn` (session_lifecycle.py:404-447): `run_thread_alive` is True so `running` is NOT flipped; `request_hard_interrupt(None)` returns False without effect (agent/interrupt_compat.py:38-47); only `_turn_cancel_requested=True` is set. 3) run.ts:1570 `status()` → row status `starting` → adapter.ts:1401-1402 returns `idle` → `#finish(active,{stopped:true})` → `#settle` unsubscribes. 4) User sends again: `start` → status `starting`→`idle` passes the busy gate (run.ts:819) → `prompt.submit` → busy loop sees `running=True` → `_handle_busy_submit` (methods_prompt.py:614-628): agent is None so no correction; prompt is enqueued; `_interrupt_busy_session(agent=None)` returns immediately (session_auto_continue.py:202-207); reply `{status:"queued"}` (session_auto_continue.py:281-283). adapter.ts:1341-1349 ignores the payload and returns `accepted`; the AOS run waits for `message.start`. 5) Build completes: the first turn thread takes the cancel branch (methods_prompt.py:506-514): `running=False`, bare `error` "Turn cancelled before the agent was ready", return — `_run_post_turn_followups`/`_drain_queued_prompt` never run (only prompt_turn.py:424, compute_host_bridge.py:218, session_auto_continue.py:335), so the queued prompt is stranded. 6) The `error` frame reaches the new AOS run (same live sid, higher seq): run.ts:1355-1361 → `status()` now `idle` → run.ts:1590-1594 `AOS_PROVIDER_RUN_FAILED` "Hermes could not complete this run."

### Repro

Engine unit test: native `status` returns "idle" (simulating the starting alias); `start` run-1, `handle.stop()` → resolves "idle" and emits RUN_FINISHED{stopped}; `start` run-2 with submit resolving `accepted`; publish `{type:"error", session_id:"live-secret", seq:1, payload:{message:"Turn cancelled before the agent was ready"}}` with `status` still "idle" → run-2 emits RUN_ERROR AOS_PROVIDER_RUN_FAILED with no `message.start` ever sent. Adapter unit test: `status()` with `session.active_list` row `{id:"live-secret",status:"starting"}` returns "idle" (adapter.ts:1401) — pin that Stop confirmation must not treat it as idle.

### Fix sketch

Split `status()` into the native tri-state (`starting|working|waiting|idle|absent`) and let callers decide: submit-eligibility accepts `starting`, Stop confirmation and `#failNativeErrorIfIdle` accept only `idle`/`absent`. In `#stop`, when status is `starting`, return "stopping" and wait for the native `error`/`session.info` edge (map the build-cancel `error` + confirmed idle to `{stopped:true}` when `active.stopping`). In `submit`, validate `prompt.submit.result.status` and surface `queued`/`steered`/`redirected` instead of treating them as `accepted` for a fresh turn (fail fast with AOS_SESSION_BUSY or adopt the queued semantics explicitly).

---

## Finding 21: Redirect-chain flags override a failed completion: after an accepted steer a native `status:"error"` turn is reported as RUN_FINISHED success

**Severity:** HIGH  
**Location:** `packages/proxy/adapters/hermes/run.ts:1345`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

Once `redirectChainActive` (or `redirectIdleObserved` during dispatch) is set, the idle `session.info` branch finishes the run successfully before checking `failedCompletionObserved`, so a turn that Hermes ended with `message.complete status:"error"` after a steer is shown as completed.

### Mechanism

1. `#steer` succeeds → `redirectChainActive=true`, generation sealed (run.ts:1611-1614). 2) Hermes ends the redirected turn with `message.complete status:"error"` (prompt_turn.py:289-292, 714-724). The payload carries no `message_id` (grep prompt_turn.py: none; `message.start` payload is None, prompt_turn.py:873), so `completedMessageId` is undefined and the sealed-id swallow at run.ts:1369-1377 never applies; run.ts:1397-1402 sets `failedCompletionObserved=true` and seals. 3) `session.info running:false` (prompt_turn.py:917-942) → run.ts:1336-1343 passes the early return; run.ts:1344 `stopping` false; run.ts:1345 `redirectChainActive` → `#finish(active)` → RUN_FINISHED `outcome:{type:"success"}`; the `#fail` branch at 1346-1351 is unreachable. Same shape while `redirectDispatchPending`: idle sets `redirectIdleObserved` and returns (run.ts:1332-1335) regardless of `failedCompletionObserved`, then `#finishAfterSteeringAcknowledgement`/`#finish` (run.ts:1615-1616, 1625-1626, 1630-1633) emits success. Tests at run.test.ts:45-196 cover only successful completions after redirect; run.test.ts:2409-2540 cover failed completions only without redirect.

### Repro

Engine unit test: `start`; publish `message.start` (seq 1), `message.delta` "Before" (seq 2); `await handle.steer({requestId:"q1",text:"Correction"})` with `redirect` resolving "redirected"; publish `message.complete {status:"error", error:"boom", text:"Before"}` (seq 3) then `session.info {running:false}` (seq 4). Expect RUN_ERROR AOS_PROVIDER_RUN_FAILED; today the last event is RUN_FINISHED with `outcome.type === "success"`.

### Fix sketch

Order terminal precedence once: `failedCompletionObserved` (and a confirmed `error`) wins over `redirectChainActive`/`redirectIdleObserved`; `stopping` yields `{stopped:true}`. Concretely, in the idle branch check `failedCompletionObserved || nativeErrorObserved` before the redirect branch, and in `#finishAfterSteeringAcknowledgement`/the steer catch call `#fail` when `failedCompletionObserved`. Better: replace the six booleans with one `turnOutcome: "open"|"failed"|"stopped"|"complete"` decided by `message.complete`/`error`+status and applied at the idle edge.

---

## Finding 22: A `queued` steer (redirect during agent build) ends the AOS run at the first turn's idle edge, before Hermes runs the queued correction; the next Send then hits AOS_SESSION_BUSY

**Severity:** MEDIUM  
**Location:** `packages/proxy/adapters/hermes/run.ts:1617`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

`session.redirect` returns `queued` when the agent is still building (methods_session.py:2080-2083); AOS accepts it and marks `redirectChainActive`, but Hermes drains the queue only after `session.info running:false`, exactly the frame at which run.ts:1345 finishes the AOS run, so the queued turn streams to nobody.

### Mechanism

1. User sends on a cold Session and steers while the agent builds: `session.redirect` with `agent is None and running` → `_enqueue_prompt` → `{status:"queued"}` (methods_session.py:2080-2083); adapter.ts:1374-1380 accepts `queued`; run.ts:1611-1619 sets `redirectChainActive=true` and returns "queued"; coordinator publishes `aos.steer.accepted delivery:"queued"` (session-coordinator.ts:541-549); the browser clears the composer and marks a reconciliation (aos-client.ts:786-796). 2) The first turn runs and completes: `message.complete status:"complete"` → run.ts:1404-1405 seals (no finish because `redirectChainActive`). 3) `finally` emits `session.info running:false` (prompt_turn.py:917-942) → run.ts:1345 `#finish(active)` → RUN_FINISHED, `#settle` unsubscribes. 4) Only now `_run_post_turn_followups` → `_drain_queued_prompt` (prompt_turn.py:944, 424; session_auto_continue.py:286-300) sets `running=True` and runs the queued correction with `message.start`… on the same live sid — no AOS run observes it. 5) User sends again: run.ts:812 `status()` → `working` → run.ts:819-825 `AOS_SESSION_BUSY` "Hermes is already running this Session." Registry retainers are also gone, so this unobserved turn is subject to the idle `session.close` timer (see separate finding).

### Repro

Engine unit test: `start` with `redirect` resolving "queued"; publish `message.start`(1), `message.delta`(2); `await handle.steer(...)` → "queued"; publish `message.complete {text}`(3), `session.info {running:false}`(4) → run emits RUN_FINISHED; then publish `message.start`(5), `message.delta`(6) → no active run receives them (`engine.start` of a new run with `status` "running" emits AOS_SESSION_BUSY).

### Fix sketch

Treat `queued` as a chained-turn contract: when a steer was `queued`, do not finish on the idle edge; keep the run open until the drained turn's `message.complete` (Desktop debounces lease release for chained `message.start`, apps/desktop/src/store/gateway.ts:1401-1431). Simplest: after idle with `redirectChainActive` and a queued delivery, wait for either `message.start` within a short grace (then continue the same run as a new generation) or a second idle/`status()==='idle'` (then finish). Alternatively refuse `queued` (return `ServerRunSteerUnavailableError` so the browser falls back to an ordinary Send after the turn).

---

## Finding 23: `#stop` converts authoritative Hermes rejections (4007 session not found, -32602) into AOS_STOP_UNCERTAIN, leaving the coordinator `uncertain` and the Session unable to start new runs

**Severity:** MEDIUM  
**Location:** `packages/proxy/adapters/hermes/adapter.ts:1357`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

`interrupt()` funnels every failure through `throwUnavailable`, erasing `HermesRpcRejectedError`, so a definitive "session no longer live" answer to `session.interrupt` becomes `AOS_STOP_UNCERTAIN`, which the coordinator maps to `uncertain` and thereafter rejects every `start` with run_conflict.

### Mechanism

1. adapter.ts:1352-1359: `session.interrupt` catch → `throwUnavailable` (adapter.ts:301-304) → `HermesUnavailableError`, regardless of whether the transport lost the socket (`HermesRpcUncertainError`) or Hermes answered with a JSON-RPC error (`HermesRpcRejectedError`, transport.ts:484-496). 2) run.ts:1562-1567: any throw → `active.uncertain=true`, `throw stopUncertain()`; the run is not settled and stays in `#active`. 3) session-coordinator.ts:492-498: non-`ServerRunStopNotDispatchedError` → `execution.state="uncertain"`; session-coordinator.ts:344-345: `start` throws `ServerRunConflictError` while state !== idle; `routes/sessions.ts` maps uncertain to `failed` with no resume. 4) Upstream returns 4007 for a sid that is no longer in `_sessions` (session_lifecycle.py:497-502; methods_session.py:641) — e.g. after the WS-orphan reaper tore the session down following an AOS socket loss (session_lifecycle.py:560-634, 20 s grace) — which is an authoritative statement that there is nothing left to stop.

### Repro

Engine unit test: native `interrupt` rejects with `new HermesRpcRejectedError(4007)` (or adapter-level: transport `request("session.interrupt")` rejecting with `HermesRpcError(4007)`); `handle.stop()` rejects with code AOS_STOP_UNCERTAIN and `engine.start(scope, input({runId:"run-2"}))` throws ServerRunConflictError. Expected: 4007 settles the run (RUN_FINISHED{stopped} or RUN_ERROR) and run-2 starts.

### Fix sketch

Preserve the error class through `interrupt()` (like `redirect()` does at adapter.ts:1370-1371): uncertain → `ServerRunStopUncertain`; rejected with 4007/-32602 → a `HermesSessionGoneError` that `#stop` maps to `#finish(active,{stopped:true})` (or `#fail` with a specific code) and settles. Vendoring `JsonRpcRequestChannel` keeps response errors and socket-loss rejections distinct, but the AOS wrapper must stop collapsing them in `throwUnavailable`.

---

## Finding 24: `message.complete status:"interrupted"` ignores `active.stopping`: the run finishes as plain success and interrupted tools are reported `{status:"completed"}`

**Severity:** LOW  
**Location:** `packages/proxy/adapters/hermes/run.ts:1408`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

Hermes ends an interrupted turn with `message.complete status:"interrupted"`, but run.ts treats every non-error status as success, so a Stop that is confirmed by the completion frame (rather than by idle) loses `{stopped:true}` and settles open tools as completed.

### Mechanism

1. `#stop` → `session.interrupt` → `_interrupt_session_turn` requests a hard interrupt (session_lifecycle.py:404-447); if `status()` still says `working`, `#stop` returns "stopping" (run.ts:1569-1578). 2) The turn thread finishes with `_result_status(result) == "interrupted"` (prompt_turn.py:289-292) and emits `message.complete {status:"interrupted"}` before `session.info running:false`. 3) run.ts:1397 checks only `payload.status === "error"`; otherwise run.ts:1403-1408 → `#finish(active)` with `result === undefined` → RUN_FINISHED has no `stopped:true` and `#settleOpenTools(active,"completed")` (run.ts:1668-1676) writes `{"status":"completed"}` TOOL_CALL_RESULT for tools Hermes actually aborted. The idle path (run.ts:1344) does emit `{stopped:true}`/"stopped"; run.test.ts:1392-1427 pins only that path. The same happens when another client (Desktop/TUI) stops the turn: AOS shows success.

### Repro

Engine unit test: `interrupt` resolves, `status` resolves "running"; `start`; publish `tool.start {tool_id:"t1",name:"terminal"}`(1); `await handle.stop()` → "stopping"; publish `message.complete {status:"interrupted", text:""}`(2). Expect TOOL_CALL_RESULT `{"status":"stopped"}` and RUN_FINISHED `result:{stopped:true}`; today both say completed/absent.

### Fix sketch

In the `message.complete` handler map `payload.status === "interrupted"` (or `active.stopping`) to `#finish(active,{stopped:true})`; keep `error` → failed-awaiting-idle. This also makes Stops from other Hermes clients render as stopped.

---

## Finding 25: Registry idle timer issues `session.close` on a live Hermes session that AOS is not observing; upstream tears the turn down after a 5 s join

**Severity:** LOW  
**Location:** `packages/proxy/adapters/hermes/attachment-registry.ts:212`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

`#scheduleIdle` closes the native session after `idleMs` (300 s default) with no retainer and no routed event, without checking whether Hermes is running a turn; upstream `session.close` pops the session and tears it down regardless of a live turn.

### Mechanism

1. Retainers exist only while an AOS run observes (`subscribe`→`retain("subscriber")`, attachment-registry.ts:95-111, released at `#settle` run.ts:1794), while a browser operator-event socket is open (adapter.ts:1192-1205 via events/service.ts:85-90), or for a pending interaction. A turn AOS does not own — the queued/followup turn after a `queued` steer (previous finding), a turn started from Desktop/TUI on a Session AOS has resumed, or a turn AOS settled as `stopped` while Hermes was `starting` — has no retainer once the browser tab closes. 2) attachment-registry.ts:175-181 re-arms the timer on every routed frame, so the close fires only after `idleMs` of silence; `session.usage` ticks only while counters change (server.py:3092-3115), so a long-running silent tool (shell command, sub-agent wait) is exactly such a window. 3) adapter.ts:1177-1185 sends `session.close`; upstream `_pop_session_by_id` removes it from `_sessions` immediately (methods_session.py:1918-1922; session_lifecycle.py:355-366) and `_teardown_popped_session` joins the run thread for `_TURN_SETTLE_BEFORE_CLOSE_SECONDS = 5.0` (server.py:145, session_lifecycle.py:369-378) then `_teardown_session` → `_finalize_session(..., interrupted=True)` + `agent.close()` regardless. The same unconditional close runs for un-retained entries on proxy shutdown (attachment-registry.ts:126-135). The row also disappears from `session.active_list`, which AOS's `status()` reads as `idle` (adapter.ts:1395).

### Repro

Registry unit test with fake timers: `ensure(scope)`; `subscribe` then release; publish one routed frame; advance 300 000 ms → `close("live-stored")` is called even though a fake `native.status`/last `session.info.running:true` indicates a live turn. Live: start a turn from Hermes Desktop on a Session AOS has attached, close the AOS tab, run a `sleep 400` shell tool.

### Fix sketch

Before closing, ask Hermes: skip `session.close` (and re-arm) when `session.active_list` reports `working|waiting|starting` for the live id, or track the last `session.info.running`/`message.start` seen in the registry listener and treat `running:true` as a retainer until `running:false`. On shutdown, never close sessions whose last known state is running (the comment at attachment-registry.ts:128-130 already intends this but only checks retainers).

---

## Finding 26: "interaction" retainer leaks when a waiting-for-input execution is dropped by discovery or reconciliation instead of a run terminal event

**Severity:** LOW  
**Location:** `packages/proxy/adapters/hermes/adapter.ts:1145`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

`#retainPendingInteraction` holds an attachment retainer that is released only from `#finish`/`#fail`; when the coordinator forgets a waiting-for-input execution because Hermes no longer reports the request (`discover` → undefined) or `interactions.#reconcile` drops the pending entries, the retainer stays and the native session never idle-closes until a later run on the same Session terminates.

### Mechanism

1. run.ts:1175-1195: an interrupt outcome → adapter.ts:1110-1118 `#retainPendingInteraction` → `retain(scope,"interaction")` stored in `#pendingInteractionReleases` (adapter.ts:1145-1152) → `#finishInterrupt` settles the run without clearing it (run.ts:1694-1710, by design). 2) Later `inspectExecution` (adapter.ts:878-880) → `interactions.resume` → `#reconcile` deletes all pending entries for the scope (interactions.ts:761-763) and returns `idle`/`unknown` when Hermes has no pending request; session-coordinator.ts:269-276 then deletes the execution. 3) Nothing calls `clearPendingInteraction` on that path (call sites: adapter.ts:1134 after a full resolve, run.ts:1690, 1721), so `entry.retainers` keeps `interaction` and attachment-registry.ts:211/214 never schedules the idle close; the live Hermes session and `#attachmentInfo` stay pinned until some future run on the Session reaches `#finish`/`#fail`.

### Repro

Adapter unit test: publish a `clarify.request`-shaped frame through `acceptInteraction` (or a `pending_approval` in `session.resume`) so the run ends with an interrupt; then make `session.resume` return `{session_id, running:false, status:"idle"}` and call `runs.discover(scope, runId)` → returns undefined; advance fake timers past `sessionIdleMs` → `session.close` is never requested for the live id.

### Fix sketch

Release the interaction retainer whenever the pending set for a scope becomes empty: have `HermesInteractions` expose an `onPendingCleared(scope)` hook (or return a flag from `resume()`/`acceptNative` expiry) and call `clearPendingInteraction` from `inspectExecution` when the snapshot has no interrupts. With the server-request rewrite (finding 1), tie the retainer to the open `srq` id and release on `request.cancel`/response.

---

## Finding 27: Authoritative Hermes rejections are erased into "uncertain" and brick the Session

**Severity:** HIGH  
**Location:** `packages/proxy/adapters/hermes/adapter.ts:1346`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

`throwUnavailable` (adapter.ts:301-304) discards `HermesRpcRejectedError` (a definitive JSON-RPC error frame) so an authoritatively rejected `prompt.submit` becomes `AOS_SEND_UNCERTAIN`, which the coordinator treats as an unrecoverable `uncertain` execution.

### Mechanism

1. Hermes rejects `prompt.submit` with an application error frame: 4090 slot limit (upstream tui_gateway/methods_prompt.py:592-596), 4007 "session no longer live" / 4009 "disconnect interrupt settling" (tui_gateway/session_lifecycle.py:497-505), 5070/5071 storage (methods_prompt.py:465-476, which also sets running=False). 2. transport.ts:484-496 maps the frame to `HermesRpcError(code)` (message deliberately dropped, code kept; transport.test.ts:56-84 pins this). 3. adapter.ts:1341-1347 catches it and calls `throwUnavailable`, which rethrows a bare `HermesUnavailableError` (adapter.ts:301-304), losing the rejected-vs-uncertain distinction. 4. run.ts:860-869: any non-rewind throw from `submit` becomes `acknowledgement = "uncertain"`; run.ts:882-887 → `#markUncertain` → RUN_ERROR `AOS_SEND_UNCERTAIN` (run.ts:1725-1734). 5. session-coordinator.ts:191-199 lists that code in `uncertainError`, so `#consume` sets `execution.state = "uncertain"` (:653-657); `start` then rejects every later Send with `ServerRunConflictError` (:344-345) and routes/sessions.ts:29-30/79-80 reports the Session as `failed`. Same erasure on two sibling paths: (a) `#rawHistory` for a rewind runs outside the try at adapter.ts:1314-1320, so a dashboard HTTP 5xx before any submit also yields `AOS_SEND_UNCERTAIN`; (b) `session.interrupt` rejected with 4007 (adapter.ts:1352-1359) → run.ts:1564-1566 `AOS_STOP_UNCERTAIN` and coordinator `uncertain` (session-coordinator.ts:497-498) although nothing was dispatched to a live turn. Only `redirect` preserves the class (adapter.ts:1370-1371).

### Repro

Unit: native `submit` mock throws `new HermesRpcRejectedError(4090)` (or wire-level: transport `request("prompt.submit")` rejects with `HermesRpcError(4090)` through the real `HermesServerAdapter`). Expect today: RUN_STARTED, RUN_ERROR code AOS_SEND_UNCERTAIN; `engine.start(scope, input({runId:"run-2"}))` rejects "already active"; coordinator `state()` === "uncertain". Expected: a terminal, settled `AOS_PROVIDER_RUN_FAILED`/`AOS_SESSION_BUSY`-class error and a second Send admitted. Second case: `transport.http` for `/api/sessions/{id}/messages` throws `HermesHttpError(500)` on a rewind submit → today AOS_SEND_UNCERTAIN, expected AOS_PROVIDER_UNAVAILABLE (nothing was sent).

### Fix sketch

Make the wrapper surface a three-way class and stop erasing it: keep `HermesRpcRejectedError(code)` through `submit`/`interrupt` (do not route them through `throwUnavailable`); in `submit` return `{acknowledgement:"rejected", reason: code}` for -32600/-32601/-32602 and 4xxx/5xxx application codes, and treat only timeout/socket-loss (`HermesRpcUncertainError`) and -32603/-32000 (server exception during dispatch) as `uncertain`. In run.ts map rejected codes to settled public errors (4090 → AOS_SESSION_BUSY-style capacity message; 4007/4009 → a settled "Session must be reopened" error). Move the rewind `#rawHistory` read inside a try that throws `providerUnavailable()` instead of falling into the uncertain branch. In `#stop`, on `HermesRpcRejectedError` consult `status()` and finish `{stopped:true}` when idle/absent instead of throwing `AOS_STOP_UNCERTAIN`.

---

## Finding 28: Both "Hermes could not complete this run." producers discard the native cause and nothing is logged server-side

**Severity:** HIGH  
**Location:** `packages/proxy/adapters/hermes/run.ts:1347`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

The `error` handler ignores `payload.message`, the `message.complete` handler reads only `payload.status` and drops `error`/`error_surface`/`failure_reason`, and no module under adapters/hermes has a logger, so the public constant string is the only trace of a failed turn.

### Mechanism

1. run.ts:1355-1361: on `error` only `active.nativeErrorObserved = true` is set; `payload.message` is never read or logged. 2. run.ts:1397-1402: on `message.complete` with `status:"error"` only `failedCompletionObserved` is set; upstream puts a structured, client-safe classification in `payload.error_surface = {layer, code, retryable}` and the raw reason in `payload.error` (tui_gateway/prompt_turn.py:684-693, 719-724; agent-init failures carry `error_surface.code = "agent_init_failed"`, methods_prompt.py:496-499), and `failure_reason`/`billing` for billing walls (prompt_turn.py:705-707). 3. Both terminal sites emit the same literal (run.ts:1347-1351, 1590-1594). 4. `grep logger|console` over packages/proxy/adapters/hermes returns nothing; the only proxy log sites are app.ts:150 and routes/runs.ts:316 (HTTP-level), and `redactForLog` rewrites every Error to `{name, message:"Upstream request failed"}` and drops own-properties such as `HermesRpcRejectedError.code` (redaction.ts:21-22), so even those logs cannot say which native code occurred. 5. Presentation is also inconsistent: when the model produced no text, upstream composes the assistant text itself as `"<title>. Your message was not answered.\nDetails: <raw provider detail>\n<hint>"` (prompt_turn.py:296-305, tui_gateway/user_messages.py:72-82) and run.ts:1380-1396 streams that verbatim into the assistant bubble; when partial text exists, the cause is dropped entirely. So the user sees raw provider detail in one case and a contentless constant in the other, and operators see neither in logs.

### Repro

Unit: publish `message.start`, then `message.complete {status:"error", text:"", error:"Bedrock 400: assistant prefill rejected", recoverable:true, error_surface:{layer:"provider", code:"bad_request", retryable:false}}`, then `session.info {running:false}` with an injected logger spy. Today: RUN_ERROR with the constant message, logger never called. Expected: a code/message derived from `error_surface` (e.g. distinguishing `agent_init_failed`, provider, billing) and one redacted server log line carrying `{layer, code, retryable, failure_reason, message}`.

### Fix sketch

Introduce a single `settleFailure(active, reason)` used by both sites; derive `reason` from `payload.error_surface` (`layer`/`code`/`retryable`) and `payload.failure_reason`, mapping to a small public catalogue (e.g. AOS_PROVIDER_RUN_FAILED with `retryable` and a localized sub-message per `code`), never forwarding `payload.error` or the `Details:` line. Inject a redacting logger into `HermesRunEngine`/adapter (pass through factory.ts) and log native `error.message`, `message.complete.error`, `error_surface`, and rejected RPC `code`s at the failure sites. Extend `redactForLog` to keep `code`/`status` own-properties of Error instances so HTTP-level logs are diagnosable.

---

## Finding 29: Stop during the deferred agent build is reported as a run failure

**Severity:** MEDIUM  
**Location:** `packages/proxy/adapters/hermes/run.ts:1589`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

`#failNativeErrorIfIdle` never consults `active.stopping`, so the bare `error` Hermes emits when a turn is cancelled before the agent is ready races the Stop path and fails the run instead of finishing it as stopped.

### Mechanism

1. User presses Stop while the first turn is still waiting for the deferred agent build. `#stop` sets `active.stopping = true` and sends `session.interrupt` (run.ts:1558-1563). 2. Upstream `_interrupt_session_turn` sets `_turn_cancel_requested = True` (tui_gateway/session_lifecycle.py:419-424) and `session.interrupt` returns `{status:"interrupted"}` (methods_session.py:2038-2045). 3. The turn thread leaves `_wait_agent_for_prompt` ("honors a cancel promptly", methods_prompt.py:486-489) and, because `_turn_cancel_requested` is set, sets `running=False` and emits a bare `error {"message":"Turn cancelled before the agent was ready"}` with no `message.complete` and no `session.info` (methods_prompt.py:506-514). 4. run.ts:1355-1361 receives it: `nativeErrorObserved = true` and `#failNativeErrorIfIdle` issues its own `status()` read. 5. adapter.ts:1383-1404 maps the session to `"idle"` (row absent, `idle`, or `starting` all collapse to idle). 6. Two `status()` RPCs are now in flight (one from `#stop` at run.ts:1570, one from the error handler). If the error frame's RPC resolves first, run.ts:1589-1594 emits RUN_ERROR "Hermes could not complete this run."; the `session.info` branch correctly prefers `stopping` (run.ts:1344) but `#failNativeErrorIfIdle` has no such guard. The same ordering hazard exists for any `error` frame arriving after Stop (e.g. the terminal-emit fallback at prompt_turn.py:765).

### Repro

Unit: native `interrupt` resolves; `status` mock returns "idle"; start a run, call `handle.stop()` but make the mock `status()` for the Stop path await a deferred promise; before it resolves, publish `{type:"error", session_id, seq:2, payload:{message:"Turn cancelled before the agent was ready"}}` whose `status()` resolves immediately. Today: terminal event is RUN_ERROR AOS_PROVIDER_RUN_FAILED. Expected: RUN_FINISHED with `result.stopped === true`.

### Fix sketch

Route every idle confirmation through one settle function that checks `active.stopping` first (as run.ts:1344 already does): in `#failNativeErrorIfIdle`, when `status()` is idle and `active.stopping`, call `#finish(active, {stopped:true})`; otherwise fail. Also clear `nativeErrorObserved` when `status()` returns running/waiting so a later idle edge after an advisory error settles rather than fails.

---

## Finding 30: Slash-command detection failures are reported as an authoritative "Hermes rejected this command."

**Severity:** MEDIUM  
**Location:** `packages/proxy/adapters/hermes/adapter.ts:1305`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

`submit` wraps `nativeSlashInvocation` in a catch-all that returns `acknowledgement:"rejected"`, so a timed-out or invalid `commands.catalog` read (a read-only pre-check) is presented as Hermes refusing the user's command.

### Mechanism

1. Any user text matching `^\/([^\s/]+)(?:\s+…)?$` (slash-commands.ts:39) enters the slash path at adapter.ts:1298, including prose such as "/etc/hosts is missing" ("/etc" then a space). 2. `nativeSlashInvocation` calls `commands.catalog` over the socket (slash-commands.ts:14-18, 78). 3. If that RPC fails with `HermesRpcUncertainError` (15 s timeout, transport.ts:365-368; socket loss, transport.ts:511-517), a plain `Error("Hermes connection failed")` (transport.ts:360, 423, 441, 540) or `Error("Invalid Hermes command catalog")` (slash-commands.ts:25, 31, 91), adapter.ts:1305-1307 catches everything and returns `{acknowledgement:"rejected"}`. 4. run.ts:871-880 turns `rejected` without a `rejection` reason into RUN_ERROR `AOS_PROVIDER_RUN_FAILED` "Hermes rejected this command." The class is wrong twice: Hermes never saw the text (not rejected), and the read failed (unavailable), whereas the same condition on the `status()` pre-check throws `providerUnavailable()` (run.ts:811-816). run.test.ts:894-914 pins only the case where the native `submit` itself returns `rejected`, not this catch-all.

### Repro

Adapter-level: transport `request` rejects `commands.catalog` with `new HermesRpcUncertainError()` (or `new Error("Hermes connection failed")`) and never receives `prompt.submit`; call `engine.start(scope, input({text:"/etc/hosts is missing"}))`. Today: RUN_ERROR AOS_PROVIDER_RUN_FAILED "Hermes rejected this command.", `prompt.submit` never called. Expected: `HermesRunPublicError` AOS_PROVIDER_UNAVAILABLE (503 `temporarily_unavailable`), since no mutation was attempted.

### Fix sketch

In `submit`, only return `rejected` for `HermesRpcRejectedError`; rethrow `HermesRpcUncertainError`/other failures from the catalog read as a distinct unavailable signal (not through the generic catch at run.ts:860-869, which would mark it uncertain). In run.ts, treat a pre-submit unavailable throw like the `status()` failure path: settle and throw `providerUnavailable()`. Consider caching the catalog per attached Session so a transient socket blip cannot reclassify plain prose.

---

## Finding 31: AOS_STOP_UNCERTAIN is published as temporarily_unavailable (503) instead of uncertain_mutation (409)

**Severity:** LOW  
**Location:** `packages/proxy/adapters/hermes/adapter.ts:706`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

`publicError` maps every `HermesRunPublicError` to `temporarily_unavailable` regardless of its `code`, so the documented `uncertain_mutation` vocabulary entry is never used for an unconfirmed Stop.

### Mechanism

1. `#stop` throws `stopUncertain()` = `HermesRunPublicError("AOS_STOP_UNCERTAIN", …)` when `session.interrupt` fails (run.ts:1564-1566, 362-367). 2. session-coordinator.ts:497-498 marks the execution `uncertain` and rethrows. 3. app.ts:132-149 asks `runtime.publicError`; adapter.ts:703-712 matches `cause instanceof HermesRunPublicError` without inspecting `cause.code` and returns `{code:"temporarily_unavailable", status:503}`. 4. routes/http.ts:27-32 defines `uncertain_mutation` ("The runtime may have accepted the request. Refresh to reconcile before trying again.", 409) exactly for this situation and `ServerRunSteerUncertainError` already uses it (app.ts:143-144). The browser's `isUncertainDelivery` keys on `uncertain_mutation` (src/components/assistant-ui/elements/message-queue.tsx:43-49), so the wrong code also prevents any future reuse of that branch for Stop; today `onCancel` swallows the rejection entirely (src/runtime-adapters/aos/composition.tsx:229-232), hiding the misclassification.

### Repro

Route test: native `interrupt` mock throws; `POST /api/aos/v1/agents/a/sessions/s/runs/stop` on a running Session. Today: status 503, code `temporarily_unavailable`. Expected: status 409, code `uncertain_mutation` (matching `ServerRunSteerUncertainError`).

### Fix sketch

In `publicError`, branch on `cause.code`: `AOS_STOP_UNCERTAIN` → `{code:"uncertain_mutation", status:409}`, `AOS_PROVIDER_UNAVAILABLE` → 503. Add the case to adapter.test.ts alongside the existing publicError matrix.

---

## Finding 32: Browser reconnect has no retry, backoff, or cap: one failed redial fails a healthy run; an empty stream loops at zero delay

**Severity:** HIGH  
**Location:** `src/runtime-adapters/aos/aos-client.ts:338`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

`reconnectingSse` redials `/runs/reconnect` exactly once per interruption with no retry/backoff and throws on any non-OK or rejected redial, while a 200 stream that ends without a terminal event triggers an immediate unbounded redial loop.

### Mechanism

1. On a body read failure or an intercepted `RUN_ERROR AOS_CONNECTION_INTERRUPTED`, the generator sets `interrupted` and falls through to `response = await reconnect(after)` (aos-client.ts:300-307, 324-329, 338). There is no try/catch around `reconnect`, no delay, and no attempt counter.
2. If the fetch rejects (proxy momentarily unreachable, container restart, flaky network) the rejection escapes the generator; `reconnectingResponse.pull` calls `controller.error(error)` (aos-client.ts:361-366); `HttpAgent.runAgent`'s `catchError` -> assistant-ui `startRun` catch dispatches `RUN_ERROR` with `err.message` (node_modules/@assistant-ui/react-ag-ui/dist/runtime/AgUiThreadRuntimeCore.js:684-691). The Hermes turn keeps running.
3. If the redial returns non-OK (e.g. 503 because the engine's `#reattach` hit `providerUnavailable()` while Hermes was still down, run.ts:1105-1113; or a transient 5xx from a reverse proxy), the next loop iteration throws `Error("AOS run request failed (503)")` (aos-client.ts:282-283) with the same effect.
4. Because no `RUN_ERROR` AG-UI event reaches `onEvent`, `acceptRunEvent` never runs: `#sessionStatuses` stays `running` and `#runIds` keeps the stale runId (aos-client.ts:844-846, 881-893 never executed).
5. Conversely, if the redial returns 200 and the SSE closes with `done` before any terminal event (coordinator fanout closed by segment replacement, session-coordinator.ts:466 / 667; subscriber-fanout.ts:116-129), `terminal` stays false and the loop re-enters `reconnect(after)` immediately (aos-client.ts:322, 334-338) — a zero-delay reconnect storm against the proxy.

### Repro

Unit test with `createAosRunAgent({fetcher})`: fetcher call 1 returns an SSE body that emits `id: 1` + `RUN_STARTED` then `controller.error(new Error("socket lost"))`; fetcher call 2 (the `/reconnect` POST) rejects with `new TypeError("Failed to fetch")` (or resolves `Response.json({error:{code:"temporarily_unavailable",description:"Hermes is unavailable"}},{status:503})`); fetcher call 3 would return `RUN_STARTED`+`TEXT_MESSAGE_*`+`RUN_FINISHED`. Expected: the run recovers using call 3. Actual: `collect(agent, input)` rejects after call 2 and call 3 is never made. Second test: fetcher call 2 returns `new Response("", {headers:{"content-type":"text/event-stream"}})` repeatedly; observe `fetcher` invoked hundreds of times with no delay.

### Fix sketch

Wrap the redial in a bounded retry loop driven by the vendored `reconnect-backoff.ts` semantics (base ~300 ms, cap ~15 s, full jitter; ~6-8 attempts). Retry on fetch rejection, 5xx, and on an empty non-terminal stream; return silently on `signal.aborted`; on 4xx (`run_conflict`, `not_found`) or exhaustion yield a single synthetic `RUN_ERROR` with a stable AOS code (e.g. `AOS_RECONNECT_EXHAUSTED`) so `acceptRunEvent` can mark the Session and the thread-list `load()` path can resume it later. Add tests for: rejected redial then success; 503 then success; empty-stream backoff; abort during backoff.

---

## Finding 33: Reload during a running Session whose segment has no complete journal renders the healthy run as failed

**Severity:** HIGH  
**Location:** `src/runtime-adapters/aos/aos-thread-list.ts:153`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

After the mandatory one-shot history reload on `AOS_RESET_REQUIRED`, `resume()` yields `status: incomplete/error` even when the proxy just confirmed `execution.status === "running"`, so any run that went through engine recovery, discovery, journal eviction, or journal byte overflow shows as failed on reload while Hermes is still working.

### Mechanism

1. `reconnectRun` always dials `/runs/reconnect` without `after` (aos-client.ts:1216-1220). Coordinator `recover` with `after === undefined` on a same-runId, non-uncertain execution requires `segment.journal`; when it is absent it returns `#resetSubscription` -> `RUN_ERROR AOS_RESET_REQUIRED` (session-coordinator.ts:389-398, 825-843).
2. The journal is absent for every segment built by `#recoverExecution` (`journalComplete=false`, session-coordinator.ts:443-449) and by discovery, for the 6th+ concurrently running Session (`MAX_ACTIVE_RUN_JOURNALS = 5`, :96, :700-712), and for any run whose compacted journal exceeds `maxReplayBytes` (= `subscriberBytes`, factory.ts:43; `#rememberJournal` drops the journal, :685-699). Every transport socket loss interrupts every Session and forces `#recoverExecution` on redial, so after one Hermes blip all running Sessions are journal-less for the rest of their turn.
3. Browser `resume()` handles the reset by calling `loadHistory` once; if `history.execution?.status` is still `running` it falls to the else branch and yields `{status:{type:"incomplete",reason:"error",error:"AOS run history must be reloaded before continuing."}}` and returns (aos-thread-list.ts:129-164, specifically 153-162). No further subscription is attempted although the coordinator would happily serve `#subscribe(segment, 0)` future-only events for `after: 0` (session-coordinator.ts:399-404, 760-793).
4. `acceptRunEvent` also marks the Session `failed` for that `RUN_ERROR` (aos-client.ts:881-882) before `loadHistory` flips it back to `running` (aos-client.ts:952-953).
5. Test aos-thread-list.test.ts:311 ("stops recovery after one history reload when the provider still reports the run as active") pins this error outcome; the pinned behavior contradicts the provider contract (Hermes says the turn is running).

### Repro

1. Start a run, force `RUN_ERROR AOS_CONNECTION_INTERRUPTED` (or use two clients so the coordinator's journal is evicted); browser redials and the coordinator builds a recovered segment (`journal: undefined`). 2) Reload the page: `loadHistory` -> `execution:{status:"running",runId}` -> `resume()` -> `/reconnect` without `after` -> `RUN_ERROR AOS_RESET_REQUIRED`. 3) `loadHistory` again -> still `running`. Expected: the thread stays in running state and receives subsequent live events. Actual: `resume()` yields incomplete/error and stops. Unit form: `AosThreadListAdapter` with `loadHistory` always returning `execution:{status:"running",runId:"run-1"}` and `reconnectRun` yielding one `AOS_RESET_REQUIRED` — current test at aos-thread-list.test.ts:311 asserts the error; the assertion should become a running/complete outcome.

### Fix sketch

In `resume()`, after the single reload confirms `running`, continue with a second `reconnectRun(threadId, runId, signal, {after: 0})` (add an optional cursor to `reconnectRun`) so the coordinator serves raw future-only events on top of the reloaded history plus `#activeFallback`; only yield error when the reload reports `failed`/unknown. Keep the one-reload guard to avoid loops but do not convert a confirmed-running run into an error status. Coordinator side (complementary): give recovered/discovered segments a journal seeded from the replayed frames, or make `recover` fall back to raw `after: 0` replay instead of `#resetSubscription` when the journal is missing but the raw replay buffer is intact.

---

## Finding 34: Coordinator `uncertain` execution (`execution.status: "failed"` with runId) is never resumed by the browser, so a recoverable run looks permanently failed

**Severity:** HIGH  
**Location:** `src/runtime-adapters/aos/aos-thread-list.ts:53`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

`load()` arms `unstable_resume` only for `status === "running"`; for `"failed"` (the proxy's projection of `uncertain`) it drops the runId even though `/runs/reconnect` with that runId is exactly the path that reattaches the engine and reconciles the turn.

### Mechanism

1. `routes/sessions.ts:73-83` maps coordinator state `uncertain` to `execution.status: "failed"` and still includes `runId`.
2. `AosThreadHistoryAdapter.load()` sets `#activeRunId` only when `status === "running"` (aos-thread-list.ts:53-56); `AosRemoteClient.loadHistory` deletes `#runIds` for anything but running (aos-client.ts:954-956) and sets Session status `failed` (:953).
3. In-run, the same states are produced by `RUN_ERROR AOS_SEND_UNCERTAIN` / `AOS_INTERACTION_UNCERTAIN` (run.ts:1725-1745) which the browser forwards as a plain failure (`acceptRunEvent` -> `failed`, aos-client.ts:881-893; assistant-ui shows the message error) — unlike `AOS_CONNECTION_INTERRUPTED`, which is intercepted and auto-redialed (aos-client.ts:300-307).
4. The coordinator's only exit from `uncertain` is `recover` with the exact runId (session-coordinator.ts:405-426 -> `#recoverExecution` -> engine `#reattach`, run.ts:1061-1146); `start` rejects new turns with `ServerRunConflictError` while `state !== "idle"` (:344-345). The browser never issues that call, so the Session stays 409 for every Send until proxy restart.
5. `AOS_SEND_UNCERTAIN` is emitted whenever `prompt.submit` throws — including a 15 s RPC timeout on a half-open socket after Hermes already accepted the prompt (`status:"streaming"` returns immediately upstream, methods_prompt.py:669-676) — so the turn is frequently alive.

### Repro

Unit: `AosThreadListAdapter` with `loadHistory` resolving `execution:{status:"failed",runId:"run-1"}` and a `reconnectRun` spy. `load()` returns no `unstable_resume`; `resume()` returns immediately; `reconnectRun` never called. Integration: `/runs` SSE emits `RUN_STARTED` then `RUN_ERROR AOS_SEND_UNCERTAIN`; observe `client.sessionStatus(threadId) === "failed"`, no `/reconnect` POST, and the next `/runs` POST answered 409.

### Fix sketch

Browser: (a) in `load()`, arm resume when `execution.runId` is present and status is `running` or `failed`; (b) in `reconnectingSse`, treat `AOS_SEND_UNCERTAIN` and `AOS_INTERACTION_UNCERTAIN` like `AOS_CONNECTION_INTERRUPTED` (redial with backoff, do not forward) so the engine's `#reattach` reconciles; (c) `acceptRunEvent` should map the recoverable codes (`uncertainError` set) to a distinct status (e.g. keep `running`) rather than `failed`. Engine/coordinator (complementary, outside this lens): `#reattach` must re-check `status()` after replay so a run Hermes never accepted settles instead of hanging.

---

## Finding 35: Browser reuses a stale SSE cursor across coordinator segments (per-segment sequences restart at 0), causing skipped events or an infinite zero-delay redial loop

**Severity:** MEDIUM  
**Location:** `src/runtime-adapters/aos/aos-client.ts:298`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

`after` is treated as a run-level cursor but the proxy numbers each segment from 0; when another client's recovery replaces the segment, this client's stream closes without a terminal event and its redial with the old cursor either drops the new segment's leading events (ag-ui verify failure) or receives an empty stream forever.

### Mechanism

1. `reconnectingSse` keeps `after` across redials (aos-client.ts:280, 298-299) and never clears it.
2. Coordinator segments start at `nextSequence: 0` (session-coordinator.ts:606-611) and `#recoverExecution` closes the previous segment's fanout (:466), which ends every attached SSE without a terminal event (subscriber-fanout.ts:116-129 -> `createRunStreamResponse` closes on `result.done`, routes/runs.ts:216-220).
3. The displaced client sees `done` with `terminal === false` and redials with `after = <old-segment seq>` (aos-client.ts:322-338).
4. `recover` now matches the new segment (`runId` equal, state `running`, `after` defined) and returns `#subscribe(segment, after)` which filters `sequence <= after` in both replay and live (session-coordinator.ts:399-404, 770-780): the first `after` events of the new segment (including `TEXT_MESSAGE_START`) are dropped. `verifyEvents` in `runAgent` then rejects the next `TEXT_MESSAGE_CONTENT` ("No active text message found") and the run errors in the browser.
5. If the new segment finishes within `after` events, the SSE is empty and closes -> `done`, `terminal` false -> immediate redial -> identical empty result: a zero-delay loop until the tab is closed (no cap in `reconnectingSse`).

### Repro

Two subscribers on one running Session: client A streams `/runs` (segment 1, ids 1..40). Engine emits `RUN_ERROR AOS_CONNECTION_INTERRUPTED` (id 41); client B (already reconnecting) triggers `#recoverExecution`, creating segment 2 (ids 1..). Client A's stream closes with `done`; it POSTs `/reconnect {after: 41}`; coordinator serves segment 2 events with sequence > 41 only. If segment 2 emits <= 41 events before `RUN_FINISHED`, A's stream is empty and it redials in a tight loop. Coordinator-level unit: start run, subscribe with `after: 41` against a fresh recovered segment, assert first events are skipped.

### Fix sketch

Coordinator (primary): keep the run's sequence monotonic across segments by seeding the replacement segment's `nextSequence` from the replaced segment, or encode a segment epoch in the SSE `id:` (e.g. `epoch:seq`) and reset when it changes. Browser: when a stream ends without a terminal event, apply the same bounded backoff as finding 1, and if the server signals a new epoch (or the first received `id` is lower than `after`), restart with `after: 0`.

---

## Finding 36: Client-side Session status cache is sticky and diverges from provider truth after Stop, reconnect failure, or any RUN_ERROR

**Severity:** MEDIUM  
**Location:** `src/runtime-adapters/aos/aos-client.ts:1477`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

Once `#sessionStatuses` holds a locally derived value, catalog and session reads never override it, and `stopRun` sets `running` for `stopping` after the browser has already aborted the stream that would deliver the settling `RUN_FINISHED`, so Sessions show `running`/`failed` indefinitely and `#runIds` stays stale.

### Mechanism

1. `#rememberSession` computes `status = this.#sessionStatuses.get(id) ?? session.status` (aos-client.ts:1476-1480): the cached value wins over every later `listSessions`/`getSession` payload; only `loadHistory` (:952-957) or a new run event changes it.
2. Stop path: assistant-ui `cancel()` aborts the fetch first (AgUiThreadRuntimeCore.js:186-192 -> `reconnectingSse` returns on `signal.aborted`, aos-client.ts:328, 334-336), then `onCancel` calls `client.stopRun` (composition.tsx:229-232). `stopRun` maps `stopping -> running` (aos-client.ts:1078-1081) and leaves `#runIds` intact; the eventual `RUN_FINISHED {stopped:true}` is never observed because the stream is gone. `stopRun` failures (e.g. 503 `AOS_STOP_UNCERTAIN`) are swallowed (`.catch(() => undefined)`).
3. Reconnect failure (finding 1) likewise leaves `running` + stale runId.
4. Stale `#runIds` makes `steerRun` send an outdated `expectedRunId` (aos-client.ts:1090-1097) -> 409 -> thread.aui.tsx:1055-1063 falls back to `submitOrdinary()`, silently converting a steer into a new turn.
5. `RUN_ERROR` of any code sets `failed` (aos-client.ts:881-882) and that too is sticky until the thread is reopened.

### Repro

Unit: `listSessions` returns status `running`; `stopRun` -> `{status:"stopping"}`; `listSessions` again returns status `idle`; `client.sessionStatus(id)` and `getSessionMetadata([id])[0].status` still equal `running`. Also: `acceptRunEvent(RUN_ERROR)` then `listSessions` with `idle` -> still `failed`.

### Fix sketch

Track which threads have an actively observed run (`#runIds`); in `#rememberSession`, prefer the provider's `session.status` whenever no run is being observed (or when the cached value is `failed`/`idle`). After `stopRun` returns `stopping`, refresh via `getSession`/`loadHistory` once the reconciler invalidates the scope (`subscribeSessionInvalidation` already exists, aos-client.ts:1187-1191) or on a short timer; clear `#runIds` on Stop so steer cannot target a dead run.

---

## Finding 37: First turn of a draft Session is never observed by the client (onEvent bound only when remoteId exists), leaving status idle and steering broken for that turn

**Severity:** LOW  
**Location:** `src/runtime-adapters/aos/composition.tsx:188`  
**Fixed by vendoring:** No — requires adapter-level fix

### Summary

`onEvent` is `undefined` for the HttpAgent created while the thread is still a local draft; the promoting run streams on that agent instance, so `acceptRunEvent` never receives `RUN_STARTED`/`RUN_FINISHED` for the Session's first turn.

### Mechanism

1. `createAosRunAgent` calls `onEvent?.(signalEvent)` without a thread id (aos-client.ts:312-313); composition binds `onEvent: remoteId ? (event) => client.acceptRunEvent(remoteId, event) : undefined` (composition.tsx:188-190).
2. For a draft, `remoteId` is undefined at agent creation; `runFetch` resolves the remote id lazily (aos-client.ts:423-427) but the bound callback is still `undefined`.
3. When `remoteId` appears, `useMemo` builds a new agent (composition.tsx:199) and `updateOptions` swaps `this.agent` (AgUiThreadRuntimeCore.js:86-92), but the in-flight run keeps `activeRunAgent` (:635-636), so the whole first turn streams through the old callback-less agent.
4. Consequences: `#sessionStatuses` stays `idle` (set at `createSession`, aos-client.ts:922) during the turn; `#runIds` is never set, so `steerRun` throws local `run_conflict` (aos-client.ts:1090-1096) and thread.aui.tsx:1055-1063 falls back to `submitOrdinary()`, queuing the text as a new turn instead of steering; `media.setSafelyIdle(true)` while running (composition.tsx:409-412); no `run-started`/`run-finished` activity events for that turn.

### Repro

Extend composition.test.tsx "promotes a local draft before dispatching its first queued run": after the `/runs` POST is observed and before the SSE ends, assert `supplied.workspace.sessionStatus("remote-session")` — it is `"idle"` (expected `"running"`); after `RUN_FINISHED`, `subscribeActivity` received no `run-started` event for `remote-session`.

### Fix sketch

Pass the resolved thread id to the callback: change `onEvent` to `(threadId, event) => void` and invoke `onEvent?.(resolvedThreadId, signalEvent)` inside `runFetch`; in composition, bind `onEvent: (threadId, event) => client.acceptRunEvent(threadId, event)` unconditionally (ownership is already adopted via `adoptSessionOwnership`/`createSession`).

---

## Appendix: audit maps

The raw audit JSON at the path above contains six named maps produced by the
research agents:

| Map name              | Contents                                        |
| --------------------- | ----------------------------------------------- |
| `transport-adapter`   | Transport and adapter flow analysis             |
| `run-engine`          | Run engine state machine and lifecycle analysis |
| `coordinator-browser` | Coordinator and browser runtime analysis        |
| `upstream-contract`   | Upstream Hermes server API contract             |
| `dry-structure`       | Code duplication and structure analysis         |
| `fix-history`         | History of previous fixes and regressions       |

---

## Status after implementation

The implementation spans commits `7420ae2` through `857ec5a` on branch
`worktree-hermes-vendored-gateway`. The raw audit JSON lives outside the
repository at the path shown in the Appendix; it is not part of the AOS
source tree.

`MAX_ACTIVE_RUN_JOURNALS` and `journalComplete` no longer exist in
`session-coordinator.ts`; those symbols were removed when the coordinator was
refactored to a single compacted journal.

| Finding | Status   | Notes                                                                                                                                                  |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1      | Fixed    | Discovery now scans only the open-turn ring; catch-up uses the run cursor, not the full retained ring.                                                 |
| F2      | Fixed    | Typed native outcomes (`HermesSubmitOutcome`) distinguish rejected from uncertain; definitive rejections no longer become `AOS_SEND_UNCERTAIN`.        |
| F3      | Fixed    | Coordinator one subscribe path and journal eliminate the pre-submit status race.                                                                       |
| F4      | Fixed    | Vendored `JsonRpcGatewayClient` owns `gateway.ping` heartbeat.                                                                                         |
| F5      | Fixed    | Vendored client owns socket-generation tracking; observers do not accumulate across redials.                                                           |
| F6      | Fixed    | One turn-outcome rule maps `status:"interrupted"` to stopped, not success.                                                                             |
| F7      | Fixed    | Duplicate of F4; fixed by vendoring.                                                                                                                   |
| F8      | Fixed    | `gateway.ts` drops events exceeding 2 MiB before they reach the shared socket.                                                                         |
| F9      | Fixed    | `attachment-registry.ts` invalidates the binding on 4001 and 4007 rejection.                                                                           |
| F10     | Fixed    | Duplicate of F5; fixed by vendoring.                                                                                                                   |
| F11     | Fixed    | Vendored client owns frame-decode state; it is scoped to the socket generation.                                                                        |
| F12     | Fixed    | Vendored client handles `close()` during an in-flight dial.                                                                                            |
| F13     | Fixed    | Duplicate of F1; fixed by open-turn ring scan.                                                                                                         |
| F14     | Fixed    | Bounded pre-active queue management prevents emit-into-closed-queue overflow.                                                                          |
| F15     | Fixed    | Duplicate of F5/F10; fixed by vendoring.                                                                                                               |
| F16     | Fixed    | Coordinator compacted journal covers recovered segments; no journalless recovery path remains.                                                         |
| F17     | Fixed    | Coordinator issues monotonic sequences per run across segments; stale cursors no longer skip events.                                                   |
| F18     | Fixed    | `gateway.ts` detects epoch changes and emits the reset signal; `run.ts` classifies them as `AOS_RESET_REQUIRED`.                                       |
| F19     | Fixed    | `interactions.ts` registers `onRequest` for `clarify` and `approval`; it re-delivers `open_requests` on reattach and responds over the request handle. |
| F20     | Fixed    | Settlement watcher and one turn-outcome rule handle Stop during the agent-build window correctly.                                                      |
| F21     | Fixed    | One turn-outcome rule; redirect-chain flags do not override a native `status:"error"`.                                                                 |
| F22     | Fixed    | Queued-steer path waits for Hermes to start the drained turn before settling.                                                                          |
| F23     | Fixed    | Three-way error classification in `gateway.ts`; Stop rejections map to the correct outcome rather than `uncertain`.                                    |
| F24     | Fixed    | Duplicate of F6; one turn-outcome rule.                                                                                                                |
| F25     | Fixed    | `attachment-registry.ts` running-aware idle close; the idle timer does not fire while a run is active.                                                 |
| F26     | Fixed    | `interactions.ts` `request.cancel` subscription expires pending requests; the interaction retainer is released.                                        |
| F27     | Fixed    | Duplicate of F2; typed native outcomes.                                                                                                                |
| F28     | Fixed    | Failure catalogue logs one redacted, bounded native cause per failed run.                                                                              |
| F29     | Fixed    | Duplicate of F20; settlement watcher.                                                                                                                  |
| F30     | Deferred | Slash-command detection errors are a separate concern; not addressed in this branch.                                                                   |
| F31     | Deferred | `AOS_STOP_UNCERTAIN` HTTP status mapping is a browser/routes concern; not addressed in this branch.                                                    |
| F32     | Deferred | Browser reconnect backoff is in `src/runtime-adapters/aos`; not addressed in this branch.                                                              |
| F33     | Deferred | Browser behavior on reload during a running segment with coordinator-owned journal; not addressed in this branch.                                      |
| F34     | Deferred | Coordinator side addressed (uncertain executions recover on next Send); browser-side resume path deferred.                                             |
| F35     | Deferred | Coordinator issues monotonic sequences (server side fixed); browser stale-cursor handling deferred.                                                    |
| F36     | Deferred | Browser-side sticky status cache; not addressed in this branch.                                                                                        |
| F37     | Deferred | Browser-side draft-Session first-turn observation; not addressed in this branch.                                                                       |
