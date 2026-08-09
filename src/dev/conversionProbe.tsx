/**
 * Watches the conversion window for the thing that closed its disclosure.
 *
 * The readout is on screen rather than in the console: the fault is
 * intermittent and the inspector is a poor place to catch something you have
 * seconds to notice. Everything it counts distinguishes one explanation from
 * another —
 *
 *   mounts / cleanups  the component itself is being re-created
 *   node replaced      the <details> element is swapped out under a live
 *                      component, which takes its open state with it
 *   toggles            the element survived and something closed it, which
 *                      would be the webview or a stray activation
 *   batches            output is arriving at all, so the window is live
 *
 * A native <details> sits alongside the real disclosure so both are under the
 * same conditions at once: if the button keeps its state while the details
 * loses its own, the difference is the DOM node, not the app's state.
 *
 * Development only, behind `import.meta.env.DEV`, and dropped from a
 * production build.
 */

import { For, createSignal, onCleanup, onMount } from "solid-js";

/** Survives re-creation of the component, which is the point of counting it. */
let mounts = 0;
let cleanups = 0;

type ProbeEvent = { at: string; what: string };

const stamp = () => new Date().toISOString().slice(11, 23);

const ConversionProbe = (props: {
  /** How many batches of output have arrived. */
  batches: number;
  /** Which shape the parent is passing its props in. */
  propShape: "eager" | "lazy";
  onPropShapeChange: (shape: "eager" | "lazy") => void;
}) => {
  const [events, setEvents] = createSignal<ProbeEvent[]>([]);
  const [replacements, setReplacements] = createSignal(0);
  const [toggles, setToggles] = createSignal(0);
  let details: HTMLDetailsElement | undefined;

  const note = (what: string) =>
    setEvents((seen) => [{ at: stamp(), what }, ...seen].slice(0, 8));

  mounts += 1;
  note(`mounted (${mounts})`);

  onCleanup(() => {
    cleanups += 1;
  });

  onMount(() => {
    const node = details;
    if (!node?.parentElement) {
      return;
    }
    // The panel, not the element: a replacement is the element leaving its
    // parent, which the element itself is in no position to report.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const removed of record.removedNodes) {
          if (removed === node || removed.contains?.(node)) {
            setReplacements((count) => count + 1);
            note("probe <details> removed from the panel");
          }
        }
      }
    });
    observer.observe(node.parentElement.parentElement ?? node.parentElement, {
      childList: true,
      subtree: true
    });
    onCleanup(() => observer.disconnect());
  });

  return (
    <div class="conversion-probe">
      <p class="conversion-probe-title">Probe (development build only)</p>

      <details
        ref={details}
        onToggle={(event) => {
          setToggles((count) => count + 1);
          note(`native <details> toggled open=${(event.currentTarget as HTMLDetailsElement).open}`);
        }}
      >
        <summary>Native &lt;details&gt; under the same conditions</summary>
        <p>If this closes on its own while the button above keeps its state, the DOM node is the difference.</p>
      </details>

      <dl class="conversion-probe-counts">
        <dt>Mounts / cleanups</dt>
        <dd>
          {mounts} / {cleanups}
        </dd>
        <dt>Node replaced</dt>
        <dd>{replacements()}</dd>
        <dt>Toggles seen</dt>
        <dd>{toggles()}</dd>
        <dt>Output batches</dt>
        <dd>{props.batches}</dd>
        <dt>Props shape</dt>
        <dd>
          {props.propShape}{" "}
          <button
            type="button"
            class="conversion-disclosure"
            onClick={() => props.onPropShapeChange(props.propShape === "lazy" ? "eager" : "lazy")}
          >
            switch to {props.propShape === "lazy" ? "eager" : "lazy"}
          </button>
        </dd>
      </dl>

      <pre class="conversion-probe-log">
        <For each={events()}>{(event) => <div>{`${event.at}  ${event.what}`}</div>}</For>
      </pre>
    </div>
  );
};

/** Default-exported for the lazy import that keeps it out of a build. */
export default ConversionProbe;
