# FlashDesk — card flip animation

**Date:** 2026-08-04 · **Status:** approved

## Problem

Clicking a review card reveals the answer instantly: `reveal()` re-renders the
card with the back appended below the front. Abdiel wants a proper flip
animation when the card is clicked.

## Decisions (agreed)

- **Back face keeps question + answer** — the flipped side shows the same
  layout the revealed state shows today (front text, divider, back text), so
  grading context is unchanged. The flip is purely a visual upgrade.
- **CSS 3D flip** over a scaleX pseudo-flip or JS Web-Animations: standard
  Quizlet feel, zero dependencies, honors the existing
  `prefers-reduced-motion` kill-switch (flip becomes instant).

## Design

**Markup** (`renderReview()` in `public/app.js`): the `#card-face` button
renders **both faces up front**:

```html
<button class="card-flip revealable" id="card-face">
  <div class="card-flip-inner">
    <div class="card-face face-front">front + "tap to reveal" hint</div>
    <div class="card-face face-back">front + divider + back</div>
  </div>
</button>
<div class="grade-row" hidden>Again / Got it</div>
```

**Behavior:** `reveal()` no longer re-renders (a re-render would cut the
transition short). It adds `.flipped` / removes `.revealable` on the existing
button, swaps `aria-hidden` between the faces, and un-hides the grade row.
All other paths (grading, ‹ › arrows, deck switch) still fully re-render,
which shows the next card front-side up with no reverse animation.

**CSS** (`public/styles.css`): `perspective` on the button,
`transform-style: preserve-3d` + `transition: transform .45s` on the inner
wrapper, both faces stacked in the same grid cell (`grid-area: 1/1`, so the
card is as tall as its taller face) with `backface-visibility: hidden`, back
face pre-rotated `rotateY(180deg)`. `.flipped` rotates the inner wrapper
180°. Grade row gets a short delayed fade-in keyframe so it lands with the
flip. Existing `.card-face` visual styles move from the button to the faces.

**Unchanged:** event delegation on `#review-area` (no new bindings), space
key via native button activation, keyboard grading (1/2/Enter), reduced
motion (global `animation/transition: none` rule already covers the new
rules).

## Testing

FlashDesk is zero-dependency with no test framework; this change is one class
toggle plus CSS. Verified in the real browser instead of unit tests (agreed
with Abdiel): click flips, space flips, grade row appears and grades advance
front-side up, arrows reset the flip, back face is not mirrored.
