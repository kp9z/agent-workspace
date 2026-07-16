export type Branding = {
  workspaceName: string;
  workspaceShortName: string;
  agentDisplayName: string;
  userDisplayName: string;
  userGreeting: string;
};

const DEFAULT_WORKSPACE_NAME = 'Agent Workspace';
const DEFAULT_WORKSPACE_SHORT_NAME = 'Agent';
const DEFAULT_AGENT_DISPLAY_NAME = 'Agent';
const DEFAULT_USER_DISPLAY_NAME = 'User';
const DEFAULT_USER_GREETING = 'What would you like to work on today?';

function readBrandingValue(value: string | undefined, fallback: string) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return fallback;
  return trimmed;
}

export function getBranding(): Branding {
  return {
    workspaceName: readBrandingValue(process.env.NEXT_PUBLIC_AGENT_WORKSPACE_NAME, DEFAULT_WORKSPACE_NAME),
    workspaceShortName: readBrandingValue(process.env.NEXT_PUBLIC_AGENT_WORKSPACE_SHORT_NAME, DEFAULT_WORKSPACE_SHORT_NAME),
    agentDisplayName: readBrandingValue(process.env.NEXT_PUBLIC_AGENT_DISPLAY_NAME, DEFAULT_AGENT_DISPLAY_NAME),
    userDisplayName: readBrandingValue(process.env.NEXT_PUBLIC_USER_DISPLAY_NAME, DEFAULT_USER_DISPLAY_NAME),
    userGreeting: DEFAULT_USER_GREETING,
  };
}

export const branding = getBranding();
