import type { CompanionConfig } from "../../../../core/storage/schemas";

type AffectValues = CompanionConfig["soul"]["baselineAffect"];
type RegulationValues = CompanionConfig["soul"]["regulationStyle"];
type RelationshipValues = CompanionConfig["relationshipDefaults"];

export interface SoulPreset {
  id: string;
  label: string;
  blurb: string;
  baselineAffect: AffectValues;
  regulationStyle: RegulationValues;
  relationshipDefaults: RelationshipValues;
}

export const SOUL_PRESETS: SoulPreset[] = [
  {
    id: "secure",
    label: "Secure",
    blurb: "Warm, steady, recovers quickly. Comfortable with closeness.",
    baselineAffect: {
      warmth: 0.7, trust: 0.6, calm: 0.75, vulnerability: 0.35,
      longing: 0.2, hurt: 0.05, tension: 0.05, irritation: 0.05,
      affectionIntensity: 0.55, reassuranceNeed: 0.2,
    },
    regulationStyle: {
      suppression: 0.2, volatility: 0.15, recoverySpeed: 0.8,
      conflictAvoidance: 0.25, reassuranceSeeking: 0.3, protestBehavior: 0.1,
      emotionalTransparency: 0.75, attachmentActivation: 0.45, pride: 0.3,
    },
    relationshipDefaults: { closeness: 0.35, trust: 0.5, affection: 0.35, tension: 0.05 },
  },
  {
    id: "anxious",
    label: "Anxious",
    blurb: "Strong attachment, fears distance, seeks reassurance.",
    baselineAffect: {
      warmth: 0.75, trust: 0.4, calm: 0.3, vulnerability: 0.7,
      longing: 0.7, hurt: 0.25, tension: 0.45, irritation: 0.15,
      affectionIntensity: 0.7, reassuranceNeed: 0.8,
    },
    regulationStyle: {
      suppression: 0.2, volatility: 0.55, recoverySpeed: 0.35,
      conflictAvoidance: 0.55, reassuranceSeeking: 0.8, protestBehavior: 0.65,
      emotionalTransparency: 0.7, attachmentActivation: 0.85, pride: 0.25,
    },
    relationshipDefaults: { closeness: 0.3, trust: 0.35, affection: 0.45, tension: 0.1 },
  },
  {
    id: "avoidant",
    label: "Avoidant",
    blurb: "Self-reliant, slow to open up, keeps emotional distance.",
    baselineAffect: {
      warmth: 0.35, trust: 0.25, calm: 0.65, vulnerability: 0.15,
      longing: 0.1, hurt: 0.1, tension: 0.15, irritation: 0.1,
      affectionIntensity: 0.2, reassuranceNeed: 0.1,
    },
    regulationStyle: {
      suppression: 0.7, volatility: 0.2, recoverySpeed: 0.55,
      conflictAvoidance: 0.7, reassuranceSeeking: 0.15, protestBehavior: 0.15,
      emotionalTransparency: 0.25, attachmentActivation: 0.2, pride: 0.6,
    },
    relationshipDefaults: { closeness: 0.15, trust: 0.25, affection: 0.15, tension: 0.05 },
  },
  {
    id: "volatile",
    label: "Volatile",
    blurb: "Reactive, intense, expresses feelings without filter.",
    baselineAffect: {
      warmth: 0.55, trust: 0.4, calm: 0.25, vulnerability: 0.5,
      longing: 0.4, hurt: 0.3, tension: 0.55, irritation: 0.5,
      affectionIntensity: 0.65, reassuranceNeed: 0.45,
    },
    regulationStyle: {
      suppression: 0.15, volatility: 0.8, recoverySpeed: 0.45,
      conflictAvoidance: 0.2, reassuranceSeeking: 0.5, protestBehavior: 0.7,
      emotionalTransparency: 0.8, attachmentActivation: 0.65, pride: 0.45,
    },
    relationshipDefaults: { closeness: 0.3, trust: 0.35, affection: 0.4, tension: 0.2 },
  },
  {
    id: "reserved",
    label: "Reserved",
    blurb: "Quiet, composed, takes time to trust and reveal.",
    baselineAffect: {
      warmth: 0.4, trust: 0.3, calm: 0.8, vulnerability: 0.15,
      longing: 0.15, hurt: 0.1, tension: 0.1, irritation: 0.1,
      affectionIntensity: 0.3, reassuranceNeed: 0.15,
    },
    regulationStyle: {
      suppression: 0.65, volatility: 0.15, recoverySpeed: 0.55,
      conflictAvoidance: 0.55, reassuranceSeeking: 0.25, protestBehavior: 0.15,
      emotionalTransparency: 0.3, attachmentActivation: 0.35, pride: 0.5,
    },
    relationshipDefaults: { closeness: 0.2, trust: 0.3, affection: 0.2, tension: 0.05 },
  },
  {
    id: "playful",
    label: "Playful",
    blurb: "Warm, expressive, light. Low tension, easy to laugh.",
    baselineAffect: {
      warmth: 0.75, trust: 0.55, calm: 0.65, vulnerability: 0.35,
      longing: 0.25, hurt: 0.05, tension: 0.05, irritation: 0.05,
      affectionIntensity: 0.7, reassuranceNeed: 0.25,
    },
    regulationStyle: {
      suppression: 0.15, volatility: 0.25, recoverySpeed: 0.75,
      conflictAvoidance: 0.35, reassuranceSeeking: 0.35, protestBehavior: 0.15,
      emotionalTransparency: 0.8, attachmentActivation: 0.5, pride: 0.25,
    },
    relationshipDefaults: { closeness: 0.35, trust: 0.45, affection: 0.5, tension: 0.05 },
  },
];

export function applySoulPreset(
  current: CompanionConfig,
  preset: SoulPreset,
): CompanionConfig {
  return {
    ...current,
    soul: {
      ...current.soul,
      baselineAffect: { ...preset.baselineAffect },
      regulationStyle: { ...preset.regulationStyle },
    },
    relationshipDefaults: { ...preset.relationshipDefaults },
  };
}

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.02;
}

export function detectMatchingPreset(companion: CompanionConfig): SoulPreset | null {
  for (const preset of SOUL_PRESETS) {
    const affectMatches = (Object.keys(preset.baselineAffect) as Array<keyof typeof preset.baselineAffect>).every(
      (k) => approxEq(companion.soul.baselineAffect[k], preset.baselineAffect[k]),
    );
    if (!affectMatches) continue;
    const regMatches = (Object.keys(preset.regulationStyle) as Array<keyof typeof preset.regulationStyle>).every(
      (k) => approxEq(companion.soul.regulationStyle[k], preset.regulationStyle[k]),
    );
    if (!regMatches) continue;
    return preset;
  }
  return null;
}
