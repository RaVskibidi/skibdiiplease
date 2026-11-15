export const T77_NAME = 'T77';
export const T77_FULL_NAME = 'T77 Security';
export const T77_TAGLINE = 'Professional Discord security, without the noise.';
export const T77_VERSION = '0.1.0';
export const T77_FOOTER = 'T77 Security';
export const T77_EMBED_AUTHOR = 'T77 Security';

export const T77_MESSAGES = {
  genericError: 'T77 could not complete that request. The incident has been logged for review.',
  permissionDenied:
    'You do not have the required T77 permission, or your role is not high enough to perform this action.',
  guildOnly: 'This command can only be used inside a server.',
  unknownCommand: 'That T77 command is no longer available. Try `/t77 help`.',
  cooldown: 'T77 is still processing a recent request. Try again shortly.',
  unsupportedInteraction: 'This interaction is no longer active. Run the command again if needed.',
  notConfigured: 'This feature has not been configured for this server yet.',
  hierarchy:
    'T77 cannot act on this member because their role is equal to or higher than T77’s role.',
} as const;

export const T77_DEFAULTS = {
  cooldownSeconds: 3,
  statusCooldownSeconds: 5,
  errorReferencePrefix: 'T77',
} as const;
