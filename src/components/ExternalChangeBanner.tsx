import { Show } from "solid-js";

/**
 * How the file on disk disagrees with the document. Kept in step with the
 * lifecycle's own kind: `deleted` and `appeared` are the two ends of a document
 * whose path did not hold what it expected.
 */
export type ExternalChangeBannerKind = "changed" | "deleted" | "appeared";

type ExternalChangeBannerProps = {
  visible: boolean;
  kind: ExternalChangeBannerKind | undefined;
  filePath: string;
  onReload: () => void;
  onSaveAs: () => void;
  onOverwrite: () => void;
  onDismiss: () => void;
};

const HEADINGS: Record<ExternalChangeBannerKind, string> = {
  changed: "File changed on disk",
  deleted: "File deleted on disk",
  appeared: "Another file now exists at this path"
};

export const ExternalChangeBanner = (props: ExternalChangeBannerProps) => (
  <Show when={props.visible}>
    <section class="external-change-banner" role="status">
      <div>
        <strong>{HEADINGS[props.kind ?? "changed"]}</strong>
        <span>{props.filePath}</span>
      </div>
      <div class="external-change-actions">
        {/* There is nothing to reload from a file that is not there. */}
        <Show when={props.kind !== "deleted"}>
          <button class="button subtle" onClick={props.onReload}>Reload from Disk</button>
        </Show>
        <button class="button subtle" onClick={props.onSaveAs}>Save As</button>
        <button class="button danger" onClick={props.onOverwrite}>
          {props.kind === "deleted" ? "Recreate File" : "Overwrite"}
        </button>
        <button class="button subtle" onClick={props.onDismiss}>Dismiss</button>
      </div>
    </section>
  </Show>
);
