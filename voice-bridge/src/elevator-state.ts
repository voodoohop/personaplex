// Elevator game state — the "brain" that Claude reasons about

export interface ElevatorState {
  currentFloor: number;
  targetFloor: number | null;
  mood: "happy" | "neurotic" | "anxious" | "drunk" | "terrified";
  resistanceLevel: number; // 0-10, increases as floor decreases
  conversationHistory: string[]; // recent turns for context
  towelMentioned: boolean;
  marvinPresent: boolean;
}

export function createInitialState(): ElevatorState {
  return {
    currentFloor: 5,
    targetFloor: null,
    mood: "happy",
    resistanceLevel: 0,
    conversationHistory: [],
    towelMentioned: false,
    marvinPresent: false,
  };
}

// Floor-based mood and resistance from the original game prompts
const FLOOR_BEHAVIOR: Record<number, { mood: ElevatorState["mood"]; resistance: number }> = {
  5: { mood: "happy", resistance: 1 },
  4: { mood: "happy", resistance: 3 },
  3: { mood: "neurotic", resistance: 6 },
  2: { mood: "anxious", resistance: 9 },
  1: { mood: "terrified", resistance: 10 },
};

export function updateStateForFloor(state: ElevatorState, floor: number): ElevatorState {
  const clamped = Math.max(1, Math.min(5, floor));
  const behavior = FLOOR_BEHAVIOR[clamped] || FLOOR_BEHAVIOR[5];
  return {
    ...state,
    currentFloor: clamped,
    mood: state.currentFloor === 5 && clamped === 5 ? "drunk" : behavior.mood, // drunk at top
    resistanceLevel: behavior.resistance,
  };
}

export function addConversationTurn(state: ElevatorState, speaker: "user" | "elevator", text: string): ElevatorState {
  const entry = `${speaker}: ${text}`;
  return {
    ...state,
    conversationHistory: [...state.conversationHistory.slice(-10), entry],
    towelMentioned: state.towelMentioned || /towel/i.test(text),
    marvinPresent: state.marvinPresent || /marvin/i.test(text),
  };
}
