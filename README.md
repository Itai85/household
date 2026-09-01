# 🏠 Household

Track your bills, contracts, and household expenses — all in one place.

Upload a bill or contract, and AI extracts the provider, tariffs, dates, and amounts automatically. Works with **Claude, ChatGPT, Gemini, Grok, Groq, Mistral**, or local models via Ollama.

## Features

- **Smart document parsing** — Upload PDFs or paste text. AI extracts everything.
- **Multi-provider AI** — Bring your own API key from any major provider.
- **Bill tracking** — Track usage, costs, and rate changes over time.
- **Bill forecast** — Estimate your next bill from historical data + current tariffs.
- **Dashboard** — See all your household costs at a glance.
- **Privacy first** — Your API key stays in your browser. Data is yours.

## Quick Start (Local)

```bash
npm install
npm run dev
```

No account needed. Data is stored locally in your browser (IndexedDB).

## Deploy (Multi-User)

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com), create a new project.

### 2. Run the database migration

In your Supabase dashboard → SQL Editor, paste and run:

```
supabase/migrations/001_initial.sql
```

### 3. Enable Google Auth (optional)

Supabase dashboard → Authentication → Providers → Google → Enable.
Add your Google OAuth credentials.

### 4. Configure environment

Create `.env` in the project root:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...your-anon-key
```

### 5. Deploy to Vercel

```bash
npm install -g vercel
vercel
```

Set the environment variables in Vercel dashboard → Settings → Environment Variables.

That's it. Users sign in with Google or email magic link, connect their own AI key, and start uploading bills.

## Tech Stack

- **Frontend**: React 19 + Vite + TypeScript
- **Storage**: IndexedDB (local) or Supabase Postgres (cloud)
- **Auth**: Supabase Auth (Google OAuth + Magic Link)
- **AI**: Multi-provider (Anthropic, OpenAI, Google, xAI, Groq, Mistral, Ollama)
- **PDF**: pdfjs-dist (browser-based, no server needed)
- **OCR**: Tesseract.js (for scanned documents)

## Project Structure

```
src/
├── platform/          # Core logic (no UI)
│   ├── ai-providers.ts    # Multi-AI adapter layer
│   ├── llm-parser.ts      # Document parsing with AI
│   ├── storage.ts         # Dual-mode: IndexedDB or Supabase
│   ├── supabase.ts        # Supabase client
│   ├── forecast.ts        # Bill forecast engine
│   ├── document-reader.ts # PDF/image text extraction
│   ├── document-parser.ts # Regex fallback parser
│   └── text-preprocessor.ts # Strip boilerplate before AI
├── store/
│   ├── AppContext.tsx      # App state (services, bills, docs)
│   └── AuthContext.tsx     # Auth state (login/logout)
├── screens/           # UI screens
│   ├── HomeScreen.tsx
│   ├── LoginScreen.tsx
│   ├── SettingsScreen.tsx
│   ├── ImportDocumentScreen.tsx
│   ├── ServiceDetailScreen.tsx
│   ├── DashboardScreen.tsx
│   └── ...
├── types/index.ts     # Domain types
└── styles.css         # All styles
```

## Cost

- **Hosting**: $0/month (Vercel free tier)
- **Database**: $0/month (Supabase free tier, up to 500MB)
- **AI**: Each user pays their own provider directly
