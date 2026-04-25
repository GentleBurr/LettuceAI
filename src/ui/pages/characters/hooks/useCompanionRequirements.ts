import { useCallback, useEffect, useState } from "react";
import { Heart, Tag, Waypoints, type LucideIcon, Cpu } from "lucide-react";
import { getEmbeddingModelInfo } from "../../../../core/storage/repo";

export type CompanionRequirementKind = "embedding" | "emotion" | "ner" | "router";

export interface CompanionRequirement {
  kind: CompanionRequirementKind;
  title: string;
  subtitle: string;
  approxSize: string;
  icon: LucideIcon;
}

const REQUIREMENT_META: Record<CompanionRequirementKind, Omit<CompanionRequirement, "kind">> = {
  embedding: {
    title: "Embedding model",
    subtitle: "Powers dynamic memory recall and semantic search across past turns.",
    approxSize: "~90 MB",
    icon: Cpu,
  },
  emotion: {
    title: "Emotion classifier",
    subtitle: "Reads turns and updates the companion's felt, expressed, and blocked emotion vectors.",
    approxSize: "~120 MB",
    icon: Heart,
  },
  ner: {
    title: "Entity extractor (NER)",
    subtitle: "Identifies people, places, and objects so memories can be canonicalized and linked.",
    approxSize: "~140 MB",
    icon: Tag,
  },
  router: {
    title: "Memory router",
    subtitle:
      "Decides whether new turns should be stored as relationship, milestone, episodic, or other memory categories.",
    approxSize: "~70 MB",
    icon: Waypoints,
  },
};

export function describeRequirement(kind: CompanionRequirementKind): CompanionRequirement {
  return { kind, ...REQUIREMENT_META[kind] };
}

export interface CompanionRequirementsState {
  loading: boolean;
  missing: CompanionRequirement[];
  refresh: () => Promise<CompanionRequirement[]>;
}

export function useCompanionRequirements(): CompanionRequirementsState {
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState<CompanionRequirement[]>([]);

  const refresh = useCallback(async (): Promise<CompanionRequirement[]> => {
    try {
      const info = await getEmbeddingModelInfo();
      const missingKinds: CompanionRequirementKind[] = [];
      if (!info.installed) missingKinds.push("embedding");
      if (!info.companionEmotionInstalled) missingKinds.push("emotion");
      if (!info.companionNerInstalled) missingKinds.push("ner");
      if (!info.companionRouterInstalled) missingKinds.push("router");
      const list = missingKinds.map(describeRequirement);
      setMissing(list);
      return list;
    } catch (err) {
      console.error("Failed to check companion requirements:", err);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { loading, missing, refresh };
}
