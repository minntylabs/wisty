import { createEffect, type Accessor } from "solid-js";
import { setNativeWindowTitle } from "../window/windowTitleService";

type UseWindowTitleSyncOptions = {
  fileName: Accessor<string>;
  isDirty: Accessor<boolean>;
  windowLabel?: string;
  /**
   * The window would not take the title. Not worth a dialog — the document is
   * open and editable either way — but the result type exists to be read, and
   * nothing read it.
   */
  onError?: (reason: string) => void;
};

const DEFAULT_WINDOW_LABEL = "main";

export const formatWindowTitle = (fileName: string, isDirty: boolean): string => {
  const baseName = fileName || "Untitled";
  return `${isDirty ? "*" : ""}${baseName}`;
};

export const useWindowTitleSync = (options: UseWindowTitleSyncOptions) => {
  const windowLabel = options.windowLabel ?? DEFAULT_WINDOW_LABEL;
  let lastTitle = "";

  createEffect(() => {
    const nextTitle = formatWindowTitle(options.fileName(), options.isDirty());
    if (nextTitle === lastTitle) {
      return;
    }

    document.title = nextTitle;

    void setNativeWindowTitle({
      label: windowLabel,
      title: nextTitle
    }).then((result) => {
      // Recorded only once it has actually been applied. Assigning it up front
      // meant a title that failed to reach the window was remembered as the
      // one showing, so the guard above skipped every later attempt at it and
      // the window kept a name from some earlier document.
      if (result.ok) {
        lastTitle = nextTitle;
        return;
      }
      options.onError?.(result.reason);
    });
  });
};
