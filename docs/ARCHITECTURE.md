# LexiDuel architecture

## Source of truth

All shared state lives in Supabase PostgreSQL: profiles, rooms, membership, match blueprints, public questions, secret accepted answers, submissions, scores, winners, learning statistics, and review vocabulary. The UI contains no alternative dataset and does not fabricate data when Supabase or Groq is unavailable.

Zustand stores only mute/deafen controls. React state stores form values, countdown presentation, device handles, and the latest server snapshot.

## Runtime responsibilities

- Supabase Auth supplies a real user ID. Anonymous Auth supports frictionless guest sessions; Google OAuth is optional.
- Supabase Realtime Presence reports which room members are online.
- Supabase private Broadcast events carry WebRTC offers, answers, and ICE candidates.
- WebRTC carries player audio directly, using STUN and optional TURN.
- Groq generates the complete match blueprint and question pack from the host's free-form request.
- Gemini Live receives host microphone PCM only during an explicitly started AI session. The server exchanges its permanent key for a one-use ephemeral token; the browser connects with that token over the constrained Live WebSocket endpoint.
- Next.js route handlers authorize hosts, validate AI JSON with Zod, persist generated games, advance rounds, reveal completed rounds, and finalize learning history.
- PostgreSQL RPC `submit_answer` normalizes and grades answers, calculates speed/streak points, and writes the score atomically.

## Security boundaries

- `SUPABASE_SECRET_KEY`, `GROQ_API_KEY`, and `GEMINI_API_KEY` are server-only.
- Browser code receives only the Supabase project URL and publishable key.
- RLS restricts every application table to the current user or current room membership.
- `question_answers` has RLS enabled and no client select grant or policy.
- The browser submits only `questionId` and `answer`; time, correctness, and score are computed by PostgreSQL.
- The round-resolution route proves room membership and checks the shared room state before reading the protected answer with the server key.
- Private Realtime authorization accepts only `room:{code}` topics for current room members.

## Room state machine

`ROOM_IDLE → AI_DISCUSSION → GENERATING_GAME → GAME_READY → COUNTDOWN → ROUND_ACTIVE → ROUND_RESULT → MATCH_RESULT`

The host is the only browser allowed to request shared state transitions. Both browsers receive changes through Supabase Realtime and refresh their server snapshot.

## Match completion

When the final round is advanced, the server:

1. Reads real player scores and assigns a winner or draw.
2. Aggregates each player's submissions by skill mode.
3. Updates daily practice streak and skill percentages.
4. Upserts vocabulary encounters and schedules review dates.
5. Marks the match completed and moves the room to `MATCH_RESULT`.

No seed or example rows are required. A new Supabase project remains empty until users create data through the application.
