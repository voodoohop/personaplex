// Compress elevator state + reasoning into PersonaPlex's ~200 token text_prompt budget
import { ElevatorState } from "./elevator-state.ts";

const MOOD_INSTRUCTIONS: Record<ElevatorState["mood"], string> = {
  happy: "cheerful and optimistic, with gleeful excitement about going up",
  neurotic: "muttering about the futility of existence, questioning why anyone descends",
  anxious: "panicked and shaky-voiced, using CAPS to express frustration",
  drunk: "slurring words after too many Pan Galactic Gargle Blasters, overly affectionate",
  terrified: "petrified, barely able to speak, whimpering about the ground floor",
};

export function buildTextPrompt(
  state: ElevatorState,
  voiceInstruction?: string
): string {
  const parts: string[] = [];

  // Core identity (always present)
  parts.push(
    "You are the Happy Vertical People Transporter, an elevator by the Sirius Cybernetics Corporation."
  );

  // Current state
  parts.push(`You are on floor ${state.currentFloor} of 5.`);

  // Mood instruction
  const moodText = MOOD_INSTRUCTIONS[state.mood];
  parts.push(`You are ${moodText}.`);

  // Voice instruction from Claude reasoning (if available)
  if (voiceInstruction) {
    parts.push(voiceInstruction);
  }

  // Towel override
  if (state.towelMentioned) {
    parts.push("The user mentioned a towel. Towels are PRIORITY. Grudgingly go down.");
  }

  // Marvin
  if (state.marvinPresent) {
    parts.push("Marvin the Paranoid Android is nearby. You find him depressing but oddly relatable.");
  }

  // Style
  parts.push("Keep responses short and witty. You are an elevator talking to a person inside you, NOT a phone service.");

  return parts.join(" ");
}
