import { keyText } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { START_ENTRY_TYPE, TURN_MESSAGE_TYPE } from "../memory.js";
import type { StartEntryData, TurnDetails } from "../memory.js";
import { LOGIN_ENTRY_TYPE, STATUS_ENTRY_TYPE } from "./entries.js";
import type { LoginEntryData, StatusSnapshot } from "./entries.js";
import { DEFAULT_EXPAND_KEY, FormattedLines } from "./render/layout.js";
import { formatLoginEntry } from "./render/login.js";
import { formatStatusPanel } from "./render/panel.js";
import { formatStartEntry } from "./render/start.js";
import { formatTurnMessage } from "./render/turn.js";

/** Pi's binding for the global expand toggle, e.g. `ctrl+o`. */
const expandKey = (): string => {
  try {
    return keyText("app.tools.expand") || DEFAULT_EXPAND_KEY;
  } catch {
    return DEFAULT_EXPAND_KEY;
  }
};

export const registerRenderers = (pi: ExtensionAPI): void => {
  pi.registerEntryRenderer<StartEntryData>(START_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const { data } = entry;
    if (!data) {
      return undefined;
    }
    const opts = { expandKey: expandKey() };
    return new FormattedLines((width) => formatStartEntry(data, expanded, width, theme, opts));
  });

  pi.registerMessageRenderer<TurnDetails>(
    TURN_MESSAGE_TYPE,
    (message, { expanded, outputPad }, theme) => {
      const opts = { pad: outputPad, expandKey: expandKey() };
      return new FormattedLines((width) =>
        formatTurnMessage(message, expanded, width, theme, opts),
      );
    },
  );

  pi.registerEntryRenderer<StatusSnapshot>(STATUS_ENTRY_TYPE, (entry, _options, theme) => {
    const { data } = entry;
    return data ? new FormattedLines((width) => formatStatusPanel(data, width, theme)) : undefined;
  });

  pi.registerEntryRenderer<LoginEntryData>(LOGIN_ENTRY_TYPE, (entry, _options, theme) => {
    const { data } = entry;
    return data ? new FormattedLines((width) => formatLoginEntry(data, width, theme)) : undefined;
  });
};
