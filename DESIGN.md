# DESIGN.md

## Product Intent

- Operator: one person protecting their own attention on X, YouTube, Instagram and LinkedIn.
- Primary action on the settings page: flip a switch or paste a key, and see that it took.
- Primary action in the page: glance at a blurred item, answer one question, go back to reading.
- We are a filter, not a curator. Blur means visible but not pulled in; hide means removed from the page. We never rearrange the host page.

## Tone

Quiet Obsidian workspace. Neutral surfaces, one muted violet accent, thin lines, small type. The extension is a calm guest: on the host page it speaks once, in a small card, and leaves no trace when answered.

## Principles

1. Every surface matters: settings rows, the status chip and the in-page card get the same care. Beauty is a merge gate, in light and in dark.
2. Visualize state: key saved, provider state, budget used and what was filtered are visible without opening anything.
3. Immediate feedback, zero friction: every control saves itself; there is no save button and no blocking step.
4. Motion stays: reduced motion softens it to an opacity change and never removes the feedback.
5. Never disturb the host: no layout shift, no scroll movement, no remote assets.

## Tokens

Options tokens live on `:root` in `entrypoints/options/index.html`. In-page tokens live on `.box` in `src/overlay.ts`, so the page and the shadow root cannot reach each other. Both use `light-dark()`.

### Color

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#faf9f6` | `#191a20` | Page, recedes |
| `--panel` | `#ffffff` | `#22242c` | Grouped rows and the in-page card |
| `--chrome` | `#f0efec` | `#1e2027` | Controls at rest, code cells |
| `--fg` | `#282632` | `#eeedf4` | Names and values |
| `--muted` | `#67626e` | `#aaa6b7` | Descriptions and captions |
| `--line` | `#dedbe3` | `#3c3c49` | Separators, control borders, switch off |
| `--accent` / `--accent-bg` | `#7355b6` / `#ede7f7` | `#c0a8fb` / `#39304b` | On state, focus, the one suggested answer |
| `--green` / `--green-bg` | `#247051` / `#e8f5ed` | `#8bd5b3` / `#253d34` | Healthy state |
| `--amber` / `--amber-bg` | `#966320` / `#fcf0d9` | `#edbf78` / `#443926` | Needs attention, recoverable |
| `--red` / `--red-bg` | `#a8402f` / `#fbe9e5` | `#f0a596` / `#46291f` | Failed action only |
| `--shadow` | `#1d17201a` | `#00000036` | Floating elements only |

### Elevation

Flat by default. Only the status chip and the in-page card float, because only they sit above other content.

### Shape

Group 10px, card 10px, control and button 7px, tag and switch full round. Lines are always 1px.

### Spacing

4px base: 4, 8, 12, 16, 24, 32. Rows pad 12px 16px with a 48px minimum height. Sections sit 32px apart.

## Typography

System stacks only: `-apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`, and `ui-monospace, "SF Mono", Menlo, Consolas, monospace` for keys and signatures. Korean uses `word-break: keep-all`.

| Role | Size and weight |
|---|---|
| Page title | 20px, 600, -0.01em |
| Section heading | 14px, 600 |
| Setting name | 13px, 500 |
| Description, chip, in-page question | 12px, 400 to 500 |
| Tag | 11px, 500 |
| Signature and metadata | 11px mono |

## Layout and Responsive

One 680px column. A row puts name and description on the left and the control on the right. Below 520px the row wraps with the control under the text. The page never scrolls sideways; long signatures wrap.

## Primitives

### Setting row

`data_bearing: true`

| State | Specification | same_as | non_color_cue |
|---|---|---|---|
| default | Name, description, control | | Text and position |
| hover | Toggle rows tint to `--chrome` | | Pointer cursor |
| active | Follows its control | switch.active | Thumb movement |
| focus | Ring on the control | switch.focus | 2px outline |
| disabled | Not used | | |
| loading | Not used, saving is reported by the status chip | status chip.loading | Pulsing dot |

### Switch

`data_bearing: true`

| State | Specification | same_as | non_color_cue |
|---|---|---|---|
| default | 40x22 track, off `--line`, on `--accent` | | Thumb left or right |
| hover | Track at 85% opacity | | Pointer cursor |
| active | Thumb travels 120ms via transform | | Thumb movement |
| focus | 2px `--accent` outline, 2px offset | | Outline |
| disabled | Not used | | |
| loading | Not used, the state changes before storage answers | | |

### Field (select, key input)

`data_bearing: true`

| State | Specification | same_as | non_color_cue |
|---|---|---|---|
| default | 30px high, 220px wide, `--chrome` fill, `--line` border | | Border, chevron |
| hover | Border darkens to `--muted` | | Border contrast |
| active | Follows focus | field.focus | Outline |
| focus | 2px `--accent` outline | | Outline |
| disabled | Not used | | |
| loading | Key field reports "저장 중…" in the chip | status chip.loading | Pulsing dot |

### Button

`data_bearing: false`

| State | Specification | same_as | non_color_cue |
|---|---|---|---|
| default | 30px high, `--chrome` fill, `--line` border | | Label |
| hover | Border darkens to `--muted` | | Border contrast |
| active | Scale .98 | | Size |
| focus | 2px `--accent` outline | | Outline |
| disabled | Opacity .55, not-allowed cursor | | Cursor, dim |
| loading | Not used, results arrive in the chip | status chip | Glyph |

