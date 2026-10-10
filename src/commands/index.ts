import { projectCommand } from './project.js';
import { setupCommand } from './setup.js';
import type { Command } from './types.js';

export const commands: Command[] = [setupCommand, projectCommand];
