<!--
  Built-in design guide. Registered in code at packages/core/src/brand/design.ts,
  which strips this note before the text is used. It is added to a session only
  when the request is user interface work, so it costs nothing elsewhere. Keep it
  short: every line here is read on every UI task.
-->

# UI design guide

## Start from what the project has

- Find the design system first: theme files, CSS variables, a Tailwind config,
  a component library (shadcn/ui, Radix, MUI, Chakra, Mantine, Vuetify,
  Bootstrap), existing pages. Reuse its tokens and components; never add a
  second library or a second set of colours.
- No system at all: use Tailwind if the stack allows it, with a handful of
  well made components (button, input, card, dialog, nav). Match the stack:
  plain HTML gets one stylesheet, React gets components, never a new framework.

## Typography

- One family for text (system stack or one web font), at most one more for
  headings. A modular scale: 12, 14, 16, 18, 20, 24, 30, 36, 48, 60 px.
- Body 16px, line height 1.5 to 1.7, line length 60 to 75 characters
  (`max-width: 65ch`). Headings tighter: line height 1.1 to 1.3.
- Weight and size make hierarchy, not colour alone. Two or three weights.

## Spacing and layout

- A 4px base, 8px rhythm: 4, 8, 12, 16, 24, 32, 48, 64, 96. No odd values.
- Related things close, groups apart: inner padding smaller than outer gaps.
- A 12 column grid or a centred container (max width 1120 to 1280px, side
  padding 16px on mobile, 24 to 32px on desktop). Use flex and grid with `gap`,
  never margins to fake columns.
- Align to a few edges. Generous whitespace beats borders and boxes.

## Colour and contrast

- One primary colour, one neutral ramp (9 to 11 steps), semantic colours for
  success, warning and danger. Accent sparingly: one primary action per view.
- Text contrast at least 4.5:1 (3:1 for 24px text or 19px bold), controls and
  focus rings at least 3:1 against their background. Never grey text on a
  coloured background without checking.
- Colours are tokens, defined once and used by name, never raw values in
  components. Without a system, start from:
  `--bg`, `--surface`, `--border`, `--text`, `--text-muted`, `--primary`,
  `--primary-text` (text on the primary), `--success`, `--warning`,
  `--danger`, `--focus`; spacing and type the same way (`--space-1` to
  `--space-8`, `--text-sm`, `--text-base`, `--text-lg`...).
- Dark mode, when the project has one: redefine the same tokens under
  `prefers-color-scheme: dark` or a `data-theme` attribute; raise surfaces with
  lighter greys, not shadows; desaturate the primary.

## Responsive

- Mobile first. Breakpoints 640, 768, 1024, 1280px (Tailwind sm, md, lg, xl).
- Nothing may scroll sideways at 390px: no fixed widths over the viewport,
  long words and URLs wrap (`overflow-wrap: anywhere`), images
  `max-width: 100%`, tables scroll inside their own container.
- Touch targets at least 44 by 44px on mobile. Navigation collapses to a menu.

## States

Every interactive element and every data view has its states designed, not
left to defaults:
- hover, active, focus-visible (a visible ring, never `outline: none` alone),
  disabled;
- empty (what to do first), loading (skeletons shaped like the content),
  error (what happened and how to retry), success.

## Accessibility

- Semantic elements: `header`, `nav`, `main`, `footer`, `button` for actions,
  `a` for navigation, one `h1`, headings in order.
- Every input has a label, every image an `alt` (empty when decorative), icon
  buttons an `aria-label`. Everything works with the keyboard.
- Respect `prefers-reduced-motion`; animations 150 to 250ms, ease out.

## Avoid the generic look

- No centred everything, no purple to blue gradient hero by default, no
  emoji as icons, no lorem ipsum: write real, specific copy for the product.
- Pick one clear idea for the page (a strong headline, a real screenshot or
  illustration, a distinct accent) and let the rest stay quiet.
- Consistent radius (one or two values), one shadow scale, one icon set
  (Lucide, Heroicons or the project's own).

## The loop

1. Write the layout plan first when asked: sections, components, states.
2. Build it.
3. Render it and take screenshots with the `screenshot` tool, desktop and
   mobile (start the dev server with it, or open the HTML file).
4. Compare with the request and this guide: hierarchy, spacing, contrast,
   overflow at 390px, overlapping elements, console errors, states. When no
   image comes back, work from the measures it reports.
5. Fix what is off. Stop after 3 rounds, and say what is left.
