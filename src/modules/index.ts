/** Registered capability modules. Add new Jev-backed capabilities here. */

import { evaluateModule } from "./evaluate/index.js";
import { routingModule } from "./routing/index.js";
import type { JevModule } from "./types.js";

export const MODULES: JevModule[] = [routingModule, evaluateModule];
