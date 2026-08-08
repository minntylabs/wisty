import { Show } from "solid-js";

/**
 * How the file on disk disagrees with the document. Kept in step with the
 * lifecycle's own kind: `deleted` and `appeared` are the two ends of a document
 * whose path did not hold what it expected.
 */
export type ExternalChangeBannerKind = "changed" | "deleted" | "appeared" | "not-a-file";

type ExternalChangeBannerProps = {
  visible: boolean;
  kind: ExternalChangeBannerKind | undefined;
  filePath: string;
  /**
   * Whether something that reads or writes the document is already running.
   *
   * These buttons sit outside the command pipeline, which is what stops the
   * menus and shortcuts firing during a load or a save. Without this they are
   * the one way to start a second one — overwriting a file with a half-loaded
   * editor, or reloading over a save that is still streaming.
   */
  busy: boolean;
  onReload: () => void;
  onSaveAs: () => void;
  onOverwrite: () => void;
  onDismiss: () => void;
};

const HEADINGS: Record<ExternalChangeBannerKind, string> = {
  changed: "File changed on disk",
  deleted: "File deleted on disk",
  appeared: "Another file now exists at this path",
  "not-a-file": "This path is no longer a file"
};

/** Nothing can be read from it, and a save cannot be published over it. */
const isUnusablePath = (kind: ExternalChangeBannerKind | undefined) => kind === "not-a-file";

export const ExternalChangeBanner = (props: ExternalChangeBannerProps) => (
  <Show when={props.visible}>
    <section class="external-change-banner" role="status">
      <div>
        <strong>{HEADINGS[props.kind ?? "changed"]}</strong>
        <span>{props.filePath}</span>
      </div>
      <div class="external-change-actions">
        {/* There is nothing to reload from a file that is not there. */}
        <Show when={props.kind !== "deleted" && !isUnusablePath(props.kind)}>
          <button class="button subtle" disabled={props.busy} onClick={props.onReload}>Reload from Disk</button>
        </Show>
        <button class="button subtle" disabled={props.busy} onClick={props.onSaveAs}>Save As</button>
        {/* Publishing a save renames over the path, which a directory refuses,
            so there is no overwrite to offer — only somewhere else to save. */}
        <Show when={!isUnusablePath(props.kind)}>
          <button class="button danger" disabled={props.busy} onClick={props.onOverwrite}>
            {props.kind === "deleted" ? "Recreate File" : "Overwrite"}
          </button>
        </Show>
        {/* Dismiss only hides the banner, so it is safe whatever else runs. */}
        <button class="button subtle" onClick={props.onDismiss}>Dismiss</button>
      </div>
    </section>
  </Show>
);
