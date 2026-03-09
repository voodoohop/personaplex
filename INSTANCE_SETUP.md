# PersonaPlex Instance Setup (Vast.ai)

## Requirements

- **GPU**: RTX 4090 (24GB VRAM) — model uses ~19GB
- **Image**: PyTorch 2.x with CUDA (e.g. `pytorch/pytorch:2.x-cuda12.x`)
- **Disk**: ~30GB (model weights + code)

## 1. PersonaPlex (Moshi 7B voice model)

```bash
cd /workspace
git clone https://github.com/voodoohop/personaplex.git
cd personaplex

# Install Python deps (system python, no venv needed on Vast.ai)
pip install -e ./moshi
pip install sphn aiohttp

# Build client
cd client && npm install && npm run build && cd ..

# Run (with our tool-calling extensions)
screen -dmS personaplex bash -c 'python3 -m moshi.server --host 0.0.0.0 --static client/dist --tools 2>&1 | tee /tmp/personaplex.log'
```

PersonaPlex serves on **port 8998**:
- WebSocket API: `ws://localhost:8998/api/chat`
- Web client: `http://localhost:8998/` (if `--static client/dist` is used)

### Key flags
- `--tools` — enables tool calling (elevator game mechanics)
- `--host 0.0.0.0` — listen on all interfaces

### Moshi binary protocol (WebSocket)
| Kind byte | Direction | Description |
|-----------|-----------|-------------|
| 0x00 | server→client | Handshake |
| 0x01 | bidirectional | Audio (Opus) |
| 0x02 | client→server | Text injection (with `<system>` tags) |
| 0x02 | server→client | Text token |
| 0x04 | server→client | Metadata/events (JSON) |
| 0x07 | client→server | Soft reset (re-tokenize prompt, reset streaming) |

## 2. vaos-voice-bridge (Talker-Reasoner architecture)

Original repo: https://github.com/jmanhype/vaos-voice-bridge

```bash
cd /workspace
git clone https://github.com/jmanhype/vaos-voice-bridge.git
cd vaos-voice-bridge

# Install bun
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

bun install
```

### .env configuration
```env
SUPABASE_URL=https://dummy.supabase.co
SUPABASE_SERVICE_ROLE_KEY=dummy-key-that-is-long-enough-here
ANTHROPIC_AUTH_TOKEN=<real key or dummy>
ANTHROPIC_BASE_URL=https://api.anthropic.com
PORT=9001
LOG_LEVEL=debug
PERSONAPLEX_HOST=localhost
PERSONAPLEX_PORT=8998
PERSONAPLEX_WS_PATH=/api/chat
LETTA_BASE_URL=http://localhost:8283
LETTA_AGENT_NAME=voice-reasoner
VOICE_PROMPT_PATH=VARF2.pt
```

### Known fixes needed
1. **tts.ts missing exports**: `server.ts` imports `synthesize` and `readWavPcm` from `tts.ts`, but only `PersonaplexTTS` class is exported. Add wrapper functions (see commit history).
2. **reasoner.ts constructor mismatch**: `server.ts` calls `new Reasoner(bus, memory, trigger, sessionId)` but constructor expects `(config: Config)`. Fix: change constructor to accept `...args: any[]` and call `getConfig()` when not passed a Config object.

```bash
screen -dmS bridge bash -c 'cd /workspace/vaos-voice-bridge && bun run src/server.ts 2>&1 | tee /tmp/bridge.log'
```

Bridge serves on **port 9001** with built-in web client at `/`.

## 3. Cloudflare tunnel (optional, for external access)

```bash
# Download cloudflared
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# Tunnel to PersonaPlex client
screen -dmS cftunnel cloudflared tunnel --url http://localhost:8998
```

## 4. Access via SSH tunnel (local dev)

```bash
# Forward PersonaPlex client
ssh -i ~/.ssh/pollinations_services_2026 -p <SSH_PORT> -L 8998:localhost:8998 root@<SSH_HOST>

# Forward vaos-voice-bridge
ssh -i ~/.ssh/pollinations_services_2026 -p <SSH_PORT> -L 9001:localhost:9001 root@<SSH_HOST>
```

## Architecture

```
Browser <--WS--> vaos-voice-bridge (port 9001) <--WS--> PersonaPlex/Moshi (port 8998)
                      |                                        |
                      +-- Letta/Claude (System 2)              +-- GPU (RTX 4090)
                      +-- Supabase (memory)                    +-- ~19GB VRAM
```

- **System 1 (Talker)**: PersonaPlex Moshi 7B — fast, full-duplex voice
- **System 2 (Reasoner)**: Claude/Letta — slow, smart decisions
- Bridge routes between them, with trigger-based activation of System 2

## Repos

- **PersonaPlex fork**: https://github.com/voodoohop/personaplex (main branch = server mods, feat/voice-bridge = our minimal bridge)
- **vaos-voice-bridge original**: https://github.com/jmanhype/vaos-voice-bridge
