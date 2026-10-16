# Image canvas artboards

These are the artboards of the image design canvas
(<https://claude.ai/artifact/Umg16L46DWePJVmMJDf78b>, private to the owner), copied on
2026-10-16 so that every session can read them. They draw four directions for an image field:
the record page with its larger view, the editor, the empty and missing states, thumbnails in a
list, gallery covers and Studio's cell (W-263, [the plan](../media.md#native-ui)).

| File | Direction |
| --- | --- |
| `Main.dc.html` | **A · Inline picture**, chosen: the picture fitted in its field row, a source line and a `⋯` menu under it, a dashed drop zone when empty, a quiet row when missing |
| `B.dc.html` | B · Cover banner: the first picture as a banner over the page, others as tiles |
| `C.dc.html` | C · Card with toolbar: every action visible under the picture |
| `D.dc.html` | D · Chip and preview pane: a compact chip per field, the picture in a side pane |
| `*-dark.dc.html` | The same four in Dark, each importing its Light board with `theme="dark"` |

**A was taken on 2026-10-16** as the recommended direction, under the owner's standing goal for
I-012 ("use the recommended direction if I haven't picked one"). It needs nothing new in the
page's layout: a picture is one more field row, the actions sit where the record page already
puts a field's menu, and the same thumbnail serves lists, boards and Studio. The owner can still
pick another; W-266 to W-268 build A.

They are reference markup, not code to ship: each file is a Design Component page that the
canvas's runtime renders, and the colours in each are the Mica tokens of `02-tokens.css` as
literals, which the Workbench takes from the tokens instead.
