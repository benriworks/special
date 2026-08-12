/**
 * Mode registry. FROZEN — mode agents implement strictly inside their own
 * src/modes/<id>/ directory; this file must not change.
 */

import type { Mode } from '../engine/types';
import { fluidMode } from './fluid';
import { galaxyMode } from './galaxy';
import { flockMode } from './flock';
import { rdMode } from './rd';
import { mojiMode } from './moji';
import { hanabiMode } from './hanabi';
import { driftMode } from './drift';
import { gravityMode } from './gravity';
import { tesseractMode } from './tesseract';
import { premiereMode } from './premiere';

export const modes: Mode[] = [fluidMode, galaxyMode, flockMode, rdMode, mojiMode, hanabiMode, driftMode, gravityMode, tesseractMode, premiereMode];
