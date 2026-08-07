# A WebKitGTK crash when an editor contains an image

WebKitGTK 2.52.3 aborts its web process while emitting an accessibility event.
Wisty hit it as a hard crash of the editing surface, and it is easy to trigger
from ordinary rich-text editing, so it is written up here for anyone else who
runs into it.

Filed upstream at [bugs.webkit.org](https://bugs.webkit.org). Confirmed still
present in 2.52.5, the current stable release at the time of writing.

## Symptoms

The web process dies with `SIGABRT`. In an application that means the editor
goes blank or the window freezes; there is no JavaScript error, because the
process running the JavaScript is gone.

It looks random at first. It is not — it is entirely deterministic, but the
conditions include where the caret is, so it appears to depend on what the user
was doing rather than on the content.

## Conditions

All five must hold at once:

1. A focused `contenteditable` element.
2. A **replaced element** inside it — an `<img>` is enough, including one with
   no attributes at all.
3. A character **above U+00FF** somewhere in the text after that element. An en
   dash, a curly apostrophe, an em dash, an emoji. Latin-1 accented characters
   such as `é` or `ÿ` do **not** trigger it.
4. The caret **collapsed at the very end** of the editable's text.
5. The AT-SPI accessibility bus reachable — the default on a desktop Linux
   session.

Remove any one and it does not crash.

## Why it looks like an obscure edge case and is not

Every rich-text editor built on CodeMirror 6 meets condition 2 without asking
for it. CodeMirror brackets **any inline widget** with
`<img class="cm-widgetBuffer" aria-hidden="true">` elements — not only
replacements, but plain widget decorations too. Anything that hides a markdown
delimiter, renders an inline token as an icon, or shows a hint next to a word
puts images inside the editable.

Condition 3 is met by ordinary prose. A curly apostrophe is above U+00FF, and
word processors and speech-to-text models produce them constantly. The word
"don't" is enough.

Condition 4 is met by pressing Ctrl+End, or by Select All — which is what made
this look like a Select All bug for a while. Select All only matters because it
leaves the caret at the end of the document.

## Mechanism

In `Source/WebCore/accessibility/atspi/AccessibilityObjectTextAtspi.cpp`:

`offsetMapping()` builds a table mapping UTF-16 offsets to UTF-8 byte offsets —
but returns an **empty** table when the underlying `WTF::String` is 8-bit. That
is the U+00FF boundary: WTF stores a string as Latin-1 where it can, and only
promotes to 16-bit when a character does not fit.

`UTF16OffsetToUTF8()` then indexes that table without checking its length. When
the string is 16-bit the table is populated and the lookup is fine; the failure
comes from the offset, not the storage.

`selectionChanged()` performs the bounds check on `caretOffset` *after* the
lookup rather than before. With the caret at the very end of the text, the
offset equals the length, the index is one past the end, and `Vector`'s release
assertion aborts the process.

So the crash needs a 16-bit string (condition 3) reached with an
end-of-text offset (condition 4), during a selection-changed event that only
fires when something is listening (condition 5). The replaced element
(condition 2) is what makes the accessible text's UTF-16 and UTF-8 lengths
diverge in the first place.

## Reproducing it

No framework needed. A page with a `contenteditable` div containing an `<img>`,
some text with an en dash after it, and the caret placed at the end of that text:

```html
<div id="ed" contenteditable="true">foo <img> bar &ndash; baz</div>
<script>
  const ed = document.getElementById('ed');
  ed.focus();
  const last = ed.childNodes[ed.childNodes.length - 1];
  const range = document.createRange();
  range.setStart(last, last.data.length);
  range.collapse(true);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
</script>
```

Load that in a WebKitGTK view with the accessibility bus available. The web
process aborts within a second or two.

Include `<meta charset="utf-8">` if you use a literal en dash rather than the
entity, or the file's encoding will mangle it and you will be testing the wrong
character.

## Working around it

Wisty disables the accessibility bridge before GTK initialises, so the web
process never builds an accessibility tree and the crashing path is never
entered:

```rust
std::env::set_var("AT_SPI_BUS_ADDRESS", "disabled:");
```

It must run before GTK initialisation, because the variable is read once at
startup and the web process inherits it from its parent.

**This disables screen-reader support**, which is a real cost and not one to
apply casually. Wisty makes it the default because the alternative is an editor
that crashes during normal use, and provides `WISTY_ENABLE_A11Y=1` to turn the
workaround off for anyone who needs the accessibility tree more than they need
the editor not to crash. That configuration can still hit the bug.

The narrower-looking fix — avoiding replaced elements in the editable — does not
work. As noted above, any inline widget emits the buffer images, so avoiding one
decoration type is not sufficient; you would have to give up inline widgets
entirely.

`NO_AT_BRIDGE=1` and GTK4's `GTK_A11Y=none` have the same effect and the same
cost.

The real fix is upstream: the bounds check in `selectionChanged()` belongs
before the lookup, not after.