### Tag

`data_bearing: true`

| State | Specification | same_as | non_color_cue |
|---|---|---|---|
| default | 11px text on tinted fill with a 5px dot | | Wording |
| hover | Not interactive | | |
| active | Not interactive | | |
| focus | Not interactive | | |
| disabled | `tag-none`: muted on `--chrome` | | Wording |
| loading | Not used | | |
| success | `tag-fresh`: green | | Wording |
| warning | `tag-stale`: amber | | Wording |

### Status chip

`data_bearing: true`

| State | Specification | same_as | non_color_cue |
|---|---|---|---|
| default | Hidden, opacity 0, bottom left so it never covers a control on the right | | Absent |
| hover | Not interactive | | |
| active | Not interactive | | |
| focus | Not focusable, announced by `role=status` | | Screen reader text |
| disabled | Not used | | |
| loading | Pulsing dot and "저장 중…" | | Dot, wording |
| success | ✓, stays 2.4s | | Glyph, wording |
| warning | Not used | | |
| error | ! in red, stays until the next action | | Glyph, wording |

### In-page prompt

`data_bearing: true`

| State | Specification | same_as | non_color_cue |
|---|---|---|---|
| default | `--panel` card, 1px `--line`, question and two buttons, placed once and never moved | | Wording |
| hover | Button border or fill changes, no transition | | Pointer cursor |
| active | Button scales to .96 | | Size |
| focus | 2px `--accent` outline | | Outline |
| disabled | Not used | | |
| loading | Not used, removal is synchronous | | |

Yes takes `--accent-bg`, because agreeing with the model is the common case. No is neutral.

## Interaction and Feedback

- A toggle or select saves on `change`; a key field saves 350ms after the last keystroke and on leaving the page. The chip reports each result.
- Saving does not change what the page already shows: the form keeps what the user typed.
- Provider state is derived and never probed: no key, paused after a 429 or 5xx, answered today, or not called yet.
- Answering a prompt removes it at once. "No" fades the item back in; "Yes" hides it.
- An item that moved under its prompt drops the prompt rather than moving it.

## Motion

`motion_present: true`

| Surface | Motion | Duration |
|---|---|---|
| Options sections | Fade and 4px rise on load | 240ms |
| Switch | Thumb transform | 120ms |
| Budget meter | `scaleX` transform | 320ms |
| Status chip | Fade and 6px rise | 180ms |
| In-page card | Fade, 2px rise, scale from .98 | 180ms |
| Item entering blur | Opacity and filter | 180ms |
| Item released by "No" | Opacity and filter | 220ms |

In-page motion uses opacity, filter and transform only, never height, margin or anything else that reflows.

`reduced_motion`: entrances and the release become an opacity fade of 120ms or less; the switch keeps a 120ms color fade while its thumb jumps; the meter jumps. Blur itself applies at once. Feedback stays.

## Light and Dark

Options follows `prefers-color-scheme`. The in-page card follows the host page: the scanner's geometry phase reads the painted background of `body`, then `html`, and sets `color-scheme` on the prompt host. A transparent or unreadable background falls back to `prefers-color-scheme`. Check both themes before merging.

## Accessibility

Switches are checkboxes with `role=switch` inside their label. The meter is `role=meter`. Focus is always a 2px outline. Every state pairs color with wording or a glyph. Status text goes through `role=status`. The prompt is a labelled group whose buttons are real buttons.

## Do

- Use the tokens above and system fonts.
- Put each new setting in a row, and let it save itself.
- Show state in words next to its color.
- Keep in-page styles in the shadow root; only `ITEM_CSS` reaches the document.

## Don't

- Don't add a save button, a modal or a confirmation step.
- Don't animate height, margin, width or position on the host page.
- Don't move a placed prompt, or restyle or reparent a feed item beyond `data-jev`.
- Don't load remote fonts, images, CSS or scripts.
- Don't use a solid accent fill for buttons, or a second accent color.
- Don't claim a provider is reachable without evidence from a real answer.

## Verification

- `bun run typecheck`, `bun test`, `bunx wxt build`.
- Screenshots of options in light and dark, and of the prompt on a light and a dark host, reviewed against Do and Don't.
- `bun run qa` for layout shift on the prompt scenarios.

## Accepted Debt

| id | decision | date | upgrade_path |
|---|---|---|---|
| chrome-123 | `light-dark()` requires Chrome 123 or later; older browsers lose these colors | 2026-11-04 | Set `minimum_chrome_version`, or duplicate tokens in media queries |
| no-probe | Provider state is inferred from today's answers because a probe would spend budget | 2026-11-04 | Persist the last call result in the background |
| signature-count | "Filtered today" counts model signatures, not items, and leaves out rule-based hides | 2026-11-04 | Have the scanner persist per-day counters |
| no-exit-motion | The prompt has no exit animation because its removal must be synchronous | 2026-11-04 | None planned |
| theme-once | A prompt keeps the theme read when it was placed if the host switches theme under it | 2026-11-04 | Re-read the theme in `revalidate` |
