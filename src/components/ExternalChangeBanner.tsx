import { Show } from "solid-js";

type ExternalChangeBannerProps = {
  visible: boolean;
  kind: "changed" | "deleted" | undefined;
  filePath: string;
  onReload: () => void;
  onSaveAs: () => void;
  onOverwrite: () => void;
  onDismiss: () => void;
};

export const ExternalChangeBanner = (props: ExternalChangeBannerProps) => (
  <Show when={props.visible}>
    <section class="external-change-banner" role="status">
      <div>
        <strong>{props.kind === "deleted" ? "File deleted on disk" : "File changed on disk"}</strong>
        <span>{props.filePath}</span>
      </div>
      <div class="external-change-actions">
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
