# Stellarator Cognitive Architecture — MVP

A TypeScript MVP for a multi-agent cognitive architecture. Four independent specialists create proposals in parallel, the Fusion Engine combines them into a decision, and the Field Engine maintains an inertial state across iterations. The default backend is an already authenticated OpenCode installation with `opencode/big-pickle`; Ollama remains a local fallback.

## MVP Plan

1. Define strict Zod schemas for proposals, the field state, and fusion results.
2. Integrate OpenCode without orchestration frameworks while retaining Ollama as a fallback.
3. Run specialists in parallel and combine their responses in a convergence loop.
4. Provide a CLI and verify TypeScript compilation.

## Installation

Requires Node.js 20+ and an authenticated OpenCode installation with the `opencode/big-pickle` model.

```powershell
npm install
npm run dev -- "Design an MVP for a task management service" 3 0.8
```

By default, the project calls `opencode run --format json --model opencode/big-pickle`. Credentials remain in the user's OpenCode configuration and are never written to this repository. Optionally configure environment variables using `.env.example` as a reference.

### Local Fallback

To use Ollama instead, start `ollama serve` and switch the backend:

```powershell
$env:LLM_BACKEND="ollama"
$env:OLLAMA_MODEL="llama3.2"
npm run dev -- "Your goal"
```

## How It Works

`SpecialistAgent` generates and Zod-validates a strict JSON proposal. `Stellarator` collects all proposals with `Promise.all`; `FusionEngine` then assesses the combined plan and its consensus. `FieldEngine` applies field updates smoothly, retains short-term memory, and ends the loop once the configured convergence threshold is met.

Build with `npm run build`; run the compiled version with `npm start -- "your goal"`.
