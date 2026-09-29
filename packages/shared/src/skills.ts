export interface BotCustomSkillStored {
  id: string;
  name: string;
  displayName: string;
  description: string;
  instructions: string;
  resources: Record<string, string>;
  enabled: boolean;
}

export interface BotSkillConfigStored {
  /** Missing means every bundled default is enabled; an empty array disables all built-ins. */
  enabledBuiltInIds?: string[];
  customSkills: BotCustomSkillStored[];
}
