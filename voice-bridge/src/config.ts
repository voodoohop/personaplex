// Voice bridge configuration
export const config = {
  // PersonaPlex server
  personaplexHost: process.env.PERSONAPLEX_HOST || "localhost",
  personaplexPort: parseInt(process.env.PERSONAPLEX_PORT || "8998"),
  personaplexWsPath: process.env.PERSONAPLEX_WS_PATH || "/api/chat",

  // Voice settings
  voicePrompt: process.env.VOICE_PROMPT || "VARF2.pt",
  audioTemperature: parseFloat(process.env.AUDIO_TEMPERATURE || "0.9"),
  textTemperature: parseFloat(process.env.TEXT_TEMPERATURE || "0.7"),

  // Bridge server
  port: parseInt(process.env.PORT || "3001"),

  // Claude API (for System 2 reasoning)
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",

  // Timing
  turnSilenceMs: 350, // ms of no text tokens = turn complete
  reconnectDelayMs: 2000, // wait for PersonaPlex session lock release
  system2TimeoutMs: 15000, // max time for Claude to respond
};
