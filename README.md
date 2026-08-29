# LexiDuel

LexiDuel is a private two-player English practice room with WebRTC voice, AI-generated matches, server-side grading, and persistent learning history. Its learning labs cover vocabulary, listening comprehension, minimal pairs, dictation, story listening, shadowing, pronunciation, speaking, reading, sentence building, cloze, error correction, collocations and writing.

There is no seed script, sample player, sample room, sample question, or browser fallback. A fresh database is intentionally empty. Supabase is the only source of truth for shared application data.

## 1. Create and configure Supabase

1. Create a new Supabase project.
2. Open **Authentication → Providers → Anonymous Sign-Ins** and enable anonymous sign-ins. Google OAuth is optional.
3. Open the SQL editor and run [`supabase/schema.sql`](supabase/schema.sql), then every migration in the exact order listed in [`supabase/README.md`](supabase/README.md). The scripts create the tables, functions, triggers, RLS policies, Realtime authorization, learning labs and protected grading paths.
4. Open **Project Settings → API Keys** and copy the project URL, publishable key, and secret key.

The SQL file targets a clean LexiDuel project and is not a repeatable seed. Do not run it twice against the same schema.

## 2. Configure local environment

Copy `.env.example` to `.env.local` and set:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY=YOUR_SERVER_ONLY_SECRET_KEY

GROQ_API_KEY=YOUR_GROQ_KEY
GROQ_MODEL=YOUR_JSON_CAPABLE_GROQ_MODEL

GEMINI_API_KEY=YOUR_GOOGLE_AI_STUDIO_KEY
GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview
GEMINI_GRADING_MODEL=gemini-3.7-flash
GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview
```

Never expose `SUPABASE_SECRET_KEY`, `GROQ_API_KEY`, or `GEMINI_API_KEY` with a `NEXT_PUBLIC_` prefix. The browser receives a one-use, short-lived Gemini Live token from the authenticated server route; it never receives the permanent Gemini API key.

The included Google button also requires a Google provider in Supabase. Add these local and production callbacks to the provider/redirect allow lists:

```text
http://localhost:3000/auth/callback
https://YOUR_DOMAIN/auth/callback
```

## 3. Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, enter a real display name, create a room, then open a second private browser profile and join with the generated code. Data appears only after these actions.

## 4. Voice configuration

The browser uses Supabase private Realtime channels for presence and WebRTC signaling. Audio itself travels through WebRTC.

Inside the practice builder, the host can explicitly start Gemini Live listening. The browser streams raw PCM microphone audio directly to Gemini with a short-lived token and plays Gemini's 24kHz PCM response. Stopping Gemini immediately ends capture and closes the Live WebSocket.

The public Google STUN server in `.env.example` is sufficient for many local tests. Production users behind restrictive networks require TURN:

```dotenv
NEXT_PUBLIC_TURN_URL=turns:YOUR_TURN_HOST:5349
NEXT_PUBLIC_TURN_USERNAME=SHORT_LIVED_USERNAME
NEXT_PUBLIC_TURN_CREDENTIAL=SHORT_LIVED_CREDENTIAL
```

Use short-lived TURN credentials in production; browser TURN credentials cannot be treated as permanent secrets.

## 5. Deploy to Vercel

1. Import the repository into Vercel.
2. Add every required environment variable for Production and Preview.
3. Deploy.
4. Add the deployed `/auth/callback` URL to Supabase Auth redirect URLs.
5. Test with two different signed-in/anonymous browser sessions.

Run these checks before deploying:

```bash
npm run lint
npm run build
```

## Data and security model

- Supabase Auth creates a `profiles` and `user_learning_stats` row through a database trigger.
- Room creation, joining, leaving, and answer grading use `SECURITY DEFINER` RPCs with explicit grants.
- `question_answers` cannot be selected by browser roles.
- An answer is revealed only after the room reaches the round-result state.
- Scores, winners, vocabulary history, and learning scores are calculated and persisted on the server.
- Zustand stores only mute/deafen controls; it never stores authoritative game data.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full runtime boundaries.

## Design assets

- `design/lexiduel-screen-board.png` is the high-fidelity source board.
- `public/images/lexi-host.png` is the generated AI host portrait.
