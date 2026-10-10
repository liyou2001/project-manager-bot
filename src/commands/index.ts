import { eventCommand } from './event.js';
import { projectCommand } from './project.js';
import { refreshCommand } from './refresh.js';
import { setupCommand } from './setup.js';
import { timezoneCommand } from './timezone.js';
import type { Command } from './types.js';

export const commands: Command[] = [setupCommand, projectCommand, eventCommand, refreshCommand, timezoneCommand];
