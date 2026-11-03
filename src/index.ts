import type { API } from 'homebridge';

import { PaperclipPlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, PaperclipPlatform);
};
